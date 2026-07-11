import type { MapBboxContext } from './giopCopilotTypes';
import { endpointAssetKindLabel } from './gisEndpointAssetKind';
import { GIOP_MAP_LABEL_FONT_REGULAR, GIS_IMPORT_MAGENTA } from './giopMapLayers';

export interface ImportSegmentHighlightGeoJson {
  line: GeoJSON.FeatureCollection;
  line_before?: GeoJSON.FeatureCollection;
  endpoints: GeoJSON.FeatureCollection;
  proposed_assets?: GeoJSON.FeatureCollection;
  suggested_links?: GeoJSON.FeatureCollection;
}

export interface ImportSegmentHighlightState {
  segmentId: number;
  label: string;
  geojson: ImportSegmentHighlightGeoJson;
  bbox?: MapBboxContext;
}

/** Tight focus on endpoint connections — excludes the full conductor span. */
export function bboxFromEndpointFixGeojson(
  geojson: ImportSegmentHighlightGeoJson,
): MapBboxContext | null {
  const coords: Array<[number, number]> = [];

  const collect = (fc?: GeoJSON.FeatureCollection) => {
    for (const feature of fc?.features ?? []) {
      const geom = feature.geometry;
      if (!geom) continue;
      if (geom.type === 'Point') {
        const c = geom.coordinates as [number, number];
        if (Number.isFinite(c[0]) && Number.isFinite(c[1])) coords.push(c);
      } else {
        const lineCoords = lineStringCoordsFromGeom(geom);
        if (!lineCoords) continue;
        for (const pt of lineCoords) {
          if (Number.isFinite(pt[0]) && Number.isFinite(pt[1])) coords.push(pt);
        }
      }
    }
  };

  collect(geojson.endpoints);
  collect(geojson.proposed_assets);
  collect(geojson.suggested_links);
  collect(geojson.line_before);
  if (coords.length === 0) collect(geojson.line);
  if (coords.length === 0) return null;

  let west = coords[0][0];
  let east = coords[0][0];
  let south = coords[0][1];
  let north = coords[0][1];
  for (const [lon, lat] of coords) {
    west = Math.min(west, lon);
    east = Math.max(east, lon);
    south = Math.min(south, lat);
    north = Math.max(north, lat);
  }

  const span = Math.max(east - west, north - south);
  // Keep short endpoint fixes large enough to read instead of fitting a
  // marker-width conductor inside a much larger fixed box.
  const pad = Math.max(0.00002, Math.min(0.00008, span * 0.35));
  return {
    west: west - pad,
    south: south - pad,
    east: east + pad,
    north: north + pad,
  };
}

export const IMPORT_SEGMENT_LINE_SOURCE = 'import-segment-line';
export const IMPORT_SEGMENT_LINE_BEFORE_SOURCE = 'import-segment-line-before';
export const IMPORT_SEGMENT_LINE_BEFORE_HALO_LAYER = 'import-segment-line-before-halo';
export const IMPORT_SEGMENT_LINE_BEFORE_LAYER = 'import-segment-line-before-layer';
export const IMPORT_SEGMENT_LINE_BEFORE_ARROW_LAYER = 'import-segment-line-before-arrow';
export const IMPORT_SEGMENT_LINE_HALO_LAYER = 'import-segment-line-halo';
export const IMPORT_SEGMENT_LINE_LAYER = 'import-segment-line-layer';
export const IMPORT_SEGMENT_LINE_ARROW_LAYER = 'import-segment-line-arrow';

/** Keep after-snap line only when it clearly differs from as-built (meters). */
export const IMPORT_SEGMENT_AFTER_SNAP_MIN_MOVE_M = 1.5;
export const IMPORT_SEGMENT_ENDPOINT_SOURCE = 'import-segment-endpoints';
export const IMPORT_SEGMENT_ENDPOINT_LAYER = 'import-segment-endpoints-layer';
export const IMPORT_SEGMENT_LABEL_LAYER = 'import-segment-endpoint-labels';
export const IMPORT_SEGMENT_PROPOSED_SOURCE = 'import-segment-proposed-assets';
export const IMPORT_SEGMENT_PROPOSED_LAYER = 'import-segment-proposed-layer';
export const IMPORT_SEGMENT_PROPOSED_LABEL_LAYER = 'import-segment-proposed-labels';
export const IMPORT_SEGMENT_LINK_SOURCE = 'import-segment-suggested-links';
export const IMPORT_SEGMENT_LINK_LAYER = 'import-segment-suggested-links-layer';
export const IMPORT_SEGMENT_LINK_LABEL_LAYER = 'import-segment-suggested-link-labels';

