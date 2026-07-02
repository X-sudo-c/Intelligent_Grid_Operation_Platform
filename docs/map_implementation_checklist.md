# Map implementation checklist (FR-010 / architecture.txt)

Prioritized plan to align the GIOP portal map with functional requirements.  
**Spec refs:** `architexture functional.txt` §6.10, §6.3; `architecture.txt` Module 7; `backoffice-ui/theme.js`.

**Last updated:** 2026-06-29

---

## Progress summary

| Phase | Focus | Status | ~Complete |
|-------|--------|--------|-----------|
| **0** | Data + GIS reference boundaries | Verify GPKG; boundaries done | 85% |
| **1** | Network completeness & SLD symbology | Code done — smoke-test with GPKG | 90% |
| **2** | Martin tile enrichment | Done | 100% |
| **3** | Operational overlays | WO + outage partial; loss zones pending | 55% |
| **4** | Interaction & identify | Identify partial; cross-panel gaps | 40% |
| **5** | Mobile parity | Tile prefetch started | 25% |
| | **Overall map / visualization (FR-010 slice)** | | **~55–60%** |

**Recommended next:** re-import `Power System.gpkg` → verify Phase 1 → loss-zone shading + layer panel → ops table flyTo.

---

## Current baseline

| Layer | Source | Status |
|-------|--------|--------|
| Carto basemap | raster | Done |
| `ug_cable_33kv`, `ug_cable_11kv`, `oh_conductor_33kv`, `oh_conductor_11kv` | Martin (`gis.*`) | Done (requires GPKG import + active network catalog) |
| `power_transformer` | Martin (`gis.*`) | Done |
| `connectivity_nodes`, `ac_line_segments` | Martin (`public.*`) | Done (zoom ≥ 12) |
| Graph chunk overlay | `GET /api/v1/graph/chunk` | Done |
| Staging points | `GET /api/v1/assets/staging` | Done |
| GIS reference boundaries (catalog-driven) | `gis.reference_layers` + Martin / GeoJSON | Done |
| Work-order pins | `GET /api/v1/work-orders` → `GiopMapView` | Done |
| Outage downstream impact | topology impact GeoJSON overlay | Done |
| Side-map “Show on map” | DQ, cases, tickets, WOs, outages | Done |
| Cross-panel focus | `GiopSelectionContext` → `focusMrid` | Partial (selection sync; ops table does not fly main map) |
| Click identify popup | `giopMapIdentify.ts` | Partial (points/chunk/WO; not full CIM card or line layers) |

---

## Phase 0 — Data & GIS reference layers (P0)

**Goal:** Map has real network geometry; boundary overlays are catalog-driven (multi-company).

| # | Task | Files | Status |
|---|------|-------|--------|
| 0.1 | Import `Power System.gpkg` into `gis.*` | `scripts/import_power_system_gpkg.sh` | **Blocked** until run locally |
| 0.2 | Promote topology to `public.*` | `scripts/promote_topology.sh` | Verify after GPKG import |
| 0.3 | Re-activate network catalog rows after import | `gis.reference_layers`, migration `00056` | Pending (00056 sets `kind='network'` inactive until data exists) |
| 0.4 | GIS import wizard (GPKG / GeoJSON / KML) | `GiopGisImportWizard.tsx`, `reference_import.py` | Done |
| 0.5 | Catalog-driven boundary detail + overview on map | `giopReferenceBoundaryOverlays.ts`, `GiopMapView.tsx` | Done |
| 0.6 | Boundary identify + per-product toggles | `giopBoundaries.ts`, `GiopMapView.tsx` | Done |
| 0.7 | Overview dissolve / hole cleanup | migrations `00054`, `00055` | Done |

**Acceptance:** Boundaries render at low zoom without seam artifacts; network overview lines appear after GPKG import; no 500s from missing `gis.*` Martin sources.

---

## Phase 1 — Network completeness & SLD symbology (P0)

**Goal:** Voltage-classified geographic network at all zoom levels; conflict/trace/staging visible.

