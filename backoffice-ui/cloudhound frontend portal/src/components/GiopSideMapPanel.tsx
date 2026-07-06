import { ExternalLink, X } from 'lucide-react';
import { GiopMapView } from './GiopMapView';
import type { GiopStagingAsset, GiopTopologyPayload } from '../api/giop-api';
import type { GiopMapFlyRequest } from '../lib/giopMapFlyRequest';

interface GiopSideMapPanelProps {
  mrid: string | null;
  name: string | null;
  coordinates: [number, number] | null;
  isLightMode: boolean;
  stagingAssets: GiopStagingAsset[];
  startMrid: string;
  mapRefreshToken: number;
  flyRequest?: GiopMapFlyRequest | null;
  impactOverlay: GiopTopologyPayload | null;
  onClose: () => void;
  onOpenFullMap: () => void;
  onNodeClick: (mrid: string, coordinates?: [number, number]) => void;
  /** Data Quality desk: map stays open; hide the close control. */
  persistent?: boolean;
}

export function GiopSideMapPanel({
  mrid,
  name,
  coordinates,
  isLightMode,
  stagingAssets,
  startMrid,
  mapRefreshToken,
  flyRequest = null,
  impactOverlay,
  onClose,
  onOpenFullMap,
  onNodeClick,
  persistent = false,
}: GiopSideMapPanelProps) {
  const border = isLightMode ? 'border-slate-200 bg-white' : 'border-premium-border/75 bg-premium-sidebar';
  const muted = isLightMode ? 'text-slate-500' : 'text-premium-muted';
  const btn = isLightMode
    ? 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
    : 'text-premium-muted hover:text-premium-text hover:bg-premium-hover';

  return (
    <div className={`h-full flex flex-col border-l ${border}`}>
      <div className={`shrink-0 px-3 py-2 flex items-center justify-between gap-2 border-b ${isLightMode ? 'border-slate-200' : 'border-premium-border/80'}`}>
        <div className="min-w-0">
          <p className={`text-xs font-medium ${isLightMode ? 'text-slate-800' : 'text-premium-text-secondary'}`}>
            Map preview
          </p>
          <p className={`text-xs truncate ${muted}`} title={name ?? mrid ?? undefined}>
            {name || (mrid ? `${mrid.slice(0, 8)}…` : 'Select an asset')}
          </p>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={onOpenFullMap}
            className={`inline-flex items-center gap-1 px-2 py-1 text-xs rounded transition ${btn}`}
            title="Open full map tab"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            Full map
          </button>
          {!persistent && (
            <button
              type="button"
              onClick={onClose}
              className={`inline-flex h-7 w-7 items-center justify-center rounded transition ${btn}`}
              aria-label="Close map panel"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
      <div className="flex-1 min-h-0 relative">
        <GiopMapView
          isLightMode={isLightMode}
          focusMrid={mrid}
          focusCoordinates={coordinates}
          focusLabel={name}
          pulseFocus={Boolean(mrid)}
          showSearchBar={false}
          stagingAssets={stagingAssets}
          refreshToken={mapRefreshToken}
          onNodeClick={onNodeClick}
          impactOverlay={impactOverlay}
          flyRequest={flyRequest}
        />
      </div>
    </div>
  );
}