export function isEndpointFixHighlight(geojson: ImportSegmentHighlightGeoJson): boolean {
  return (geojson.proposed_assets?.features.length ?? 0) > 0
    || (geojson.suggested_links?.features.length ?? 0) > 0;
}

export type ImportSegmentLabelKind = 'from' | 'to' | 'link' | 'start-badge' | 'end-badge';

export type ImportSegmentLabelAnchor =
  | 'center'
  | 'top'
  | 'bottom'
  | 'left'
  | 'right'
  | 'top-left'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-right';

export interface ImportSegmentMapLabel {
  coord: [number, number];
  text: string;
  kind: ImportSegmentLabelKind;
  /** Neighbor on the conductor span — used to push labels off the line. */
  inwardCoord?: [number, number];
  /** Gap segment ends — used to offset distance labels off the dashed link. */
  linkEnds?: [[number, number], [number, number]];
}

interface MapProjectPoint {
  project(lngLat: { lng: number; lat: number }): { x: number; y: number };
}

function lngLatPoint(map: MapProjectPoint, coord: [number, number]) {
  return map.project({ lng: coord[0], lat: coord[1] });
}

function normalizeXY(x: number, y: number): [number, number] {
  const len = Math.hypot(x, y);
  if (len < 1e-6) return [0, -1];
  return [x / len, y / len];
}

function lineStringCoordsFromGeom(geom: GeoJSON.Geometry | null | undefined): [number, number][] | null {
  if (!geom) return null;
  if (geom.type === 'LineString' && geom.coordinates.length >= 2) {
    return geom.coordinates as [number, number][];
  }
  if (geom.type === 'MultiLineString' && geom.coordinates.length > 0) {
    let best: [number, number][] | null = null;
    for (const part of geom.coordinates) {
      if (!part || part.length < 2) continue;
      const coords = part as [number, number][];
      if (!best || coords.length > best.length) best = coords;
    }
    return best;
  }
  return null;
}

function primaryLineCoords(geojson: ImportSegmentHighlightGeoJson): [number, number][] | null {
  for (const fc of [geojson.line, geojson.line_before]) {
    for (const feature of fc?.features ?? []) {
      const coords = lineStringCoordsFromGeom(feature.geometry);
      if (coords) return coords;
    }
  }
  return null;
}

/** Prefer as-built span for wire direction (START/END badges, gray arrow). */
function asBuiltLineCoords(geojson: ImportSegmentHighlightGeoJson): [number, number][] | null {
  for (const fc of [geojson.line_before, geojson.line]) {
    for (const feature of fc?.features ?? []) {
      const coords = lineStringCoordsFromGeom(feature.geometry);
      if (coords) return coords;
    }
  }
  return null;
}

function lineEnds(feature: GeoJSON.Feature): [[number, number], [number, number]] | null {
  const coords = lineStringCoordsFromGeom(feature.geometry);
  if (!coords || coords.length < 2) return null;
  return [coords[0], coords[coords.length - 1]];
}

function pointCoord(feature: GeoJSON.Feature): [number, number] | null {
  const geom = feature.geometry;
  if (!geom || geom.type !== 'Point') return null;
  const c = geom.coordinates as [number, number];
  if (!Number.isFinite(c[0]) || !Number.isFinite(c[1])) return null;
  return c;
}

function lineMidpoint(feature: GeoJSON.Feature): [number, number] | null {
  const geom = feature.geometry;
  if (!geom || geom.type !== 'LineString') return null;
  const coords = geom.coordinates;
  if (!coords.length) return null;
  const mid = coords[Math.floor(coords.length / 2)] as [number, number];
  if (!Number.isFinite(mid[0]) || !Number.isFinite(mid[1])) return null;
  return mid;
}

function labelKindFromProps(props: GeoJSON.GeoJsonProperties): ImportSegmentLabelKind {
  const endRole = props?.end_role;
  if (endRole === 'to') return 'to';
  if (endRole === 'from') return 'from';
  const role = props?.role;
  if (role === 'end') return 'to';
  return 'from';
}

function assetIdFromProps(props: GeoJSON.GeoJsonProperties): string {
  const raw = props?.asset_id;
  if (raw != null && String(raw).trim()) return String(raw).trim();
  const labeled = String(props?.node_id ?? props?.map_label ?? '').trim();
  return labeled
    .replace(/^(FROM|TO)\s*(→|:)\s*(\w+:\s*)?/i, '')
    .trim();
}

