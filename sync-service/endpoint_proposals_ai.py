"""AI steward scan for GIS endpoint fix proposals (DeepSeek / cleanup LLM)."""

from __future__ import annotations

import json
import os
import re
import uuid
from typing import Any

from agents.llm.provider import cleanup_llm_configured, complete_chat, get_llm_profile
from agents.llm.react import run_tool_loop

from endpoint_proposals import (
    claim_proposals_for_ai_scan,
    list_endpoint_fix_proposals,
    release_ai_scan_claims,
)
from endpoint_proposal_tier import normalize_data_tier, tier_config

AI_SCAN_MAX_LIMIT = max(10, min(100, int(os.getenv("GIOP_ENDPOINT_AI_SCAN_MAX_LIMIT", "100"))))
AI_SCAN_DEFAULT_LIMIT = max(10, min(AI_SCAN_MAX_LIMIT, int(os.getenv("GIOP_ENDPOINT_AI_SCAN_DEFAULT_LIMIT", "10"))))
AI_SCAN_MAX_OUTPUT_TOKENS = max(4096, min(65536, int(os.getenv("GIOP_ENDPOINT_AI_SCAN_MAX_OUTPUT_TOKENS", "32768"))))

AI_SCAN_SYSTEM = """You are the GIOP geometry steward agent reviewing GIS conductor endpoint fix proposals.

Context:
- Raw GPKG lines have originating_node_id / end_node_id text fields (pole unique IDs).
- Geometry-based proposals matched line endpoints to nearest overhead support-structure poles.
- Tier A = both ends within ~5m. Tier B = assisted match within ~15m — review carefully.

Your job:
1. Reason about whether each proposal makes topological sense (geometry vs typo vs wrong pole).
2. Call preview_geom_snap_candidate(segment_id) when you need per-segment pole distances and tiers.
3. Think step by step — stewards will read your reasoning in the UI.

Rules:
- Do NOT approve or write to the database.
- If geometry proposal looks correct, agree=true and confidence=high for tier_a with small distances.
- Flag typos when current_from/to is close to proposed pole ID (spelling/format).
- Only suggest different proposed_from/proposed_to when you disagree with geometry match.

Finish with a fenced JSON block:
```json
{
  "thoughts": "2-4 sentence overall summary of your analysis",
  "reviews": [
    {
      "proposal_id": "uuid",
      "segment_id": 123,
      "agree": true,
      "confidence": "high",
      "rationale": "one line per row",
      "proposed_from": null,
      "proposed_to": null
    }
  ]
}
```
Include a review entry for every proposal id listed in the user message."""

AI_SCAN_SYSTEM_COMPACT = """You are the GIOP geometry steward reviewing GIS endpoint fix proposals in a LARGE batch.

Rules:
- Tier A + small distances → agree=true, confidence=high.
- Tier B within 15m → agree=true unless distance >12m then confidence=medium.
- Keep each rationale under 12 words. Overall thoughts max 2 sentences.
- Do NOT write long prose — stewards need compact triage at scale.

Finish ONLY with fenced JSON:
```json
{"thoughts": "brief summary", "reviews": [{"proposal_id": "uuid", "segment_id": 1, "agree": true, "confidence": "high", "rationale": "short", "proposed_from": null, "proposed_to": null}]}
```
Include every proposal_id from the user message."""

TIER_A_AUTO_MAX_M = 5.0
TIER_A_STAGING_AUTO_MAX_M = 1.0

AI_SCAN_SYSTEM_STAGING = """You are the GIOP geometry steward reviewing staging field-capture line endpoint proposals.

Context:
- Staging ac_line_segments link source_node_id / target_node_id connectivity node UUIDs.
- Proposals re-link line endpoints to nearest active staging connectivity nodes when geometry mismatches.
- Tier A = both ends within ~1m. Tier B = assisted match within ~5m.

Rules:
- Do NOT approve or write to the database.
- agree=true with confidence=high when tier_a and small distances.
- Keep rationale under 12 words per row in large batches.

Finish with fenced JSON:
```json
{"thoughts": "brief summary", "reviews": [{"proposal_id": "uuid", "segment_id": 0, "agree": true, "confidence": "high", "rationale": "short", "proposed_from": null, "proposed_to": null}]}
```
Include every proposal_id from the user message."""


def _max_endpoint_dist_m(proposal: dict[str, Any]) -> float | None:
    dists = [proposal.get("start_dist_m"), proposal.get("end_dist_m")]
    nums = [float(d) for d in dists if d is not None]
    return max(nums) if nums else None


