import { useCallback, useState, type ReactNode } from 'react';
import { giopThemeTokens } from '../lib/giopTheme';

export interface GiopMapLayerToggle {
  id: string;
  label: string;
  /** Swatch color reflecting the layer's map styling. */
  color: string;
  active: boolean;
  onToggle: () => void;
  hint?: string;
}

export interface GiopMapLayerGroup {
  label: string;
  toggles: GiopMapLayerToggle[];
}

interface GiopMapControlPanelProps {
  isLightMode: boolean;
  groups: GiopMapLayerGroup[];
  /** Optional special control (e.g. territory mode) rendered in the footer. */
  footerSlot?: ReactNode;
}

const PANEL_STATE_KEY = 'giop.map.overlays.expanded.v1';

function readExpanded(): boolean {
  try {
    return localStorage.getItem(PANEL_STATE_KEY) !== 'collapsed';
  } catch {
    return true;
  }
}

function LayerSwitch({
  toggle,
  isLightMode,
}: {
  toggle: GiopMapLayerToggle;
  isLightMode: boolean;
}) {
  const t = giopThemeTokens(isLightMode);
  const { active, onToggle, label, color, hint } = toggle;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={active}
      aria-label={label}
      title={hint ?? label}
      onClick={onToggle}
      className={`group flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors ${t.hover}`}
    >
      <span
        className="h-2.5 w-2.5 shrink-0 rounded-full ring-2 ring-inset ring-white/15 transition-opacity"
        style={{ backgroundColor: color, opacity: active ? 1 : 0.4 }}
        aria-hidden
      />
      <span
        className={`flex-1 truncate text-xs font-medium transition-colors ${
          active ? t.text : t.muted
        }`}
      >
        {label}
      </span>
      <span
        className={`relative h-4 w-7 shrink-0 rounded-full transition-colors duration-200 ${
          active
            ? 'bg-premium-accent'
            : isLightMode
              ? 'bg-slate-300'
              : 'bg-premium-hover-strong'
        }`}
        aria-hidden
      >
        <span
          className={`absolute top-0.5 h-3 w-3 rounded-full bg-white shadow-sm transition-transform duration-200 ${
            active ? 'translate-x-3.5' : 'translate-x-0.5'
          }`}
        />
      </span>
    </button>
  );
}

export function GiopMapControlPanel({
  isLightMode,
  groups,
  footerSlot,
}: GiopMapControlPanelProps) {
  const t = giopThemeTokens(isLightMode);
  const [expanded, setExpanded] = useState<boolean>(readExpanded);

  const toggleExpanded = useCallback(() => {
    setExpanded((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(PANEL_STATE_KEY, next ? 'expanded' : 'collapsed');
      } catch {
        /* ignore persistence failure */
      }
      return next;
    });
  }, []);

  const activeCount = groups.reduce(
    (sum, group) => sum + group.toggles.filter((toggle) => toggle.active).length,
    0,
  );

  const shell = isLightMode
    ? 'border-slate-200/80 bg-white/90 text-slate-700 shadow-lg'
    : 'border-premium-border/50 bg-premium-card/95 text-premium-text shadow-premium backdrop-blur-xl';

  return (
    <div
      className={`giop-map-control pointer-events-auto absolute left-3 top-3 z-10 w-52 overflow-hidden rounded-xl border ${shell}`}
    >
      <button
        type="button"
        onClick={toggleExpanded}
        aria-expanded={expanded}
        className={`flex w-full items-center justify-between gap-2 px-3 py-2.5 transition-colors ${t.hover}`}
      >
        <span className={`flex items-center gap-2 text-xs font-semibold uppercase tracking-wide ${t.text}`}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden className="opacity-80">
            <path
              d="M12 3 3 8l9 5 9-5-9-5Z M3 13l9 5 9-5 M3 18l9 5 9-5"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          Overlays
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums ${
              isLightMode
                ? 'bg-slate-200 text-slate-600'
                : 'bg-premium-hover text-premium-text-secondary'
            }`}
          >
            {activeCount}
          </span>
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden
            className={`opacity-70 transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}
          >
            <path
              d="m6 9 6 6 6-6"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      </button>

      <div
        className={`grid transition-all duration-300 ease-out ${
          expanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
        }`}
      >
        <div className="min-h-0 overflow-hidden">
          <div
            className={`border-t px-1.5 pb-2 pt-1.5 ${
              isLightMode ? 'border-slate-200/70' : 'border-premium-border/50'
            }`}
          >
            {groups.map((group) => (
              <div key={group.label} className="mb-1 last:mb-0">
                <p
                  className={`px-2 pb-0.5 pt-1 text-[10px] font-semibold uppercase tracking-wider ${t.mutedDim}`}
                >
                  {group.label}
                </p>
                {group.toggles.map((toggle) => (
                  <LayerSwitch key={toggle.id} toggle={toggle} isLightMode={isLightMode} />
                ))}
              </div>
            ))}
            {footerSlot && (
              <div
                className={`mt-1 border-t px-1 pt-2 ${
                  isLightMode ? 'border-slate-200/70' : 'border-premium-border/50'
                }`}
              >
                {footerSlot}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
