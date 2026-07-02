import type { FeatureCollection } from 'geojson';
import type { Map as MaplibreMap } from 'maplibre-gl';
import type { GiopDqQueueItem } from '../api/giop-api';
import { DUPLICATE_CLUSTER_ZOOM } from './giopMapLayers';
import type { DqQueueLocationCluster } from './giopDqLocationClusters';
import {
  partitionDqQueueItems,
  queueItemDuplicateDetected,
} from './giopDqLocationClusters';

/** Fan radius in metres — visible separation at DUPLICATE_CLUSTER_ZOOM. */
export const DUPLICATE_FAN_RADIUS_M = 16;

/** Seconds for one full colocated-fan orbit. */
export const DUPLICATE_FAN_ORBIT_PERIOD_S = 52;

/** Bright fan palette — same vivid colors on light and dark basemaps. */
export const DUPLICATE_FAN_COLORS_BRIGHT = [
  '#06b6d4',
  '#f59e0b',
  '#a855f7',
  '#22c55e',
  '#ef4444',
  '#3b82f6',
  '#ec4899',
] as const;

/** @deprecated Use DUPLICATE_FAN_COLORS_BRIGHT */
export const DUPLICATE_FAN_COLORS_DARK = DUPLICATE_FAN_COLORS_BRIGHT;

/** @deprecated Use DUPLICATE_FAN_COLORS_BRIGHT */
export const DUPLICATE_FAN_COLORS_LIGHT = DUPLICATE_FAN_COLORS_BRIGHT;

export function duplicateFanPinColor(index: number, _isLightMode?: boolean): string {
  return DUPLICATE_FAN_COLORS_BRIGHT[index % DUPLICATE_FAN_COLORS_BRIGHT.length];
}

/** @deprecated Use duplicateFanPinColor(index) */
export const DUPLICATE_FAN_COLORS = DUPLICATE_FAN_COLORS_BRIGHT;

export interface DuplicateClusterMapStyle {
  spokeColor: string;
  spokeActiveWidth: number;
  spokeInactiveWidth: number;
  spokeActiveOpacity: number;
  spokeInactiveOpacity: number;
  centerColor: string;
  centerStroke: string;
  pinStroke: string;
  pinActiveStroke: string;
  pinInactiveRadius: number;
  pinActiveRadius: number;
  labelColor: string;
  labelActiveColor: string;
  labelHalo: string;
  labelHaloWidth: number;
  nearLineColor: string;
  nearLineWidth: number;
  nearLineOpacity: number;
}

export function duplicateClusterMapStyle(isLightMode: boolean): DuplicateClusterMapStyle {
  return {
    spokeColor: '#f59e0b',
    spokeActiveWidth: 2.5,
    spokeInactiveWidth: 1.2,
    spokeActiveOpacity: 0.9,
    spokeInactiveOpacity: 0.45,
    centerColor: '#94a3b8',
    centerStroke: '#ffffff',
    pinStroke: '#ffffff',
    pinActiveStroke: '#ffffff',
    pinInactiveRadius: 6,
    pinActiveRadius: 9,
    labelColor: '#b45309',
    labelActiveColor: '#b45309',
    labelHalo: isLightMode ? '#f8fafc' : '#121212',
    labelHaloWidth: 0,
    nearLineColor: '#ef4444',
    nearLineWidth: 2,
    nearLineOpacity: 0.85,
  };
}

