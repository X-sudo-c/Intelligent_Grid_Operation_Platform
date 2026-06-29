import { ExternalLink, X } from 'lucide-react';
import { GiopMapView } from './GiopMapView';
import type { GiopStagingAsset, GiopTopologyPayload } from '../api/giop-api';

interface GiopSideMapPanelProps {
  mrid: string | null;
  name: string | null;
  coordinates: [number, number] | null;
  isLightMode: boolean;
  stagingAssets: GiopStagingAsset[];
  startMrid: string;
  mapRefreshToken: number;
  impactOverlay: GiopTopologyPayload | null;
  onClose: () => void;
  onOpenFullMap: () => void;
  onNodeClick: (mrid: string, coordinates?: [number, number]) => void;
}

export function GiopSideMapPanel({
  mrid,
  name,
  coordinates,
  isLightMode,
  stagingAssets,
  startMrid,
  mapRefreshToken,
  impactOverlay,
  onClose,
  onOpenFullMap,
  onNodeClick,
}: GiopSideMapPanelProps) {
  const border = isLightMode ? 'border-slate-200 bg-white' : 'border-[#283246]/75 bg-[#0f141d]';
  const muted = isLightMode ? 'text-slate-500' : 'text-slate-400';
  const btn = isLightMode
    ? 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
    : 'text-slate-400 hover:text-slate-100 hover:bg-slate-800';

  return (
    <div className={`h-full flex flex-col border-l ${border}`}>
      <div className={`shrink-0 px-3 py-2 flex items-center justify-between gap-2 border-b ${isLightMode ? 'border-slate-200' : 'border-slate-800'}`}>
        <div className="min-w-0">
          <p className={`text-xs font-medium ${isLightMode ? 'text-slate-800' : 'text-slate-200'}`}>
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
          <button
            type="button"
            onClick={onClose}
            className={`inline-flex h-7 w-7 items-center justify-center rounded transition ${btn}`}
            aria-label="Close map panel"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
      <div className="flex-1 min-h-0 relative">
        <GiopMapView
          isLightMode={isLightMode}
          focusMrid={mrid}
          focusCoordinates={coordinates}
          focusLabel={name}
          pulseFocus={Boolean(mrid)}
          stagingAssets={stagingAssets}
          refreshToken={mapRefreshToken}
          startMrid={startMrid}
          onNodeClick={onNodeClick}
          impactOverlay={impactOverlay}
        />
      </div>
    </div>
  );
}
