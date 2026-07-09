/**
 * Catalog-driven GIS reference layer overlays (GeoJSON + dynamic Martin).
 */
import type { GeoJSONSource, Map as MaplibreMap } from 'maplibre-gl';
import {
  ECG_BOUNDARY_FILL,
  ECG_BOUNDARY_LABEL_DISTRICT,
  ECG_BOUNDARY_OUTLINE,
} from './giopBoundaries';
import type { GiopReferenceMapLayerConfig } from '../api/giop-api';
import { getReferenceLayerGeojson } from '../api/giop-api';

/** Built-in Martin layers to hide when catalog serves the same slug via GeoJSON. */
export const REFERENCE_BUILTIN_MARTIN_HIDE: Record<string, string[]> = {
  'ecg-admin-boundaries': [
    ECG_BOUNDARY_FILL,
    ECG_BOUNDARY_OUTLINE,
    ECG_BOUNDARY_LABEL_DISTRICT,
    'ecg-regions-fill',
    'ecg-regions-outline',
    'ecg-regions-label',
  ],
};

function sourceId(slug: string): string {
  return `ref-${slug}`;
}

function geomFamily(geometryType?: string | null): 'polygon' | 'line' | 'point' {
  const g = (geometryType || '').toUpperCase();
  if (g.includes('POLYGON')) return 'polygon';
  if (g.includes('LINE')) return 'line';
  return 'point';
}

function referencePaint(kind: string, family: 'polygon' | 'line' | 'point', light: boolean) {
  const boundary = kind === 'boundary';
  const fill = boundary ? (light ? '#0ea5e9' : '#38bdf8') : light ? '#8b5cf6' : '#a78bfa';
  const line = boundary ? (light ? '#0369a1' : '#7dd3fc') : light ? '#6d28d9' : '#c4b5fd';
  if (family === 'polygon') {
    return {
      fill: {
        'fill-color': fill,
        'fill-opacity': boundary ? 0.12 : 0.18,
        'fill-antialias': false,
      },
      line: {
        'line-color': line,
        'line-width': 1.5,
        'line-opacity': 0.9,
      },
    };
  }
  if (family === 'line') {
    return {
      line: {
        'line-color': line,
        'line-width': 1.4,
        'line-opacity': 0.85,
      },
    };
  }
  return {
    point: {
      'circle-radius': 4,
      'circle-color': fill,
      'circle-stroke-width': 1,
      'circle-stroke-color': '#ffffff',
      'circle-opacity': 0.85,
    },
  };
}

function setBuiltInMartinVisibility(map: MaplibreMap, configs: GiopReferenceMapLayerConfig[]): void {
  for (const cfg of configs) {
    if (!cfg.built_in_map_style) continue;
    if (cfg.render_mode !== 'geojson_static' && cfg.render_mode !== 'geojson_bbox') continue;
    // Only hide built-in Martin once the catalog GeoJSON source is on the map.
    // Hiding earlier leaves a gap if the GeoJSON fetch fails or is still in flight.
    if (!map.getSource(sourceId(cfg.slug))) continue;
    const hideIds = REFERENCE_BUILTIN_MARTIN_HIDE[cfg.slug] ?? [];
    for (const layerId of hideIds) {
      if (map.getLayer(layerId)) {
        map.setLayoutProperty(layerId, 'visibility', 'none');
      }
    }
  }
}

function restoreBuiltInMartinVisibility(map: MaplibreMap): void {
  for (const layerIds of Object.values(REFERENCE_BUILTIN_MARTIN_HIDE)) {
    for (const layerId of layerIds) {
      if (map.getLayer(layerId)) {
        map.setLayoutProperty(layerId, 'visibility', 'visible');
      }
    }
  }
}

function addGeoJsonLayers(
  map: MaplibreMap,
  cfg: GiopReferenceMapLayerConfig,
  data: GeoJSON.FeatureCollection,
  light: boolean,
): void {
  const sid = sourceId(cfg.slug);
  const family = geomFamily(cfg.geometry_type);
  const paint = referencePaint(cfg.kind, family, light);
  const minz = cfg.is_overview_derived
    ? (cfg.min_zoom ?? 0)
    : (cfg.detail_min_zoom ?? cfg.min_zoom ?? 0);
  const maxz = cfg.is_overview_derived
    ? (cfg.detail_min_zoom ?? cfg.max_zoom ?? 24)
    : (cfg.max_zoom ?? 24);

  if (map.getSource(sid)) {
    (map.getSource(sid) as GeoJSONSource).setData(data);
    return;
  }

  map.addSource(sid, { type: 'geojson', data });

  const hidden = { visibility: 'none' as const };

  if (family === 'polygon' && paint.fill) {
    map.addLayer({
      id: `${sid}-fill`,
      type: 'fill',
      source: sid,
      minzoom: minz,
      maxzoom: maxz,
      layout: hidden,
      paint: paint.fill,
    });
  }
  if (paint.line) {
    map.addLayer({
      id: `${sid}-line`,
      type: 'line',
      source: sid,
      minzoom: minz,
      maxzoom: maxz,
      layout: hidden,
      paint: paint.line,
    });
  }
  if (family === 'point' && paint.point) {
    map.addLayer({
      id: `${sid}-point`,
      type: 'circle',
      source: sid,
      minzoom: minz,
      maxzoom: maxz,
      layout: hidden,
      paint: paint.point,
    });
  }
}

