/**
 * ECG administrative boundaries map layer (Martin source `ecg_admin_boundaries`).
 * Columns come from the imported GeoPackage, so the identify popup renders
 * whatever attributes are present rather than assuming a fixed schema.
 */
import type { Map as MaplibreMap, MapGeoJSONFeature } from 'maplibre-gl';

export const ECG_BOUNDARY_SOURCE = 'ecg_admin_boundaries';
export const ECG_REGION_SOURCE = 'ecg_admin_regions';
export const ECG_REGION_FILL = 'ecg-regions-fill';
export const ECG_REGION_OUTLINE = 'ecg-regions-outline';
export const ECG_REGION_LABEL = 'ecg-regions-label';
export const ECG_BOUNDARY_FILL = 'ecg-boundaries-fill';
export const ECG_BOUNDARY_OUTLINE = 'ecg-boundaries-outline';
export const ECG_BOUNDARY_LABEL_DISTRICT = 'ecg-boundaries-label-district';

/** Zoom below this shows region outlines/labels; at/above shows districts. */
export const ECG_DISTRICT_MIN_ZOOM = 10;

export const ECG_BOUNDARY_LAYER_IDS = [
  ECG_REGION_FILL,
  ECG_REGION_OUTLINE,
  ECG_REGION_LABEL,
  ECG_BOUNDARY_FILL,
  ECG_BOUNDARY_OUTLINE,
  ECG_BOUNDARY_LABEL_DISTRICT,
] as const;

/** Layers used for boundary identify clicks (region + district). */
export const ECG_BOUNDARY_HIT_LAYER_IDS = [
  ECG_REGION_FILL,
  ECG_REGION_OUTLINE,
  ECG_BOUNDARY_FILL,
  ECG_BOUNDARY_OUTLINE,
] as const;

/** Extract district/region labels from an ECG boundary feature. */
export function territoryFromBoundaryFeature(
  feature: { properties?: Record<string, unknown> | null },
): { district?: string; region?: string } {
  const props = feature.properties ?? {};
  const pick = (...keys: string[]) => {
    for (const key of keys) {
      const found = Object.entries(props).find(([k]) => k.toLowerCase() === key);
      if (found && found[1] != null && String(found[1]).trim() !== '') {
        return String(found[1]).trim();
      }
    }
    return undefined;
  };
  return {
    district: pick('district', 'district_name', 'name'),
    region: pick('region', 'region_name'),
  };
}

/** Popup title: ECG district name, then region. */
const TITLE_KEYS = ['district', 'district_name', 'name', 'region', 'region_name'];

/** Keys omitted from the attribute list (title + internal ids). */
const SKIP_KEYS = /^(fid|ogc_fid|id|gid|geom|wkb_geometry)$/i;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function prettyKey(key: string): string {
  return key.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function pickTitle(props: Record<string, unknown>): { titleKey?: string; title: string } {
  const entries = Object.entries(props);
  for (const candidate of TITLE_KEYS) {
    const found = entries.find(([k]) => k.toLowerCase() === candidate);
    if (found && found[1] != null && String(found[1]).trim() !== '') {
      return { titleKey: found[0], title: String(found[1]) };
    }
  }
  return { title: 'ECG boundary' };
}

export function setEcgBoundaryVisibility(map: MaplibreMap, visible: boolean): void {
  const value = visible ? 'visible' : 'none';
  for (const id of ECG_BOUNDARY_LAYER_IDS) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', value);
  }
}

export function applyEcgBoundaryTheme(map: MaplibreMap, light: boolean): void {
  const textColor = light ? '#0c4a6e' : '#e0f2fe';
  const haloColor = light ? '#ffffff' : '#0f172a';
  const fillColor = light ? '#0284c7' : '#38bdf8';
  const lineColor = light ? '#0369a1' : '#7dd3fc';
  for (const id of [ECG_REGION_LABEL, ECG_BOUNDARY_LABEL_DISTRICT]) {
    if (!map.getLayer(id)) continue;
    map.setPaintProperty(id, 'text-color', textColor);
    map.setPaintProperty(id, 'text-halo-color', haloColor);
  }
  for (const id of [ECG_REGION_FILL, ECG_BOUNDARY_FILL]) {
    if (!map.getLayer(id)) continue;
    map.setPaintProperty(id, 'fill-color', fillColor);
  }
  for (const id of [ECG_REGION_OUTLINE, ECG_BOUNDARY_OUTLINE]) {
    if (!map.getLayer(id)) continue;
    map.setPaintProperty(id, 'line-color', lineColor);
    map.setPaintProperty(id, 'line-opacity', 0.95);
  }
}

export function ecgBoundaryPopupHtml(feature: MapGeoJSONFeature, light = false): string {
  const props = (feature.properties ?? {}) as Record<string, unknown>;
  const { titleKey, title } = pickTitle(props);

  const rows: string[] = [];
  for (const [key, raw] of Object.entries(props)) {
    if (key === titleKey) continue;
    if (raw == null || String(raw).trim() === '') continue;
    if (SKIP_KEYS.test(key)) continue;
    rows.push(
      `<div class="giop-map-hover__row"><span class="giop-map-hover__label">${escapeHtml(
        prettyKey(key),
      )}</span><span class="giop-map-hover__value">${escapeHtml(String(raw))}</span></div>`,
    );
  }

  const themeClass = light ? 'giop-map-hover--light' : 'giop-map-hover--dark';
  return `<div class="giop-map-hover ${themeClass}">
    <div class="giop-map-hover__title">${escapeHtml(title)}</div>
    ${
      rows.length > 0
        ? `<div class="giop-map-hover__body">${rows.join('')}</div>`
        : '<div class="giop-map-hover__hint">ECG administrative boundary</div>'
    }
  </div>`;
}
