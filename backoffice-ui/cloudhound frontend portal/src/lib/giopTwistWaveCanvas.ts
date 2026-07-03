/**
 * Intertwined particle-wave ribbons — pink / purple / blue strands that
 * cross and weave (reference mesh style). Works on light backgrounds.
 */

import { readAnalyserLevel } from './giopVoiceLevel';

export interface TwistWaveOptions {
  /** Dots per strand — lower for small button icons */
  density?: number;
  /** 0..1 animation intensity */
  intensity?: number;
}

interface StrandDef {
  phase: number;
  speed: number;
  freq1: number;
  freq2: number;
  hueBase: number;
  ySkew: number;
}

const STRANDS: StrandDef[] = [
  { phase: 0, speed: 1.0, freq1: 4.8, freq2: 8.2, hueBase: 320, ySkew: -0.08 },
  { phase: 2.15, speed: 1.12, freq1: 5.4, freq2: 9.1, hueBase: 275, ySkew: 0.06 },
  { phase: 4.3, speed: 0.92, freq1: 4.2, freq2: 7.6, hueBase: 230, ySkew: 0.02 },
];

function envelope(u: number): number {
  const base = Math.pow(Math.sin(Math.PI * Math.max(0, Math.min(1, u))), 1.15);
  const skew = 0.78 + 0.22 * Math.sin(Math.PI * u * 1.1);
  return base * skew;
}

function strandOffset(
  u: number,
  strand: StrandDef,
  time: number,
  maxAmp: number,
): number {
  const env = envelope(u);
  const p = strand.phase + time * strand.speed;
  const w1 = Math.sin(u * Math.PI * strand.freq1 + p);
  const w2 = 0.42 * Math.sin(u * Math.PI * strand.freq2 - p * 1.25 + time * 1.4);
  const w3 = 0.22 * Math.sin(u * Math.PI * (strand.freq1 + strand.freq2) * 0.55 + time * 2.1);
  const twist = 0.15 * Math.sin(u * Math.PI * 3 + p * 0.7) * Math.cos(u * Math.PI * 6 + time);
  return env * (w1 + w2 + w3 + twist) * maxAmp + strand.ySkew * maxAmp;
}

function hsla(h: number, s: number, l: number, a: number): string {
  return `hsla(${((h % 360) + 360) % 360}, ${s}%, ${l}%, ${a})`;
}

function strandColor(u: number, strand: StrandDef, layer: number): string {
  const hue = strand.hueBase + u * 55 + layer * 12;
  const light = 48 + layer * 4 + Math.sin(u * Math.PI * 2) * 6;
  return hsla(hue, 88, light, 0.55 + layer * 0.12);
}

export function readVoiceWaveAmplitude(analyser: AnalyserNode | null): number {
  if (!analyser) return 0.22;
  return Math.max(0.18, readAnalyserLevel(analyser));
}

/* ------------------------------------------------------------------ */
/* Voice dock renderer — twisted dotted ribbons (particle mesh style).  */
/* ------------------------------------------------------------------ */

interface MeshStrand {
  phase: number;
  speed: number;
  /** Center-line wave frequencies */
  f1: number;
  f2: number;
  /** Twist (band-width rotation) frequency + speed */
  twistF: number;
  twistSpeed: number;
  twistPhase: number;
  /** Ribbon thickness relative to wave height */
  band: number;
  alpha: number;
  /** Gradient hue stops for this strand: [pos, h, s, l][] */
  hues: [number, number, number, number][];
}

