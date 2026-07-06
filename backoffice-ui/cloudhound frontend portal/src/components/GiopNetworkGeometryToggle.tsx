import { Layers } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  NETWORK_GEOMETRY_MODE_META,
  type NetworkGeometryMode,
} from '../lib/giopMapLayers';

const MODES: NetworkGeometryMode[] = ['master', 'gis', 'both'];

interface GiopNetworkGeometryToggleProps {
  isLightMode: boolean;
  gisOverviewAvailable: boolean;
  mode: NetworkGeometryMode;
  onModeChange: (mode: NetworkGeometryMode) => void;
  /** inline = search-bar chip; floating = map corner (side preview only). */
  variant?: 'inline' | 'floating';
  positionClass?: string;
}

export function GiopNetworkGeometryToggle({
  isLightMode,
  gisOverviewAvailable,
  mode,
  onModeChange,
  variant = 'floating',
  positionClass = 'right-11 top-2',
}: GiopNetworkGeometryToggleProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const inline = variant === 'inline';
  const meta = NETWORK_GEOMETRY_MODE_META[mode];

  useEffect(() => {
    if (!open) return;
    const onDocClick = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  const selectMode = useCallback(
    (next: NetworkGeometryMode) => {
      if (next === 'gis' && !gisOverviewAvailable) return;
      onModeChange(next);
      setOpen(false);
    },
    [gisOverviewAvailable, onModeChange],
  );

  const shell = isLightMode
    ? 'border-slate-200/90 bg-white text-slate-700 shadow-lg'
    : 'border-premium-border/50 bg-premium-card/95 text-premium-text shadow-premium backdrop-blur-xl';

  return (
    <div
      ref={rootRef}
      className={
        inline
          ? 'relative'
          : `pointer-events-auto absolute z-20 ${positionClass}`
      }
    >
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={`Line geometry: ${meta.label}`}
        title={`${meta.label} — GIS import vs master`}
        onClick={() => setOpen((prev) => !prev)}
        className={
          inline
            ? `giop-map-spotlight__filter-btn relative${open || mode !== 'both' ? ' giop-map-spotlight__filter-btn--active' : ''}`
            : `flex h-9 w-9 items-center justify-center rounded-full border transition-colors ${shell} ${
                isLightMode ? 'hover:bg-slate-50' : 'hover:bg-premium-hover'
              } ${open ? (isLightMode ? 'ring-2 ring-cyan-500/40' : 'ring-2 ring-premium-accent/35') : ''}`
        }
      >
        <Layers className="h-4 w-4" aria-hidden />
        <span
          className={
            inline
              ? 'absolute bottom-1 right-1 h-1.5 w-1.5 rounded-full ring-1 ring-white/90'
              : 'absolute bottom-0.5 right-0.5 h-2 w-2 rounded-full ring-2 ring-white/90'
          }
          style={{ backgroundColor: meta.swatch }}
          aria-hidden
        />
      </button>

      {open && (
        <div
          role="listbox"
          aria-label="Network geometry source"
          className={
            inline
              ? `giop-map-spotlight__panel giop-map-spotlight__geometry-panel ${shell} !left-auto !right-0 !top-full !mt-1.5 !w-56 !max-h-none`
              : `absolute left-0 top-full mt-1.5 w-52 overflow-hidden rounded-xl border ${shell}`
          }
        >
          <p
            className={`px-3 py-2 text-[10px] font-semibold uppercase tracking-wide ${
              isLightMode ? 'text-slate-500' : 'text-premium-muted'
            }`}
          >
            Line geometry
          </p>
          <ul className="px-1.5 pb-2">
            {MODES.map((option) => {
              const item = NETWORK_GEOMETRY_MODE_META[option];
              const disabled = option === 'gis' && !gisOverviewAvailable;
              const selected = mode === option;
              return (
                <li key={option}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={selected}
                    disabled={disabled}
                    title={disabled ? 'GIS overview tiles unavailable' : item.hint}
                    onClick={() => selectMode(option)}
                    className={`flex w-full items-start gap-2.5 rounded-lg px-2 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                      selected
                        ? isLightMode
                          ? 'bg-cyan-50 text-cyan-950'
                          : 'bg-premium-accent/12 text-premium-accent'
                        : isLightMode
                          ? 'hover:bg-slate-50'
                          : 'hover:bg-premium-hover'
                    }`}
                  >
                    <span
                      className="mt-0.5 h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: item.swatch }}
                      aria-hidden
                    />
                    <span className="min-w-0">
                      <span className="block text-xs font-medium">{item.label}</span>
                      <span
                        className={`block text-[10px] leading-snug mt-0.5 ${
                          isLightMode ? 'text-slate-500' : 'text-premium-muted'
                        }`}
                      >
                        {item.hint}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
