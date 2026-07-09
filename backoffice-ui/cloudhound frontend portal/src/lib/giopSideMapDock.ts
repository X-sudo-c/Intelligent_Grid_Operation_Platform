/** Persist Map preview dock / float layout across sessions. */

export type SideMapDockMode = 'docked' | 'floating';

export interface SideMapFloatRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const DOCK_MODE_KEY = 'giop.portal.sideMapDockMode.v1';
const FLOAT_RECT_KEY = 'giop.portal.sideMapFloatRect.v1';
const DOCK_WIDTH_KEY = 'giop.portal.sideMapDockWidth.v1';

const MIN_W = 320;
const MIN_H = 280;
const DEFAULT_W = 440;
const DEFAULT_H = 520;
/** Docked rail: leave room for the main content column. */
const DOCK_MIN_W = 280;
const DOCK_MAX_RATIO = 0.72;
const DOCK_DEFAULT_W = 440;

export function clampSideMapDockWidth(width: number): number {
  if (typeof window === 'undefined') {
    return Math.min(Math.max(DOCK_MIN_W, width), 720);
  }
  const maxW = Math.max(DOCK_MIN_W, Math.floor(window.innerWidth * DOCK_MAX_RATIO));
  return Math.min(Math.max(DOCK_MIN_W, width), maxW);
}

export function readSideMapDockWidth(): number {
  try {
    const raw = localStorage.getItem(DOCK_WIDTH_KEY);
    const n = raw ? Number(raw) : DOCK_DEFAULT_W;
    return clampSideMapDockWidth(Number.isFinite(n) ? n : DOCK_DEFAULT_W);
  } catch {
    return DOCK_DEFAULT_W;
  }
}

export function writeSideMapDockWidth(width: number): void {
  try {
    localStorage.setItem(DOCK_WIDTH_KEY, String(clampSideMapDockWidth(width)));
  } catch {
    /* ignore */
  }
}

export function readSideMapDockMode(): SideMapDockMode {
  try {
    const raw = localStorage.getItem(DOCK_MODE_KEY);
    return raw === 'floating' ? 'floating' : 'docked';
  } catch {
    return 'docked';
  }
}

export function writeSideMapDockMode(mode: SideMapDockMode): void {
  try {
    localStorage.setItem(DOCK_MODE_KEY, mode);
  } catch {
    /* ignore */
  }
}

export function defaultSideMapFloatRect(): SideMapFloatRect {
  if (typeof window === 'undefined') {
    return { x: 48, y: 72, width: DEFAULT_W, height: DEFAULT_H };
  }
  const width = Math.min(DEFAULT_W, Math.max(MIN_W, window.innerWidth - 96));
  const height = Math.min(DEFAULT_H, Math.max(MIN_H, window.innerHeight - 120));
  return {
    x: Math.max(16, window.innerWidth - width - 24),
    y: Math.max(64, Math.round((window.innerHeight - height) / 2)),
    width,
    height,
  };
}

export function readSideMapFloatRect(): SideMapFloatRect {
  try {
    const raw = localStorage.getItem(FLOAT_RECT_KEY);
    if (!raw) return defaultSideMapFloatRect();
    const parsed = JSON.parse(raw) as Partial<SideMapFloatRect>;
    const base = defaultSideMapFloatRect();
    const width = Number(parsed.width);
    const height = Number(parsed.height);
    const x = Number(parsed.x);
    const y = Number(parsed.y);
    return clampSideMapFloatRect({
      x: Number.isFinite(x) ? x : base.x,
      y: Number.isFinite(y) ? y : base.y,
      width: Number.isFinite(width) ? width : base.width,
      height: Number.isFinite(height) ? height : base.height,
    });
  } catch {
    return defaultSideMapFloatRect();
  }
}

export function writeSideMapFloatRect(rect: SideMapFloatRect): void {
  try {
    localStorage.setItem(FLOAT_RECT_KEY, JSON.stringify(clampSideMapFloatRect(rect)));
  } catch {
    /* ignore */
  }
}

export function clampSideMapFloatRect(rect: SideMapFloatRect): SideMapFloatRect {
  if (typeof window === 'undefined') return rect;
  const width = Math.min(Math.max(MIN_W, rect.width), window.innerWidth - 24);
  const height = Math.min(Math.max(MIN_H, rect.height), window.innerHeight - 24);
  const x = Math.min(Math.max(8, rect.x), Math.max(8, window.innerWidth - width - 8));
  const y = Math.min(Math.max(8, rect.y), Math.max(8, window.innerHeight - height - 8));
  return { x, y, width, height };
}
