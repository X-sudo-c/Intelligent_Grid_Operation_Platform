# Map implementation checklist (FR-010 / architecture.txt)

Prioritized plan to align the GIOP portal map with functional requirements.  
**Spec refs:** `architexture functional.txt` §6.10, §6.3; `architecture.txt` Module 7; `backoffice-ui/theme.js`.

## Current baseline

| Layer | Source | Status |
|-------|--------|--------|
| Carto basemap | raster | Done |
| `ug_cable_33kv`, `ug_cable_11kv`, `oh_conductor_33kv` | Martin (`gis.*`) | Done |
| `connectivity_nodes`, `ac_line_segments` | Martin (`public.*`) | Done (zoom ≥ 12) |
| Graph chunk overlay | `GET /api/v1/graph/chunk` | Done |
| Staging points | `GET /api/v1/assets/staging` | Done |
| Cross-panel focus | `GiopSelectionContext` → `focusMrid` | Partial |

---

## Phase 1 — Network completeness & SLD symbology (P0)

**Goal:** Voltage-classified geographic network at all zoom levels; conflict/trace/staging visible.

| # | Task | Files |
|---|------|-------|
| 1.1 | SLD voltage colors on overview lines (33 kV blue, 11 kV red) | `portal/src/lib/giopSldTheme.ts`, `portal/src/lib/giopMapLayers.ts`, `GiopMapView.tsx` |
| 1.2 | Add `oh_conductor_11kv` Martin overview layer | `GiopMapView.tsx` |
| 1.3 | Add `power_transformer` point layer (Martin `gis.power_transformer`) | `GiopMapView.tsx` |
| 1.4 | Graph-chunk edges use SLD voltage colors (already via `giopChunkGeoJson`) | verify only |
| 1.5 | `IN_CONFLICT` / `PENDING_FIELD` node styling on chunk overlay | `giopChunkGeoJson.ts`, `GiopMapView.tsx`, `giopSldTheme.ts` |
| 1.6 | Remove debug instrumentation (`debugMapLog`, tile probes) | `GiopMapView.tsx` |
| 1.7 | Map legend (voltage swatches + staging/conflict keys) | `GiopMapLegend.tsx`, `GiopMapView.tsx` |

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

**Apply:** `npx supabase migration up` (or OVERSEEYER → **Apply pending**) then restart **martin**.

**Verify:** OVERSEEYER Observability → **Map tiles (00017)** card, or **Migrations** → **Verify map tiles**, or `./scripts/verify_map_tile_views.sh`.

**Acceptance:** Detail-zoom Martin tiles color lines by `nominal_voltage`; conflict nodes show red at tile level.

---

## Phase 3 — Operational overlays (P1)

**Goal:** Map shows ops context required by FR-012, FR-016, FR-010.

| # | Task | Files |
|---|------|-------|
| 3.1 | Work-order pins (`GET /api/v1/work-orders` with lat/lon) | `sync-service/ops_work_orders.py`, `giop-api.ts`, `GiopMapView.tsx` |
| 3.2 | Active outage feeder/area highlight | `sync-service/ops_outages.py`, `GiopOutagesTab.tsx`, `GiopPortal.tsx` |
| 3.3 | Energy loss-zone shading (feeder polygons from energy accounting) | `sync-service/main.py`, `GiopInsightsTab.tsx` |
| 3.4 | Toggle layer panel (network / ops / staging) | `GiopMapLayerPanel.tsx` |

**Acceptance:** Selecting an outage or work order flies map to location; affected network section highlighted.

---

## Phase 4 — Interaction & identify (P2)

**Goal:** Full cross-panel command panel per architecture.txt Module 7.

| # | Task | Files |
|---|------|-------|
| 4.1 | Click identify popup (name, voltage, validation, feeder, lifecycle) | `GiopMapIdentifyPopup.tsx`, extend `GET /api/v1/assets/master` |
| 4.2 | Table row → map flyTo (operations grid) | `GiopOperationsTab.tsx`, `GiopSelectionContext.tsx` |
| 4.3 | Map click → topology graph focus | `GiopSplitView.tsx`, `GiopTopologyTab.tsx` |
| 4.4 | Post-repair / post-promote map refresh | `GiopPortal.tsx` (`mapRefreshToken`) — verify all paths |
| 4.5 | LV segment layer (`gis.*_lvle` or promoted LV `ac_line_segments`) dashed black | migration + `GiopMapView.tsx` |
| 4.6 | HV 161 kV / GRIDCo transmission layer if present in GPKG | `gis` import + Martin |

**Acceptance:** Clicking any asset shows CIM attributes; ops table selection highlights map coordinates.

---

## Phase 5 — Mobile parity (P2)

| # | Task | Files |
|---|------|-------|
| 5.1 | Offline vector tile cache (`.pbf`) | `mobile/mobile_init.sql`, `mobile/lib/` |
| 5.2 | Work-order + asset pins on field map | `mobile/screens/map_screen.dart` |
| 5.3 | Martin URL config for device | `mobile/README.md`, env |

---

## Data / infra dependencies

| Dependency | Path | Notes |
|------------|------|-------|
| GPKG import | `scripts/import_power_system_gpkg.sh` | Populates `gis.*` tables |
| Topology wire | `scripts/promote_topology.sh` | `public.ac_line_segments` + nodes |
| Memgraph sync | `memgraph/bootstrap.py`, `sync-service/graph_sync.py` | Trace/chunk accuracy |
| Martin container | `giop-martin` on `:3001` | Auto-publishes `gis` + `public` geometry |
| Portal proxy | `portal/vite.config.ts` `/martin` | Dev tile routing |

---

## Traceability

| Requirement | Phase |
|-------------|-------|
| FR-010 map vectors from Martin / MapLibre | 1–2 |
| FR-010 conflict red treatment | 1, 2 |
| FR-010 cross-panel selection | 4 |
| FR-003 voltage enums / CIM assets | 1–2 |
| FR-016 outage geography | 3 |
| FR-012 work-order locations | 3 |
| FR-011 offline map tiles | 5 |
| architecture.txt SLD colors | 1–2 |
