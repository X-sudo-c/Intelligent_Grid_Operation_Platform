import { GiopSplitView } from './GiopSplitView';
import { GiopOperationsTab } from './GiopOperationsTab';
import type { GiopSplitViewProps } from './GiopSplitView';
import type { GiopStagingAsset } from '../api/giop-api';

const OPS_DESK_TOP_RATIO_KEY = 'giop.portal.opsDeskTopRatio.v1';

function readTopRatio(): number {
  try {
    const raw = localStorage.getItem(OPS_DESK_TOP_RATIO_KEY);
    const n = raw ? Number(raw) : 58;
    return Number.isFinite(n) ? Math.min(75, Math.max(45, n)) : 58;
  } catch {
    return 58;
  }
}

type GiopOperationsDeskProps = GiopSplitViewProps & {
  opsRefreshToken?: number;
  onRefreshTopology?: () => void;
  onMapRefresh?: () => void;
  onAssetFocus?: (asset: GiopStagingAsset) => void;
  onTableAssetsLoaded?: (assets: GiopStagingAsset[]) => void;
};

/** FR-010 steward desk: map + topology on top, asset verification below (legacy layout). */
export function GiopOperationsDesk({
  opsRefreshToken = 0,
  onRefreshTopology,
  onMapRefresh,
  onAssetFocus,
  onTableAssetsLoaded,
  isLightMode,
  ...splitProps
}: GiopOperationsDeskProps) {
  const topRatio = readTopRatio();
  const border = isLightMode ? 'border-slate-200' : 'border-premium-border/80';

  return (
    <div className="h-full min-h-0 flex flex-col overflow-hidden">
      <div
        className={`min-h-0 shrink-0 border-b ${border}`}
        style={{ height: `${topRatio}%` }}
      >
        <GiopSplitView
          isLightMode={isLightMode}
          {...splitProps}
          mapChrome="operations"
          pulseFocus={Boolean(splitProps.focusMrid)}
        />
      </div>
      <div className={`min-h-0 flex-1 flex flex-col overflow-hidden ${border}`}>
        <GiopOperationsTab
          isLightMode={isLightMode}
          embedded
          onRefreshTopology={onRefreshTopology}
          onMapRefresh={onMapRefresh}
          refreshToken={opsRefreshToken}
          onAssetFocus={onAssetFocus}
          onAssetsLoaded={onTableAssetsLoaded}
        />
      </div>
    </div>
  );
}
