# Voice & map latency — phased rollout

Track what is implemented and how to verify each phase.

## Phase 1 — Backend place cache (Redis)

**Goal:** Repeat “zoom to Tema” / place resolution skips Nominatim (8s) and heavy DB fuzzy work.

| Component | Change |
|-----------|--------|
| `geocode.py` | Redis cache on `geocode_map_places()` |
| `place_resolve.py` | Redis cache on `resolve_place()` + `h3_primary` cell |
| `redis_cache.py` | `geocode_places_key`, `place_resolve_key` |

**Env:**

```bash
REDIS_URL=redis://127.0.0.1:6379/0
PLACE_GEOCODE_CACHE_TTL_SEC=86400
PLACE_RESOLVE_CACHE_TTL_SEC=3600
```

**Verify:** Say “zoom to Tema” twice — second request should include `"cached": true` in fast-path `data` (debug) and `voice-turn` should be &lt;200ms.

---

## Phase 2 — Fast-only voice turn (skip LLM on map commands)

**Goal:** Realtime `run_giop_command` tries deterministic regex fast path first; only falls back to steward LLM when needed.

| Component | Change |
|-----------|--------|
| `voice.py` | `fast_only` parameter on `run_voice_turn` |
| `main.py` | `PortalVoiceTurnPayload.fast_only` |
| `useGiopRealtimeSession.ts` | Two-step: `fastOnly: true` then full turn |

**Verify:** Network tab shows two `voice-turn` calls only when the command needs LLM. Map pan/zoom shows one fast call with `"fast_path": true`.

---

## Phase 3 — Realtime token pre-mint

**Goal:** Remove token mint delay when user first clicks Live voice.

| Component | Change |
|-----------|--------|
| `giopRealtimeTokenCache.ts` | Prefetch + reuse ephemeral secret |
| `GiopPortal.tsx` | Prefetch on mount when `VITE_GIOP_REALTIME=1` |

**Verify:** Click Live voice — debug event `session_token_minted` should show `prefetched: true` if portal loaded earlier.

---

## Phase 4 — H3 on resolved places

**Goal:** Stable spatial cache keys and future hex-bucket counts without replacing lat/lon navigation.

Resolved places now include `h3_primary` and `h3_resolution` when the `h3` library is installed.

---

## Phase 5 — Instant client-side relative zoom

**Goal:** "Zoom in" / "zoom out" never wait on `/voice-turn` or the LLM.

| Component | Change |
|-----------|--------|
| `giopRelativeZoom.ts` | Parse relative zoom + build `fly_to` from live viewport |
| `useGiopRealtimeSession.ts` | Apply on `history_updated` + skip API in tool |
| `EnhancedCopilotPanel.tsx` | Typed commands skip API |
| Map fly duration | 280ms for relative zoom (vs 900ms default) |

**Verify:** Say "zoom in" on Live voice — map should move before the assistant speaks. Network tab shows **no** `voice-turn` for pure zoom in/out.

---

## Still recommended (not yet implemented)

- Client-side direct `/voice-turn` for typed chat (bypass Realtime entirely for map-only UI)
- Optimistic map fly before speech completes (partially true — ui_actions fire on tool return)
- Expand `gis.place_aliases` seed list to minimize geocode
- `GIOP_LLM_MAX_TOOL_TURNS=4` for slow-path cap

## Quick checklist

- [ ] Redis running (`redis-cli ping`)
- [ ] Migration 00064 (Tema alias) applied
- [ ] `VITE_GIOP_REALTIME=1` for live voice
- [ ] Chrome for Realtime; Firefox uses hands-free STT path
- [ ] sync-service restarted after deploy