function mergeEndLabel(
  kind: ImportSegmentLabelKind,
  currentId: string | undefined,
  proposedId: string | undefined,
  proposedKind: string | null | undefined,
  plain = false,
): string {
  const prefix = kind === 'to' ? 'TO' : 'FROM';
  const cur = currentId?.trim();
  const prop = proposedId?.trim();
  if (cur && prop && cur.toLowerCase() === prop.toLowerCase()) {
    return plain ? cur : `${prefix}: ${cur}`;
  }
  if (cur && prop) {
    return plain ? `${cur} → ${prop}` : `${prefix}: ${cur} → ${prop}`;
  }
  if (prop) {
    const kindLabel = endpointAssetKindLabel(proposedKind);
    if (plain) {
      return proposedKind && kindLabel !== 'asset' ? `${kindLabel}: ${prop}` : prop;
    }
    return proposedKind && kindLabel !== 'asset'
      ? `${prefix} → ${kindLabel}: ${prop}`
      : `${prefix} → ${prop}`;
  }
  if (cur) return plain ? cur : `${prefix}: ${cur}`;
  return '';
}

/** HTML marker labels — MapLibre symbol glyphs are unreliable in this stack. */
export function collectImportSegmentMapLabels(
  geojson: ImportSegmentHighlightGeoJson,
): ImportSegmentMapLabel[] {
  const labels: ImportSegmentMapLabel[] = [];
  const lineCoords = primaryLineCoords(geojson);
  const wireCoords = asBuiltLineCoords(geojson);
  const endpointFix = isEndpointFixHighlight(geojson);

  if (endpointFix && wireCoords && wireCoords.length >= 2) {
    labels.push({
      coord: wireCoords[0],
      text: 'START',
      kind: 'start-badge',
      inwardCoord: wireCoords[1],
    });
    labels.push({
      coord: wireCoords[wireCoords.length - 1],
      text: 'END',
      kind: 'end-badge',
      inwardCoord: wireCoords[wireCoords.length - 2],
    });
  }

  type EndState = {
    kind: ImportSegmentLabelKind;
    currentId?: string;
    proposedId?: string;
    proposedKind?: string | null;
    coord?: [number, number];
    proposedCoord?: [number, number];
  };

  const ends = new Map<ImportSegmentLabelKind, EndState>();

  const noteEnd = (
    feature: GeoJSON.Feature,
    proposed: boolean,
  ) => {
    const coord = pointCoord(feature);
    if (!coord) return;
    const props = feature.properties ?? {};
    const kind = labelKindFromProps(props);
    const state = ends.get(kind) ?? { kind };
    const id = assetIdFromProps(props);
    if (proposed) {
      state.proposedId = id || state.proposedId;
      state.proposedKind = (props.asset_kind as string | null | undefined) ?? state.proposedKind;
      state.proposedCoord = coord;
    } else {
      state.currentId = id || state.currentId;
      state.coord = coord;
    }
    ends.set(kind, state);
  };

  for (const feature of geojson.endpoints?.features ?? []) {
    noteEnd(feature, feature.properties?.proposed === true);
  }
  for (const feature of geojson.proposed_assets?.features ?? []) {
    noteEnd(feature, true);
  }

  for (const state of ends.values()) {
    const text = mergeEndLabel(
      state.kind,
      state.currentId,
      state.proposedId,
      state.proposedKind,
      endpointFix,
    );
    const coord = state.coord ?? state.proposedCoord;
    if (!text || !coord) continue;
    labels.push({ coord, text, kind: state.kind, inwardCoord: undefined });
  }

  if (lineCoords && lineCoords.length >= 2) {
    for (const label of labels) {
      if (label.kind === 'from') {
        label.inwardCoord = (wireCoords ?? lineCoords)[1];
      } else if (label.kind === 'to') {
        const span = wireCoords ?? lineCoords;
        label.inwardCoord = span[span.length - 2];
      }
    }
  }

  const seenLink = new Set<string>();
  for (const feature of geojson.suggested_links?.features ?? []) {
    const coord = lineMidpoint(feature);
    if (!coord) continue;
    const props = feature.properties ?? {};
    const text = String(props.dist_label ?? props.map_label ?? '').trim();
    if (!text) continue;
    const key = `${coord[0].toFixed(7)}|${coord[1].toFixed(7)}|${text}`;
    if (seenLink.has(key)) continue;
    seenLink.add(key);
    const endRole = String(props.end_role ?? props.role ?? '').toLowerCase();
    let inwardCoord: [number, number] | undefined;
    if (lineCoords && lineCoords.length >= 2) {
      if (endRole === 'from' || endRole === 'start') {
        inwardCoord = lineCoords[1];
      } else if (endRole === 'to' || endRole === 'end') {
        inwardCoord = lineCoords[lineCoords.length - 2];
      }
    }
    labels.push({
      coord,
      text,
      kind: 'link',
      linkEnds: lineEnds(feature) ?? undefined,
      inwardCoord,
    });
  }

  return labels;
}

