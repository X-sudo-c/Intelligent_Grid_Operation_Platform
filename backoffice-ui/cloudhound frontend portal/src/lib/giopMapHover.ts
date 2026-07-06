import type { Map as MaplibreMap, MapGeoJSONFeature, MapMouseEvent } from 'maplibre-gl';

export type GiopMapHoverKind =
  | 'pole'
  | 'transformer-dt'
  | 'transformer-pt'
  | 'staging'
  | 'chunk'
  | 'technician'
  | 'work-order';

const LAYER_KIND: Record<string, GiopMapHoverKind> = {
  nodes: 'pole',
  'nodes-transformers-dt': 'transformer-dt',
  'nodes-transformers-pt': 'transformer-pt',
  'master-transformers-dt': 'transformer-dt',
  'master-transformers-pt': 'transformer-pt',
  'staging-points': 'staging',
  'field-technician-points': 'technician',
  'work-order-pins': 'work-order',
};

export function giopMapHoverKindForLayer(layerId: string): GiopMapHoverKind | null {
  return LAYER_KIND[layerId] ?? null;
}

const HOVER_HIT_PX = 10;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function prop(feature: MapGeoJSONFeature, key: string): string | undefined {
  const value = feature.properties?.[key];
  if (value == null || value === '') return undefined;
  return String(value);
}

function validationLabel(raw: string): string {
  switch (raw) {
    case 'PENDING_FIELD':
      return 'Pending field verification';
    case 'STAGED':
      return 'Staged';
    case 'VALIDATED':
      return 'Validated';
    case 'REJECTED':
      return 'Rejected';
    default:
      return raw.replace(/_/g, ' ');
  }
}

function hoverTitle(kind: GiopMapHoverKind): string {
  switch (kind) {
    case 'transformer-dt':
      return 'Distribution transformer';
    case 'transformer-pt':
      return 'Power transformer';
    case 'staging':
      return 'Staging asset';
    case 'technician':
      return 'Field technician';
    case 'work-order':
      return 'Work order';
    case 'chunk':
      return 'Grid node (viewport)';
    default:
      return 'Connectivity node';
  }
}

function hoverRow(label: string, value: string): string {
  return `<div class="giop-map-hover__row"><span class="giop-map-hover__label">${escapeHtml(label)}</span><span class="giop-map-hover__value">${escapeHtml(value)}</span></div>`;
}

export function giopMapHoverHtml(
  feature: MapGeoJSONFeature,
  kind: GiopMapHoverKind,
  light = false,
): string {
  const rows: string[] = [];
  const name = prop(feature, 'name') ?? prop(feature, 'display_name') ?? prop(feature, 'summary');
  const mrid = prop(feature, 'mrid') ?? prop(feature, 'technician_id') ?? prop(feature, 'reference');
  const validation = prop(feature, 'validation');
  const feeder = prop(feature, 'boundary_feeder_id');
  const status = prop(feature, 'status');
  const workType = prop(feature, 'work_type');
  const connected = feature.properties?.connected;
  const traced = feature.properties?.traced;

  if (name && name !== mrid) rows.push(hoverRow('Name', name));
  if (mrid) rows.push(hoverRow('MRID', mrid));
  if (validation) rows.push(hoverRow('Status', validationLabel(validation)));
  if (status) rows.push(hoverRow('Status', status.replace(/_/g, ' ')));
  if (workType) rows.push(hoverRow('Type', workType.replace(/_/g, ' ')));
  if (feeder) rows.push(hoverRow('Feeder', feeder));
  if (connected !== undefined && connected !== '') {
    rows.push(hoverRow('Connected', connected === true || connected === 'true' ? 'Yes' : 'No'));
  }
  if (traced === true || traced === 'true') rows.push(hoverRow('Traced', 'Yes'));

  const emptyHint =
    kind === 'transformer-dt' || kind === 'transformer-pt'
      ? 'Transformer — click for details'
      : 'Click for details';

  const themeClass = light ? 'giop-map-hover--light' : 'giop-map-hover--dark';

  return `<div class="giop-map-hover ${themeClass}">
    <div class="giop-map-hover__title">${escapeHtml(hoverTitle(kind))}</div>
    ${rows.length > 0 ? `<div class="giop-map-hover__body">${rows.join('')}</div>` : `<div class="giop-map-hover__hint">${emptyHint}</div>`}
  </div>`;
}

function activeHoverLayers(map: MaplibreMap): string[] {
  return Object.keys(LAYER_KIND).filter((layerId) => map.getLayer(layerId));
}

function pickHoverFeature(
  map: MaplibreMap,
  point: MapMouseEvent['point'],
): { feature: MapGeoJSONFeature; kind: GiopMapHoverKind } | null {
  const layers = activeHoverLayers(map);
  if (!layers.length) return null;

  const pad = HOVER_HIT_PX;
  const features = map.queryRenderedFeatures(
    [
      [point.x - pad, point.y - pad],
      [point.x + pad, point.y + pad],
    ],
    { layers },
  );

  for (const feature of features) {
    const layerId = feature.layer?.id;
    if (!layerId) continue;
    const kind = LAYER_KIND[layerId];
    if (kind) return { feature, kind };
  }
  return null;
}

/** Persistent map hover — queries all node/transformer layers on each mousemove. */
export function attachGiopMapHover(
  map: MaplibreMap,
  host: HTMLElement,
  isLight: () => boolean,
): () => void {
  const tip = document.createElement('div');
  tip.className = 'giop-map-hover-tip giop-map-hover-tip--hidden';
  tip.setAttribute('role', 'tooltip');
  host.appendChild(tip);

  const hide = () => {
    tip.classList.add('giop-map-hover-tip--hidden');
    map.getCanvas().style.cursor = '';
  };

  const onMove = (e: MapMouseEvent) => {
    // Skip expensive hit-tests while the user is panning/zooming — avoids jank and stuck drags.
    if (map.isMoving()) {
      hide();
      return;
    }
    const hit = pickHoverFeature(map, e.point);
    if (!hit) {
      hide();
      return;
    }

    const light = isLight();
    map.getCanvas().style.cursor = 'pointer';
    tip.className = `giop-map-hover-tip ${light ? 'giop-map-hover-tip--light' : 'giop-map-hover-tip--dark'}`;
    tip.innerHTML = giopMapHoverHtml(hit.feature, hit.kind, light);

    const maxX = host.clientWidth - 16;
    const maxY = host.clientHeight - 16;
    const left = Math.min(e.point.x + 14, maxX);
    const top = Math.min(e.point.y + 14, maxY);
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
    tip.classList.remove('giop-map-hover-tip--hidden');
  };

  map.on('mousemove', onMove);
  map.on('mouseleave', hide);
  map.on('dragstart', hide);

  return () => {
    map.off('mousemove', onMove);
    map.off('mouseleave', hide);
    map.off('dragstart', hide);
    tip.remove();
    map.getCanvas().style.cursor = '';
  };
}
