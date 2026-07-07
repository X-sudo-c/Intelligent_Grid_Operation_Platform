# GIOP AI Implementation

This document describes how artificial intelligence is wired into the GIOP (Grid Intelligence Operations Platform) stack: which models are used, where LLM calls happen, how district-scale scans scale with workers, and how the portal polls progress.

---

## Overview

GIOP uses **two LLM profiles** served through a single OpenAI-compatible client (`sync-service/agents/llm/provider.py`):

| Profile | Purpose | Default model | Typical callers |
|---------|---------|---------------|-----------------|
| **copilot** | Map steward chat, voice copilot, ReAct tool loop | `gpt-4o-mini` (OpenAI) | Portal chat/voice, ~35 map/DQ tools |
| **cleanup** | Endpoint-fix AI scans, orchestrator briefings | `deepseek-v4-flash` (DeepSeek) | District/batch steward scans on GIS proposals |

**Not everything labeled “AI” calls an LLM.** Topology DQ batch scans, geometry tier classification, and cleanup action proposals are largely **deterministic SQL + graph rules**. The main **generative** AI workloads are:

1. **Steward copilot** (chat + voice) — interactive map/DQ assistant  
2. **Endpoint-fix AI scans** — batch review of GIS conductor endpoint proposals  
3. **Validation agent briefing** — optional cleanup-profile summary after a DQ validation cycle  

---

## Architecture (high level)

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Portal (React)                                                          │
│  GiopPortal · GisEndpointFixProposalsPanel · GiopDataQualityTab          │
└───────────────┬───────────────────────────────┬─────────────────────────┘
                │ giop-api.ts                   │
                ▼                               ▼
┌───────────────────────────┐     ┌─────────────────────────────────────┐
│  Steward AI               │     │  Endpoint-fix AI                     │
│  POST /portal/ai/chat     │     │  POST …/ai-scan/district             │
│  POST /portal/ai/voice-*  │     │  GET  …/ai-scan/runs/{id}            │
└─────────────┬─────────────┘     └──────────────┬──────────────────────┘
              │                                   │
              ▼                                   ▼
┌───────────────────────────┐     ┌─────────────────────────────────────┐
│  agents/llm/chat.py       │     │  endpoint_fix_ai_runs.py             │
│  agents/llm/react.py      │     │  endpoint_proposals_ai.py            │
│  agents/voice*.py         │     │  pgmq_worker.py (endpoint_fix_ai_jobs)│
│  profile = copilot        │     │  profile = cleanup                   │
└─────────────┬─────────────┘     └──────────────┬──────────────────────┘
              │                                   │
              └──────────────┬────────────────────┘
                             ▼
              ┌──────────────────────────┐
              │  agents/llm/provider.py   │
              │  complete_chat()          │
              │  → POST /chat/completions │
              └──────────────────────────┘
                             │
              ┌──────────────┴──────────────┐
              ▼                             ▼
        OpenAI API                   DeepSeek API
        (copilot)                    (cleanup)
```

**Supporting infrastructure:** Postgres (proposals, runs, scans), **pgmq** (durable job queue), **Redis** (run progress cache, voice sessions, general caching).

---

## 1. LLM provider layer

**Files:** `sync-service/agents/llm/provider.py`, `.env.example`

### Configuration

Copilot and cleanup each resolve API key, base URL, model, temperature, timeout, and optional DashScope workspace header. Cleanup falls back to copilot credentials when cleanup-specific vars are unset.

```bash
# Copilot (chat / voice / ReAct)
GIOP_LLM_API_KEY=              # or OPENAI_API_KEY
GIOP_LLM_BASE_URL=https://api.openai.com/v1
GIOP_LLM_MODEL=gpt-4o-mini
GIOP_LLM_TIMEOUT_SEC=60
GIOP_LLM_MAX_TOOL_TURNS=8

