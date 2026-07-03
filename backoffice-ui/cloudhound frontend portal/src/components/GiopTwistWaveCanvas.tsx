import { useEffect, useRef } from 'react';
import { drawTwistWave, readVoiceWaveAmplitude } from '../lib/giopTwistWaveCanvas';

interface GiopTwistWaveCanvasProps {
  className?: string;
  /** Dots per strand — use ~36 for toolbar button, ~72 for dock */
  density?: number;
  active?: boolean;
  getAnalyser?: () => AnalyserNode | null;
}

/** Animated intertwined wave canvas — shared by map button and voice dock. */
export function GiopTwistWaveCanvas({
  className,
  density = 72,
  active = false,
  getAnalyser,
}: GiopTwistWaveCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | undefined>(undefined);
  const getAnalyserRef = useRef(getAnalyser);
  getAnalyserRef.current = getAnalyser;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, rect.width * dpr);
      canvas.height = Math.max(1, rect.height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    resize();
    window.addEventListener('resize', resize);

    const start = performance.now();
    const tick = (ts: number) => {
      const t = (ts - start) / 1000;
      const mic = getAnalyserRef.current
        ? readVoiceWaveAmplitude(getAnalyserRef.current())
        : 0.22 + Math.sin(t * 2.2) * 0.08;
      const intensity = active ? 1.08 : 0.82;
      drawTwistWave(ctx, canvas.clientWidth, canvas.clientHeight, mic, t, {
        density,
        intensity,
      });
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      window.removeEventListener('resize', resize);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [active, density]);

  return <canvas ref={canvasRef} className={className} aria-hidden />;
}