def _rule_tier_a_review(proposal: dict[str, Any]) -> dict[str, Any]:
    tier = proposal.get("data_tier") or "gis"
    max_m = TIER_A_STAGING_AUTO_MAX_M if tier == "staging" else TIER_A_AUTO_MAX_M
    max_dist = _max_endpoint_dist_m(proposal) or 0.0
    return {
        "proposal_id": proposal["id"],
        "segment_id": proposal["segment_id"],
        "agree": True,
        "confidence": "high",
        "rationale": (
            f"Tier A geometry match — nearest poles within {max_dist:.1f} m "
            f"(auto, no LLM)."
        ),
        "proposed_from": None,
        "proposed_to": None,
    }


def _partition_for_tiered_scan(
    proposals: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Tier A within tolerance → rule-based; tier B and borderline → LLM batch."""
    auto: list[dict[str, Any]] = []
    llm: list[dict[str, Any]] = []
    for proposal in proposals:
        if proposal.get("tier") != "tier_a":
            llm.append(proposal)
            continue
        max_dist = _max_endpoint_dist_m(proposal)
        tier = proposal.get("data_tier") or "gis"
        max_m = TIER_A_STAGING_AUTO_MAX_M if tier == "staging" else TIER_A_AUTO_MAX_M
        if max_dist is not None and max_dist <= max_m:
            auto.append(proposal)
        else:
            llm.append(proposal)
    return auto, llm


def _extract_json_payload(text: str) -> dict[str, Any] | None:
    if not text:
        return None
    raw: str | None = None
    fence = re.search(r"```json\s*(\{.*\})\s*```", text, re.DOTALL | re.IGNORECASE)
    if fence:
        raw = fence.group(1)
    else:
        start = text.find("{")
        end = text.rfind("}")
        if start >= 0 and end > start:
            raw = text[start : end + 1]
    if not raw:
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return None


def _proposal_brief(p: dict[str, Any]) -> dict[str, Any]:
    brief = {
        "proposal_id": p["id"],
        "segment_id": p.get("segment_id"),
        "tier": p.get("tier"),
        "import_reason": p.get("import_reason"),
        "current_from": p.get("current_from"),
        "current_to": p.get("current_to"),
        "proposed_from": p.get("proposed_from"),
        "proposed_to": p.get("proposed_to"),
        "start_dist_m": p.get("start_dist_m"),
        "end_dist_m": p.get("end_dist_m"),
        "start_nearest_pole": p.get("start_nearest_pole"),
        "end_nearest_pole": p.get("end_nearest_pole"),
    }
    if p.get("segment_mrid"):
        brief["segment_mrid"] = p["segment_mrid"]
    return brief


def _insert_scan_row(
    conn,
    *,
    district: str,
    data_tier: str = "gis",
    batch_id: str | None,
    model: str | None,
    status: str = "running",
) -> str:
    scan_id = str(uuid.uuid4())
    tier = normalize_data_tier(data_tier)
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO gis.endpoint_fix_ai_scans (
              id, district, data_tier, proposal_batch_id, model, llm_profile, status
            ) VALUES (%s::uuid, %s, %s, %s::uuid, %s, 'cleanup', %s)
            """,
            (scan_id, district, tier, batch_id, model, status),
        )
    conn.commit()
    return scan_id