# Cleanup (endpoint-fix AI)
GIOP_CLEANUP_LLM_API_KEY=      # optional; falls back to copilot key
GIOP_CLEANUP_LLM_BASE_URL=https://api.deepseek.com/v1
GIOP_CLEANUP_LLM_MODEL=deepseek-v4-flash
GIOP_CLEANUP_LLM_DEEP_MODEL=deepseek-v4-pro
GIOP_CLEANUP_LLM_TIMEOUT_SEC=120
```

### `complete_chat()`

Single entry point for chat completions. Behavior:

- Builds OpenAI-compatible JSON payload (`model`, `messages`, `max_tokens`, optional `tools`)
- On missing API key → **deterministic fallback** (never hard-crashes the portal)
- On 401/402/403/5xx → fallback with error snippet
- On other 4xx (e.g. 429) → raises (callers should retry at higher layers)

Health checks: `llm_health(profile)` probes `GET /models` with a 60s cache.

---

## 2. Steward copilot (chat & voice)

### Text chat

**Route:** `POST /api/v1/portal/ai/chat`  
**Flow:** `run_steward_chat()` → fast path regex/heuristics → full `run_tool_loop()` as `StewardCopilot`  
**Profile:** `copilot`

### ReAct tool loop

**File:** `sync-service/agents/llm/react.py`

`run_tool_loop()` runs multi-turn tool calling: LLM proposes tool calls → `_execute_tool()` runs them → results fed back until the model answers or max turns exceeded.

Representative tools (not exhaustive):

- Map: `pan_map`, `resolve_place`, `highlight_asset`
- DQ / topology: `topology_dq_summary`, `topology_batch_scan`, `detect_cycles`
- GIS endpoint fix: `generate_endpoint_fix_proposals`, `ai_scan_endpoint_fix_proposals`
- Staging, KPI, CIM export, etc.

Tool steps can be audited to `public.agent_audit_log`.

### Voice

**Files:** `agents/voice.py`, `voice_router.py`, `voice_stt.py`, `voice_tts.py`, `voice_session.py`

| Route | Role |
|-------|------|
| `GET /portal/ai/voice/status` | STT/TTS/LLM readiness |
| `POST /portal/ai/voice-turn` | Text command → fast path or steward chat |
| `POST /portal/ai/voice-audio-turn` | Audio → STT → voice turn |
| `POST /portal/ai/speak` | TTS WAV (Supertonic) |
| `POST /portal/ai/realtime/session` | Ephemeral OpenAI Realtime token |

**Fast path:** `voice_router.py` matches patterns (counts, pan, trace) without LLM when possible.  
**Slow path:** Full steward chat, then text shortened for TTS.

Voice session state is stored in Redis (`VOICE_SESSION_TTL_SEC`).

---

## 3. Endpoint-fix AI (primary scale workload)

Stewards review **geometry-derived proposals** that map raw conductor line endpoints to nearest pole IDs. AI adds `ai_rationale`, `ai_agrees`, and `ai_confidence` before bulk human approval.

### 3.1 Data model

| Table | Purpose |
|-------|---------|
| `gis.conductor_endpoint_proposals` | Pending/approved/rejected rows; AI + claim columns |
| `gis.endpoint_fix_ai_scans` | Per-batch audit: thoughts, transcript, reviews JSONB |
| `gis.endpoint_fix_ai_runs` | District background run: progress counters, `swarm_workers` |
| `pgmq.q_endpoint_fix_ai_jobs` | Durable work queue (`{"run_id": "uuid"}`) |

**Proposal AI columns:** `ai_rationale`, `ai_confidence`, `ai_agrees`, `ai_scan_id`  
**Swarm claim columns:** `ai_claim_token`, `ai_claimed_at`, `ai_claim_expires_at`

Migrations: `00090`–`00094` in `supabase/migrations/`.

### 3.2 Proposal generation (non-LLM)

`gis.generate_endpoint_fix_proposals(district, …)` matches conductor segment endpoints to poles:

- **Tier A** — both ends within ~5 m  
- **Tier B** — assisted match within ~15 m  

SQL lives in `00090_conductor_endpoint_proposals.sql`; Python wrapper in `endpoint_proposals.py`.

### 3.3 Scan modes

**File:** `endpoint_proposals_ai.py` — `ai_scan_endpoint_fix_proposals()`

| Mode | Behavior |
|------|----------|
| **`tiered`** (default) | Tier A within 5 m → rule auto-review (**no LLM**); remainder → batch LLM |
| **`batch`** | One `complete_chat()` over all rows in the batch |
| **`agent`** | ReAct loop with `preview_geom_snap_candidate` tool only |

**Reasoning depth:** `quick` (default) or `deep` (heavier model + more turns). District swarm runs **coerce deep → quick** because swarm uses tiered batch only.

The LLM must return fenced JSON:

```json
{
  "thoughts": "brief summary",
  "reviews": [
    {
      "proposal_id": "uuid",
      "segment_id": 123,
      "agree": true,
      "confidence": "high",
      "rationale": "short line",
      "proposed_from": null,
      "proposed_to": null
    }
  ]
}
```

### 3.4 Single-batch API

**Route:** `POST /api/v1/gis/endpoint-fix-proposals/ai-scan`

Scans up to `limit` rows (default 10, max 100) in one request. Suitable for smoke tests and small steward actions.

### 3.5 District-scale swarm

**Route:** `POST /api/v1/gis/endpoint-fix-proposals/ai-scan/district`

For hundreds or thousands of rows per district.

```
POST /ai-scan/district
    │
    ├─ create_endpoint_fix_ai_run()
    │     • count pending rows without ai_rationale
    │     • swarm_workers = min(GIOP_AI_SWARM_MAX_INFLIGHT, ceil(rows / batch_size))
    │     • INSERT gis.endpoint_fix_ai_runs (status=running)
    │
    ├─ fan_out_endpoint_fix_ai_jobs(run_id, workers)
    │     • N messages → pgmq.endpoint_fix_ai_jobs
    │
    └─ pgmq_worker (background thread in sync-service)
          │
          ├─ read up to SWARM_MAX_INFLIGHT messages in parallel
          ├─ execute_endpoint_fix_ai_batch(run_id) per message
          │     ├─ claim_proposals_for_ai_scan()  [SKIP LOCKED]
          │     ├─ ai_scan_endpoint_fix_proposals(swarm_claim=True)
          │     ├─ UPDATE run counters
          │     ├─ cache progress in Redis
          │     └─ re-enqueue one sweeper if work remains (deduped)
          └─ sweep_stalled_endpoint_fix_ai_jobs() if queue empty but run active