export function applyDuplicateClusterMapPaint(
  map: MaplibreMap,
  layerIds: {
    spoke: string;
    center: string;
    pin: string;
    label: string;
    near: string;
  },
  style: DuplicateClusterMapStyle,
  hasNearLine: boolean,
): void {
  if (map.getLayer(layerIds.spoke)) {
    map.setPaintProperty(layerIds.spoke, 'line-color', style.spokeColor);
    map.setPaintProperty(layerIds.spoke, 'line-width', [
      'case',
      ['==', ['get', 'isActive'], 1],
      style.spokeActiveWidth,
      style.spokeInactiveWidth,
    ]);
    map.setPaintProperty(layerIds.spoke, 'line-opacity', [
      'case',
      ['==', ['get', 'isActive'], 1],
      style.spokeActiveOpacity,
      style.spokeInactiveOpacity,
    ]);
  }
  if (map.getLayer(layerIds.center)) {
    map.setPaintProperty(layerIds.center, 'circle-color', style.centerColor);
    map.setPaintProperty(layerIds.center, 'circle-stroke-color', style.centerStroke);
  }
  if (map.getLayer(layerIds.pin)) {
    map.setPaintProperty(layerIds.pin, 'circle-radius', [
      'case',
      ['==', ['get', 'isActive'], 1],
      style.pinActiveRadius,
      style.pinInactiveRadius,
    ]);
    map.setPaintProperty(layerIds.pin, 'circle-stroke-width', [
      'case',
      ['==', ['get', 'isActive'], 1],
      2.5,
      1.5,
    ]);
    map.setPaintProperty(layerIds.pin, 'circle-stroke-color', style.pinStroke);
  }
  if (map.getLayer(layerIds.label)) {
    map.setPaintProperty(layerIds.label, 'text-size', [
      'case',
      ['==', ['get', 'isActive'], 1],
      11.5,
      10,
    ]);
    map.setPaintProperty(layerIds.label, 'text-color', style.labelColor);
    map.setPaintProperty(layerIds.label, 'text-halo-color', style.labelHalo);
    map.setPaintProperty(layerIds.label, 'text-halo-width', style.labelHaloWidth);
  }
  if (hasNearLine && map.getLayer(layerIds.near)) {
    map.setPaintProperty(layerIds.near, 'line-color', style.nearLineColor);
    map.setPaintProperty(layerIds.near, 'line-width', style.nearLineWidth);
    map.setPaintProperty(layerIds.near, 'line-opacity', style.nearLineOpacity);
  }
}

export interface DuplicateClusterPin {
  mrid: string;
  name: string | null;
  coordinates: [number, number];
  isActive: boolean;
  color: string;
}

export interface DuplicateNearLine {
  from: [number, number];
  to: [number, number];
  distanceM?: number;
  fromMrid: string;
  toMrid: string;
}

export interface DuplicateClusterOverlay {
  center: [number, number];
  pins: DuplicateClusterPin[];
  nearLine?: DuplicateNearLine | null;
  mode: 'exact' | 'near' | 'mixed';
}

/** Offset N pins in a small circle around a shared coordinate. */
export function flyToDuplicateClusterView(
  map: MaplibreMap,
  overlay: DuplicateClusterOverlay,
  duration = 900,
): void {
  const activePin = overlay.pins.find((pin) => pin.isActive);

  if (overlay.nearLine && overlay.mode === 'near') {
    const lons = [overlay.nearLine.from[0], overlay.nearLine.to[0]];
    const lats = [overlay.nearLine.from[1], overlay.nearLine.to[1]];
    map.fitBounds(
      [
        [Math.min(...lons), Math.min(...lats)],
        [Math.max(...lons), Math.max(...lats)],
      ],
      { padding: 120, duration, maxZoom: DUPLICATE_CLUSTER_ZOOM },
    );
    return;
  }

  if (duplicateClusterOrbitEnabled(overlay)) {
    map.flyTo({
      center: overlay.center,
      zoom: DUPLICATE_CLUSTER_ZOOM,
      duration,
    });
    return;
  }

  const center = activePin?.coordinates ?? overlay.center;
  map.flyTo({
    center,
    zoom: DUPLICATE_CLUSTER_ZOOM,
    duration,
  });
}

export function fanOffsetCoordinates(
  center: [number, number],
  index: number,
  total: number,
  radiusM = DUPLICATE_FAN_RADIUS_M,
): [number, number] {
  return fanOrbitCoordinates(center, index, total, 0, radiusM);
}

