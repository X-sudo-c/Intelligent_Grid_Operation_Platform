/**
 * Manual verification for WGS84 geodesic measure distances.
 * Run: npx tsx scripts/verify-map-measure.ts
 */
import { formatMeasureMeters, geodesicMeters, haversineMeters, polylineLengthMeters } from '../src/lib/giopMapMeasure';

function assertNear(label: string, actual: number, expected: number, toleranceM: number) {
  const delta = Math.abs(actual - expected);
  if (delta > toleranceM) {
    throw new Error(`${label}: expected ~${expected} m, got ${actual.toFixed(4)} m (Δ ${delta.toFixed(4)} m)`);
  }
  console.log(`✓ ${label}: ${actual.toFixed(3)} m (expected ~${expected} m, Δ ${delta.toFixed(3)} m)`);
}

// Accra area — 269 m east at ~5.603°N (matches typical field span scale).
const achimotaA: [number, number] = [-0.23385, 5.60312];
const achimotaB: [number, number] = [-0.23142, 5.60312];
const eastSpanM = geodesicMeters(achimotaA, achimotaB);
assertNear('269 m east-west span (Accra lat)', eastSpanM, 269.222, 0.01);

// Known geodesic reference: equator 1° longitude ≈ 111.32 km.
const equatorA: [number, number] = [0, 0];
const equatorB: [number, number] = [1, 0];
assertNear('1° longitude at equator', geodesicMeters(equatorA, equatorB), 111_319.5, 50);

// Polyline sum equals segment sum.
const path: [number, number][] = [
  [-0.23385, 5.60312],
  [-0.23263, 5.60312],
  [-0.23142, 5.60312],
];
const segSum = geodesicMeters(path[0], path[1]) + geodesicMeters(path[1], path[2]);
const pathLen = polylineLengthMeters(path);
assertNear('Polyline total = segment sum', pathLen, segSum, 0.001);

// Vincenty vs haversine should agree within centimetres on short spans.
const hv = haversineMeters(achimotaA, achimotaB);
assertNear('Geodesic vs haversine (short span)', eastSpanM, hv, 0.05);

assertNear('Sub-metre span formats as mm', Number.parseFloat(formatMeasureMeters(0.42).replace(' mm', '')), 420, 0.1);

console.log('\nAll map measure checks passed.');
