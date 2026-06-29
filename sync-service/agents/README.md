# GIOP Multi-Agent Validation Engine

Python package inside `sync-service` implementing governed multi-agent GIS validation and cleanup.

## Agents

| Agent | Module | Role |
|-------|--------|------|
| Orchestrator | `orchestrator.py` | Runs validation cycles, KPI snapshot |
| Validator | `validator.py` | Per-asset rule checks |
| Graph | `graph_agent.py` | Topology batch scan + NetworkX analysis |
| Queue Manager | `queue_manager.py` | Routes exceptions to virtual queues |
| Cleanup | `cleanup_agent.py` | Proposes/executes remediation |
| Proposal | `proposal_agent.py` | Dry-run topology edits → review → publish to master |
| Approval | `approval_agent.py` | Steward approve/reject (no auto-execute by default) |
| Steward LLM | `llm/chat.py` | ReAct tool-calling steward assistant |
| Tool loop | `llm/react.py` | OpenAI-compatible multi-turn tool execution |

## Policy

All mutating operations pass through `policy.py`. LLM agents recommend actions; PolicyEngine enforces autonomy levels and approval gates.

## ReAct tool loop

Steward chat and agent validation cycles use `run_tool_loop()` which calls DQ/topology tools (`list_exceptions`, `detect_cycles`, `propose_cleanup`, etc.) until the model returns a final answer. Configure `GIOP_LLM_MAX_TOOL_TURNS` (default 8).

## API (sync-service)

- `POST /api/v1/validation/run?async=true` — start cycle (returns immediately; default async)
- `GET /api/v1/validation/runs/{id}/progress` — live phase + audit steps
- `GET /api/v1/agents/status` — engine online + LLM configured
- `GET /api/v1/validation/runs`, `GET /api/v1/validation/runs/{id}`
- `GET /api/v1/kpis/latest`, `GET /api/v1/kpis/run/{id}`
- `POST /api/v1/portal/ai/chat` — steward copilot (staging review, territory stats, UI navigation)
- `POST /api/v1/portal/ai/voice-turn` — voice session with fast path (counts, highlight, pan)
- `POST /api/v1/portal/ai/transcribe` — local Whisper STT (`requirements-voice.txt`)
- `POST /api/v1/portal/ai/speak` — Supertonic WAV TTS (`./scripts/start-supertonic.sh`)
- `GET /api/v1/portal/ai/voice/status` — STT/TTS availability
- `GET /api/v1/spatial/territory?district=` — ECG district/region bbox
- `GET /api/v1/spatial/inventory?tier=master&asset_kind=pole&district=` — asset counts
- `GET /api/v1/approvals/pending`
- `POST /api/v1/approvals/{id}/approve|reject` — approve does **not** write master by default (`execute: false`)
- `POST /api/v1/proposals/generate/{exception_id}` — dry-run + queue proposal
- `GET /api/v1/proposals/approved` — approved, awaiting publish
- `POST /api/v1/proposals/{id}/publish` — apply repair to master
- `POST /api/v1/cleanup/generate/{exception_id}` — alias for proposal generate
- `POST /api/v1/cleanup/execute/{cleanup_id}` — direct execute (legacy / admin)
- `GET /api/v1/exceptions/queue/{queue_name}`

## Environment

```bash
GIOP_LLM_API_KEY=          # or OPENAI_API_KEY
GIOP_LLM_BASE_URL=https://api.openai.com/v1
GIOP_LLM_MODEL=gpt-4o-mini
SUPABASE_DB_URI=postgresql://...
```

Without LLM keys, the assistant uses deterministic fallback text.

## Qwen (DashScope)

```bash
GIOP_LLM_API_KEY=sk-ws-...          # or sk-... from Model Studio
GIOP_LLM_BASE_URL=https://dashscope-intl.aliyuncs.com/compatible-mode/v1
GIOP_LLM_MODEL=qwen-plus
GIOP_LLM_WORKSPACE_ID=              # required for some sk-ws keys (X-DashScope-Workspace)
GIOP_LLM_MAX_TOOL_TURNS=5
```

Smoke test:

```bash
cd sync-service && python scripts/test_qwen_llm.py
```

If you get `AccessDenied.Unpurchased`, activate the model in [Model Studio](https://modelstudio.console.alibabacloud.com/) for your workspace (Singapore/intl region keys use the `-intl` base URL).

## Scheduler

Nightly full cycle (wire to system cron):

```bash
cd sync-service && python -m agents.scheduler
```

Example crontab (02:00 UTC daily):

```cron
0 2 * * * cd /path/to/ECG/sync-service && python -m agents.scheduler >> /var/log/giop-agent.log 2>&1
```

Postgres pg_cron (migration `00043`) purges agent audit logs and validation results older than 90 days.

## Tests

```bash
cd sync-service && python -m pytest tests/test_agents.py -v
```

## Eval harness

```bash
cd sync-service && python -m agents.eval_harness
```

## Extraction (Phase 5)

This package can be extracted to a standalone FastAPI service. Keep `agents/` imports stable and move `main.py` routes to a thin gateway.