def _finalize_scan(
    conn,
    scan_id: str,
    *,
    status: str,
    thoughts: str | None,
    transcript: list[dict[str, Any]],
    reviews: list[dict[str, Any]],
    proposals_reviewed: int,
    error_message: str | None = None,
) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE gis.endpoint_fix_ai_scans
            SET status = %s,
                thoughts = %s,
                transcript = %s::jsonb,
                reviews = %s::jsonb,
                proposals_reviewed = %s,
                error_message = %s,
                completed_at = now()
            WHERE id = %s::uuid
            """,
            (
                status,
                thoughts,
                json.dumps(transcript),
                json.dumps(reviews),
                proposals_reviewed,
                error_message,
                scan_id,
            ),
        )
    conn.commit()


def _apply_reviews(
    conn, scan_id: str, reviews: list[dict[str, Any]], *, data_tier: str = "gis"
) -> int:
    tier = normalize_data_tier(data_tier)
    table = tier_config(tier)["proposals_table"]
    if tier == "staging":
        proposed_from_col = "proposed_source"
        proposed_to_col = "proposed_target"
    else:
        proposed_from_col = "proposed_from"
        proposed_to_col = "proposed_to"
    updated = 0
    with conn.cursor() as cur:
        for review in reviews:
            proposal_id = review.get("proposal_id")
            if not proposal_id:
                continue
            agree = review.get("agree")
            confidence = review.get("confidence")
            if confidence not in ("high", "medium", "low"):
                confidence = "medium" if agree else "low"
            rationale = review.get("rationale")
            proposed_from = review.get("proposed_from")
            proposed_to = review.get("proposed_to")
            cur.execute(
                f"""
                UPDATE {table}
                SET ai_rationale = %s,
                    ai_confidence = %s,
                    ai_agrees = %s,
                    ai_scan_id = %s::uuid,
                    {proposed_from_col} = COALESCE(%s, {proposed_from_col}),
                    {proposed_to_col} = COALESCE(%s, {proposed_to_col}),
                    ai_claim_token = NULL,
                    ai_claimed_at = NULL,
                    ai_claim_expires_at = NULL
                WHERE id = %s::uuid AND status = 'pending'
                """,
                (
                    rationale,
                    confidence,
                    agree,
                    scan_id,
                    proposed_from,
                    proposed_to,
                    proposal_id,
                ),
            )
            updated += cur.rowcount
    conn.commit()
    return updated


def _token_budget_for_batch(count: int, *, reasoning_depth: str) -> int:
    per_row = 220 if count >= 40 else 350
    base = 6144 if reasoning_depth == "deep" else 4096
    return min(base + count * per_row, AI_SCAN_MAX_OUTPUT_TOKENS)


def _system_prompt_for_batch(
    count: int, *, reasoning_depth: str, data_tier: str = "gis"
) -> str:
    if normalize_data_tier(data_tier) == "staging":
        return AI_SCAN_SYSTEM_STAGING if count >= 25 else AI_SCAN_SYSTEM_STAGING
    if count >= 40 or reasoning_depth == "quick" and count >= 25:
        return AI_SCAN_SYSTEM_COMPACT
    return AI_SCAN_SYSTEM


def _run_batch_llm_review(
    district: str,
    proposals: list[dict[str, Any]],
    *,
    model: str | None = None,
    max_tokens: int = 4096,
    reasoning_depth: str = "quick",
    data_tier: str = "gis",
) -> dict[str, Any]:
    briefs = [_proposal_brief(p) for p in proposals]
    system = _system_prompt_for_batch(
        len(briefs), reasoning_depth=reasoning_depth, data_tier=data_tier
    )
    user_msg = (
        f"District: {district}\n"
        f"Review these {len(briefs)} endpoint fix proposals:\n"
        f"{json.dumps(briefs, indent=2)}"
    )
    result = complete_chat(
        [
            {"role": "system", "content": system},
            {"role": "user", "content": user_msg},
        ],
        profile="cleanup",
        model=model,
        max_tokens=max_tokens,
    )
    content = result.get("content") or ""
    transcript = [
        {"role": "user", "content": user_msg[:500] + "…"},
        {"role": "assistant", "content": content},
    ]
    payload = _extract_json_payload(content)
    reviews = (payload or {}).get("reviews") or []
    thoughts = (payload or {}).get("thoughts") if payload else None
    if not thoughts:
        thoughts = content[:2000] if not content.lstrip().startswith("```") else None
    if not thoughts and payload is None and content:
        thoughts = "LLM response could not be parsed — try Deep reasoning or fewer rows."
    return {
        "model": result.get("model"),
        "content": content,
        "transcript": transcript,
        "reviews": reviews,
        "thoughts": thoughts,
    }


def _run_agent_llm_review(
    conn,
    district: str,
    proposals: list[dict[str, Any]],
    *,
    model: str | None = None,
    max_turns: int = 8,
) -> dict[str, Any]:
    briefs = [_proposal_brief(p) for p in proposals]
    user_msg = (
        f"District: {district}\n"
        f"Review these {len(briefs)} endpoint fix proposals. "
        f"Use preview_geom_snap_candidate for any row you are unsure about.\n"
        f"{json.dumps(briefs, indent=2)}"
    )
    messages = [
        {"role": "system", "content": AI_SCAN_SYSTEM},
        {"role": "user", "content": user_msg},
    ]

    def _tool_filter(name: str) -> bool:
        return name in ("preview_geom_snap_candidate",)

    react = run_tool_loop(
        conn,
        messages,
        agent_name="GeometryStewardAgent",
        max_turns=max_turns,
        tool_filter=_tool_filter,
        llm_profile="cleanup",
        model=model,
    )
    content = react.get("content") or ""
    payload = _extract_json_payload(content)
    reviews = (payload or {}).get("reviews") or []
    thoughts = (payload or {}).get("thoughts") or content[:4000]
    return {
        "model": react.get("model"),
        "transcript": react.get("transcript") or [],
        "reviews": reviews,
        "thoughts": thoughts,
    }


def _resolve_scan_models(reasoning_depth: str) -> tuple[str | None, str | None, int]:
    from agents.llm.provider import (
        cleanup_llm_deep_max_tool_turns,
        cleanup_llm_deep_model,
        cleanup_llm_model,
        get_llm_profile,
    )

    cfg = get_llm_profile("cleanup")
    if not cfg.configured:
        return None, None, 6
    if reasoning_depth == "deep":
        return cleanup_llm_model(), cleanup_llm_deep_model(), cleanup_llm_deep_max_tool_turns()
    return cleanup_llm_model(), cleanup_llm_model(), 6


def ai_scan_endpoint_fix_proposals(
    conn,
    district: str,
    *,
    data_tier: str = "gis",
    batch_id: str | None = None,
    limit: int | None = None,
    offset: int = 0,
    unscanned_only: bool = False,
    swarm_claim: bool = False,
    mode: str = "tiered",
    reasoning_depth: str = "quick",
) -> dict[str, Any]:
    """Run cleanup LLM over pending proposals; persist thoughts + per-row AI rationale."""
    district = (district or "").strip()
    tier = normalize_data_tier(data_tier)
    if not district:
        raise ValueError("district is required")
    if limit is None:
        limit = AI_SCAN_DEFAULT_LIMIT
    if limit < 1 or limit > AI_SCAN_MAX_LIMIT:
        raise ValueError(f"limit must be between 1 and {AI_SCAN_MAX_LIMIT}")
    if mode not in ("agent", "batch", "tiered"):
        raise ValueError("mode must be agent, batch, or tiered")
    if reasoning_depth not in ("quick", "deep"):
        raise ValueError("reasoning_depth must be quick or deep")

    claim_token: str | None = None
    try:
        if swarm_claim:
            claim_token, proposals = claim_proposals_for_ai_scan(
                conn, district, limit, data_tier=tier
            )
            if not proposals:
                raise ValueError("no_pending_proposals")
            page = {"proposals": proposals, "total": len(proposals), "limit": limit, "offset": 0}
        else:
            page = list_endpoint_fix_proposals(
                conn,
                data_tier=tier,
                district=district,
                status="pending",
                batch_id=batch_id,
                unscanned_only=unscanned_only,
                limit=limit,
                offset=offset,
            )
            proposals = page["proposals"]
            if not proposals:
                raise ValueError("no_pending_proposals")

        cfg = get_llm_profile("cleanup")
        scan_id = _insert_scan_row(
            conn,
            district=district,
            data_tier=tier,
            batch_id=batch_id or proposals[0].get("batch_id"),
            model=cfg.model if cfg.configured else None,
        )

        auto_proposals: list[dict[str, Any]] = []
        llm_proposals = proposals
        if mode == "tiered":
            auto_proposals, llm_proposals = _partition_for_tiered_scan(proposals)

        needs_llm = mode == "agent" or mode == "batch" or bool(llm_proposals)
        if needs_llm and not cleanup_llm_configured():
            thoughts = (
                "Cleanup LLM not configured (GIOP_CLEANUP_LLM_API_KEY). "
                "Geometry proposals are unchanged — configure DeepSeek to enable AI scan."
            )
            _finalize_scan(
                conn,
                scan_id,
                status="failed",
                thoughts=thoughts,
                transcript=[{"role": "assistant", "content": thoughts}],
                reviews=[],
                proposals_reviewed=0,
                error_message="llm_not_configured",
            )
            if claim_token:
                release_ai_scan_claims(conn, claim_token, data_tier=tier)
            return {
                "scan_id": scan_id,
                "district": district,
                "data_tier": tier,
                "proposals_reviewed": 0,
                "thoughts": thoughts,
                "transcript": [{"role": "assistant", "content": thoughts}],
                "reviews": [],
                "configured": False,
            }

        auto_reviews = [_rule_tier_a_review(p) for p in auto_proposals]
        transcript: list[dict[str, Any]] = []
        if auto_reviews:
            transcript.append(
                {
                    "role": "assistant",
                    "content": (
                        f"Auto-reviewed {len(auto_reviews)} Tier A proposal(s) "
                        f"within {TIER_A_AUTO_MAX_M:.0f} m — no LLM call."
                    ),
                }
            )

        reviews = list(auto_reviews)
        thoughts_parts: list[str] = []
        if auto_reviews:
            thoughts_parts.append(
                f"{len(auto_reviews)} Tier A row(s) auto-approved by geometry rules."
            )
        model = cfg.model if cfg.configured else None
        quick_model, deep_model, deep_max_turns = _resolve_scan_models(reasoning_depth)
        use_agent = reasoning_depth == "deep" or mode == "agent"
        use_batch = not use_agent and (mode == "batch" or mode == "tiered")

        if use_batch:
            batch_targets = proposals if mode == "batch" else llm_proposals
            if batch_targets:
                token_budget = _token_budget_for_batch(
                    len(batch_targets), reasoning_depth=reasoning_depth
                )
                batch = _run_batch_llm_review(
                    district,
                    batch_targets,
                    model=deep_model if reasoning_depth == "deep" else quick_model,
                    max_tokens=token_budget,
                    reasoning_depth=reasoning_depth,
                    data_tier=tier,
                )
                transcript.extend(batch["transcript"])
                reviews.extend(batch["reviews"])
                if batch.get("thoughts"):
                    thoughts_parts.append(batch["thoughts"])
                model = batch.get("model") or model
        elif use_agent:
            agent_targets = proposals if mode == "agent" else llm_proposals
            if agent_targets:
                agent_turns = deep_max_turns if reasoning_depth == "deep" else 6
                if reasoning_depth == "deep":
                    agent_turns = max(agent_turns, min(len(agent_targets) * 2 + 2, 16))
                agent = _run_agent_llm_review(
                    conn,
                    district,
                    agent_targets,
                    model=deep_model if reasoning_depth == "deep" else quick_model,
                    max_turns=agent_turns,
                )
                transcript.extend(agent["transcript"])
                reviews.extend(agent["reviews"])
                if agent.get("thoughts"):
                    thoughts_parts.append(agent["thoughts"])
                model = agent.get("model") or model

        thoughts = " ".join(thoughts_parts).strip() or None
        updated = _apply_reviews(conn, scan_id, reviews, data_tier=tier) if reviews else 0
        _finalize_scan(
            conn,
            scan_id,
            status="completed",
            thoughts=thoughts,
            transcript=transcript,
            reviews=reviews,
            proposals_reviewed=updated if reviews else len(auto_reviews),
        )

        return {
            "scan_id": scan_id,
            "district": district,
            "data_tier": tier,
            "model": model,
            "proposals_reviewed": updated if reviews else len(auto_reviews),
            "thoughts": thoughts,
            "transcript": transcript,
            "reviews": reviews,
            "configured": True,
            "mode": mode,
            "reasoning_depth": reasoning_depth,
            "auto_reviewed": len(auto_reviews),
            "llm_reviewed": len(reviews) - len(auto_reviews),
            "limit": limit,
            "offset": offset,
            "remaining_unscanned": max(0, page["total"] - len(proposals)) if unscanned_only else None,
        }
    except Exception as exc:
        if claim_token:
            release_ai_scan_claims(conn, claim_token, data_tier=tier)
        if "scan_id" in locals():
            _finalize_scan(
                conn,
                scan_id,
                status="failed",
                thoughts=None,
                transcript=[],
                reviews=[],
                proposals_reviewed=0,
                error_message=str(exc)[:500],
            )
        raise


def get_endpoint_fix_ai_scan(conn, scan_id: str) -> dict[str, Any] | None:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT id, district, proposal_batch_id, model, llm_profile, status,
                   thoughts, transcript, reviews, proposals_reviewed,
                   error_message, created_at, completed_at
            FROM gis.endpoint_fix_ai_scans
            WHERE id = %s::uuid
            """,
            (scan_id,),
        )
        row = cur.fetchone()
    if not row:
        return None
    return {
        "id": str(row[0]),
        "district": row[1],
        "proposal_batch_id": str(row[2]) if row[2] else None,
        "model": row[3],
        "llm_profile": row[4],
        "status": row[5],
        "thoughts": row[6],
        "transcript": row[7] or [],
        "reviews": row[8] or [],
        "proposals_reviewed": row[9],
        "error_message": row[10],
        "created_at": row[11].isoformat() if row[11] else None,
        "completed_at": row[12].isoformat() if row[12] else None,
    }


def get_latest_endpoint_fix_ai_scan(
    conn, district: str, *, data_tier: str = "gis"
) -> dict[str, Any] | None:
    district = (district or "").strip()
    tier = normalize_data_tier(data_tier)
    if not district:
        return None
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT id FROM gis.endpoint_fix_ai_scans
            WHERE district = %s AND data_tier = %s
            ORDER BY created_at DESC
            LIMIT 1
            """,
            (district, tier),
        )
        row = cur.fetchone()
    if not row:
        return None
    return get_endpoint_fix_ai_scan(conn, str(row[0]))
