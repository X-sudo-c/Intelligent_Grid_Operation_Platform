# Data scale architecture — GIOP

Guidance for when to use columnar stores, MPP, pre-computed aggregations, and probabilistic structures versus the current Postgres + Martin + Redis stack.

**Related:** `docs/map_implementation_checklist.md`, `docs/latency_phases.md`, `config/martin.yaml`

**Last updated:** 2026-07-04

---

## Current scale (Ghana master network)

| Store | Approx. volume | Primary workload |
|-------|----------------|------------------|
| `ac_line_segments` / `map_ac_line_segments` | ~1.08M lines | Map tiles (Martin), promote, DQ |
| `connectivity_nodes` / `map_connectivity_nodes` | ~924k points | Map tiles, graph chunk (split view) |
| `gis.conductor_segments` | ~1M+ (import staging) | Import, snap, promote |
| LV overhead (national) | ~793k segments | Detail tiles from z13+ |

This is **large for a national GIS portal** but **not** “billions of rows” warehouse scale. Hot-path problems here are **tile serving, layer budgeting, and duplicate data paths** — not lack of a columnar database.

---

## What we use today (and why it fits)

| Component | Role | Scale pattern |
|-----------|------|----------------|
| **Postgres + PostGIS** | System of record (CIM), spatial queries, tile views | OLTP + indexed bbox queries |
| **Martin** | Vector tile generation | Pre-computed geometry **per tile/zoom** |
| **Redis** | Graph chunk cache, reference layers, geocode/place resolve | Response cache (15–30 min TTL) |
| **Memgraph** | Topology trace, graph analytics | Subgraph / path queries |
| **H3** | Coverage hexes, territory bucketing | Spatial **pre-aggregation** |
| **TimescaleDB** (`giop-timescale`) | Energy / interval time-series | Columnar-friendly **when used for telemetry** |
| **Materialized views** | e.g. `gis.conductor_import_status` | Pre-computed steward queue counts |

---

## Pattern guide

### Columnar databases (ClickHouse, BigQuery, DuckDB-at-scale)

| | |
|---|---|
| **Use for GIOP when** | Billions of **meter interval reads**, multi-year **billing cubes**, append-only **audit/event** analytics where queries are mostly `SUM/COUNT/GROUP BY` |
| **Do not use for** | Map geometry, CIM promote, topology truth, outage impact — needs exact rows + updates |
| **Recommendation now** | **No** as primary store. Keep PostGIS for network assets. |
| **Future path** | ETL/stream **facts** to columnar for dashboards; Postgres remains operational OLTP |

### Massively parallel processing (Spark, Presto, etc.)

| | |
|---|---|
| **Use for GIOP when** | Nightly **national DQ scans** over full history + external feeds; ML feature gen over huge asset + event history |
| **Do not use for** | Interactive map pan/zoom, single-feeder trace, portal CRUD |
| **Recommendation now** | **No** dedicated MPP cluster. Postgres parallel query + background jobs suffice through tens/hundreds of millions of rows. |

### Pre-computed aggregations

| | |
|---|---|
| **Use for GIOP when** | Country/mid zoom map, KPI dashboards, import pipeline stats, H3 coverage rollups, copilot place index |
| **Recommendation now** | **Yes — selectively.** Best ROI at current scale. |
| **Already in place** | GIS overview Martin layers, H3 coverage, Redis caches, import status MV, KPI snapshots |
| **Caution** | Do **not** bulk-filter master lines for “performance” (see rollback notes below). Pre-compute **summaries for overview**; keep detail in master for z11+. |

### Probabilistic data structures (HyperLogLog, Bloom filters, Count-Min Sketch)

| | |
|---|---|
| **Use for GIOP when** | Approximate dashboard badges (“~1.2M assets in Ashanti”), ingest dedup (“seen this MRID in batch?”), high-cardinality event streams |
| **Do not use for** | Map rendering, promote-to-CIM, topology, outage impact |
| **Recommendation now** | **Only for specific UX/analytics**, not core network truth. Prefer **H3** (deterministic) for spatial rollups. |

---

## Workload matrix

| Workload | Primary store | Pre-aggregation | Columnar / MPP | Notes |
|----------|---------------|-----------------|----------------|-------|
| **Map pan/zoom (Martin)** | PostGIS views → Martin | Tile pyramids, zoom bands, GIS overview | No | Biggest win: node/layer budgeting, Redis, no duplicate chunk API on Map tab |
| **Map identify / asset CRUD** | Postgres | — | No | Exact OLTP |
| **Split / viewport subgraph** | Postgres + Redis chunk cache | Simplified edges in chunk SQL | No | `streamGraphChunk={false}` on main Map tab |
| **DQ scans (topology rules)** | Postgres | Snapshot summaries | MPP only if national batch >> 100M rows/run | Batch jobs, not interactive |
| **Import pipeline / steward queue** | Postgres + import status MV | MV + Redis summary cache | No | |
| **Copilot place search / geocode** | Postgres + Redis | Place index, geocode cache | No | See `latency_phases.md` |
| **Energy accounting / intervals** | TimescaleDB | Continuous aggregates, rollups | Columnar if intervals → billions | Already have Timescale in stack |
| **Audit / lineage ledger** | Postgres (append-heavy) | Monthly partitions, rollup tables | Columnar if query volume explodes | |
| **National billing analytics** | — | Regional/monthly cubes | **Yes, when AMI scale demands** | Sidecar warehouse |

