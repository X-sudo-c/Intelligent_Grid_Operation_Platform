const API_BASE = import.meta.env.VITE_API_URL || '/api';

export interface ServiceStatus {
  id: string;
  name: string;
  kind: string;
  status: string;
  detail: string;
  port: number | null;
  pid: number | null;
  log_path: string | null;
  checked_at: string;
}

export interface StackStatus {
  platform: string;
  overall: string;
  summary: { up: number; down: number; partial: number; total: number };
  services: ServiceStatus[];
  paths: { root: string; overseeyer: string; logs: string; pids: string };
}

export interface MigrationFile {
  version: string;
  filename: string;
  path: string;
  size_bytes: number;
  modified_at: string;
}

export interface MigrationInfo {
  local_count: number;
  applied_count: number;
  pending_count: number;
  local: MigrationFile[];
  applied: { version: string; name: string }[];
  pending: string[];
  db_reachable: boolean;
  db_error: string | null;
}

export interface SyncMetricsCheck {
  status: string;
  reason?: string;
  apm_status?: string;
  request_count?: number;
  error_count?: number;
  error_rate_pct?: number;
  latency_p50_ms?: number;
  latency_p95_ms?: number;
  last_kafka_ingest_at?: number | null;
}

export interface DlqCheck {
  status: string;
  reason?: string;
  source?: string;
  open_count?: number;
}

export interface TopologyCheck {
  status: string;
  reason?: string;
  node_count?: number;
  edge_count?: number;
  edge_ratio?: number;
  hint?: string | null;
  estimate?: boolean;
}

export interface GraphSyncCheck {
  status: string;
  reason?: string;
  in_sync?: boolean;
  postgres_nodes?: number;
  postgres_edges?: number;
  memgraph_nodes?: number;
  memgraph_edges?: number;
  node_delta?: number;
  edge_delta?: number;
  hint?: string | null;
}

export interface RedisCheck {
  status: string;
  enabled?: boolean;
  port?: number;
  hint?: string | null;
  reason?: string;
}

export interface VoiceTtsCheck {
  status: string;
  port?: number;
  url?: string;
  phase?: string;
  installed?: boolean;
  pid?: number | null;
  port_open?: boolean;
  docs_ok?: boolean;
  start_job_running?: boolean;
  log_name?: string;
  log_tail?: string[];
  hint?: string | null;
  voice_api?: {
    stt?: { available?: boolean; mode?: string; model?: string; hint?: string | null };
    tts?: { enabled?: boolean; available?: boolean; url?: string; voice?: string };
  } | null;
}

export interface DataPlaneCheck {
  status: string;
  staging_count?: number | null;
  open_conflicts?: number | null;
  postgres_error?: string;
  timescale?: {
    reachable: boolean;
    meter_readings_table?: boolean;
    error?: string;
  };
}

export interface MapTilesCheck {
  status: string;
  reason?: string;
  hint?: string;
  postgres_error?: string;
  node_view_rows?: number;
  line_view_rows?: number;
  voltage_mix?: { nominal_voltage: string; lines: number }[];
  has_asset_kind?: boolean;
  asset_kind_mix?: { asset_kind: string; nodes: number }[];
  transformer_nodes?: number;
  martin_port?: number;
  martin_layers?: Record<string, boolean>;
  martin_error?: string | null;
}

export interface TrialCheck {
  status: string;
  running?: boolean;
  action?: string | null;
  latest_backup?: string | null;
  backup_count?: number;
  counts?: Record<string, number>;
  sync_reachable?: boolean;
  postgres_reachable?: boolean;
  reason?: string;
}

export interface TrialStatus {
  running: boolean;
  action: string | null;
  log_name: string;
  backup_dir: string;
  latest_backup: string | null;
  counts?: Record<string, number>;
  counts_status?: string;
  sync_reachable: boolean;
  postgres_reachable: boolean;
}

export interface TrialBackupInfo {
  path: string;
  name: string;
  size_bytes: number;
  modified_at: string;
}

export interface TrialBackups {
  status: string;
  backup_dir: string;
  latest: string | null;
  backups: TrialBackupInfo[];
}

export interface LogFileInfo {
  name: string;
  service_id: string | null;
  path: string;
  size_bytes: number;
  modified_at: string;
}

export interface LogTail {
  name: string;
  path: string;
  service_id: string | null;
  tail: number;
  total_lines: number;
  lines: string[];
}

export interface ObservabilitySnapshot {
  checked_at: string;
  stack: StackStatus;
  sync_metrics: SyncMetricsCheck;
  dlq: DlqCheck;
  topology: TopologyCheck;
  graph_sync: GraphSyncCheck;
  redis: RedisCheck;
  voice_tts?: VoiceTtsCheck;
  data_plane: DataPlaneCheck;
  map_tiles: MapTilesCheck;
  trial?: TrialCheck;
  logs: LogFileInfo[];
  migrations: MigrationInfo;
}