/** Pin START / END badges on the wire tips (minimal offset). */
export function importSegmentDirectionBadgePlacement(
  map: MapProjectPoint,
  label: ImportSegmentMapLabel,
): { anchor: ImportSegmentLabelAnchor; offset: [number, number] } {
  if (label.inwardCoord) {
    const p = lngLatPoint(map, label.coord);
    const inward = lngLatPoint(map, label.inwardCoord);
    let ox = p.x - inward.x;
    let oy = p.y - inward.y;
    [ox, oy] = normalizeXY(ox, oy);
    const perpX = -oy;
    const perpY = ox;
    const sign = label.kind === 'start-badge' ? 1 : -1;
    return { anchor: 'center', offset: [perpX * 30 * sign, perpY * 30 * sign] };
  }
  return {
    anchor: 'center',
    offset: [0, label.kind === 'start-badge' ? -16 : 16],
  };
}

/** Push HTML callouts off endpoints / gap links so they do not cover geometry. */
export function importSegmentLabelMarkerPlacement(
  map: MapProjectPoint,
  label: ImportSegmentMapLabel,
): { anchor: ImportSegmentLabelAnchor; offset: [number, number] } {
  const margin = 8;
  const push = label.kind === 'link' ? 26 : 54;

  let ox = 0;
  let oy = -1;

  if (label.kind === 'link' && label.linkEnds) {
    const [a, b] = label.linkEnds;
    const pa = lngLatPoint(map, a);
    const pb = lngLatPoint(map, b);
    const dx = pb.x - pa.x;
    const dy = pb.y - pa.y;
    [ox, oy] = normalizeXY(-dy, dx);
    if (label.inwardCoord) {
      const start = lngLatPoint(map, a);
      const inward = lngLatPoint(map, label.inwardCoord);
      const outwardX = start.x - inward.x;
      const outwardY = start.y - inward.y;
      if (ox * outwardX + oy * outwardY < 0) {
        ox = -ox;
        oy = -oy;
      }
    }
  } else if (label.inwardCoord) {
    const pAnchor = lngLatPoint(map, label.coord);
    const pInward = lngLatPoint(map, label.inwardCoord);
    [ox, oy] = normalizeXY(pAnchor.x - pInward.x, pAnchor.y - pInward.y);
    const perpScale = label.kind === 'from' ? -16 : 16;
    const [ux, uy] = [ox, oy];
    [ox, oy] = normalizeXY(ux + (-uy * perpScale) / push, uy + (ux * perpScale) / push);
  }

  const offsetX = ox * (push + margin);
  const offsetY = oy * (push + margin);

  let anchor: ImportSegmentLabelAnchor;
  if (ox >= 0 && oy >= 0) anchor = 'top-left';
  else if (ox >= 0 && oy < 0) anchor = 'bottom-left';
  else if (ox < 0 && oy >= 0) anchor = 'top-right';
  else anchor = 'bottom-right';

  return { anchor, offset: [offsetX, offsetY] };
}

export function importSegmentLineHaloPaint(isLightMode: boolean) {
  return {
    'line-color': isLightMode ? '#ffffff' : '#0f172a',
    'line-width': ['interpolate', ['linear'], ['zoom'], 14, 9, 16, 11, 18, 13],
    'line-opacity': isLightMode ? 0.55 : 0.45,
  };
}

export function importSegmentLinePaint(_isLightMode: boolean) {
  return {
    'line-color': GIS_IMPORT_MAGENTA,
    'line-width': ['interpolate', ['linear'], ['zoom'], 14, 3, 16, 4, 18, 5],
    'line-opacity': 0.45,
  };
}

/** MapLibre highlight layers + badge placement expect LineString. */
export function asLineStringFeatureCollection(
  fc: GeoJSON.FeatureCollection | undefined,
): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  for (const feature of fc?.features ?? []) {
    const coords = lineStringCoordsFromGeom(feature.geometry);
    if (!coords) continue;
    features.push({
      type: 'Feature',
      properties: feature.properties ?? {},
      geometry: { type: 'LineString', coordinates: coords },
    });
  }
  return { type: 'FeatureCollection', features };
}

