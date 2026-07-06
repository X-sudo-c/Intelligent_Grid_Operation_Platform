import { useEffect, useState } from 'react';
import { getSampleConnectedNode } from '../api/giop-api';
import {
  pickTopologySeed,
  readCachedTopologySeedCenter,
  shouldAutoResolveTopologySeed,
  writeCachedTopologySeed,
  type TopologySeedCenter,
} from '../lib/giopTopologySeed';

export interface GiopTopologySeedState {
  topologySeed: string;
  seedCenter: TopologySeedCenter | null;
  /** False while fetching a national-graph seed to replace the demo island. */
  seedReady: boolean;
}

export function useGiopTopologySeed(routeStartMrid: string | undefined): GiopTopologySeedState {
  const [topologySeed, setTopologySeed] = useState(() => pickTopologySeed(routeStartMrid));
  const [seedCenter, setSeedCenter] = useState<TopologySeedCenter | null>(() =>
    readCachedTopologySeedCenter(),
  );
  const [seedReady, setSeedReady] = useState(
    () => !shouldAutoResolveTopologySeed(routeStartMrid),
  );

  useEffect(() => {
    const next = pickTopologySeed(routeStartMrid);
    setTopologySeed(next);
    setSeedCenter(readCachedTopologySeedCenter());
    if (!shouldAutoResolveTopologySeed(routeStartMrid)) {
      setSeedReady(true);
      return;
    }

    let cancelled = false;
    setSeedReady(false);
    void getSampleConnectedNode()
      .then((sample) => {
        if (cancelled || !sample?.mrid) return;
        const center =
          sample.lon != null && sample.lat != null
            ? { lon: sample.lon, lat: sample.lat }
            : null;
        writeCachedTopologySeed(sample.mrid, center);
        setTopologySeed(sample.mrid);
        setSeedCenter(center);
      })
      .catch(() => {
        /* keep demo seed as last resort */
      })
      .finally(() => {
        if (!cancelled) setSeedReady(true);
      });

    return () => {
      cancelled = true;
    };
  }, [routeStartMrid]);

  return { topologySeed, seedCenter, seedReady };
}
