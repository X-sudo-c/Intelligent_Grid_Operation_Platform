"""Data-tier routing for GIS import vs staging CIM endpoint fix proposals."""

from __future__ import annotations

from typing import Any, Literal

DataTier = Literal["gis", "staging"]

_TIER_CONFIG: dict[DataTier, dict[str, Any]] = {
    "gis": {
        "proposals_table": "gis.conductor_endpoint_proposals",
        "segment_col": "segment_id",
        "generate_fn": "gis.generate_endpoint_fix_proposals",
        "apply_fn": "gis.apply_endpoint_fix_proposals",
        "order_col": "segment_id",
        "columns": [
            "id",
            "segment_id",
            "district",
            "source_layer",
            "source_fid",
            "import_reason",
            "current_from",
            "current_to",
            "proposed_from",
            "proposed_to",
            "start_dist_m",
            "end_dist_m",
            "start_nearest_pole",
            "end_nearest_pole",
            "proposed_from_kind",
            "proposed_to_kind",
            "start_nearest_kind",
            "end_nearest_kind",
            "tier",
            "rationale",
            "status",
            "batch_id",
            "created_at",
            "reviewed_at",
            "reviewed_by",
            "applied_at",
            "ai_rationale",
            "ai_confidence",
            "ai_agrees",
            "ai_scan_id",
            "ai_claim_token",
            "ai_claimed_at",
            "ai_claim_expires_at",
        ],
    },
    "staging": {
        "proposals_table": "staging.line_endpoint_proposals",
        "segment_col": "segment_mrid",
        "generate_fn": "staging.generate_line_endpoint_fix_proposals",
        "apply_fn": "staging.apply_line_endpoint_fix_proposals",
        "order_col": "segment_mrid",
        "columns": [
            "id",
            "segment_mrid",
            "district",
            "current_source",
            "current_target",
            "proposed_source",
            "proposed_target",
            "start_dist_m",
            "end_dist_m",
            "start_nearest",
            "end_nearest",
            "tier",
            "rationale",
            "status",
            "batch_id",
            "created_at",
            "reviewed_at",
            "reviewed_by",
            "applied_at",
            "ai_rationale",
            "ai_confidence",
            "ai_agrees",
            "ai_scan_id",
            "ai_claim_token",
            "ai_claimed_at",
            "ai_claim_expires_at",
        ],
    },
}


def normalize_data_tier(value: str | None) -> DataTier:
    tier = (value or "gis").strip().lower()
    if tier not in ("gis", "staging"):
        raise ValueError("data_tier must be gis or staging")
    return tier  # type: ignore[return-value]


def tier_config(data_tier: DataTier | str | None = "gis") -> dict[str, Any]:
    return _TIER_CONFIG[normalize_data_tier(data_tier if isinstance(data_tier, str) else data_tier)]
