import { useEffect, useMemo, useState } from 'react';
import {
  getMapPlacesIndex,
  type GiopFieldTechnician,
  type GiopMapSearchResult,
  type GiopStagingAsset,
  type GiopWorkOrder,
} from '../api/giop-api';
import { buildOpsSearchCatalog } from '../lib/giopMapLocalSearch';

/** Stable defaults — avoid `= []` in props/deps (new reference every render). */
export const EMPTY_STAGING_ASSETS: GiopStagingAsset[] = [];
export const EMPTY_WORK_ORDERS: GiopWorkOrder[] = [];
export const EMPTY_FIELD_TECHNICIANS: GiopFieldTechnician[] = [];

let cachedPlaces: GiopMapSearchResult[] | null = null;
let placesPromise: Promise<GiopMapSearchResult[]> | null = null;

function loadPlacesIndex(): Promise<GiopMapSearchResult[]> {
  if (cachedPlaces) return Promise.resolve(cachedPlaces);
  if (!placesPromise) {
    placesPromise = getMapPlacesIndex()
      .then((places) => {
        cachedPlaces = places;
        return places;
      })
      .catch(() => {
        placesPromise = null;
        return [] as GiopMapSearchResult[];
      });
  }
  return placesPromise;
}

export function useGiopMapSearchCatalog(options: {
  workOrders?: GiopWorkOrder[];
  fieldTechnicians?: GiopFieldTechnician[];
  stagingAssets?: GiopStagingAsset[];
}) {
  const [places, setPlaces] = useState<GiopMapSearchResult[]>(cachedPlaces ?? []);
  const [placesReady, setPlacesReady] = useState(cachedPlaces !== null);

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

  return { placeCatalog: places, opsCatalog, placesReady };
}