const MESH_STRANDS: MeshStrand[] = [
  {
    // Hot pink → crimson
    phase: 0.0, speed: 1.35, f1: 2.6, f2: 5.1,
    twistF: 3.4, twistSpeed: 3.6, twistPhase: 0.4, band: 1.35, alpha: 0.95,
    hues: [[0, 285, 98, 50], [0.4, 320, 98, 46], [0.75, 340, 99, 44], [1, 355, 98, 45]],
  },
  {
    // Indigo → violet
    phase: 2.1, speed: 0.92, f1: 3.4, f2: 6.2,
    twistF: 2.6, twistSpeed: -3.1, twistPhase: 1.9, band: 1.15, alpha: 0.9,
    hues: [[0, 230, 96, 48], [0.45, 255, 96, 46], [0.8, 285, 96, 44], [1, 305, 98, 43]],
  },
  {
    // Light neon blue — bright cyan-azure accent
    phase: 4.2, speed: 1.6, f1: 2.1, f2: 4.4,
    twistF: 4.3, twistSpeed: 2.7, twistPhase: 3.1, band: 0.95, alpha: 0.9,
    hues: [[0, 187, 100, 60], [0.4, 195, 100, 57], [0.8, 205, 100, 55], [1, 218, 98, 55]],
  },
  {
    // Magenta → rose
    phase: 1.1, speed: 1.12, f1: 3.0, f2: 5.6,
    twistF: 3.0, twistSpeed: -4.0, twistPhase: 5.0, band: 0.82, alpha: 0.8,
    hues: [[0, 290, 97, 47], [0.45, 315, 98, 44], [0.85, 338, 99, 43], [1, 350, 97, 44]],
  },
  {
    // Deep blue → purple accent
    phase: 3.3, speed: 0.75, f1: 2.35, f2: 4.9,
    twistF: 2.2, twistSpeed: 4.4, twistPhase: 2.4, band: 0.68, alpha: 0.72,
    hues: [[0, 220, 94, 45], [0.5, 245, 94, 44], [1, 290, 96, 42]],
  },
];

/** Soft ends, slightly fuller on the left like the reference artwork. */
function meshEnvelope(u: number): number {
  const base = Math.pow(Math.sin(Math.PI * Math.max(0, Math.min(1, u))), 0.8);
  return base * (1.12 - 0.3 * u);
}

/** 0→1 opacity ramp at the tips — longer on the right so nothing looks cut. */
function meshEndFade(u: number): number {
  const d = u < 0.5 ? u / 0.14 : (1 - u) / 0.24;
  if (d >= 1) return 1;
  const c = Math.max(0, d);
  return c * c * (3 - 2 * c);
}

function strandColorAt(strand: MeshStrand, u: number, alpha = 1): string {
  const stops = strand.hues;
  const pos = Math.max(0, Math.min(1, u));
  let i = 0;
  while (i < stops.length - 1 && stops[i + 1][0] < pos) i += 1;
  const [p0, h0, s0, l0] = stops[i];
  const [p1, h1, s1, l1] = stops[Math.min(i + 1, stops.length - 1)];
  const t = p1 === p0 ? 0 : (pos - p0) / (p1 - p0);
  const h = h0 + (h1 - h0) * t;
  const s = s0 + (s1 - s0) * t;
  const l = l0 + (l1 - l0) * t;
  return `hsla(${h}, ${s}%, ${l}%, ${alpha})`;
}

/** Thin resting line shown while silent. */
function drawMeshIdleLine(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  level: number,
) {
  const cy = height / 2;
  const alpha = Math.max(0, 0.45 - level * 0.5);
  if (alpha <= 0.02) return;
  const grad = ctx.createLinearGradient(0, 0, width, 0);
  grad.addColorStop(0, 'rgba(148, 163, 184, 0)');
  grad.addColorStop(0.2, `rgba(168, 162, 220, ${alpha})`);
  grad.addColorStop(0.5, `rgba(203, 173, 225, ${alpha + 0.12})`);
  grad.addColorStop(0.8, `rgba(168, 162, 220, ${alpha})`);
  grad.addColorStop(1, 'rgba(148, 163, 184, 0)');
  ctx.strokeStyle = grad;
  ctx.lineWidth = 1.3;
  ctx.beginPath();
  ctx.moveTo(0, cy);
  ctx.lineTo(width, cy);
  ctx.stroke();
}

/**
 * Twisted dotted-ribbon voice wave: each strand is a center curve plus a
 * rotating band width, sampled as rows of tiny dots. Where the band width
 * crosses zero the ribbon pinches — the woven figure-eight look.
 */