function lineStringCoords(feature: GeoJSON.Feature | undefined): [number, number][] | null {
  return lineStringCoordsFromGeom(feature?.geometry);
}

function approxMetersBetween(a: [number, number], b: [number, number]): number {
  const midLat = ((a[1] + b[1]) / 2) * (Math.PI / 180);
  const dx = (b[0] - a[0]) * 111320 * Math.cos(midLat);
  const dy = (b[1] - a[1]) * 110540;
  return Math.hypot(dx, dy);
}

/** True when after-snap geometry visibly moves vs as-built (worth a separate stroke). */
export function afterSnapLineVisiblyDiffers(
  line: GeoJSON.FeatureCollection | undefined,
  lineBefore: GeoJSON.FeatureCollection | undefined,
  minMoveM = IMPORT_SEGMENT_AFTER_SNAP_MIN_MOVE_M,
): boolean {
  const after = lineStringCoords(line?.features?.[0]);
  const before = lineStringCoords(lineBefore?.features?.[0]);
  if (!after) return false;
  if (!before) return true;
  const startMove = approxMetersBetween(before[0], after[0]);
  const endMove = approxMetersBetween(before[before.length - 1], after[after.length - 1]);
  return Math.max(startMove, endMove) >= minMoveM;
}

function pointNearWireEnd(
  point: [number, number],
  wire: [number, number][],
  tolM: number,
): boolean {
  if (wire.length < 2) return false;
  return (
    approxMetersBetween(point, wire[0]) <= tolM
    || approxMetersBetween(point, wire[wire.length - 1]) <= tolM
  );
}

/**
 * Drop gap links that redraw the whole as-built span (common on 2–5 m stubs where
 * the proposed node sits on the opposite wire tip). Those links bury the solid wire.
 */
export function filterGapLinksDistinctFromWire(
  links: GeoJSON.FeatureCollection | undefined,
  lineBefore: GeoJSON.FeatureCollection | undefined,
  tolM = 1.25,
): GeoJSON.FeatureCollection {
  const wire = lineStringCoords(lineBefore?.features?.[0]);
  const features: GeoJSON.Feature[] = [];
  for (const feature of links?.features ?? []) {
    const ends = lineEnds(feature);
    if (!ends || !wire) {
      features.push(feature);
      continue;
    }
    const [a, b] = ends;
    const spansWholeWire =
      pointNearWireEnd(a, wire, tolM) && pointNearWireEnd(b, wire, tolM);
    if (spansWholeWire) continue;
    features.push(feature);
  }
  return { type: 'FeatureCollection', features };
}

export function importSegmentEndpointPaint(isLightMode: boolean) {
  const unresolved = isLightMode ? '#dc2626' : '#f87171';
  const startResolved = isLightMode ? '#16a34a' : '#4ade80';
  const endResolved = isLightMode ? '#2563eb' : '#60a5fa';
  const startUnresolved = isLightMode ? '#ca8a04' : '#facc15';
  return {
    'circle-radius': ['interpolate', ['linear'], ['zoom'], 14, 4, 16, 5, 18, 6, 20, 6],
    'circle-color': [
      'case',
      ['all', ['==', ['get', 'role'], 'start'], ['==', ['get', 'resolved'], true]],
      startResolved,
      ['all', ['==', ['get', 'role'], 'start'], ['==', ['get', 'resolved'], false]],
      startUnresolved,
      ['all', ['==', ['get', 'role'], 'end'], ['==', ['get', 'resolved'], true]],
      endResolved,
      unresolved,
    ],
    'circle-stroke-color': isLightMode ? '#ffffff' : '#0f172a',
    'circle-stroke-width': 1.5,
    'circle-opacity': 1,
  };
}

export function importSegmentLabelLayout() {
  return {
    'text-field': ['coalesce', ['get', 'map_label'], ['get', 'node_id']],
    'text-size': 11,
    'text-offset': [0, 1.4],
    'text-anchor': 'top' as const,
    'text-max-width': 16,
    'text-allow-overlap': true,
    'text-ignore-placement': true,
    'text-font': GIOP_MAP_LABEL_FONT_REGULAR,
  };
}