/** Offset N pins on a ring around center, rotated by phaseRad (0 = north-first fan). */
export function fanOrbitCoordinates(
  center: [number, number],
  index: number,
  total: number,
  phaseRad: number,
  radiusM = DUPLICATE_FAN_RADIUS_M,
): [number, number] {
  const [lon, lat] = center;
  if (total <= 1) return center;
  const angle = (2 * Math.PI * index) / total - Math.PI / 2 + phaseRad;
  const mPerDegLat = 111_320;
  const mPerDegLon = 111_320 * Math.cos((lat * Math.PI) / 180);
  const dLat = (radiusM * Math.sin(angle)) / mPerDegLat;
  const dLon = (radiusM * Math.cos(angle)) / mPerDegLon;
  return [lon + dLon, lat + dLat];
}

export function duplicateClusterOrbitEnabled(overlay: DuplicateClusterOverlay): boolean {
  return overlay.pins.length > 1 && overlay.mode !== 'near';
}

export function buildDuplicateClusterGeoJson(
  overlay: DuplicateClusterOverlay,
  phaseRad = 0,
): FeatureCollection {
  const orbit = duplicateClusterOrbitEnabled(overlay);
  const pinFeatures = overlay.pins.map((pin, index) => {
    const coordinates = orbit
      ? fanOrbitCoordinates(overlay.center, index, overlay.pins.length, phaseRad)
      : pin.coordinates;
    return {
      type: 'Feature' as const,
      properties: {
        mrid: pin.mrid,
        name: pin.name || pin.mrid.slice(0, 8),
        color: pin.color,
        isActive: pin.isActive ? 1 : 0,
      },
      geometry: {
        type: 'Point' as const,
        coordinates,
      },
    };
  });

  const spokeFeatures = pinFeatures.map((pin) => ({
    type: 'Feature' as const,
    properties: { isActive: pin.properties.isActive },
    geometry: {
      type: 'LineString' as const,
      coordinates: [overlay.center, pin.geometry.coordinates as [number, number]],
    },
  }));

  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'Point',
          coordinates: overlay.center,
        },
      },
      ...pinFeatures,
      ...spokeFeatures,
    ],
  };
}

export function clusterDuplicateMode(
  cluster: DqQueueLocationCluster,
): 'exact' | 'near' | 'mixed' {
  const hasExact = cluster.colocatedCount > 1;
  const hasNear = cluster.items.some((item) =>
    item.exceptions.some(
      (ex) => ex.status === 'OPEN' && ex.rule_code === 'ASSET_DUPLICATE_NEAR',
    ),
  );
  if (hasExact && hasNear) return 'mixed';
  if (hasExact) return 'exact';
  return 'near';
}

interface NearDupDetails {
  mrid?: string;
  name?: string;
  distance_m?: number;
}

export function findOpenNearDuplicateException(item: GiopDqQueueItem) {
  return item.exceptions.find(
    (ex) => ex.status === 'OPEN' && ex.rule_code === 'ASSET_DUPLICATE_NEAR',
  );
}

export function resolveNearDuplicatePeer(
  item: GiopDqQueueItem,
  lookup: Map<string, GiopDqQueueItem>,
): { mrid: string; name: string | null; coordinates: [number, number] | null; distanceM?: number } | null {
  const ex = findOpenNearDuplicateException(item);
  if (!ex?.details || typeof ex.details !== 'object') return null;
  const details = ex.details as NearDupDetails;
  const peerMrid = details.mrid?.trim();
  if (!peerMrid) return null;
  const peer = lookup.get(peerMrid);
  const coordinates =
    peer?.longitude != null && peer?.latitude != null
      ? ([peer.longitude, peer.latitude] as [number, number])
      : null;
  return {
    mrid: peerMrid,
    name: details.name ?? peer?.name ?? null,
    coordinates,
    distanceM: typeof details.distance_m === 'number' ? details.distance_m : undefined,
  };
}

