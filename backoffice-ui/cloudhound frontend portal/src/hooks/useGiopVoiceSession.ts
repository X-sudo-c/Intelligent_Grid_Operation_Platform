/**
 * Voice capture — record in browser, auto-send on silence, one API hop to copilot.
 *
 * Mic opens immediately for the wave UI; MediaRecorder only starts after VAD
 * detects speech so silence is not uploaded. Trailing silence ends the turn.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_VOICE_VAD, VoiceVadMonitor } from '../lib/giopVoiceVad';

const MAX_RECORD_MS = 12_000;
/** Max wait for the user to start speaking after arming the mic. */
const MAX_ARM_MS = 8_000;
const VAD_POLL_MS = 50;

function pickRecorderMime(): string {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4',
  ];
  for (const mime of candidates) {
    if (MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return '';
}

function streamIsLive(stream: MediaStream | null): boolean {
  return Boolean(stream?.getTracks().some((t) => t.readyState === 'live'));
}

function blobWouldHaveSpeech(chunks: Blob[]): boolean {
  let size = 0;
  for (const part of chunks) size += part.size;
  return size >= 800;
}

export interface PendingVoiceTranscript {
  text: string;
  raw?: string;
  fixes?: string[];
}

export interface UseGiopVoiceSessionOptions {
  /** Send recorded audio to the copilot (transcribe + chat on server). */
  onAudioTurn: (blob: Blob) => void | Promise<void>;
  enabled?: boolean;
  /** Keep the mic stream open between turns (handsfree — faster re-listen). */
  keepStreamBetweenTurns?: boolean;
  /** Auto-stop and send when the user pauses (default true). */
  autoSendOnSilence?: boolean;
}

export function useGiopVoiceSession({
  onAudioTurn,
  enabled = true,
  keepStreamBetweenTurns = false,
  autoSendOnSilence = true,
}: UseGiopVoiceSessionOptions) {
  const [recording, setRecording] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [supported, setSupported] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const mimeRef = useRef('audio/webm');
  const maxTimerRef = useRef<number | undefined>(undefined);
  const armTimerRef = useRef<number | undefined>(undefined);
  const vadTimerRef = useRef<number | undefined>(undefined);
  const vadRef = useRef(new VoiceVadMonitor());
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const onAudioTurnRef = useRef(onAudioTurn);
  const keepStreamRef = useRef(keepStreamBetweenTurns);
  const autoSendRef = useRef(autoSendOnSilence);
  const startRecordingRef = useRef<() => void>(() => undefined);
  /** True once MediaRecorder has started for this armed turn. */
  const captureStartedRef = useRef(false);
  /** User/manual stop — allow empty blob without "no speech" error when keepStream. */
  const discardTurnRef = useRef(false);

  onAudioTurnRef.current = onAudioTurn;
  keepStreamRef.current = keepStreamBetweenTurns;
  autoSendRef.current = autoSendOnSilence;

  useEffect(() => {
    const ok =
      typeof window !== 'undefined' &&
      Boolean(navigator.mediaDevices?.getUserMedia) &&
      typeof MediaRecorder !== 'undefined' &&
      Boolean(pickRecorderMime());
    setSupported(ok);
  }, []);

  const cleanupAnalyser = useCallback(() => {
    analyserRef.current = null;
    const ctx = audioContextRef.current;
    audioContextRef.current = null;
    if (ctx && ctx.state !== 'closed') {
      void ctx.close().catch(() => undefined);
    }
  }, []);

  const releaseStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    recorderRef.current = null;
    cleanupAnalyser();
  }, [cleanupAnalyser]);

  const stopVad = useCallback(() => {
    window.clearInterval(vadTimerRef.current);
    vadTimerRef.current = undefined;
    window.clearTimeout(armTimerRef.current);
    armTimerRef.current = undefined;
    vadRef.current.reset();
  }, []);

  const cleanupAfterTurn = useCallback(() => {
    stopVad();
    recorderRef.current = null;
    captureStartedRef.current = false;
    window.clearTimeout(maxTimerRef.current);
    if (!keepStreamRef.current || !streamIsLive(streamRef.current)) {
      releaseStream();
    }
  }, [releaseStream, stopVad]);

  const attachAnalyser = useCallback(async (stream: MediaStream) => {
    if (analyserRef.current && streamIsLive(streamRef.current)) return;
    cleanupAnalyser();
    const AudioCtx =
      window.AudioContext ??
      (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.45;
    analyser.minDecibels = -90;
    analyser.maxDecibels = -10;
    const source = ctx.createMediaStreamSource(stream);
    const silent = ctx.createGain();
    silent.gain.value = 0;
    source.connect(analyser);
    analyser.connect(silent);
    silent.connect(ctx.destination);
    audioContextRef.current = ctx;
    analyserRef.current = analyser;
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }
  }, [cleanupAnalyser]);

  const beginCapture = useCallback(() => {
    if (captureStartedRef.current) return;
    const stream = streamRef.current;
    const mime = mimeRef.current;
    if (!stream || !mime) return;

    chunksRef.current = [];
    discardTurnRef.current = false;
    const recorder = new MediaRecorder(stream, { mimeType: mime });
    recorderRef.current = recorder;

    recorder.ondataavailable = (ev) => {
      if (ev.data.size > 0) chunksRef.current.push(ev.data);
    };

    recorder.onstop = () => {
      setRecording(false);
      // stopVad() may have already reset the monitor; captureStarted is still true here.
      const hadSpeech = captureStartedRef.current || blobWouldHaveSpeech(chunksRef.current);
      const blob = new Blob(chunksRef.current, { type: mimeRef.current });
      cleanupAfterTurn();
      chunksRef.current = [];

      if (discardTurnRef.current) {
        discardTurnRef.current = false;
        return;
      }

      if (!hadSpeech || blob.size < 800) {
        if (keepStreamRef.current) {
          scheduleRestartRef.current();
        } else {
          setError('No speech detected — try again.');
        }
        return;
      }

      setProcessing(true);
      void (async () => {
        try {
          await onAudioTurnRef.current(blob);
          setError(null);
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Voice request failed');
        } finally {
          setProcessing(false);
        }
      })();
    };

    recorder.onerror = () => {
      setError('Recording failed — try again.');
      stopRecordingRef.current();
    };

    recorder.start(200);
    captureStartedRef.current = true;
    window.clearTimeout(armTimerRef.current);
    armTimerRef.current = undefined;
    maxTimerRef.current = window.setTimeout(() => {
      stopRecordingRef.current();
    }, MAX_RECORD_MS);
  }, [cleanupAfterTurn]);

  const scheduleRestartRef = useRef<() => void>(() => undefined);

  const stopRecording = useCallback(() => {
    stopVad();
    window.clearTimeout(maxTimerRef.current);
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      try {
        recorder.stop();
      } catch {
        cleanupAfterTurn();
        setRecording(false);
      }
      return;
    }
    // Armed but never spoke — drop the turn without uploading silence.
    cleanupAfterTurn();
    setRecording(false);
  }, [cleanupAfterTurn, stopVad]);

  const stopRecordingRef = useRef(stopRecording);
  stopRecordingRef.current = stopRecording;

  const scheduleRestart = useCallback(() => {
    if (!keepStreamRef.current) return;
    window.setTimeout(() => {
      if (!recorderRef.current && !captureStartedRef.current) startRecordingRef.current();
    }, 120);
  }, []);
  scheduleRestartRef.current = scheduleRestart;

  const startVad = useCallback(() => {
    stopVad();
    vadRef.current.reset();
    captureStartedRef.current = false;

    vadTimerRef.current = window.setInterval(() => {
      const analyser = analyserRef.current;
      if (!analyser) return;
      const now = performance.now();
      vadRef.current.tick(analyser, now, DEFAULT_VOICE_VAD);

      // Gate: only start MediaRecorder after real speech.
      if (!captureStartedRef.current && vadRef.current.hasHeardSpeech()) {
        beginCapture();
      }

      if (!autoSendRef.current) return;
      if (!captureStartedRef.current) return;
      const recorder = recorderRef.current;
      if (!recorder || recorder.state === 'inactive') return;
      if (vadRef.current.shouldSend(now, DEFAULT_VOICE_VAD)) {
        stopRecordingRef.current();
      }
    }, VAD_POLL_MS);

    armTimerRef.current = window.setTimeout(() => {
      if (captureStartedRef.current) return;
      // Never spoke while armed — re-arm handsfree or stop.
      stopVad();
      setRecording(false);
      if (keepStreamRef.current) {
        scheduleRestartRef.current();
      } else {
        cleanupAfterTurn();
        setError('No speech detected — try again.');
      }
    }, MAX_ARM_MS);
  }, [beginCapture, cleanupAfterTurn, stopVad]);

  const startRecording = useCallback(async () => {
    if (!enabled) {
      setError('Copilot is busy — wait for the current reply.');
      return;
    }
    const mime = pickRecorderMime();
    if (!mime) {
      setError('This browser cannot record audio for voice commands.');
      return;
    }

    setError(null);

    try {
      let stream = streamRef.current;
      if (!streamIsLive(stream)) {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
        streamRef.current = stream;
      }
      if (!stream) {
        setError('Could not access the microphone.');
        return;
      }
      await attachAnalyser(stream);
      mimeRef.current = mime;
      chunksRef.current = [];
      captureStartedRef.current = false;
      discardTurnRef.current = false;
      setRecording(true);
      startVad();
    } catch (err) {
      releaseStream();
      setRecording(false);
      if (err instanceof DOMException && err.name === 'NotAllowedError') {
        setError('Microphone permission denied — allow mic access in browser settings.');
      } else if (err instanceof DOMException && err.name === 'NotFoundError') {
        setError('No microphone detected.');
      } else {
        setError(err instanceof Error ? err.message : 'Could not start recording');
      }
    }
  }, [attachAnalyser, enabled, releaseStream, startVad]);

  startRecordingRef.current = () => {
    void startRecording();
  };

  const toggle = useCallback(() => {
    if (recording || processing) stopRecording();
    else void startRecording();
  }, [processing, recording, startRecording, stopRecording]);

  const forceRelease = useCallback(() => {
    discardTurnRef.current = true;
    stopVad();
    window.clearTimeout(maxTimerRef.current);
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      try {
        recorder.stop();
      } catch {
        /* ignore */
      }
    }
    releaseStream();
    captureStartedRef.current = false;
    setRecording(false);
    setProcessing(false);
  }, [releaseStream, stopVad]);

  const stopRef = useRef(forceRelease);
  stopRef.current = forceRelease;

  useEffect(() => () => {
    stopRef.current();
  }, []);

  useEffect(() => {
    if (!enabled && recording) {
      stopRef.current();
    }
  }, [enabled, recording]);

  const getAnalyser = useCallback(() => analyserRef.current, []);

  return {
    active: recording,
    requesting: processing,
    recording,
    transcribing: processing,
    processing,
    interim: '',
    supported,
    error,
    pendingUtterance: null as PendingVoiceTranscript | null,
    confirmPending: async () => undefined,
    discardPending: () => undefined,
    updatePendingText: (_text?: string) => undefined,
    toggle,
    start: startRecording,
    stop: stopRecording,
    release: forceRelease,
    getAnalyser,
  };
}
