import type { GiopValidationProgress } from '../api/giop-api';

export const VALIDATION_PHASE_DEFS = [
  { id: 'validator', label: 'Validator Agent', detail: 'SQL rules & batch checks' },
  { id: 'graph', label: 'Graph Agent', detail: 'Topology scan & NetworkX analysis' },
  { id: 'queue', label: 'Queue Manager', detail: 'Route exceptions to virtual queues' },
  { id: 'cleanup', label: 'Cleanup Agent', detail: 'Propose actionable remediation samples' },
  { id: 'kpi', label: 'KPI Snapshot', detail: 'Compute thresholds & escalations' },
  { id: 'agent_briefing', label: 'AI Orchestrator', detail: 'LLM steward briefing', agentOnly: true },
] as const;

export function formatValidationElapsed(startedAt?: string | null, localStartedMs?: number): string {
  const start = startedAt ? new Date(startedAt).getTime() : localStartedMs ?? Date.now();
  if (Number.isNaN(start)) return '0s';
  const sec = Math.max(0, Math.floor((Date.now() - start) / 1000));
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m ${sec % 60}s`;
}

export function isValidationTerminal(progress: GiopValidationProgress | null | undefined): boolean {
  return progress?.status === 'completed' || progress?.status === 'failed';
}
