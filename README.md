# GIOP Platform

## Quick start

**One command** — check health and start anything offline:

```bash
chmod +x scripts/start_giop_stack.sh
./scripts/start_giop_stack.sh              # start missing services
./scripts/start_giop_stack.sh --check-only # status only
./scripts/start_giop_stack.sh --backoffice --portal  # legacy :8080 + React portal :5173
./scripts/start_giop_stack.sh --bootstrap  # reconcile Memgraph after containers are up
```

Logs and PIDs: `.giop/logs/`, `.giop/pids/`

Or start components manually:

1. **Supabase** (Postgres + REST + Realtime):
   ```bash
   npx supabase start
   npx supabase db reset   # applies migrations 00001–00017
   ```

2. **Supporting services** (start containers individually):
   ```bash
   docker start my-memgraph giop-martin giop-timescale giop-redis
   .venv/bin/python memgraph/bootstrap.py   # reconcile Memgraph from Postgres (removes orphans)
   ```

   Redis is optional but recommended for sync-service caching (`REDIS_URL` in `.env`). If Redis is down, the sync gateway continues without cache.

   After `npx supabase db reset`, always re-run bootstrap so topology matches Postgres.

3. **Python services**:
   ```bash
   cd sync-service && uvicorn main:app --host 0.0.0.0 --port 5000 --reload
   cd ocr-service && uvicorn main:app --host 0.0.0.0 --port 5002 --reload
   ```

4. **Backoffice** — React portal (primary) or legacy static UI:

   **GIOP Portal** (topology graph, map, operations, OCR):
   ```bash
   cd "backoffice-ui/cloudhound frontend portal"
   cp .env.local.example .env.local   # first time only
   npm install && npm run dev         # http://localhost:5173
   ```

   **Legacy UI** (fallback during migration):
   ```bash
   cd backoffice-ui && python3 -m http.server 8080
   ```

5. **Mobile** (Flutter field app):
   ```bash
   cd mobile && flutter run
   ```

## Staging → master asset flow

Field captures land in the **`staging`** Postgres schema (`staging.identified_objects`, `staging.connectivity_nodes`). They do **not** appear on the map or in Memgraph until backoffice approval.

| Tier | Schema | Map / Memgraph | Validation |
|------|--------|----------------|------------|
| Staging | `staging.*` | Hidden | `PENDING_FIELD`, `STAGED`, `IN_CONFLICT` |
| Master | `public.*` | Visible | `APPROVED` (after promote) |

Approve calls `promote_staged_asset()` which copies the row into `public.*` and removes it from staging. Graph webhooks fire only on **public** table changes.

## New APIs (sync-service :5000)

| Endpoint | Purpose |
|----------|---------|
| `GET /api/v1/assets/staging` | List pending field assets (staging schema) |
| `GET /api/v1/assets/master?bbox=` | Master assets in map bbox |
| `POST /api/v1/field/nodes` | Field capture → **staging** only |
| `POST /api/v1/topology/repair` | Repair staging or master asset by MRID |
| `PATCH /api/v1/assets/{mrid}/validation` | Approve promotes staging → master |
| `PATCH /api/v1/assets/{mrid}` | Update asset name (staging or master) |
| `PATCH /api/v1/assets/{mrid}/equipment` | Update nominal voltage on conducting equipment |
| `GET /api/v1/graph/chunk?bbox=&start_mrid=` | Viewport subgraph for map/topology panel |
| `POST /api/v1/inspections` | Create field inspection (OCR validation) |
| `GET /api/v1/inspections` | List inspections (`?asset_mrid=` optional) |
| `POST /api/v1/inspections/{id}/validate` | Run OCR validation on inspection photo |
| `POST /api/v1/m2c/spot-bill-sync` | Offline spot bill → customer ledger |
| `GET /api/v1/lineage?asset_mrid=` | Immutable audit lineage for an asset |
| `GET /api/v1/conflicts` | List open offline conflict proposals |
| `POST /api/v1/conflicts/{id}/resolve` | Resolve conflict (master / field / discard) |
| `GET /api/v1/schematic/generate?mrid=` | W3C SVG engineering schematic |
| `POST /api/v1/analytics/energy-accounting/balance` | Feeder energy balance + anomaly flag |
| `GET /api/v1/dlq` | Integration dead-letter queue |
| `PATCH /api/v1/dlq/{id}` | Update or discard DLQ item |
| `POST /api/v1/dlq/{id}/retry` | Retry failed integration payload |
| `GET /api/v1/health/metrics` | In-process APM latency/error metrics |

### Operational modules (Phase 2 MVP)

| Endpoint | Purpose |
|----------|---------|
| `GET/POST /api/v1/cases` | Contact centre case list / intake |
| `PATCH /api/v1/cases/{id}` | Update case status and assignment |
| `POST /api/v1/cases/{id}/convert-ticket` | Convert case → trouble ticket |
| `POST /api/v1/cases/{id}/convert-work-order` | Convert case → work order |
| `GET/POST /api/v1/tickets` | Trouble ticket queue |
| `PATCH /api/v1/tickets/{id}` | Ticket lifecycle updates |
| `POST /api/v1/tickets/{id}/link` | Link ticket to case/outage/work order |
| `GET/POST /api/v1/work-orders` | Work order dispatch board |
| `GET /api/v1/work-orders/assigned?user=` | Mobile field assignment pull |
| `PATCH /api/v1/work-orders/{id}` | Field status updates |
| `GET/POST /api/v1/outages` | Outage publication and tracking |
| `POST /api/v1/outages/{id}/restore` | Mark outage restored |
| `GET /api/v1/regulatory/metrics` | SAIDI / SAIFI / CAIDI for period |
| `POST /api/v1/regulatory/reports/generate` | Persist regulatory snapshot |

