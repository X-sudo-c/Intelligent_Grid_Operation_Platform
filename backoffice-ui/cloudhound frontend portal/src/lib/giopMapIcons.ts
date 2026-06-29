import type { Map as MaplibreMap } from 'maplibre-gl';

export const TRANSFORMER_ICON_ID = 'giop-transformer';

/** Draw a simple distribution-transformer glyph (coils + core) for MapLibre symbol layers. */
function drawTransformerIcon(ctx: CanvasRenderingContext2D, size: number, fill: string, stroke: string) {
  const s = size / 64;
  ctx.clearRect(0, 0, size, size);

  ctx.strokeStyle = stroke;
  ctx.fillStyle = fill;
  ctx.lineWidth = 3 * s;
  ctx.lineJoin = 'round';

  // Core body
  ctx.beginPath();
  const x = 18 * s;
  const y = 30 * s;
  const w = 28 * s;
  const h = 22 * s;
  const r = 4 * s;
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Primary coil (left)
  ctx.beginPath();
  ctx.arc(26 * s, 22 * s, 9 * s, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // Secondary coil (right)
  ctx.beginPath();
  ctx.arc(38 * s, 22 * s, 9 * s, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // Bushings
  ctx.lineWidth = 2.5 * s;
  ctx.beginPath();
  ctx.moveTo(24 * s, 52 * s);
  ctx.lineTo(24 * s, 58 * s);
  ctx.moveTo(32 * s, 52 * s);
  ctx.lineTo(32 * s, 58 * s);
  ctx.moveTo(40 * s, 52 * s);
  ctx.lineTo(40 * s, 58 * s);
  ctx.stroke();
}

export function registerGiopMapIcons(map: MaplibreMap, light: boolean): void {
  if (map.hasImage(TRANSFORMER_ICON_ID)) return;

  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const fill = light ? '#7c3aed' : '#a78bfa';
  const stroke = light ? '#ffffff' : '#1e1b4b';
  drawTransformerIcon(ctx, size, fill, stroke);

  const imageData = ctx.getImageData(0, 0, size, size);
  map.addImage(TRANSFORMER_ICON_ID, imageData, { pixelRatio: 2 });
}

export function refreshGiopMapIcons(map: MaplibreMap, light: boolean): void {
  if (map.hasImage(TRANSFORMER_ICON_ID)) {
    map.removeImage(TRANSFORMER_ICON_ID);
  }
  registerGiopMapIcons(map, light);
}
