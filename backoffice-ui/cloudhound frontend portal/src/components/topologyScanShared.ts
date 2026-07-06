export const TOPOLOGY_SCAN_PHASE_DEFS = [
  { id: 'auto_clear', label: 'Clear resolved exceptions' },
  { id: 'orphans', label: 'Orphan node scan' },
  { id: 'dangling', label: 'Dangling line scan' },
  { id: 'endpoints', label: 'Endpoint approval check' },
  { id: 'geometric', label: 'Geometric topology rules' },
  { id: 'snapshot', label: 'Save metrics snapshot' },
] as const;

export function formatScanElapsed(startedAt?: string | null, localStartedMs?: number): string {
  const start = startedAt ? new Date(startedAt).getTime() : localStartedMs ?? Date.now();
  if (Number.isNaN(start)) return '0s';
  const sec = Math.max(0, Math.floor((Date.now() - start) / 1000));
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m ${sec % 60}s`;
}

export function formatScanEta(seconds?: number | null): string | null {
  if (seconds == null || seconds <= 0) return null;
  if (seconds < 60) return `~${seconds}s remaining`;
  return `~${Math.ceil(seconds / 60)}m remaining`;
}

export function isTopologyScanTerminal(status?: string | null): boolean {
  return status === 'completed' || status === 'failed';
}
