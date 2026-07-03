import { useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import type { GiopVoiceUiMode } from '../context/GiopVoiceModeContext';
import { drawTwistMeshWave } from '../lib/giopTwistWaveCanvas';
import { readAnalyserLevel } from '../lib/giopVoiceLevel';
import { getSpeechAnalyser } from '../lib/giopVoicePlayback';

interface GiopVoiceDockProps {
  mode: GiopVoiceUiMode;
  transcribing: boolean;
  arming: boolean;
  recording: boolean;
  speaking: boolean;
  error: string | null;
  getAnalyser: () => AnalyserNode | null;
  onTap: () => void;
  onCancel: () => void;
}

/**
 * Siri-style voice wave — replaces the AI Copilot FAB in place.
 * Listening: moves with the user's mic. Speaking: moves with the
 * assistant's actual TTS audio. Silence collapses to a thin line.
 */
export function GiopVoiceDock({
  transcribing,
  arming,
  recording,
  speaking,
  error,
  getAnalyser,
  onTap,
  onCancel,
}: GiopVoiceDockProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | undefined>(undefined);
  const levelRef = useRef(0);
  const noiseFloorRef = useRef(0.03);
  const stateRef = useRef({ arming, transcribing, speaking, recording });
  stateRef.current = { arming, transcribing, speaking, recording };
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
      const state = stateRef.current;

      let target: number;
      if (state.speaking) {
        const tts = readAnalyserLevel(getSpeechAnalyser());
        // Browser speechSynthesis has no analyser — synthesize a speech-like
        // envelope so the wave still moves with the reply.
        target =
          tts > 0.01
            ? tts
            : 0.3 +
              0.24 * Math.abs(Math.sin(t * 4.1)) * Math.abs(Math.sin(t * 1.3)) +
              0.06 * Math.sin(t * 9.7);
      } else if (state.transcribing) {
        target = 0.12 + 0.06 * Math.sin(t * 5.2);
      } else if (state.recording) {
        const raw = readAnalyserLevel(getAnalyserRef.current());
        noiseFloorRef.current =
          noiseFloorRef.current * 0.96 + Math.min(raw, noiseFloorRef.current + 0.02) * 0.04;
        const gated = Math.max(0, raw - noiseFloorRef.current * 0.85);
        target = 0.18 + Math.min(1, gated * 1.75);
      } else if (state.arming) {
        target = 0.22 + 0.08 * Math.sin(t * 3.5);
      } else {
        target = 0.12;
      }

      const rising = target > levelRef.current;
      const k = rising ? 0.58 : 0.11;
      levelRef.current += (target - levelRef.current) * k;

      drawTwistMeshWave(ctx, canvas.clientWidth, canvas.clientHeight, levelRef.current, t);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      window.removeEventListener('resize', resize);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  useEffect(() => {
    if (!recording) {
      noiseFloorRef.current = 0.03;
    }
  }, [recording]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const ariaLabel = error
    ? error
    : speaking
      ? 'Assistant speaking — tap to interrupt'
      : arming
        ? 'Starting microphone'
        : transcribing
          ? 'Processing speech'
          : 'Hands-free — speak naturally, Escape to stop';

  const passive = arming || transcribing;

  return (
    <motion.button
      type="button"
      className={`giop-voice-dock${passive ? ' giop-voice-dock--passive' : ''}`}
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.94 }}
      transition={{ duration: 0.3, ease: 'easeOut' }}
      onClick={passive ? undefined : onTap}
      aria-label={ariaLabel}
      aria-disabled={passive}
    >
      <canvas ref={canvasRef} className="giop-voice-dock__canvas" aria-hidden />
      {error ? <span className="sr-only">{error}</span> : null}
    </motion.button>
  );
}
