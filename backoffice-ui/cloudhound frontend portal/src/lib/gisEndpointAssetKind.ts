/** Steward-facing labels for GIS endpoint proposal asset kinds. */
export const ENDPOINT_ASSET_KIND_LABELS: Record<string, string> = {
  pole_11kv: '11 kV pole',
  pole_33kv: '33 kV pole',
  pole_lv: 'LV pole',
  distribution_transformer: 'DT',
  power_transformer: 'PT',
  connectivity_asset: 'asset',
};

export function endpointAssetKindLabel(kind: string | null | undefined): string {
  if (!kind) return 'asset';
  return ENDPOINT_ASSET_KIND_LABELS[kind] ?? kind.replace(/_/g, ' ');
}