export function importSegmentLabelPaint(isLightMode: boolean) {
  return {
    'text-color': [
      'case',
      ['==', ['get', 'end_role'], 'from'],
      isLightMode ? '#15803d' : '#4ade80',
      ['==', ['get', 'end_role'], 'to'],
      isLightMode ? '#b45309' : '#fbbf24',
      isLightMode ? '#0f172a' : '#f8fafc',
    ],
    'text-halo-color': isLightMode ? '#ffffff' : '#1e293b',
    'text-halo-width': 2,
  };
}

export function importSegmentLineArrowLayout() {
  return {
    'symbol-placement': 'line' as const,
    'symbol-spacing': 80,
    'text-field': '▶',
    'text-size': 12,
    'text-keep-upright': false,
    'text-allow-overlap': true,
    'text-ignore-placement': true,
    'text-rotation-alignment': 'map' as const,
    'text-pitch-alignment': 'viewport' as const,
    'text-font': GIOP_MAP_LABEL_FONT_REGULAR,
  };
}

export function importSegmentLineBeforeArrowPaint(isLightMode: boolean) {
  return {
    'text-color': isLightMode ? '#475569' : '#cbd5e1',
    'text-halo-color': isLightMode ? '#ffffff' : '#0f172a',
    'text-halo-width': 1.5,
    'text-opacity': 0.95,
  };
}

export function importSegmentLineArrowPaint(isLightMode: boolean) {
  return {
    'text-color': GIS_IMPORT_MAGENTA,
    'text-halo-color': isLightMode ? '#ffffff' : '#0f172a',
    'text-halo-width': 1.5,
    'text-opacity': 0.9,
  };
}

export function importSegmentProposedPaint(isLightMode: boolean) {
  const dt = isLightMode ? '#7c3aed' : '#c4b5fd';
  const pt = isLightMode ? '#b45309' : '#fcd34d';
  const pole = isLightMode ? '#0d9488' : '#5eead4';
  return {
    'circle-radius': ['interpolate', ['linear'], ['zoom'], 14, 5, 16, 6, 18, 7, 20, 7],
    'circle-color': [
      'match',
      ['get', 'asset_kind'],
      'distribution_transformer',
      dt,
      'power_transformer',
      pt,
      pole,
    ],
    'circle-stroke-color': isLightMode ? '#ffffff' : '#0f172a',
    'circle-stroke-width': 1.5,
    'circle-opacity': 1,
  };
}

export function importSegmentProposedLabelLayout() {
  return {
    'text-field': ['coalesce', ['get', 'map_label'], ['get', 'node_id']],
    'text-size': 11,
    'text-offset': [0, 1.6],
    'text-anchor': 'top' as const,
    'text-max-width': 18,
    'text-allow-overlap': true,
    'text-ignore-placement': true,
    'text-font': GIOP_MAP_LABEL_FONT_REGULAR,
  };
}

export function importSegmentLineBeforeHaloPaint(isLightMode: boolean) {
  return {
    'line-color': isLightMode ? '#facc15' : '#fde047',
    'line-width': ['interpolate', ['linear'], ['zoom'], 14, 14, 16, 18, 18, 22, 20, 26, 22, 30],
    'line-opacity': 1,
  };
}

export function importSegmentLineBeforePaint(isLightMode: boolean) {
  return {
    'line-color': isLightMode ? '#0f172a' : '#ffffff',
    'line-width': ['interpolate', ['linear'], ['zoom'], 14, 6, 16, 8, 18, 11, 20, 14, 22, 16],
    'line-opacity': 1,
  };
}

export function importSegmentSuggestedLinkPaint(_isLightMode: boolean) {
  return {
    'line-color': GIS_IMPORT_MAGENTA,
    'line-width': ['interpolate', ['linear'], ['zoom'], 14, 3, 16, 4, 18, 5],
    'line-opacity': 0.92,
    'line-dasharray': [2.5, 1.5],
  };
}

export function importSegmentLinkLabelLayout() {
  return {
    'symbol-placement': 'line-center' as const,
    'text-field': ['coalesce', ['get', 'dist_label'], ['get', 'map_label']],
    'text-size': 11,
    'text-offset': [0, -0.9],
    'text-allow-overlap': true,
    'text-ignore-placement': true,
    'text-rotation-alignment': 'viewport' as const,
    'text-font': GIOP_MAP_LABEL_FONT_REGULAR,
  };
}

export function importSegmentLinkLabelPaint(isLightMode: boolean) {
  return {
    'text-color': GIS_IMPORT_MAGENTA,
    'text-halo-color': isLightMode ? '#ffffff' : '#0f172a',
    'text-halo-width': 2,
  };
}
