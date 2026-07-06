import type { GiopMapSearchResult } from '../api/giop-api';

/** Lets a parent toolbar drive map search while the map owns camera + handlers. */
export interface GiopMapSearchBridge {
  onPreview: (result: GiopMapSearchResult | null) => void;
  onSelect: (result: GiopMapSearchResult) => void;
  placeCatalog: GiopMapSearchResult[];
  opsCatalog: GiopMapSearchResult[];
  placesReady: boolean;
}