| # | Task | Files | Status |
|---|------|-------|--------|
| 1.1 | SLD voltage colors on overview lines (33 kV blue, 11 kV red) | `giopSldTheme.ts`, `giopMapLayers.ts`, `GiopMapView.tsx` | Done |
| 1.2 | Add `oh_conductor_11kv` Martin overview layer | `giopMapLayers.ts`, `GiopMapView.tsx` | Done |
| 1.3 | Add `power_transformer` point layer | `giopMapLayers.ts`, `GiopMapView.tsx` | Done |
| 1.4 | Graph-chunk edges use SLD voltage colors | `giopChunkGeoJson.ts` | Done — verify only |
| 1.5 | `IN_CONFLICT` / `PENDING_FIELD` node styling on chunk overlay | `giopChunkGeoJson.ts`, `GiopMapView.tsx`, `giopSldTheme.ts` | Done |
| 1.6 | Remove debug instrumentation (`debugMapLog`, tile probes) | `GiopMapView.tsx` | Done |
| 1.7 | Map legend (voltage swatches + staging/conflict keys) | `GiopMapLegend.tsx`, `GiopMapView.tsx` | Done |
| 1.8 | End-to-end smoke test with loaded GPKG | manual / OVERSEEYER map-tiles card | **Todo** |

**Acceptance:** Whole-Ghana view shows OH/UG backbone by voltage color; zoom 12+ shows CIM nodes/lines; conflicts render red; no debug HTTP to localhost.

---

## Phase 2 — Martin tile enrichment (P1) — **done**

**Goal:** Martin vector tiles carry attributes needed for map styling without relying only on GeoJSON chunk.

| # | Task | Files | Status |
|---|------|-------|--------|
| 2.1 | PostGIS view `public.map_ac_line_segments` | `supabase/migrations/00017_map_tile_views.sql` | Done |
| 2.2 | PostGIS view `public.map_connectivity_nodes` | same | Done |
| 2.3 | Martin auto-publishes `public` geometry views | no docker change required | Done |
| 2.4 | MapLibre paint from `nominal_voltage` / `validation` | `giopMapLayers.ts` | Done |
| 2.5 | `refreshToken` bust cache for all Martin sources | `GiopMapView.tsx` | Done |

**Apply:** `.tools/supabase/supabase db push --local` (or OVERSEEYER → **Apply pending**) then restart **martin**.

**Verify:** OVERSEEYER Observability → **Map tiles (00017)** card, or **Migrations** → **Verify map tiles**, or `./scripts/verify_map_tile_views.sh`.

**Acceptance:** Detail-zoom Martin tiles color lines by `nominal_voltage`; conflict nodes show red at tile level.

---

## Phase 3 — Operational overlays (P1)

**Goal:** Map shows ops context required by FR-012, FR-016, FR-010.

| # | Task | Files | Status |
|---|------|-------|--------|
| 3.1 | Work-order pins (`GET /api/v1/work-orders` with lat/lon) | `sync-service/ops_work_orders.py`, `giop-api.ts`, `GiopMapView.tsx` | Done |
| 3.2 | Active outage feeder/area highlight | `GiopOutagesTab.tsx`, `GiopPortal.tsx`, impact overlay in `GiopMapView.tsx` | Partial (overlay works; main-map fly workflow could be smoother) |
| 3.3 | Energy loss-zone shading (feeder polygons from energy accounting) | `sync-service/main.py`, `GiopInsightsTab.tsx`, `GiopMapView.tsx` | **Todo** (Insights tab shows variance text only) |
| 3.4 | Unified toggle layer panel (network / ops / staging / boundaries) | `GiopMapView.tsx` (inline toggles today) | Partial (WO + boundary toggles exist; no grouped `GiopMapLayerPanel`) |
| 3.5 | Show on map from steward tabs | `GiopMapOverlayContext.tsx`, `GiopSideMapPanel.tsx`, DQ/cases/tickets/WO tabs | Done |

**Acceptance:** Selecting an outage or work order flies map to location; affected network section highlighted; anomalous feeders shaded on map.

---

## Phase 4 — Interaction & identify (P2)

**Goal:** Full cross-panel command panel per architecture.txt Module 7.

