import { useEffect, useMemo, useState } from 'react';
import {
  getMapPlacesIndex,
  type GiopFieldTechnician,
  type GiopMapSearchResult,
  type GiopStagingAsset,
  type GiopWorkOrder,
} from '../api/giop-api';
import { buildOpsSearchCatalog } from '../lib/giopMapLocalSearch';
import { readSwCache } from '../lib/giopSwCache';

/** Stable defaults — avoid `= []` in props/deps (new reference every render). */
export const EMPTY_STAGING_ASSETS: GiopStagingAsset[] = [];
export const EMPTY_WORK_ORDERS: GiopWorkOrder[] = [];
export const EMPTY_FIELD_TECHNICIANS: GiopFieldTechnician[] = [];

const PLACES_SW_KEY = 'map-places-index';

let cachedPlaces: GiopMapSearchResult[] | null = null;
let placesPromise: Promise<GiopMapSearchResult[]> | null = null;

function sessionPlaces(): GiopMapSearchResult[] | null {
  const cached = readSwCache<GiopMapSearchResult[]>(PLACES_SW_KEY);
  return cached && cached.length > 0 ? cached : null;
}

/** Shared districts/regions catalog (cached across map search + steward panels). */
export function loadPlacesIndex(): Promise<GiopMapSearchResult[]> {
  if (cachedPlaces) return Promise.resolve(cachedPlaces);

  const fromSession = sessionPlaces();
  if (fromSession && !placesPromise) {
    cachedPlaces = fromSession;
    // Revalidate in background; keep returning session data immediately.
    placesPromise = getMapPlacesIndex()
      .then((places) => {
        cachedPlaces = places;
        return places;
      })
      .catch(() => {
        placesPromise = null;
        return cachedPlaces ?? [];
      });
    return Promise.resolve(fromSession);
  }

  if (!placesPromise) {
    placesPromise = getMapPlacesIndex()
      .then((places) => {
        cachedPlaces = places;
        return places;
      })
      .catch(() => {
        placesPromise = null;
        return (sessionPlaces() ?? []) as GiopMapSearchResult[];
      });
  }
  return placesPromise;
}

/** ECG admin district names for steward filters (excludes regions). */
export function districtNamesFromPlaces(places: GiopMapSearchResult[]): string[] {
  const names = new Set<string>();
  for (const place of places) {
    const title = place.title?.trim();
    if (!title) continue;
    const isDistrict =
      place.place_type === 'district' ||
      (!place.place_type && place.id?.startsWith('district:'));
    if (!isDistrict) continue;
    names.add(title);
  }
  return [...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

export function useGiopMapSearchCatalog(options: {
  workOrders?: GiopWorkOrder[];
  fieldTechnicians?: GiopFieldTechnician[];
  stagingAssets?: GiopStagingAsset[];
}) {
  const [places, setPlaces] = useState<GiopMapSearchResult[]>(() => {
    if (cachedPlaces) return cachedPlaces;
    return sessionPlaces() ?? [];
  });
  const [placesReady, setPlacesReady] = useState(
    () => cachedPlaces !== null || sessionPlaces() !== null,
  );

  useEffect(() => {
    let cancelled = false;
    void loadPlacesIndex().then((loaded) => {
      if (cancelled) return;
      setPlaces(loaded);
      setPlacesReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const opsCatalog = useMemo(
    () =>
      buildOpsSearchCatalog({
        workOrders: options.workOrders ?? EMPTY_WORK_ORDERS,
        fieldTechnicians: options.fieldTechnicians ?? EMPTY_FIELD_TECHNICIANS,
        stagingAssets: options.stagingAssets ?? EMPTY_STAGING_ASSETS,
      }),
    [options.workOrders, options.fieldTechnicians, options.stagingAssets],
  );

  return { placeCatalog: places, places, placesReady, opsCatalog };
}
