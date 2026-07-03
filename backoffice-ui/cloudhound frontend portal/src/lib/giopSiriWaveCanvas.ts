/**
 * Cinematic Siri-style voice wave (iOS9 family).
 *
 * Three luminous color layers (blue / green / pink), each made of a few
 * gaussian lobes with randomized position, width, amplitude and drift.
 * Layers grow, breathe and respawn on independent cycles so the ribbon
 * constantly intertwines instead of looping. The whole thing collapses to a
 * thin idle line during silence and blooms with the voice level — both when
 * the user speaks (mic) and when the assistant replies (TTS analyser).
 */

const LAYER_COLORS: [number, number, number][] = [
  [32, 133, 252], // Siri blue
  [94, 252, 169], // Siri green
  [253, 71, 103], // Siri pink/red
];

interface Lobe {
  offset: number; // -1..1 along the ribbon
  width: number; // gaussian width
  amp: number; // relative amplitude
  driftSpeed: number;
  driftPhase: number;
  pulseSpeed: number;
  pulsePhase: number;
}

interface WaveLayer {
  color: [number, number, number];
  lobes: Lobe[];
  cycleStart: number;
  cycleDur: number;
  seedPhase: number;
}

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function makeLobes(): Lobe[] {
  const count = 2 + Math.floor(Math.random() * 3); // 2..4
  const lobes: Lobe[] = [];
  for (let i = 0; i < count; i += 1) {
    lobes.push({
      offset: rand(-0.75, 0.75),
      width: rand(0.03, 0.16),
      amp: rand(0.4, 1.0),
      driftSpeed: rand(0.25, 0.9) * (Math.random() < 0.5 ? -1 : 1),
      driftPhase: rand(0, Math.PI * 2),
      pulseSpeed: rand(1.4, 3.2),
      pulsePhase: rand(0, Math.PI * 2),
    });
  }
  return lobes;
}

function makeLayer(color: [number, number, number], time: number): WaveLayer {
  return {
    color,
    lobes: makeLobes(),
    cycleStart: time,
    cycleDur: rand(2.2, 4.2),
    seedPhase: rand(0, Math.PI * 2),
  };
}

let layers: WaveLayer[] | null = null;

function ensureLayers(time: number): WaveLayer[] {
  if (!layers) {
    layers = LAYER_COLORS.map((c) => makeLayer(c, time - Math.random() * 2));
  }
  return layers;
}

/** Ends pinned to zero, soft shoulders — the classic Siri taper. */
function taper(t: number): number {
  const clamped = Math.max(-1, Math.min(1, t));
  return Math.pow(1 - clamped * clamped, 2);
}

/** Smooth grow → hold → fade over the layer's life cycle. */
function lifeEnvelope(progress: number): number {
  return Math.pow(Math.sin(Math.PI * Math.max(0, Math.min(1, progress))), 1.2);
}

function layerHeight(layer: WaveLayer, t: number, time: number, level: number): number {
  let sum = 0;
  for (const lobe of layer.lobes) {
    const off =
      lobe.offset + 0.16 * Math.sin(time * lobe.driftSpeed + lobe.driftPhase);
    const pulse = 0.62 + 0.38 * Math.sin(time * lobe.pulseSpeed + lobe.pulsePhase);
    const d = t - off;
    sum += lobe.amp * pulse * Math.exp(-(d * d) / (2 * lobe.width * lobe.width));
  }
  return sum * taper(t) * level;
}

function drawLayer(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  layer: WaveLayer,
  time: number,
  level: number,
) {
  const progress = (time - layer.cycleStart) / layer.cycleDur;
  if (progress >= 1) {
    layer.lobes = makeLobes();
    layer.cycleStart = time;
    layer.cycleDur = rand(2.2, 4.2);
    layer.seedPhase = rand(0, Math.PI * 2);
  }
  const env = lifeEnvelope(progress);
  if (env <= 0.01) return;

  const cy = height / 2;
  const maxH = height * 0.46;
  const steps = Math.max(90, Math.ceil(width / 2));
  const [r, g, b] = layer.color;

  const amp = (t: number) => layerHeight(layer, t, time, level) * env * maxH;

  ctx.beginPath();
  ctx.moveTo(0, cy);
  for (let i = 0; i <= steps; i += 1) {
    const x = (i / steps) * width;
    const t = (i / steps) * 2 - 1;
    ctx.lineTo(x, cy - amp(t));
  }
  for (let i = steps; i >= 0; i -= 1) {
    const x = (i / steps) * width;
    const t = (i / steps) * 2 - 1;
    ctx.lineTo(x, cy + amp(t));
  }
  ctx.closePath();

  ctx.fillStyle = `rgba(${r}, ${g}, ${b}, 0.62)`;
  ctx.fill();
}

/** Thin resting line — visible when the wave is silent. */
function drawIdleLine(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  level: number,
) {
  const cy = height / 2;
  const alpha = Math.max(0, 0.5 - level * 0.55);
  if (alpha <= 0.02) return;

  const grad = ctx.createLinearGradient(0, 0, width, 0);
  grad.addColorStop(0, 'rgba(148, 163, 184, 0)');
  grad.addColorStop(0.18, `rgba(148, 163, 184, ${alpha})`);
  grad.addColorStop(0.5, `rgba(203, 213, 225, ${alpha + 0.15})`);
  grad.addColorStop(0.82, `rgba(148, 163, 184, ${alpha})`);
  grad.addColorStop(1, 'rgba(148, 163, 184, 0)');

  ctx.strokeStyle = grad;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(0, cy);
  ctx.lineTo(width, cy);
  ctx.stroke();
}

export { readAnalyserLevel } from './giopVoiceLevel';

export function drawSiriVoiceWave(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  level: number,
  time: number,
) {
  ctx.clearRect(0, 0, width, height);

  drawIdleLine(ctx, width, height, level);

  if (level <= 0.015) return;

  ctx.globalCompositeOperation = 'lighter';
  for (const layer of ensureLayers(time)) {
    drawLayer(ctx, width, height, layer, time, level);
  }
  ctx.globalCompositeOperation = 'source-over';
}
