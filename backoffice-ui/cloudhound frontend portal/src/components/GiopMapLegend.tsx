import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Map as MapLibreMap } from 'maplibre-gl';
import {
  applyGiopLegendVisibility,
  buildGiopLegendGroups,
  createDefaultGiopLegendVisibility,
  isGiopLegendGroupAvailableAtZoom,
  isGiopLegendGroupVisible,
  type GiopLegendGroup,
  type GiopLegendVisibilityState,
} from '../lib/giopMapLayers';

interface GiopMapLegendProps {
  isLightMode?: boolean;
  mapRef: React.RefObject<MapLibreMap | null>;
  mapZoom: number;
  mapReady?: boolean;
}

function LegendSwatch({ entry }: { entry: GiopLegendGroup }) {
  if (entry.icon) {
    return (
      <span className="relative inline-flex h-4 w-5 shrink-0 items-center justify-center" aria-hidden>
        <span
          className="absolute bottom-0 h-1.5 w-3 rounded-sm"
          style={{ backgroundColor: entry.color }}
        />
        <span
          className="absolute top-0 h-2 w-2 rounded-full border border-white"
          style={{ backgroundColor: entry.color, left: 2 }}
        />
        <span
          className="absolute top-0 h-2 w-2 rounded-full border border-white"
          style={{ backgroundColor: entry.color, right: 2 }}
        />
      </span>
    );
  }
  if (entry.dot) {
    return (
      <span
        className="inline-block h-2 w-2 shrink-0 rounded-full border border-white/80"
        style={{ backgroundColor: entry.color }}
        aria-hidden
      />
    );
  }
  if (entry.dashed) {
    return (
      <svg className="h-2 w-5 shrink-0" aria-hidden>
        <line
          x1="0"
          y1="4"
          x2="20"
          y2="4"
          stroke={entry.color}
          strokeWidth="2"
          strokeDasharray="4 3"
        />
      </svg>
    );
  }
  return (
    <span
      className="inline-block h-0.5 w-5 shrink-0 rounded-full"
      style={{ backgroundColor: entry.color }}
      aria-hidden
    />
  );
}

export function GiopMapLegend({
  isLightMode = false,
  mapRef,
  mapZoom,
  mapReady = true,
}: GiopMapLegendProps) {
  const groups = useMemo(() => buildGiopLegendGroups(isLightMode), [isLightMode]);
  const [visibility, setVisibility] = useState<GiopLegendVisibilityState>(() =>
    createDefaultGiopLegendVisibility(groups),
  );

  const shell = isLightMode
    ? 'border-slate-200 bg-white/92 text-slate-700'
    : 'border-slate-700 bg-slate-900/92 text-slate-200';

  useEffect(() => {
    setVisibility(createDefaultGiopLegendVisibility(groups));
  }, [groups]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    applyGiopLegendVisibility(map, visibility);
  }, [mapRef, mapReady, visibility]);

  const handleRowDoubleClick = useCallback(
    (group: GiopLegendGroup) => {
      if (!mapRef.current || !mapReady) return;
      setVisibility((prev) => ({
        ...prev,
        [group.id]: !isGiopLegendGroupVisible(group, prev),
      }));
    },
    [mapRef, mapReady],
  );

  const isGroupOn = useCallback(
    (group: GiopLegendGroup) => isGiopLegendGroupVisible(group, visibility),
    [visibility],
  );

  return (
    <div
      className={`giop-map-legend pointer-events-auto absolute bottom-3 left-3 z-10 max-w-[220px] rounded-md border px-3 py-2 text-[11px] shadow-lg ${shell}`}
    >
      <div className="mb-1 flex items-center justify-between gap-2 font-medium opacity-90">
        <span>Network layers</span>
        <span className="text-[10px] font-normal opacity-60">Zoom {mapZoom.toFixed(1)}</span>
      </div>
      <p className="mb-2 text-[10px] opacity-50 leading-snug">
        Double-click a layer to show or hide at this zoom.
      </p>
      <ul className="space-y-1">
        {groups.map((group) => {
          const on = isGroupOn(group);
          const available = isGiopLegendGroupAvailableAtZoom(group, mapZoom);
          return (
            <li key={group.id}>
              <button
                type="button"
                className={`giop-map-legend-row flex w-full items-center gap-2 rounded px-1 py-1 text-left transition-colors ${
                  on ? 'giop-map-legend-row--on' : 'giop-map-legend-row--off'
                } ${available ? '' : 'giop-map-legend-row--unavailable'} ${
                  isLightMode ? 'hover:bg-slate-100' : 'hover:bg-slate-800/60'
                }`}
                onDoubleClick={() => handleRowDoubleClick(group)}
                title={
                  available
                    ? on
                      ? 'Double-click to hide'
                      : 'Double-click to show at current zoom'
                    : 'Not in tile set at this zoom — double-click to enable when available'
                }
              >
                <LegendSwatch entry={group} />
                <span
                  className={`min-w-0 flex-1 leading-tight ${on ? '' : 'line-through opacity-60'}`}
                >
                  {group.label}
                </span>
                <span
                  className={`shrink-0 text-[9px] uppercase tracking-wide ${
                    on ? 'opacity-70' : 'opacity-40'
                  }`}
                  aria-hidden
                >
                  {on ? 'On' : 'Off'}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
