/**
 * Local voice capture — record in browser, transcribe on sync-service (Whisper).
 * No Google/cloud STT; works offline after the model is downloaded.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { portalAiTranscribe } from '../api/giop-api';

const MAX_RECORD_MS = 12_000;

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

async function ensureMicrophonePermission(): Promise<string | null> {
  if (!navigator.mediaDevices?.getUserMedia) {
    return 'Microphone API not available in this browser.';
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    return null;
  } catch (err) {
    if (err instanceof DOMException) {
      if (err.name === 'NotAllowedError') {
        return 'Microphone permission denied — allow mic access in browser settings.';
      }
      if (err.name === 'NotFoundError') {
        return 'No microphone detected.';
      }
      return err.message || err.name;
    }
    return err instanceof Error ? err.message : 'Microphone permission failed';
  }
}

export interface UseGiopVoiceSessionOptions {
  onUtterance: (text: string) => void | Promise<void>;
  enabled?: boolean;
}

export function useGiopVoiceSession({
  onUtterance,
  enabled = true,
}: UseGiopVoiceSessionOptions) {
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [supported, setSupported] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const mimeRef = useRef('audio/webm');
  const maxTimerRef = useRef<number | undefined>(undefined);
  const onUtteranceRef = useRef(onUtterance);

  onUtteranceRef.current = onUtterance;

  useEffect(() => {
    const ok =
      typeof window !== 'undefined' &&
      Boolean(navigator.mediaDevices?.getUserMedia) &&
      typeof MediaRecorder !== 'undefined' &&
      Boolean(pickRecorderMime());
    setSupported(ok);
  }, []);

  const cleanupStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    recorderRef.current = null;
    window.clearTimeout(maxTimerRef.current);
  }, []);

  const stopRecording = useCallback(() => {
    window.clearTimeout(maxTimerRef.current);
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      try {
        recorder.stop();
      } catch {
        cleanupStream();
        setRecording(false);
      }
      return;
    }
    cleanupStream();
    setRecording(false);
  }, [cleanupStream]);

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
    const micErr = await ensureMicrophonePermission();
    if (micErr) {
      setError(micErr);
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      mimeRef.current = mime;
      chunksRef.current = [];

      const recorder = new MediaRecorder(stream, { mimeType: mime });
      recorderRef.current = recorder;

      recorder.ondataavailable = (ev) => {
        if (ev.data.size > 0) chunksRef.current.push(ev.data);
      };

      recorder.onstop = () => {
        setRecording(false);
        const blob = new Blob(chunksRef.current, { type: mimeRef.current });
        cleanupStream();
        chunksRef.current = [];

        if (blob.size < 800) {
          setError('Recording too short — tap mic, speak, then tap again.');
          return;
        }

        setTranscribing(true);
        void (async () => {
          try {
            const { text } = await portalAiTranscribe(blob);
            const trimmed = text.trim();
            if (!trimmed) {
              setError('No speech detected — try again.');
              return;
            }
            setError(null);
            await onUtteranceRef.current(trimmed);
          } catch (err) {
            setError(err instanceof Error ? err.message : 'Transcription failed');
          } finally {
            setTranscribing(false);
          }
        })();
      };

      recorder.onerror = () => {
        setError('Recording failed — try again.');
        stopRecording();
      };

      recorder.start();
      setRecording(true);
      maxTimerRef.current = window.setTimeout(() => {
        stopRecording();
      }, MAX_RECORD_MS);
    } catch (err) {
      cleanupStream();
      setRecording(false);
      setError(err instanceof Error ? err.message : 'Could not start recording');
    }
  }, [cleanupStream, enabled, stopRecording]);

  const toggle = useCallback(() => {
    if (recording || transcribing) stopRecording();
    else void startRecording();
  }, [recording, startRecording, stopRecording, transcribing]);

  const stopRef = useRef(stopRecording);
  stopRef.current = stopRecording;

  useEffect(() => () => {
    stopRef.current();
    cleanupStream();
  }, [cleanupStream]);

  useEffect(() => {
    if (!enabled && recording) {
      stopRef.current();
    }
  }, [enabled, recording]);

  return {
    active: recording,
    requesting: transcribing,
    recording,
    transcribing,
    interim: '',
    supported,
    error,
    toggle,
    start: startRecording,
    stop: stopRecording,
  };
}