export function buildDuplicateClusterOverlay(
  cluster: DqQueueLocationCluster,
  activeMrid: string | null,
  lookup: Map<string, GiopDqQueueItem>,
  isLightMode = false,
): DuplicateClusterOverlay | null {
  if (cluster.longitude == null || cluster.latitude == null) return null;
  const center: [number, number] = [cluster.longitude, cluster.latitude];
  const peerMrids = cluster.peers.map((p) => p.mrid);
  const uniqueMrids = [...new Set(peerMrids.length ? peerMrids : cluster.items.map((i) => i.mrid))];
  const pins: DuplicateClusterPin[] = uniqueMrids.map((mrid, index) => {
    const peer = cluster.peers.find((p) => p.mrid === mrid);
    const item = lookup.get(mrid);
    return {
      mrid,
      name: peer?.name ?? item?.name ?? null,
      coordinates: fanOffsetCoordinates(center, index, uniqueMrids.length),
      isActive: mrid === activeMrid,
      color: duplicateFanPinColor(index, isLightMode),
    };
  });
  if (pins.length === 0) return null;

  const activeItem = activeMrid ? lookup.get(activeMrid) : cluster.items[0];
  let nearLine: DuplicateNearLine | null = null;
  if (activeItem) {
    const peer = resolveNearDuplicatePeer(activeItem, lookup);
    if (peer?.coordinates) {
      nearLine = {
        from: center,
        to: peer.coordinates,
        distanceM: peer.distanceM,
        fromMrid: activeItem.mrid,
        toMrid: peer.mrid,
      };
    }
  }

  return {
    center,
    pins,
    nearLine,
    mode: clusterDuplicateMode(cluster),
  };
}

export function buildSingletonNearDuplicateOverlay(
  item: GiopDqQueueItem,
  lookup: Map<string, GiopDqQueueItem>,
  isLightMode = false,
): DuplicateClusterOverlay | null {
  if (item.longitude == null || item.latitude == null) return null;
  const center: [number, number] = [item.longitude, item.latitude];
  const peer = resolveNearDuplicatePeer(item, lookup);
  if (!peer?.coordinates) return null;

  return {
    center,
    pins: [
      {
        mrid: item.mrid,
        name: item.name ?? null,
        coordinates: center,
        isActive: true,
        color: duplicateFanPinColor(0, isLightMode),
      },
      {
        mrid: peer.mrid,
        name: peer.name,
        coordinates: peer.coordinates,
        isActive: false,
        color: duplicateFanPinColor(1, isLightMode),
      },
    ],
    nearLine: {
      from: center,
      to: peer.coordinates,
      distanceM: peer.distanceM,
      fromMrid: item.mrid,
      toMrid: peer.mrid,
    },
    mode: 'near',
  };
}

function activePinCoordinates(
  overlay: DuplicateClusterOverlay | null,
  activeMrid: string,
): [number, number] | null {
  if (!overlay) return null;
  const pin =
    overlay.pins.find((p) => p.mrid === activeMrid) ??
    overlay.pins.find((p) => p.isActive);
  return pin?.coordinates ?? overlay.center;
}

export function duplicateFlyCoordinatesForCluster(
  cluster: DqQueueLocationCluster,
  activeMrid: string,
  lookup: Map<string, GiopDqQueueItem>,
): [number, number] | null {
  const overlay = buildDuplicateClusterOverlay(cluster, activeMrid, lookup);
  if (!overlay) return null;
  if (duplicateClusterOrbitEnabled(overlay)) return overlay.center;
  return activePinCoordinates(overlay, activeMrid);
}

export function duplicateFlyCoordinatesForMrid(
  queueItems: GiopDqQueueItem[],
  activeMrid: string,
  lookup: Map<string, GiopDqQueueItem>,
): [number, number] | null {
  const { clusters, singletons } = partitionDqQueueItems(queueItems);
  const cluster = clusters.find(
    (entry) =>
      entry.items.some((item) => item.mrid === activeMrid) ||
      entry.peers.some((peer) => peer.mrid === activeMrid),
  );
  if (cluster) {
    return duplicateFlyCoordinatesForCluster(cluster, activeMrid, lookup);
  }
  const singleton = singletons.find((item) => item.mrid === activeMrid);
  if (singleton && queueItemDuplicateDetected(singleton)) {
    return activePinCoordinates(
      buildSingletonNearDuplicateOverlay(singleton, lookup),
      activeMrid,
    );
  }
  return null;
}