async function fetchJson<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, options);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const detail = (err as { detail?: string }).detail || res.statusText;
    throw new Error(detail || `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export function getObservability(): Promise<ObservabilitySnapshot> {
  return fetchJson<ObservabilitySnapshot>('/observability').catch(async (err) => {
    if (err instanceof Error && (err.message === 'Not Found' || err.message.includes('404'))) {
      const [stack, migrations] = await Promise.all([getStatus(), getMigrations()]);
      return {
        checked_at: new Date().toISOString(),
        stack,
        sync_metrics: {
          status: 'unavailable',
          reason: 'API outdated — run ./overseeyer/scripts/start.sh to restart',
        },
        dlq: { status: 'unavailable', reason: 'restart API' },
        topology: { status: 'unavailable', reason: 'restart API' },
        graph_sync: { status: 'unavailable', reason: 'restart API' },
        redis: { status: 'unavailable', reason: 'restart API' },
        voice_tts: { status: 'unavailable', hint: 'restart API' },
        data_plane: { status: 'unavailable' },
        map_tiles: { status: 'unavailable', reason: 'restart API' },
        logs: [],
        migrations,
      };
    }
    throw err;
  });
}

export function getStatus(): Promise<StackStatus> {
  return fetchJson<StackStatus>('/status');
}

export function getMigrations(): Promise<MigrationInfo> {
  return fetchJson<MigrationInfo>('/migrations');
}

export function verifyMapTiles(): Promise<MapTilesCheck> {
  return fetchJson<MapTilesCheck>('/verify/map-tiles');
}

export function getLogTail(name: string, tail = 200): Promise<LogTail> {
  return fetchJson<LogTail>(`/logs/${encodeURIComponent(name)}?tail=${tail}`);
}

export function observabilityStreamUrl(): string {
  return `${API_BASE}/observability/stream`;
}

export function startService(id: string): Promise<unknown> {
  return fetchJson(`/services/${encodeURIComponent(id)}/start`, { method: 'POST' });
}

export function stopService(id: string): Promise<unknown> {
  return fetchJson(`/services/${encodeURIComponent(id)}/stop`, { method: 'POST' });
}

export function restartService(id: string): Promise<unknown> {
  return fetchJson(`/services/${encodeURIComponent(id)}/restart`, { method: 'POST' });
}

export function startStack(opts: {
  portal?: boolean;
  backoffice?: boolean;
  bootstrap?: boolean;
}): Promise<unknown> {
  return fetchJson('/stack/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
  });
}

export function createMigration(name: string): Promise<{ filename: string }> {
  return fetchJson('/migrations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}

export interface MigrationApplyJob {
  running: boolean;
  mode?: 'up' | 'reset';
  phase?: string;
  started_at?: string | null;
  finished_at?: string | null;
  exit_code?: number | null;
  error?: string | null;
  result?: {
    mode?: string;
    exit_code?: number;
    stdout?: string;
    stderr?: string;
    martin_paused?: boolean;
    martin_restarted?: boolean;
    migrations?: MigrationInfo;
  } | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export function getMigrationApplyStatus(): Promise<MigrationApplyJob> {
  return fetchJson<MigrationApplyJob>('/migrations/apply/status');
}

export async function applyMigrations(
  mode: 'up' | 'reset',
  confirm = false,
  onProgress?: (status: MigrationApplyJob) => void,
): Promise<unknown> {
  const job = await fetchJson<MigrationApplyJob>('/migrations/apply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode, confirm }),
  });

  onProgress?.(job);

  if (!job.running) {
    if (job.exit_code != null && job.exit_code !== 0) {
      throw new Error(job.error || job.result?.stderr || 'Migration apply failed');
    }
    return job.result ?? job;
  }

  const deadline = Date.now() + 620_000;
  while (Date.now() < deadline) {
    await sleep(2000);
    const status = await getMigrationApplyStatus();
    onProgress?.(status);
    if (!status.running) {
      if (status.exit_code != null && status.exit_code !== 0) {
        throw new Error(
          status.error || status.result?.stderr?.trim() || 'Migration apply failed',
        );
      }
      return status.result ?? status;
    }
  }
  throw new Error('Migration apply timed out — check Supabase logs; job may still be running');
}

export interface MemgraphBootstrapStatus {
  running: boolean;
  log_name: string;
  python: string;
  script: string;
}

export function getMemgraphBootstrapStatus(): Promise<MemgraphBootstrapStatus> {
  return fetchJson<MemgraphBootstrapStatus>('/memgraph/bootstrap/status');
}

export function memgraphBootstrapStreamUrl(): string {
  return `${API_BASE}/memgraph/bootstrap/stream`;
}

export function supertonicStartStreamUrl(): string {
  return `${API_BASE}/supertonic/start/stream`;
}

export function getSupertonicStatus(): Promise<{
  installed: boolean;
  running: boolean;
  pid: number | null;
  port: number;
  url: string;
  port_open: boolean;
  docs_ok: boolean;
  phase: string;
  log_name: string;
  hint: string | null;
  start_job_running: boolean;
}> {
  return fetchJson('/supertonic/status');
}

export function getTrialStatus(): Promise<TrialStatus> {
  return fetchJson<TrialStatus>('/trial/status');
}

export function getTrialBackups(): Promise<TrialBackups> {
  return fetchJson<TrialBackups>('/trial/backups');
}

export type TrialRunParams = {
  action: string;
  confirm?: boolean;
  empty_master?: boolean;
  fresh_staging?: boolean;
  dump_file?: string;
  count?: number;
  run_validation?: boolean;
};

export function trialRunStreamUrl(params: TrialRunParams): string {
  const q = new URLSearchParams();
  q.set('action', params.action);
  if (params.confirm) q.set('confirm', 'true');
  if (params.empty_master) q.set('empty_master', 'true');
  if (params.fresh_staging) q.set('fresh_staging', 'true');
  if (params.dump_file) q.set('dump_file', params.dump_file);
  if (params.count != null) q.set('count', String(params.count));
  if (params.run_validation) q.set('run_validation', 'true');
  return `${API_BASE}/trial/run/stream?${q}`;
}