export function drawTwistMeshWave(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  level: number,
  time: number,
) {
  ctx.clearRect(0, 0, width, height);
  drawMeshIdleLine(ctx, width, height, level);
  if (level <= 0.015) return;

  const cy = height / 2;
  const drive = 0.22 + level * 0.78;
  // Max excursion is ~2.3× ampH (center wave + twist band), so 0.2×height
  // guarantees peaks never reach the canvas edge — free, unboxed movement.
  const ampH = height * 0.2 * drive;
  const drawW = width * 0.94;
  const hPad = (width - drawW) / 2;
  const steps = Math.max(150, Math.min(260, Math.ceil(drawW / 1.3)));
  const rows = 13;
  const dot = Math.max(0.55, drawW / 400);

  for (const s of MESH_STRANDS) {
    for (let j = 0; j < rows; j += 1) {
      const mix = rows === 1 ? 0.5 : j / (rows - 1);
      const edge = mix - 0.5;
      const rowAlpha = s.alpha * (0.25 + 0.75 * Math.sin(Math.PI * mix)) * 0.55;
      const shear = edge * 0.09;

      for (let i = 0; i <= steps; i += 1) {
        const u = i / steps;
        const env = meshEnvelope(u);
        if (env < 0.02) continue;
        const fade = meshEndFade(u);
        if (fade < 0.03) continue;
        const uu = u + shear * env;

        // Standing-wave center (breathes in place) + a faint traveling
        // component — the shape undulates rather than scrolling sideways.
        const center =
          env *
          (Math.sin(uu * Math.PI * s.f1 + s.phase) *
            (0.72 * Math.cos(time * s.speed * 0.9 + s.phase * 1.3) + 0.28) +
            0.3 * Math.sin(uu * Math.PI * s.f2 - time * s.speed * 0.35 + s.phase * 1.7));
        // Fast twist rotation is the dominant motion — the ribbon visibly
        // turns around its own axis.
        const bandWidth =
          env *
          s.band *
          (Math.cos(uu * Math.PI * s.twistF + time * s.twistSpeed + s.twistPhase) +
            0.35 * Math.sin(uu * Math.PI * s.twistF * 1.7 - time * s.twistSpeed * 0.8));

        const y = cy + (center + edge * bandWidth) * ampH;
        const x = hPad + u * drawW;
        ctx.globalAlpha = rowAlpha * fade;
        ctx.fillStyle = strandColorAt(s, u);
        ctx.fillRect(x - dot / 2, y - dot / 2, dot, dot);
      }
    }
  }

  ctx.globalAlpha = 1;
}

export function drawTwistWave(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  micAmp: number,
  time: number,
  options: TwistWaveOptions = {},
) {
  const density = options.density ?? 72;
  const intensity = options.intensity ?? 1;
  ctx.clearRect(0, 0, width, height);

  const level = 0.35 + micAmp * 0.65;
  const maxAmp = height * 0.38 * level * intensity;
  const cy = height / 2;
  const dotBase = Math.max(0.65, width / 52);

  ctx.globalCompositeOperation = 'source-over';

  for (const strand of STRANDS) {
    const points: { x: number; y: number; u: number }[] = [];

    for (let i = 0; i <= density; i += 1) {
      const u = i / density;
      const x = u * width;
      const y = cy + strandOffset(u, strand, time, maxAmp);
      points.push({ x, y, u });
    }

    // Ribbon stroke — fine mesh between particles
    for (let pass = 0; pass < 2; pass += 1) {
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i += 1) {
        ctx.lineTo(points[i].x, points[i].y);
      }
      ctx.strokeStyle = strandColor(0.5, strand, pass);
      ctx.lineWidth = pass === 0 ? dotBase * 0.55 : dotBase * 0.35;
      ctx.globalAlpha = pass === 0 ? 0.28 : 0.42;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.stroke();
    }

    // Particle dots — dense glowing points
    for (const pt of points) {
      const dotR = dotBase * (0.85 + micAmp * 0.35);
      const g = ctx.createRadialGradient(pt.x, pt.y, 0, pt.x, pt.y, dotR * 2.2);
      g.addColorStop(0, strandColor(pt.u, strand, 2));
      g.addColorStop(0.45, strandColor(pt.u, strand, 1));
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.globalAlpha = 0.75;
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, dotR, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  ctx.globalAlpha = 1;
}
