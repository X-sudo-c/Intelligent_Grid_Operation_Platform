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
  const detail = configs.find((c) => c.slug === detailSlug);
  if (!detail) {
    return [...(BUILTIN_BOUNDARY_LAYERS[detailSlug] ?? [])];
  }

  if (detail.built_in_map_style && detail.render_mode === 'martin') {
    return [...(BUILTIN_BOUNDARY_LAYERS[detailSlug] ?? [])];
  }

  return relatedBoundarySlugs(detailSlug, configs).flatMap((slug) => catalogLayerIdsForSlug(slug));
}

export function boundaryHitLayerIds(
  visibility: Record<string, boolean>,
  configs: GiopReferenceMapLayerConfig[],
): string[] {
  const hit: string[] = [];
  for (const product of listBoundaryOverlayProducts(configs)) {
    if (!visibility[product.slug]) continue;
    const detail = configs.find((c) => c.slug === product.slug);
    if (detail?.built_in_map_style && detail.render_mode === 'martin') {
      hit.push('ecg-regions-fill', 'ecg-regions-outline', 'ecg-boundaries-fill', 'ecg-boundaries-outline');
      continue;
    }
    for (const slug of relatedBoundarySlugs(product.slug, configs)) {
      hit.push(`ref-${slug}-fill`, `ref-${slug}-line`);
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
  for (const layerId of layerIdsForBoundaryProduct(detailSlug, configs)) {
    if (map.getLayer(layerId)) {
      map.setLayoutProperty(layerId, 'visibility', value);
    }
  }
}

export function applyAllBoundaryVisibility(
  map: MaplibreMap,
  visibility: Record<string, boolean>,
  configs: GiopReferenceMapLayerConfig[],
): void {
  for (const product of listBoundaryOverlayProducts(configs)) {
    setBoundaryProductVisibility(map, product.slug, Boolean(visibility[product.slug]), configs);
  }
}
