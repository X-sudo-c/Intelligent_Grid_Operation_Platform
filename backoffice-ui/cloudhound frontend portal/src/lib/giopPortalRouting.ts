export type GiopPortalTab =
  | 'operations'
  | 'map'
  | 'topology'
  | 'combined'
  | 'ocr'
  | 'insights'
  | 'schematic'
  | 'dlq'
  | 'audit'
  | 'data-quality'
  | 'exports'
  | 'migration'
  | 'cases'
  | 'tickets'
  | 'work-orders'
  | 'outages'
  | 'reports';

export interface GiopPortalRouteState {
  tab: GiopPortalTab;
  startMrid?: string;
  graphQuery?: string;
  focusMrid?: string;
}

const TAB_PATHS: Record<GiopPortalTab, string> = {
  operations: '/operations',
  map: '/map',
  topology: '/topology',
  combined: '/combined',
  ocr: '/ocr',
  insights: '/insights',
  schematic: '/schematic',
  dlq: '/dlq',
  audit: '/audit',
  'data-quality': '/data-quality',
  exports: '/exports',
  migration: '/migration',
  cases: '/cases',
  tickets: '/tickets',
  'work-orders': '/work-orders',
  outages: '/outages',
  reports: '/reports',
};

const PATH_TABS: Record<string, GiopPortalTab> = {
  '/operations': 'operations',
  '/map': 'map',
  '/topology': 'topology',
  '/combined': 'combined',
  '/ocr': 'ocr',
  '/insights': 'insights',
  '/schematic': 'schematic',
  '/dlq': 'dlq',
  '/audit': 'audit',
  '/data-quality': 'data-quality',
  '/exports': 'exports',
  '/migration': 'migration',
  '/cases': 'cases',
  '/tickets': 'tickets',
  '/work-orders': 'work-orders',
  '/outages': 'outages',
  '/reports': 'reports',
};

export function tabToPath(tab: GiopPortalTab): string {
  return TAB_PATHS[tab];
}

export function pathToTab(path: string): GiopPortalTab | null {
  return PATH_TABS[path] ?? null;
}

export function readGiopRouteFromLocation(): GiopPortalRouteState {
  let path = window.location.pathname.replace(/\/$/, '');
  if (!path) {
    path = '/operations';
  }
  const tab = pathToTab(path) ?? 'operations';
  const params = new URLSearchParams(window.location.search);
  return {
    tab,
    startMrid: params.get('start') ?? undefined,
    graphQuery: params.get('q') ?? undefined,
    focusMrid: params.get('focus') ?? undefined,
  };
}

export function writeGiopRouteToLocation(
  state: GiopPortalRouteState,
  replace = false,
): void {
  const path = tabToPath(state.tab);
  const params = new URLSearchParams();
  if (state.startMrid) params.set('start', state.startMrid);
  if (state.graphQuery) params.set('q', state.graphQuery);
  if (state.focusMrid) params.set('focus', state.focusMrid);
  const qs = params.toString();
  const url = qs ? `${path}?${qs}` : path;
  if (replace) {
    window.history.replaceState(null, '', url);
  } else {
    window.history.pushState(null, '', url);
  }
  window.dispatchEvent(new Event('giop-route'));
}

export function subscribeToGiopRouteChanges(onChange: () => void): () => void {
  const handler = () => onChange();
  window.addEventListener('popstate', handler);
  window.addEventListener('giop-route', handler);
  return () => {
    window.removeEventListener('popstate', handler);
    window.removeEventListener('giop-route', handler);
  };
}
