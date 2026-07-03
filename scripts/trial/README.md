# GIOP staging & rules-engine trials

Dev-only workflow for emptying master, simulating field captures, and restoring.

## Quick start

```bash
chmod +x scripts/trial/*.sh

# 1) Backup + empty master + fresh staging (interactive confirm)
./scripts/trial/prep_trial.sh --empty-master --fresh-staging

# Or non-interactive:
TRIAL_CONFIRM=1 ./scripts/trial/prep_trial.sh --empty-master --fresh-staging

# 2) Simulate ~20 mixed captures from fake technicians
python3 scripts/trial/simulate_field_captures.py --count 20 --run-validation

# 3) After trials — restore full DB from backup
TRIAL_CONFIRM=1 ./scripts/trial/restore_from_backup.sh
```

## Scripts

| Script | Purpose |
|--------|---------|
| `backup_before_trial.sh` | `pg_dump` → `.giop/backups/trial/giop-pre-trial-<ts>.dump` |
| `restore_from_backup.sh` | `pg_restore --clean` from dump |
| `clear_master_network.sh` | Deletes `public` nodes/lines only; keeps `gis.*` |
| `clear_staging.sh` | `TRUNCATE staging.*` (cascades staging DQ exceptions), invalidate Redis cache |

After `clear_staging.sh`, the portal should drop staging map pins and the Data Quality nav badge within seconds. Field-capture validation issues live in `staging.data_quality_exceptions` and are removed automatically when staging rows are truncated. Master DQ issues remain in `public.data_quality_exceptions`.
| `prep_trial.sh` | Backup + optional clears |
| `reimport_master_from_gis.sh` | `gis.post_import_refresh()` after trial |
| `simulate_field_captures.py` | POST good/bad captures to sync-service |

## Simulator scenarios

- **good** — Accra bbox, random asset kinds & technicians
- **outside_ghana** — triggers `ASSET_GEOM_IN_GHANA`
- **duplicate_cluster** — same point/name cluster → `ASSET_DUPLICATE_NEAR` (after first)
- **no_feeder** — missing feeder (server may auto-fill `FEEDER-FIELD-*`)

## Restore options

1. **Full restore** — `restore_from_backup.sh` (fastest, exact snapshot)
2. **GIS re-import** — `import_power_system_gpkg.sh` then `reimport_master_from_gis.sh`
3. **Memgraph** — after restore: `.venv/bin/python memgraph/bootstrap.py`

## Env

Uses `.env` → `SUPABASE_DB_URI`, `SYNC_SERVICE_URL`.  
Backups default to `.giop/backups/trial/` (gitignored).

Set `TRIAL_CONFIRM=1` to skip interactive `YES` prompts.
