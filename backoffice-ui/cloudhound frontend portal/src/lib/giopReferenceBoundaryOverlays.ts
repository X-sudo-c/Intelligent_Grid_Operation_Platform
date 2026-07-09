/**
 * Catalog-driven boundary overlay toggles (one switch per imported boundary product).
 */
import type { Map as MaplibreMap } from 'maplibre-gl';
import type { GiopReferenceMapLayerConfig } from '../api/giop-api';
import { ECG_BOUNDARY_LAYER_IDS } from './giopBoundaries';

export interface BoundaryOverlayProduct {
  slug: string;
  display_name: string;
  hint?: string;
}

const BUILTIN_BOUNDARY_LAYERS: Record<string, readonly string[]> = {
  'ecg-admin-boundaries': ECG_BOUNDARY_LAYER_IDS,
};

const REF_LAYER_SUFFIXES = ['fill', 'line', 'point'] as const;

function catalogLayerIdsForSlug(slug: string): string[] {
  const sid = `ref-${slug}`;
  return REF_LAYER_SUFFIXES.map((suffix) => `${sid}-${suffix}`);
}

function relatedBoundarySlugs(
  detailSlug: string,
  configs: GiopReferenceMapLayerConfig[],
): string[] {
  const slugs = [detailSlug];
  const overview = configs.find((c) => c.parent_slug === detailSlug && c.is_overview_derived);
  if (overview) slugs.push(overview.slug);
  return slugs;
}

export function listBoundaryOverlayProducts(
  configs: GiopReferenceMapLayerConfig[],
): BoundaryOverlayProduct[] {
  return configs
    .filter(
      (c) =>
        c.kind === 'boundary' &&
        !c.is_overview_derived &&
        c.render_mode !== 'none' &&
        (c.feature_count == null || c.feature_count > 0),
    )
    .map((c) => {
      const zoom = c.detail_min_zoom;
      const hint =
        zoom != null
          ? `Overview below zoom ${zoom}, detail at/above`
          : 'Imported boundary reference layer';
      return {
        slug: c.slug,
        display_name: c.display_name,
        hint,
      };
    })
    .sort((a, b) => a.display_name.localeCompare(b.display_name));
}

export function layerIdsForBoundaryProduct(
  detailSlug: string,
  configs: GiopReferenceMapLayerConfig[],
): string[] {
  // Built-in ECG admin layers live in the base map style (regions + districts).
  // Always target those ids — never ref-* placeholders that were never added.
  const builtin = BUILTIN_BOUNDARY_LAYERS[detailSlug];
  if (builtin) return [...builtin];

  const detail = configs.find((c) => c.slug === detailSlug);
  if (!detail) return [];

  if (detail.built_in_map_style && detail.render_mode === 'martin') {
    return [];
  }

  return relatedBoundarySlugs(detailSlug, configs).flatMap((slug) => catalogLayerIdsForSlug(slug));
}

export function boundaryHitLayerIds(
  visibility: Record<string, boolean>,
  configs: GiopReferenceMapLayerConfig[],
): string[] {
  const hit: string[] = [];
  const products = listBoundaryOverlayProducts(configs);
  const slugs = new Set(products.map((p) => p.slug));
  for (const slug of Object.keys(BUILTIN_BOUNDARY_LAYERS)) slugs.add(slug);

  for (const slug of slugs) {
    if (!visibility[slug]) continue;
    if (BUILTIN_BOUNDARY_LAYERS[slug]) {
      hit.push(
        'ecg-regions-fill',
        'ecg-regions-outline',
        'ecg-boundaries-fill',
        'ecg-boundaries-outline',
      );
      continue;
    }
    for (const related of relatedBoundarySlugs(slug, configs)) {
      hit.push(`ref-${related}-fill`, `ref-${related}-line`);
    }
  }
  return [...new Set(hit)];
}

export function setBoundaryProductVisibility(
  map: MaplibreMap,
  detailSlug: string,
  visible: boolean,
  configs: GiopReferenceMapLayerConfig[],
): void {
  const value = visible ? 'visible' : 'none';
  let touched = 0;
  for (const layerId of layerIdsForBoundaryProduct(detailSlug, configs)) {
    if (!map.getLayer(layerId)) continue;
    map.setLayoutProperty(layerId, 'visibility', value);
    touched += 1;
  }
  // Stale catalog metadata can point at missing ref-* layers — fall back to built-ins.
  if (touched === 0) {
    const builtin = BUILTIN_BOUNDARY_LAYERS[detailSlug];
    if (!builtin) return;
    for (const layerId of builtin) {
      if (!map.getLayer(layerId)) continue;
      map.setLayoutProperty(layerId, 'visibility', value);
    }
  }
}

export function applyAllBoundaryVisibility(
  map: MaplibreMap,
  visibility: Record<string, boolean>,
  configs: GiopReferenceMapLayerConfig[],
): void {
  const products = listBoundaryOverlayProducts(configs);
  const slugs = new Set(products.map((p) => p.slug));
  // Keep built-in ECG toggle working even before map-config finishes loading.
  for (const slug of Object.keys(BUILTIN_BOUNDARY_LAYERS)) {
    slugs.add(slug);
  }
  for (const slug of slugs) {
    setBoundaryProductVisibility(map, slug, Boolean(visibility[slug]), configs);
  }
}
