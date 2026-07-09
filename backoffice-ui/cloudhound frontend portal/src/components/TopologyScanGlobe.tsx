import { useEffect, useRef } from 'react';

/** Coarse land masks — points sampled inside these rings become land particles. */
const CONTINENTS: Array<Array<[number, number]>> = [
  [
    [-17, 15], [-5, 35], [10, 37], [32, 31], [43, 12], [51, 12], [43, -1],
    [40, -15], [35, -35], [18, -35], [12, -18], [5, 5], [-5, 5], [-10, 5],
    [-17, 15],
  ],
  [
    [-10, 36], [-9, 43], [-5, 43], [0, 51], [8, 55], [12, 55], [20, 55],
    [30, 60], [40, 55], [40, 45], [30, 40], [28, 41], [20, 40], [10, 38],
    [0, 36], [-10, 36],
  ],
  [
    [40, 45], [50, 55], [70, 60], [100, 55], [130, 50], [140, 40], [145, 25],
    [120, 20], [100, 10], [95, 5], [80, 8], [70, 20], [60, 25], [50, 30],
    [45, 35], [40, 45],
  ],
  [
    [-168, 65], [-140, 70], [-100, 72], [-60, 60], [-55, 50], [-80, 45],
    [-75, 35], [-80, 25], [-100, 20], [-110, 25], [-125, 35], [-130, 50],
    [-140, 60], [-168, 65],
  ],
  [
    [-80, 10], [-70, 12], [-50, 5], [-35, -5], [-40, -25], [-55, -35],
    [-70, -55], [-75, -50], [-75, -20], [-80, 0], [-80, 10],
  ],
  [
    [115, -20], [130, -12], [145, -15], [153, -28], [145, -38], [130, -35],
    [115, -32], [115, -20],
  ],
];

const GHANA: Array<[number, number]> = [
  [-3.25, 5.0], [-2.8, 4.75], [-1.6, 4.9], [-0.7, 5.5], [0.7, 5.9],
  [1.2, 6.5], [0.7, 7.5], [0.2, 8.2], [-0.5, 8.6], [-1.5, 8.5],
  [-2.5, 8.2], [-3.1, 7.5], [-3.2, 6.5], [-3.25, 5.0],
];

const GHANA_CENTER: [number, number] = [-1.0, 7.0];

/** Hub nodes that catch the traveling gold light. */
const HUBS: Array<[number, number]> = [
  [-1.0, 7.0],
  [-0.2, 5.6],
  [-1.6, 6.7],
  [-74.0, 40.7],
  [-118.2, 34.0],
  [-46.6, -23.5],
  [2.3, 48.8],
  [13.4, 52.5],
  [37.6, 55.7],
  [139.7, 35.7],
  [121.5, 31.2],
  [72.8, 19.0],
  [31.2, 30.0],
  [18.4, -33.9],
  [151.2, -33.8],
  [103.8, 1.3],
];

const ARCS: Array<[number, number]> = [
  [0, 1], [0, 2], [0, 6], [0, 12], [3, 4], [3, 6], [5, 3],
  [6, 7], [7, 8], [8, 9], [9, 10], [10, 11], [11, 12], [12, 13],
  [13, 0], [14, 9], [15, 10], [4, 15],
];

type Vec3 = [number, number, number];

type Particle = {
  lon: number;
  lat: number;
  hub: boolean;
  ghana: boolean;
  seed: number;
  size: number;
};

function lonLatToVec(lon: number, lat: number): Vec3 {
  const λ = (lon * Math.PI) / 180;
  const φ = (lat * Math.PI) / 180;
  const cosφ = Math.cos(φ);
  return [cosφ * Math.cos(λ), Math.sin(φ), cosφ * Math.sin(λ)];
}

function rotateY(v: Vec3, yaw: number): Vec3 {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return [v[0] * c + v[2] * s, v[1], -v[0] * s + v[2] * c];
}

function rotateX(v: Vec3, pitch: number): Vec3 {
  const c = Math.cos(pitch);
  const s = Math.sin(pitch);
  return [v[0], v[1] * c - v[2] * s, v[1] * s + v[2] * c];
}

function projectVec(
  v0: Vec3,
  yaw: number,
  pitch: number,
  cx: number,
  cy: number,
  r: number,
): { x: number; y: number; depth: number; visible: boolean } {
  let v = rotateY(v0, yaw);
  v = rotateX(v, pitch);
  return {
    x: cx + v[0] * r,
    y: cy - v[1] * r,
    depth: v[2],
    visible: v[2] > -0.04,
  };
}