---

## Scale ladder

| Phase | Data volume | Architecture |
|-------|-------------|--------------|
| **1 — Now** | ~1–10M assets, single country | Postgres/PostGIS + Martin + Redis + Memgraph + H3 rollups |
| **2 — Growth** | 10–100M rows, richer AMI, multi-region | Partition Postgres by region/time; Timescale/columnar for **intervals only**; keep GIS in PostGIS |
| **3 — Analytics** | Billions of meter reads / events | Columnar warehouse + stream ingest; Postgres OLTP; MPP for batch DQ/ML |
| **4 — Global GIS edit firehose** | Billions of geometry edits | Specialized streaming GIS + tile pipeline (different product profile) |

**Decision gate for columnar:** A concrete workload fails SLO on Postgres **after** indexes, partitioning, caching, and pre-aggregates — e.g. “dashboard over 5 years of 15-min reads for 2M meters” or “audit log analytics at 50M+ rows/month.”

---

## Near-term actions (current scale — no warehouse required)

Prioritized for map load and portal responsiveness:

1. **Node tile budgeting** — raise `map_connectivity_nodes` min zoom or filter pole/conflict-only until z13+ (~924k nodes at z11.5 is heavy).
2. **Martin tile weight** — per-table simplify/clip in `config/martin.yaml`; low-zoom simplified backbone table for z6–10.
3. **Postgres ops** — spatial indexes, `ANALYZE` after promote (`00071`), fix Docker `/dev/shm` for tile queries.
4. **Map ready semantics** — mark interactive on `load`, not full `idle` (faster first paint).
5. **Cache reference map-config** — `/reference-layers/map-config` hits DB every map mount today.
6. **Keep Map tab lean** — `streamGraphChunk={false}`, `prefetchNeighbors: false` (Martin is the path).
7. **Outlier-only span filter** — keep `00072` style limits ( ~20 bad chords), not bulk 500k-line filters.

---

## Rollbacks — perf tricks that hurt correctness

These were tried to make tiles lighter; they were removed or narrowed because they broke the connected network or visibility.

| Change | Migration / location | Why removed |
|--------|---------------------|-------------|
| Bulk span filter on `map_ac_line_segments` | `00068` → removed `00069` | Hid ~500k+ segments; map looked disconnected |
| Martin experimental `clip_geom` / buffer | `config/martin.yaml` | Rendering artifacts |
| Graph chunk on Map tab + neighbor prefetch | `GiopPortal.tsx`, `useGiopGraphChunk.ts` | Duplicate load vs Martin; 5× chunk requests per pan |
| LV backbone split + `length_m` style filter | `giopMapLayers.ts` | LV lines disappeared |
| GIS network catalog inactive | `00056` | Empty country overview (accidental) |

**Template for safe perf:** pre-compute **overview** layers and **outlier** exclusion; never bulk-drop valid master geometry from Martin views.

---

## Implementation phases (recommended)

### Phase A — Map serving (P0, current sprint)

- [x] Node min-zoom / filtered pole view (`DETAIL_NODE_MIN_ZOOM=13.5`)
- [x] Reference map-config Redis cache
- [x] `mapReady` on `load` not `idle`
- [x] Defer GIS overview; default camera z11
- [x] Map tile materialized views + promote refresh (`00100_map_tile_mvs.sql`)
- [x] Martin in-process tile cache + larger pool (`config/martin.yaml`)
- [x] Age-aware `refresh_map_tile_layers` (`00106_map_tile_refresh_perf.sql`)
- [x] Optional nginx tile cache (`scripts/ensure_martin_cache.sh`, `:3002`)
- [ ] Postgres `shm_size` + runbook discipline for large promotes

### Phase B — Pre-aggregation expansion (P1)

- [ ] National low-zoom backbone simplified table (z6–10 only)
- [ ] DQ summary rollups by region/district (refresh on promote)
- [ ] H3 coverage stats served from rollup table, not ad-hoc scan

### Phase C — Timescale / intervals (P1 when AMI grows)

- [ ] Continuous aggregates on meter intervals (hourly/daily)
- [ ] Portal insights read from rollups, not raw scan

### Phase D — Columnar sidecar (P2 — gate on workload)

- [ ] Define trigger: e.g. >1B interval rows or audit analytics SLO miss
- [ ] ETL: Postgres/Timescale → ClickHouse/BigQuery for billing/audit dashboards only
- [ ] Do **not** move `ac_line_segments` or tile pipeline

### Phase E — Probabilistic / approximate (P3 — optional)

- [ ] HyperLogLog for “approx assets in view” badges
- [ ] Bloom filter on import batch dedup

---

## Quick reference — files

| Concern | Location |
|---------|----------|
| Map layers / zoom bands | `backoffice-ui/cloudhound frontend portal/src/lib/giopMapLayers.ts` |
| Chunk cache / prefetch | `backoffice-ui/cloudhound frontend portal/src/hooks/useGiopGraphChunk.ts` |
| Map tab chunk off | `backoffice-ui/cloudhound frontend portal/src/components/GiopPortal.tsx` |
| Redis TTLs | `sync-service/redis_cache.py` |
| Martin config | `config/martin.yaml` |
| Span / outlier filter | `supabase/migrations/00072_map_span_guard_and_outlier_cleanup.sql` |
| H3 / coverage | `sync-service/main.py` (`/h3/*`), portal `getH3Coverage` |
| Voice / place cache | `docs/latency_phases.md` |
