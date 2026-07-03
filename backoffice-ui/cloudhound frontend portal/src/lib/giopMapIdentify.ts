import type { Map as MaplibreMap, MapGeoJSONFeature, Popup } from 'maplibre-gl';
import maplibregl from './maplibreSetup';
import { getAssetLocation, type GiopAssetLocation } from '../api/giop-api';
import {
  giopMapHoverHtml,
  giopMapHoverKindForLayer,
  type GiopMapHoverKind,
} from './giopMapHover';

/** Kinds backed by a CIM IdentifiedObject we can enrich via the asset API. */
const ENRICHABLE_KINDS = new Set<GiopMapHoverKind>([
  'pole',
  'transformer-dt',
  'transformer-pt',
  'staging',
]);

/** Guards against stale async responses replacing a newer popup. */
let enrichSeq = 0;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function detailRow(label: string, value: string): string {
  return `<div class="giop-map-hover__row"><span class="giop-map-hover__label">${escapeHtml(label)}</span><span class="giop-map-hover__value">${escapeHtml(value)}</span></div>`;
}

function enrichmentHtml(loc: GiopAssetLocation, hasFeeder: boolean): string {
  const rows: string[] = [];
  if (loc.nominal_voltage) rows.push(detailRow('Voltage', String(loc.nominal_voltage)));
  if (!hasFeeder && loc.boundary_feeder_id) rows.push(detailRow('Feeder', loc.boundary_feeder_id));
  if (loc.tier) rows.push(detailRow('Source', loc.tier === 'staging' ? 'Staging tier' : 'Master tier'));
  if (rows.length === 0) return '';
  return `<div class="giop-map-hover__body giop-map-identify__detail">${rows.join('')}</div>`;
}

function injectDetail(baseHtml: string, extra: string): string {
  const idx = baseHtml.lastIndexOf('</div>');
  if (idx === -1) return baseHtml + extra;
  return baseHtml.slice(0, idx) + extra + baseHtml.slice(idx);
}

export const GIOP_IDENTIFY_LAYERS = [
  'nodes',
  'nodes-transformers-dt',
  'nodes-transformers-pt',
  'staging-points',
  'graph-chunk-nodes-layer',
  'field-technician-points',
  'work-order-pins',
] as const;

export type GiopIdentifyLayerId = (typeof GIOP_IDENTIFY_LAYERS)[number];

export function identifyKindForLayer(layerId: string): GiopMapHoverKind | null {
  return giopMapHoverKindForLayer(layerId);
}

export function createGiopIdentifyPopup(): Popup {
  return new maplibregl.Popup({
    closeButton: true,
    closeOnClick: true,
    maxWidth: '320px',
    className: 'giop-map-popup giop-map-identify-popup',
  });
}

export function showGiopIdentifyPopup(
  map: MaplibreMap,
  popup: Popup,
  lngLat: { lng: number; lat: number },
  feature: MapGeoJSONFeature,
  layerId: string,
  light: boolean,
): void {
  const kind = identifyKindForLayer(layerId);
  if (!kind) return;
  const baseHtml = giopMapHoverHtml(feature, kind, light);
  popup.setLngLat(lngLat).setHTML(baseHtml).addTo(map);

  if (!ENRICHABLE_KINDS.has(kind)) return;
  const rawMrid = feature.properties?.mrid;
  const mrid = rawMrid == null || rawMrid === '' ? null : String(rawMrid);
  if (!mrid) return;

  const hasFeeder = Boolean(feature.properties?.boundary_feeder_id);
  const seq = ++enrichSeq;
  void getAssetLocation(mrid)
    .then((loc) => {
      if (seq !== enrichSeq || !popup.isOpen()) return;
      const extra = enrichmentHtml(loc, hasFeeder);
      if (extra) popup.setHTML(injectDetail(baseHtml, extra));
    })
    .catch(() => {
      /* asset detail unavailable — keep base popup */
    });
}