function pointInRing(lon: number, lat: number, ring: Array<[number, number]>): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersect =
      yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi + 1e-9) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function onLand(lon: number, lat: number): boolean {
  for (const ring of CONTINENTS) {
    if (pointInRing(lon, lat, ring)) return true;
  }
  return false;
}

function inGhana(lon: number, lat: number): boolean {
  return pointInRing(lon, lat, GHANA);
}

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function shortestAngle(from: number, to: number): number {
  let d = to - from;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function hash(n: number): number {
  const x = Math.sin(n * 127.1) * 43758.5453;
  return x - Math.floor(x);
}

function buildParticles(): Particle[] {
  const out: Particle[] = [];
  const N = 5200;
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < N; i++) {
    const y = 1 - (i / (N - 1)) * 2;
    const radius = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i;
    const x = Math.cos(theta) * radius;
    const z = Math.sin(theta) * radius;
    const lat = (Math.asin(Math.max(-1, Math.min(1, y))) * 180) / Math.PI;
    const lon = (Math.atan2(z, x) * 180) / Math.PI;
    const land = onLand(lon, lat);
    const n = hash(i * 1.7);
    // Dense land stipple, sparse ocean dust — like the reference
    if (!land && n > 0.028) continue;
    if (land && n > 0.94) continue;
    out.push({
      lon,
      lat,
      hub: false,
      ghana: land && inGhana(lon, lat),
      seed: n,
      size: land ? 0.85 + n * 1.35 : 0.4 + n * 0.45,
    });
  }
  for (let i = 0; i < HUBS.length; i++) {
    const [lon, lat] = HUBS[i];
    out.push({
      lon,
      lat,
      hub: true,
      ghana: inGhana(lon, lat),
      seed: hash(i + 99),
      size: 2.2,
    });
  }
  return out;
}

const PARTICLES = buildParticles();
const PARTICLE_VECS: Vec3[] = PARTICLES.map((p) => lonLatToVec(p.lon, p.lat));

export interface TopologyScanGlobeProps {
  isLightMode: boolean;
  progress01: number;
  spinning: boolean;
  monochrome?: boolean;
  className?: string;
}

/**
 * Soft white 3D globe with stippled continents and a traveling gold light
 * that settles on Ghana as scan progress advances.
 */