| # | Task | Files | Status |
|---|------|-------|--------|
| 4.1 | Click identify popup (name, voltage, validation, feeder, lifecycle) | `giopMapIdentify.ts`, `GET /api/v1/assets/{mrid}` | Partial (points/chunk/staging/WO; enrich via `getAssetLocation`; missing lifecycle, line-layer identify) |
| 4.2 | Table row → map flyTo (operations grid) | `GiopOperationsTab.tsx`, `GiopMapOverlayContext.tsx` | **Todo** (row click sets selection but does not call `focusOnMap`) |
| 4.3 | Map click → topology graph focus | `GiopSplitView.tsx`, `GiopTopologyTab.tsx`, `GiopPortal.tsx` | Partial (`focusMrid` in URL/graph; not seamless combined-desk sync) |
| 4.4 | Post-repair / post-promote map refresh | `GiopPortal.tsx` (`mapRefreshToken`) | Partial — audit all paths (bulk approve, repair, reference import) |
| 4.5 | LV segment layer (`gis.*_lvle` or promoted LV `ac_line_segments`) dashed black | migration + `giopMapLayers.ts` | **Todo** (GPKG tables exist; not on map) |
| 4.6 | HV 161 kV / GRIDCo transmission overview layer | `gis` import + `giopMapLayers.ts` | **Todo** (SLD colors for `HV_161KV` on detail tiles only; no overview Martin layer) |
| 4.7 | Unified steward split-screen (map + table + graph) | `GiopPortal.tsx`, `GiopWorkspaceLayout.tsx` | **Todo** (separate nav tabs vs FRS single desk) |

**Acceptance:** Clicking any asset shows CIM attributes; ops table selection flies map to coordinates; map and topology stay in sync.

---

## Phase 5 — Mobile parity (P2)

| # | Task | Files | Status |
|---|------|-------|--------|
| 5.1 | Offline vector tile cache (`.pbf`) | `mobile/lib/services/tile_cache_service.dart` | Partial (prefetch/viewport cache; not full offline parity) |
| 5.2 | Work-order + asset pins on field map | `mobile/screens/map_screen.dart` | Partial (staging/capture; fewer ops pins than portal) |
| 5.3 | Martin URL config for device | `mobile/README.md`, env | Done (configurable; document + align with catalog layers) |
| 5.4 | Boundary / reference overlays on mobile | `mobile/map/giop_martin_theme.dart` | **Todo** |

**Acceptance:** Field user sees same network + boundary context offline after prefetch.

---

## Related backlog (not in original checklist)

| Item | Doc / path | Status |
|------|------------|--------|
| Voice → map (`trace_feeder` highlight) | `docs/voice_copilot_improvements_todo.md` Phase 3 | Todo |
| PGMQ durable import jobs | `sync-service/reference_import.py` | Todo (BackgroundTasks only) |
| Copilot place resolution for imported boundaries | `sync-service/agents/spatial.py` | Todo |

---

## Data / infra dependencies

| Dependency | Path | Notes |
|------------|------|-------|
| GPKG import | `scripts/import_power_system_gpkg.sh` | Populates `gis.*` tables — **required** for network overview |
| Network catalog | migration `00056` | Deactivates empty network layers until GPKG import |
| Topology wire | `scripts/promote_topology.sh` | `public.ac_line_segments` + nodes |
| Memgraph sync | `memgraph/bootstrap.py`, `sync-service/graph_sync.py` | Trace/chunk/schematic accuracy |
| Martin container | `giop-martin` on `:3001` | Auto-publishes `gis` + `public` geometry |
| Portal proxy | `portal/vite.config.ts` `/martin` | Dev tile routing |
| Reference import | `scripts/ensure_supabase_cli.sh`, GIS wizard | Boundaries via `/references` tab |

---

## Traceability

| Requirement | Phase |
|-------------|-------|
| FR-010 map vectors from Martin / MapLibre | 0–2 |
| FR-010 conflict red treatment | 1, 2 |
| FR-010 cross-panel selection | 4 |
| FR-003 voltage enums / CIM assets | 1–2, 4.5–4.6 |
| FR-016 outage geography | 3 |
| FR-012 work-order locations | 3 |
| FR-011 offline map tiles | 5 |
| FR-002 reference GIS layers (boundaries) | 0 |
| architecture.txt SLD colors | 1–2 |

---

## Suggested implementation order

1. Run GPKG import + topology promote + Memgraph bootstrap → verify Phase 1.8.
2. Phase 3.3 loss-zone map shading + 3.4 unified layer panel.
3. Phase 4.2 ops table flyTo + 4.1 richer identify (include line layers).
4. Phase 4.5 LV + 4.6 161 kV overview layers.
5. Phase 4.7 steward desk unification (optional product refactor).
6. Phase 5 mobile overlay parity.