Verify after `npx supabase db reset` and sync-service restart:

```bash
chmod +x scripts/verify_ops_modules.sh
./scripts/verify_ops_modules.sh
```

## OVERSEEYER (separate project)

Local dev control plane — **not** part of the GIOP portal. Tracks stack health, starts/stops services, and manages Supabase migrations.

```bash
chmod +x overseeyer/scripts/start.sh
./overseeyer/scripts/start.sh
```

- UI: http://127.0.0.1:5191
- API: http://127.0.0.1:5190/api/observability

See [`overseeyer/README.md`](overseeyer/README.md) for full API reference.

## Spot billing test

```bash
curl -X POST http://localhost:5000/api/v1/m2c/spot-bill-sync \
  -H "Content-Type: application/json" \
  -d '{"account_mrid":"c0000000-0000-0000-0000-000000000001","previous_reading_kwh":100,"current_reading_kwh":145.5}'
```

## Kafka consumer (optional)

If you run Kafka and Schema Registry locally:

```bash
chmod +x scripts/run_kafka_consumer.sh
./scripts/run_kafka_consumer.sh
```

Or manually:

```bash
cd sync-service && python kafka_avro_consumer.py
```

Topic: `ghana-ami-telemetry-avro`. Schema: [`config/meter_reading.avsc`](config/meter_reading.avsc)

Env vars: `KAFKA_BOOTSTRAP`, `SCHEMA_REGISTRY_URL`, `KAFKA_TOPIC`, `TIMESCALE_URI` (see `scripts/run_kafka_consumer.sh`).

## Power System GeoPackage import

Place `supabase/Power System.gpkg` locally (not committed; ~1.7 GB). After Supabase is running:

```bash
chmod +x scripts/import_power_system_gpkg.sh
./scripts/import_power_system_gpkg.sh
```

Imports all network layers into the `gis` schema, promotes ~30k distribution transformers into `public.connectivity_nodes`, and builds `gis.conductor_segments` for line geometry. Customer meters (~1.25M) are skipped by default:

```bash
IMPORT_METERS=1 ./scripts/import_power_system_gpkg.sh
```

Wire conductor topology into `ac_line_segments` (after import):

```bash
chmod +x scripts/promote_topology.sh scripts/verify_topology.sh
./scripts/promote_topology.sh
.venv/bin/python memgraph/bootstrap.py   # required: sync Memgraph from Postgres
./scripts/verify_topology.sh   # fails if edges are too sparse for map/trace
```

`verify_topology.sh` also runs during `./scripts/start_giop_stack.sh --check-only` and warns when edge density is too low.

## Production portal (no Docker)

Build the React portal and serve with nginx:

```bash
cd "backoffice-ui/cloudhound frontend portal"
npm run build
# See nginx.conf.example — proxies /api/v1 → :5000, /ocr-api → :5002
```

Set `VITE_MARTIN_URL` at build time to your Martin tile URL (or same-origin `/martin/` proxy).

### OpenTelemetry (sync-service)

Optional env vars for sync-service tracing:

```bash
export OTEL_SERVICE_NAME=giop-sync-service
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
```

Energy accounting requires TimescaleDB with `timescaledb/timescale.sql` applied (`TIMESCALE_URI`).

## Architecture parity (portal vs architecture.txt)

| Module | Feature | Status |
|--------|---------|--------|
| 2 | Staging → master promote, repair, Memgraph reconcile | Implemented |
| 3 | Immutable data lineage ledger | Implemented |
| 4 | Offline conflict detection on sync | Implemented |
| 5 | Field inspections + OCR validation (ocr-service) | Implemented |
| 8 | Schematic SVG + energy accounting balance | Implemented |
| 10 | Portal lineage, DLQ, schematic, insights, APM widget | Implemented |
| 6 | Spot-bill sync, telemetry ingest | Implemented |
| 7 | Map SLD voltage layers + enriched Martin tile views (`00017`) | Phase 1–2 done — see `docs/map_implementation_checklist.md` |
| 7 | Data scale / columnar vs PostGIS strategy | See `docs/data_scale_architecture.md` |
| 7 | Viewport chunk topology (split view) | Implemented |
| 7 | SLD voltage colors, ops name/voltage edit | Implemented |
| 8 | Mobile offline captures + spot-bill queue | Implemented |
| 12 | Work-order dispatch + mobile assignment sync | Implemented (MVP) |
| 13 | Contact centre case intake + conversion | Implemented (MVP) |
| 14 | Trouble ticket lifecycle + linking | Implemented (MVP) |
| 15 | Regulatory SAIDI/SAIFI/CAIDI metrics | Implemented (MVP) |
| 16 | Internal outage visibility + restoration | Implemented (MVP) |
| 1 | Docker Compose / Kafka broker containers | Deferred |
| 5 | Triton inference server | Replaced by ocr-service |