export function TopologyScanGlobe({
  progress01,
  spinning,
  className = '',
}: TopologyScanGlobeProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const progressRef = useRef(progress01);
  const spinningRef = useRef(spinning);

  progressRef.current = progress01;
  spinningRef.current = spinning;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let raf = 0;
    const start = performance.now();

    const draw = (now: number) => {
      const elapsed = (now - start) / 1000;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const cssW = canvas.clientWidth || 360;
      const cssH = canvas.clientHeight || 260;
      if (canvas.width !== Math.floor(cssW * dpr) || canvas.height !== Math.floor(cssH * dpr)) {
        canvas.width = Math.floor(cssW * dpr);
        canvas.height = Math.floor(cssH * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const p = Math.max(0, Math.min(1, progressRef.current));
      const zoomT = easeInOut(Math.max(0, Math.min(1, (p - 0.05) / 0.6)));
      const spinYaw = spinningRef.current ? elapsed * 0.38 : elapsed * 0.05;
      const targetYaw = -((GHANA_CENTER[0] * Math.PI) / 180);
      const targetPitch = ((GHANA_CENTER[1] * Math.PI) / 180) * 0.9;
      const yaw = spinYaw + shortestAngle(spinYaw, targetYaw) * zoomT;
      const pitch = lerp(0.16, targetPitch, zoomT);
      const baseR = Math.min(cssW, cssH) * 0.36;
      const r = lerp(baseR, baseR * 2.45, zoomT);
      const cx = cssW / 2;
      const cy = cssH / 2 + lerp(2, 12, zoomT);

      // Gold light longitude travels around the globe, then locks on Ghana
      const goldLonTravel = ((elapsed * 38) % 360) - 180;
      const goldLon = lerp(goldLonTravel, GHANA_CENTER[0], zoomT);
      const goldLat = lerp(8, GHANA_CENTER[1], zoomT);

      ctx.clearRect(0, 0, cssW, cssH);

      // Soft white void
      const voidGrad = ctx.createRadialGradient(cx, cy, r * 0.2, cx, cy, Math.max(cssW, cssH) * 0.75);
      voidGrad.addColorStop(0, '#ffffff');
      voidGrad.addColorStop(0.5, '#f8fafc');
      voidGrad.addColorStop(1, '#e8eef5');
      ctx.fillStyle = voidGrad;
      ctx.fillRect(0, 0, cssW, cssH);

      // Soft atmosphere bloom
      const bloom = ctx.createRadialGradient(cx, cy, r * 0.7, cx, cy, r * 1.28);
      bloom.addColorStop(0, 'rgba(255,255,255,0)');
      bloom.addColorStop(0.65, 'rgba(148,163,184,0.07)');
      bloom.addColorStop(1, 'rgba(148,163,184,0)');
      ctx.fillStyle = bloom;
      ctx.beginPath();
      ctx.arc(cx, cy, r * 1.28, 0, Math.PI * 2);
      ctx.fill();

      // Glass sphere
      const glass = ctx.createRadialGradient(cx - r * 0.28, cy - r * 0.32, 0, cx, cy, r);
      glass.addColorStop(0, 'rgba(255,255,255,0.72)');
      glass.addColorStop(0.4, 'rgba(248,250,252,0.28)');
      glass.addColorStop(1, 'rgba(203,213,225,0.42)');
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = glass;
      ctx.fill();

      // Rim
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(148,163,184,0.5)';
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx, cy, r + 3.5, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(226,232,240,0.75)';
      ctx.lineWidth = 5;
      ctx.stroke();

      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.clip();

      // Faint lat grid
      ctx.strokeStyle = 'rgba(148,163,184,0.14)';
      ctx.lineWidth = 0.55;
      for (let lat = -60; lat <= 60; lat += 30) {
        ctx.beginPath();
        let started = false;
        for (let lon = -180; lon <= 180; lon += 8) {
          const pt = projectVec(lonLatToVec(lon, lat), yaw, pitch, cx, cy, r);
          if (!pt.visible) {
            started = false;
            continue;
          }
          if (!started) {
            ctx.moveTo(pt.x, pt.y);
            started = true;
          } else ctx.lineTo(pt.x, pt.y);
        }
        ctx.stroke();
      }

      // Soft connection arcs — grey, gold when near the light
      for (let ai = 0; ai < ARCS.length; ai++) {
        const [ia, ib] = ARCS[ai];
        const a = HUBS[ia];
        const b = HUBS[ib];
        const va = lonLatToVec(a[0], a[1]);
        const vb = lonLatToVec(b[0], b[1]);
        const mid: Vec3 = [
          (va[0] + vb[0]) * 0.5,
          (va[1] + vb[1]) * 0.5,
          (va[2] + vb[2]) * 0.5,
        ];
        const mlen = Math.hypot(mid[0], mid[1], mid[2]) || 1;
        const lift = 1.16 + 0.06 * Math.sin(elapsed * 1.3 + ai);
        const elevated: Vec3 = [
          (mid[0] / mlen) * lift,
          (mid[1] / mlen) * lift,
          (mid[2] / mlen) * lift,
        ];
        const pa = projectVec(va, yaw, pitch, cx, cy, r);
        const pb = projectVec(vb, yaw, pitch, cx, cy, r);
        const pm = projectVec(elevated, yaw, pitch, cx, cy, r);
        if (!pa.visible && !pb.visible) continue;

        const midLon = (a[0] + b[0]) / 2;
        let dLon = Math.abs(((midLon - goldLon + 540) % 360) - 180);
        const nearGold = Math.max(0, 1 - dLon / 40);
        const pulse = 0.18 + 0.22 * (0.5 + 0.5 * Math.sin(elapsed * 2 + ai));

        ctx.beginPath();
        ctx.moveTo(pa.x, pa.y);
        ctx.quadraticCurveTo(pm.x, pm.y, pb.x, pb.y);
        if (nearGold > 0.25) {
          ctx.strokeStyle = `rgba(212, 175, 55, ${pulse * nearGold * (0.55 + zoomT * 0.25)})`;
          ctx.lineWidth = 1 + nearGold * 0.8;
        } else {
          ctx.strokeStyle = `rgba(148, 163, 184, ${pulse * 0.45})`;
          ctx.lineWidth = 0.7;
        }
        ctx.stroke();
      }

      // Stipple particles
      for (let i = 0; i < PARTICLES.length; i++) {
        const part = PARTICLES[i];
        const pt = projectVec(PARTICLE_VECS[i], yaw, pitch, cx, cy, r);
        if (!pt.visible) continue;
        const depthFade = 0.32 + 0.68 * Math.max(0, pt.depth);

        let dLon = Math.abs(((part.lon - goldLon + 540) % 360) - 180);
        const dLat = Math.abs(part.lat - goldLat);
        const goldDist = Math.hypot(dLon * 0.65, dLat);
        const goldBand = Math.max(0, 1 - goldDist / 26);
        const shimmer =
          goldBand *
          (0.4 + 0.6 * Math.sin(elapsed * 4.2 - goldDist * 0.3 + part.seed * 8));

        if (part.hub) {
          const glow = 4.5 + 2.2 * Math.sin(elapsed * 3.4 + part.seed * 10);
          const lit = Math.max(shimmer, part.ghana ? zoomT * 0.7 : 0);
          const g = ctx.createRadialGradient(pt.x, pt.y, 0, pt.x, pt.y, glow * 2.4);
          g.addColorStop(0, `rgba(212, 175, 55, ${(0.35 + lit * 0.55) * depthFade})`);
          g.addColorStop(0.4, `rgba(234, 198, 98, ${(0.12 + lit * 0.25) * depthFade})`);
          g.addColorStop(1, 'rgba(212, 175, 55, 0)');
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, glow * 2.4, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = `rgba(146, 110, 30, ${(0.55 + lit * 0.4) * depthFade})`;
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, 1.7 + zoomT * 0.6, 0, Math.PI * 2);
          ctx.fill();
          continue;
        }

        const size =
          (part.size + (part.ghana ? zoomT * 0.7 : 0)) * (0.9 + zoomT * 0.1);

        if (shimmer > 0.1) {
          const g = ctx.createRadialGradient(pt.x, pt.y, 0, pt.x, pt.y, size * 3.2);
          g.addColorStop(0, `rgba(212, 175, 55, ${0.75 * shimmer * depthFade})`);
          g.addColorStop(0.5, `rgba(234, 198, 98, ${0.28 * shimmer * depthFade})`);
          g.addColorStop(1, 'rgba(212, 175, 55, 0)');
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, size * 3.2, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = `rgba(180, 140, 40, ${(0.5 + shimmer * 0.45) * depthFade})`;
        } else {
          const grey = 145 + Math.floor(part.seed * 55);
          const alpha = (part.ghana ? 0.72 : 0.38 + part.seed * 0.35) * depthFade;
          ctx.fillStyle = `rgba(${grey},${grey + 3},${grey + 6},${alpha})`;
        }
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, size, 0, Math.PI * 2);
        ctx.fill();
      }

      // Ghana lock ring
      if (zoomT > 0.2) {
        const c = projectVec(
          lonLatToVec(GHANA_CENTER[0], GHANA_CENTER[1]),
          yaw,
          pitch,
          cx,
          cy,
          r,
        );
        if (c.visible) {
          const pulse = 9 + Math.sin(elapsed * 3) * 3;
          ctx.beginPath();
          ctx.arc(c.x, c.y, pulse + zoomT * 16, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(212, 175, 55, ${0.22 + zoomT * 0.4})`;
          ctx.lineWidth = 1.4;
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(c.x, c.y, (pulse + zoomT * 16) * 0.62, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(148, 163, 184, ${0.25 + zoomT * 0.2})`;
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }

      // Specular highlight
      const spec = ctx.createRadialGradient(
        cx - r * 0.32,
        cy - r * 0.38,
        0,
        cx - r * 0.18,
        cy - r * 0.2,
        r * 0.62,
      );
      spec.addColorStop(0, 'rgba(255,255,255,0.55)');
      spec.addColorStop(0.4, 'rgba(255,255,255,0.1)');
      spec.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = spec;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();

      ctx.restore();

      // Soft gold meridian sweep while spinning
      if (spinningRef.current && zoomT < 0.9) {
        const goldPt = projectVec(lonLatToVec(goldLon, goldLat), yaw, pitch, cx, cy, r);
        if (goldPt.visible) {
          const band = ctx.createRadialGradient(
            goldPt.x,
            goldPt.y,
            0,
            goldPt.x,
            goldPt.y,
            r * 0.55,
          );
          band.addColorStop(0, 'rgba(212,175,55,0.14)');
          band.addColorStop(0.45, 'rgba(212,175,55,0.04)');
          band.addColorStop(1, 'rgba(212,175,55,0)');
          ctx.save();
          ctx.beginPath();
          ctx.arc(cx, cy, r, 0, Math.PI * 2);
          ctx.clip();
          ctx.fillStyle = band;
          ctx.beginPath();
          ctx.arc(goldPt.x, goldPt.y, r * 0.55, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }
      }

      raf = requestAnimationFrame(draw);
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className={`block w-full h-full ${className}`}
      aria-hidden
    />
  );
}