```

**Fallback:** If `PGMQ_CONSUMER_ENABLED=0`, FastAPI `BackgroundTasks` runs an in-process `ThreadPoolExecutor` swarm (same batch executor, no pgmq).

### 3.6 Parallel claims

`claim_proposals_for_ai_scan()` uses `FOR UPDATE SKIP LOCKED` so workers never double-process the same row. Each worker gets a `claim_token`; claims expire after `GIOP_ENDPOINT_AI_CLAIM_TTL_SEC` (default 600s). Claims are cleared when reviews are applied or on error (`release_ai_scan_claims`).

### 3.7 Redis progress cache

**File:** `endpoint_fix_ai_run_cache.py`

Polling the UI every 4s used to hit Postgres with `count_pending_without_ai_review()` on every request. Progress is now cached:

| Redis key | Content |
|-----------|---------|
| `endpoint_fix_ai_run:{run_id}` | Full run dict incl. `progress_pct`, `remaining_unscanned` |
| `endpoint_fix_ai_run:active:{district}` | Active `run_id` while status is `running` |

TTL: `REDIS_ENDPOINT_FIX_RUN_TTL_SEC` (default 7200s).  
`get_endpoint_fix_ai_run()` reads cache first; workers refresh cache after each batch.

### 3.8 HTTP routes (endpoint-fix AI)

| Method | Path |
|--------|------|
| POST | `/api/v1/gis/endpoint-fix-proposals/ai-scan` |
| POST | `/api/v1/gis/endpoint-fix-proposals/ai-scan/district` |
| GET | `/api/v1/gis/endpoint-fix-proposals/ai-scan/runs/active?district=` |
| GET | `/api/v1/gis/endpoint-fix-proposals/ai-scan/runs/{run_id}` |
| GET | `/api/v1/gis/endpoint-fix-proposals/ai-scans/latest?district=` |
| GET | `/api/v1/gis/endpoint-fix-proposals/ai-scans/{scan_id}` |
| POST | `/api/v1/gis/endpoint-fix-proposals/review/bulk` |

### 3.9 Tuning for scale

Recommended production settings (see benchmarks in team notes):

```bash
GIOP_CLEANUP_LLM_MODEL=deepseek-v4-flash
GIOP_ENDPOINT_AI_DISTRICT_BATCH_SIZE=25      # triggers compact prompt at ≥25 rows
GIOP_AI_SWARM_MAX_INFLIGHT=32
GIOP_ENDPOINT_AI_SCAN_MAX_OUTPUT_TOKENS=8192
GIOP_ENDPOINT_AI_CLAIM_TTL_SEC=600
```

**DeepSeek concurrency** (account-level, not RPM): flash ≈ 2,500 concurrent completions; pro ≈ 500. Each swarm worker holds **one concurrent slot** for the full duration of a batch LLM call (~15–60s depending on batch size). GIOP’s worker cap (32) is far below provider limits; local sync-service and Postgres are the practical bottlenecks.

| Scale | Batch | Workers | Notes |
|-------|-------|---------|-------|
| &lt; 500 rows | 10–25 | 16–24 | Short wall-clock |
| 500–5,000 | 25 | 32 | Fewer LLM round trips |
| 5,000+ | 25–50 | 32 | Expect ~2–4 rows/sec sustained on flash |

---

## 4. Validation & topology DQ

### Validation agent cycle

**Route:** `POST /api/v1/validation/run?async=true` with `mode: "agent"`

1. **Deterministic phases** — SQL rules, topology batch, queue routing, KPI (`agents/orchestrator.py`, `validator.py`, …)  
2. **Agent briefing** — optional `run_agent_validation_cycle()` using cleanup profile + ReAct summary  

Frontend polls `GET /validation/runs/{id}/progress`.

### Topology DQ

**No generative LLM** in the topology scan pipeline itself.

- **Backend:** `topology_dq.py`, queue `topology_dq_jobs` (pgmq), Redis snapshot keys  
- **Routes:** `POST /api/v1/dq/topology/scan`, progress via `/dq/topology/runs/...`  
- **Copilot tools** can *trigger* scans and summarize results, but the scan engine is SQL/graph  

`pgmq_worker` registers **`endpoint_fix_ai_jobs` before `topology_dq_jobs`** so long topology jobs do not block steward AI batches on the same poll thread.

---

## 5. Frontend integration

**API client:** `backoffice-ui/cloudhound frontend portal/src/api/giop-api.ts`  
**Endpoint-fix UI:** `GisEndpointFixProposalsPanel.tsx`

### Polling patterns

| UI surface | Interval | Endpoint |
|------------|----------|----------|
| Active district AI run | 4s | `GET …/ai-scan/runs/active?district=` |
| Topology DQ scan | hook-based | `GET …/dq/topology/runs/...` |
| Validation run | hook-based | `GET …/validation/runs/{id}/progress` |

District run panel shows `progress_pct`, `swarm_workers`, `rows_reviewed / total_pending`, and latest scan thoughts when complete.

**Important:** Poll using the **same district** as the running scan. A 404 on `/runs/active` means no `running` row for that district (not necessarily that the system is idle).

### Agent status

`GET /api/v1/agents/status` — exposes `llm_configured`, `cleanup_llm_configured`, model names, tool count, and reachability probes. Used by the DQ tab on mount.

---

## 6. Operations

### Start stack

```bash
./scripts/start_giop_stack.sh          # sync-service :5000, Redis, Supabase, …
./scripts/patch_supabase_db_shm.sh     # after supabase start — 1GB /dev/shm for Postgres
```

Sync-service must be restarted after code or `.env` changes to pick up worker limits and Redis cache logic.

### Smoke tests

| Script | Purpose |
|--------|---------|
| `scripts/smoke_endpoint_swarm.py` | In-process parallel swarm (bypasses pgmq) |
| `sync-service/scripts/ab_endpoint_ai_scan.py` | A/B model comparison |
| `sync-service/scripts/test_cleanup_llm.py` | Cleanup profile connectivity |

### Logs

```bash
tail -f .giop/logs/sync-service.log
./scripts/tail_giop_stack_logs.sh
```

---

## 7. Key source files

| Area | Path |
|------|------|
| LLM client | `sync-service/agents/llm/provider.py` |
| ReAct + tools | `sync-service/agents/llm/react.py` |
| Steward chat | `sync-service/agents/llm/chat.py` |
| Endpoint AI logic | `sync-service/endpoint_proposals_ai.py` |
| District runs | `sync-service/endpoint_fix_ai_runs.py` |
| Redis run cache | `sync-service/endpoint_fix_ai_run_cache.py` |
| Proposals + claims | `sync-service/endpoint_proposals.py` |
| pgmq consumer | `sync-service/pgmq_worker.py` |
| HTTP routes | `sync-service/main.py` |
| Portal API | `backoffice-ui/.../src/api/giop-api.ts` |
| Env reference | `.env.example` |
| Tests | `sync-service/tests/test_endpoint_proposals_ai.py`, `test_endpoint_fix_swarm.py`, `test_endpoint_fix_ai_run_cache.py`, `test_agents.py` |

---

## 8. Design principles

1. **Two profiles, one client** — Copilot latency-sensitive; cleanup optimized for bulk JSON review on DeepSeek flash.  
2. **Approval-gated mutations** — AI never writes directly to promoted GIS; proposals stay `pending` until steward bulk review + apply.  
3. **Tiered automation** — Rule-based Tier A skips LLM; reserve model capacity for ambiguous Tier B rows.  
4. **Durable scale-out** — pgmq + SKIP LOCKED claims + configurable swarm workers for district runs.  
5. **Poll-friendly progress** — Redis cache for run state; Postgres remains source of truth.  
6. **Graceful degradation** — Missing LLM keys → deterministic fallbacks for copilot; endpoint scans return `llm_not_configured` with clear errors.

---

## Related docs

- [Latency phases (voice & map)](latency_phases.md)  
- [Data scale architecture](data_scale_architecture.md)  
- [Agent module README](../sync-service/agents/README.md)