function addMartinLayers(
  map: MaplibreMap,
  cfg: GiopReferenceMapLayerConfig,
  light: boolean,
): void {
  if (!cfg.martin || cfg.built_in_map_style) return;
  const sid = sourceId(cfg.slug);
  const martinId = cfg.martin.source_id;
  if (map.getSource(sid)) return;

  map.addSource(sid, {
    type: 'vector',
    tiles: cfg.martin.tiles,
    minzoom: cfg.min_zoom ?? 0,
    maxzoom: cfg.max_zoom ?? 14,
  });

  const family = geomFamily(cfg.geometry_type);
  const paint = referencePaint(cfg.kind, family, light);
  const minz = cfg.is_overview_derived
    ? (cfg.min_zoom ?? 0)
    : (cfg.detail_min_zoom ?? cfg.min_zoom ?? 0);
  const maxz = cfg.is_overview_derived
    ? (cfg.detail_min_zoom ?? cfg.max_zoom ?? 14)
    : (cfg.max_zoom ?? 14);

  const hidden = { visibility: 'none' as const };

  if (family === 'polygon' && paint.fill) {
    map.addLayer({
      id: `${sid}-fill`,
      type: 'fill',
      source: sid,
      'source-layer': martinId,
      minzoom: minz,
      maxzoom: maxz,
      layout: hidden,
      paint: paint.fill,
    });
  }
  if (paint.line) {
    map.addLayer({
      id: `${sid}-line`,
      type: 'line',
      source: sid,
      'source-layer': martinId,
      minzoom: minz,
      maxzoom: maxz,
      layout: hidden,
      paint: paint.line,
    });
  }
  if (family === 'point' && paint.point) {
    map.addLayer({
      id: `${sid}-point`,
      type: 'circle',
      source: sid,
      'source-layer': martinId,
      minzoom: minz,
      maxzoom: maxz,
      layout: hidden,
      paint: paint.point,
    });
  }
}

export async function applyReferenceMapConfig(
  map: MaplibreMap,
  configs: GiopReferenceMapLayerConfig[],
  light: boolean,
): Promise<void> {
  for (const cfg of configs) {
    if (cfg.render_mode === 'martin') {
      addMartinLayers(map, cfg, light);
      continue;
    }
    if (cfg.render_mode === 'geojson_static') {
      const data = await getReferenceLayerGeojson(cfg.slug);
      addGeoJsonLayers(map, cfg, data as GeoJSON.FeatureCollection, light);
      continue;
    }
    // geojson_bbox layers are updated on viewport change
  }
  // After GeoJSON sources exist, hide duplicate built-in Martin layers.
  setBuiltInMartinVisibility(map, configs);
}

export async function refreshReferenceBboxLayers(
  map: MaplibreMap,
  configs: GiopReferenceMapLayerConfig[],
  bbox: { west: number; south: number; east: number; north: number },
  light: boolean,
): Promise<void> {
  const bboxLayers = configs.filter((c) => c.render_mode === 'geojson_bbox');
  for (const cfg of bboxLayers) {
    const data = await getReferenceLayerGeojson(cfg.slug, bbox);
    addGeoJsonLayers(map, cfg, data as GeoJSON.FeatureCollection, light);
  }
}

export function teardownReferenceLayers(map: MaplibreMap): void {
  restoreBuiltInMartinVisibility(map);
  const style = map.getStyle();
  if (!style?.layers) return;
  for (const layer of style.layers) {
    if (!layer.id.startsWith('ref-')) continue;
    if (map.getLayer(layer.id)) map.removeLayer(layer.id);
  }
  if (style.sources) {
    for (const sid of Object.keys(style.sources)) {
      if (sid.startsWith('ref-') && map.getSource(sid)) map.removeSource(sid);
    }
  }
}
