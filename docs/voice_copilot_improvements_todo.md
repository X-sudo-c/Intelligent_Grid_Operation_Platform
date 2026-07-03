# Voice copilot & place understanding — implementation backlog

Track improvements so voice/chat reliably understands Ghana localities (e.g. **Accra** not “a car”, **Pokuase**) and can drive the map + feeder queries.

**Status:** Phases 1–3 implemented; Phase 4 (multi-company reference layers) deferred.

---

## Problem summary

| Layer | Symptom | Root cause today |
|-------|---------|------------------|
| **STT** | “Accra” transcribed as “a car” | `faster-whisper` `base` model, `beam_size=1`, no domain `initial_prompt` ([`sync-service/agents/voice_stt.py`](../sync-service/agents/voice_stt.py)) |
| **Place resolution** | “Pokuase”, local towns fail | Only `gis.ecg_admin_boundaries` district/region `ILIKE` ([`sync-service/agents/spatial.py`](../sync-service/agents/spatial.py)) |
| **Feeder on map** | “Show nodes on this feeder” | `trace_feeder` returns JSON only — no `ui_action` to highlight on map ([`sync-service/agents/graph_tools.py`](../sync-service/agents/graph_tools.py)) |

Pipeline should be:

```
Mic → STT (+ prompt + normalize) → resolve_place → pan_map / trace_feeder → map ui_action
```

---

## Phase 1 — Speech-to-text (fix “Accra” → “a car”)

### 1.1 Whisper initial prompt

- [ ] Add `VOICE_STT_INITIAL_PROMPT` to [`.env.example`](../.env.example)
- [ ] Pass `initial_prompt` into `model.transcribe()` in [`voice_stt.py`](../sync-service/agents/voice_stt.py)
- [ ] Default prompt: Ghana ECG GIS vocabulary (Accra, Kumasi, Tamale, Tema, Pokuase, feeder, district, region, staging, poles, transformers)
- [ ] Optional: append distinct `district` / `region` values from `gis.ecg_admin_boundaries` at startup or on first transcribe

### 1.2 Post-transcription normalization

- [ ] New module e.g. `sync-service/agents/voice_normalize.py`
- [ ] Dictionary of common mishearings → canonical terms (e.g. `a car` → `Accra`, `cool massey` → `Kumasi`)
- [ ] Fuzzy match against district/region list from DB (optional `pg_trgm` later)
- [ ] Call from [`portal_ai_transcribe`](../sync-service/main.py) and/or [`run_voice_turn`](../sync-service/agents/voice.py) before intent/chat

### 1.3 Model / accuracy tuning

- [ ] Document `VOICE_STT_MODEL=small` (or `medium` with GPU) in `.env.example`
- [ ] Consider `beam_size=5` (env `VOICE_STT_BEAM_SIZE`) vs current `beam_size=1`
- [ ] Expose effective settings in `GET /api/v1/portal/ai/voice/status`

### 1.4 Confirm transcript UX (optional, high value)

- [ ] In [`useGiopVoiceSession.ts`](../backoffice-ui/cloudhound%20frontend%20portal/src/hooks/useGiopVoiceSession.ts) or copilot panel: show “I heard: …” with **Edit** / **Send** before calling the agent
- [ ] Reduces impact of any remaining STT errors without re-recording

---

## Phase 2 — Place resolution (localities + districts)

### 2.1 `gis.place_aliases` table

- [ ] Migration: `alias`, `district`, `region`, `lat`, `lon`, `source`, `active`
- [ ] Seed common Ghana localities (Pokuase, Madina, Kasoa, …) → parent district + point
- [ ] Admin or CSV import path for stewards to extend

### 2.2 `resolve_place` tool

- [ ] New function (extend [`spatial.py`](../sync-service/agents/spatial.py) or `place_resolve.py`):
  1. Exact/fuzzy match on `gis.ecg_admin_boundaries` (district + region)
  2. Alias lookup in `gis.place_aliases`
  3. Optional: Nominatim/OSM geocode (Ghana bbox, env-gated)
  4. Point-in-polygon → containing district
  5. Return `{ confidence, matched_as, district, region, bbox, center, candidates[] }`
- [ ] Register tool in [`react.py`](../sync-service/agents/llm/react.py) tool schemas
- [ ] Update [`chat.py`](../sync-service/agents/llm/chat.py) system prompt: **always** `resolve_place` before `pan_map` / territory counts for geographic names
- [ ] If low confidence, assistant asks user to confirm district (don’t guess)

### 2.3 Fuzzy district search

- [ ] `pg_trgm` on `district`, `district_name`, `region` in `gis.ecg_admin_boundaries`
- [ ] Rank candidates for “Accra metro”, typos, partial names

### 2.4 Voice fast path

- [ ] [`voice_router.py`](../sync-service/agents/voice_router.py): run normalization + `resolve_place` before `_place_slots` / `pan_map`

---

## Phase 3 — Feeder trace on map

### 3.1 Richer `trace_feeder`

- [ ] Return node geometries or GeoJSON FeatureCollection (bounded sample + bbox)
- [ ] Support “this feeder” from portal context (`focus_mrid` / selected asset `boundary_feeder_id`)

### 3.2 Map `ui_action`

- [ ] New action type e.g. `highlight_feeder` in [`giopCopilotTypes.ts`](../backoffice-ui/cloudhound%20frontend%20portal/src/lib/giopCopilotTypes.ts)
- [ ] Handle in [`GiopPortal.tsx`](../backoffice-ui/cloudhound%20frontend%20portal/src/components/GiopPortal.tsx): overlay + `fit_bounds`
- [ ] Emit from `trace_feeder` tool execution in [`react.py`](../sync-service/agents/llm/react.py) when user asks to show/highlight feeder nodes

---

## Phase 4 — Context & multi-company (later)

- [ ] Stronger use of map context: viewport bbox, `selected_district`, `selected_region`, selected feeder
- [ ] Resolve places against company `gis.reference_layers` from import wizard (not only ECG boundaries)

---

## Key files

| Area | Path |
|------|------|
| STT | `sync-service/agents/voice_stt.py` |
| Voice turn | `sync-service/agents/voice.py`, `voice_router.py` |
| Transcribe API | `sync-service/main.py` → `portal_ai_transcribe` |
| Portal mic | `backoffice-ui/.../hooks/useGiopVoiceSession.ts` |
| Steward tools | `sync-service/agents/llm/react.py`, `chat.py` |
| Territory SQL | `sync-service/agents/spatial.py` |
| Map actions | `backoffice-ui/.../components/GiopPortal.tsx` |

---

## Quick verification checklist

- [ ] Type “show me Accra” in chat (no mic) — map moves (proves GIS path works; isolates STT)
- [ ] Voice “show me Accra district” — transcript shows Accra, not “a car”
- [ ] Voice “Pokuase” — resolves to parent district or asks to confirm
- [ ] “Show nodes on feeder X” — map highlights traced nodes

---

## Env vars to add (planned)

```bash
VOICE_STT_MODEL=small
VOICE_STT_BEAM_SIZE=5
VOICE_STT_INITIAL_PROMPT=Ghana ECG GIS: Accra, Kumasi, ...
# Optional:
PLACE_GEOCODE_ENABLED=0
NOMINATIM_URL=https://nominatim.openstreetmap.org
```
