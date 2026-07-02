import type { GeoJSONSource, Map as MaplibreMap } from 'maplibre-gl';
import { GIOP_MAP_LABEL_FONT_BOLD } from './giopMapLayers';

export interface TerritoryGeoJson {
  type: 'FeatureCollection';
  features: Array<{
    type: 'Feature';
    properties?: Record<string, unknown>;
    geometry: { type: string; coordinates: unknown };
  }>;
}

export const TERRITORY_HIGHLIGHT_SOURCE = 'territory-highlight';
export const TERRITORY_HIGHLIGHT_FILL = 'territory-highlight-fill';
export const TERRITORY_HIGHLIGHT_OUTLINE = 'territory-highlight-outline';
export const TERRITORY_HIGHLIGHT_LABEL = 'territory-highlight-label';

export interface TerritoryHighlightState {
  geojson: TerritoryGeoJson;
  label: string;
  district?: string;
  region?: string;
}

export function applyTerritoryHighlight(
  map: MaplibreMap,
  highlight: TerritoryHighlightState,
  light: boolean,
): void {
  const existing = map.getSource(TERRITORY_HIGHLIGHT_SOURCE) as GeoJSONSource | undefined;
  const geojsonData = highlight.geojson as Parameters<GeoJSONSource['setData']>[0];
  if (existing) {
    existing.setData(geojsonData);
  } else {
    map.addSource(TERRITORY_HIGHLIGHT_SOURCE, {
      type: 'geojson',
      data: geojsonData,
    });
  }

  const fillColor = light ? '#f59e0b' : '#fbbf24';
  const outlineColor = light ? '#b45309' : '#fcd34d';
  const labelColor = light ? '#78350f' : '#fef3c7';
  const labelHalo = light ? '#fffbeb' : '#451a03';

  if (!map.getLayer(TERRITORY_HIGHLIGHT_FILL)) {
    map.addLayer({
      id: TERRITORY_HIGHLIGHT_FILL,
      type: 'fill',
      source: TERRITORY_HIGHLIGHT_SOURCE,
      paint: {
        'fill-color': fillColor,
        'fill-opacity': 0.28,
        'fill-antialias': true,
      },
    });
  } else {
    map.setPaintProperty(TERRITORY_HIGHLIGHT_FILL, 'fill-color', fillColor);
  }

  if (!map.getLayer(TERRITORY_HIGHLIGHT_OUTLINE)) {
    map.addLayer({
      id: TERRITORY_HIGHLIGHT_OUTLINE,
      type: 'line',
      source: TERRITORY_HIGHLIGHT_SOURCE,
      paint: {
        'line-color': outlineColor,
        'line-width': 3.5,
        'line-opacity': 0.95,
      },
    });
  } else {
    map.setPaintProperty(TERRITORY_HIGHLIGHT_OUTLINE, 'line-color', outlineColor);
  }

  if (!map.getLayer(TERRITORY_HIGHLIGHT_LABEL)) {
    map.addLayer({
      id: TERRITORY_HIGHLIGHT_LABEL,
      type: 'symbol',
      source: TERRITORY_HIGHLIGHT_SOURCE,
      layout: {
        'text-field': highlight.label,
        'text-size': 15,
        'text-font': GIOP_MAP_LABEL_FONT_BOLD,
        'text-anchor': 'center',
        'text-allow-overlap': true,
        'text-ignore-placement': true,
      },
      paint: {
        'text-color': labelColor,
        'text-halo-color': labelHalo,
        'text-halo-width': 2.5,
      },
    });
  } else {
    map.setLayoutProperty(TERRITORY_HIGHLIGHT_LABEL, 'text-field', highlight.label);
    map.setPaintProperty(TERRITORY_HIGHLIGHT_LABEL, 'text-color', labelColor);
    map.setPaintProperty(TERRITORY_HIGHLIGHT_LABEL, 'text-halo-color', labelHalo);
  }
}

export function clearTerritoryHighlight(map: MaplibreMap): void {
  for (const id of [
    TERRITORY_HIGHLIGHT_LABEL,
    TERRITORY_HIGHLIGHT_OUTLINE,
    TERRITORY_HIGHLIGHT_FILL,
  ]) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
  if (map.getSource(TERRITORY_HIGHLIGHT_SOURCE)) map.removeSource(TERRITORY_HIGHLIGHT_SOURCE);
}
