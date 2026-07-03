/**
 * Steward portal debug logging — always on by default so ops/map issues are traceable
 * in the browser console. Set localStorage `giop.debug.log` to `0` to silence.
 */

export type GiopLogScope = 'map' | 'ops' | 'portal' | 'overlay' | 'audit' | 'realtime';

const STORAGE_KEY = 'giop.debug.log';

export function isGiopDebugEnabled(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === '0' || raw === 'false') return false;
  } catch {
    /* ignore */
  }
  return true;
}

export function setGiopDebugEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, enabled ? '1' : '0');
  } catch {
    /* ignore */
  }
}

type LogLevel = 'info' | 'warn' | 'error';

function emit(scope: GiopLogScope, level: LogLevel, message: string, detail?: unknown): void {
  if (!isGiopDebugEnabled()) return;
  const prefix = `[Giop/${scope}]`;
  if (detail !== undefined) {
    console[level](prefix, message, detail);
  } else {
    console[level](prefix, message);
  }
}

function scopeLogger(scope: GiopLogScope) {
  return {
    info: (message: string, detail?: unknown) => emit(scope, 'info', message, detail),
    warn: (message: string, detail?: unknown) => emit(scope, 'warn', message, detail),
    error: (message: string, detail?: unknown) => emit(scope, 'error', message, detail),
  };
}

/** Scoped loggers for map focus, ops desk, portal routing, overlay context. */
export const giopLog = {
  map: scopeLogger('map'),
  ops: scopeLogger('ops'),
  portal: scopeLogger('portal'),
  overlay: scopeLogger('overlay'),
  audit: scopeLogger('audit'),
  realtime: scopeLogger('realtime'),
};
