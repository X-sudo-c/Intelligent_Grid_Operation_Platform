/** Imperative camera pan (ops desk + DQ side panel); flies when `id` changes. */
export interface GiopMapFlyRequest {
  id: number;
  coordinates: [number, number] | null;
  boostZoom?: boolean;
  /** When set, zoom to at least this level (duplicate fan / street-level identify). */
  targetZoom?: number;
}
