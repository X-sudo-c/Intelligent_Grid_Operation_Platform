/**
 * Play copilot spoken replies via Supertonic (server) or browser TTS fallback.
 * Playback is routed through a Web Audio analyser so the voice wave can move
 * with the assistant's actual speech.
 */

let currentAudio: HTMLAudioElement | null = null;

type SpeechListener = (speaking: boolean) => void;
const speechListeners = new Set<SpeechListener>();
let speakingNow = false;

let playbackCtx: AudioContext | null = null;
let playbackAnalyser: AnalyserNode | null = null;

function setSpeaking(value: boolean): void {
  if (speakingNow === value) return;
  speakingNow = value;
  for (const listener of speechListeners) listener(value);
}

/** Subscribe to assistant speaking state. Returns unsubscribe. */
export function subscribeCopilotSpeech(listener: SpeechListener): () => void {
  speechListeners.add(listener);
  listener(speakingNow);
  return () => speechListeners.delete(listener);
}

export function isCopilotSpeaking(): boolean {
  return speakingNow;
}

/** Analyser fed by server-TTS playback; null for browser speechSynthesis fallback. */
export function getSpeechAnalyser(): AnalyserNode | null {
  return playbackAnalyser;
}

function ensurePlaybackAnalyser(): AnalyserNode | null {
  const AudioCtx =
    window.AudioContext ??
    (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtx) return null;
  if (!playbackCtx) playbackCtx = new AudioCtx();
  if (!playbackAnalyser) {
    playbackAnalyser = playbackCtx.createAnalyser();
    playbackAnalyser.fftSize = 256;
    playbackAnalyser.smoothingTimeConstant = 0.72;
    playbackAnalyser.connect(playbackCtx.destination);
  }
  return playbackAnalyser;
}

export function stopCopilotSpeech(): void {
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    window.speechSynthesis.cancel();
  }
  setSpeaking(false);
}

export async function fetchCopilotSpeechBlob(text: string): Promise<Blob | null> {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const res = await fetch('/api/v1/portal/ai/speak', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: trimmed }),
  });
  if (!res.ok) return null;
  return res.blob();
}

export async function playCopilotSpeech(text: string): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) return;
  stopCopilotSpeech();
  try {
    const blob = await fetchCopilotSpeechBlob(trimmed);
    if (blob && blob.size > 0) {
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      currentAudio = audio;

      try {
        const analyser = ensurePlaybackAnalyser();
        if (analyser && playbackCtx) {
          const source = playbackCtx.createMediaElementSource(audio);
          source.connect(analyser);
          void playbackCtx.resume().catch(() => undefined);
        }
      } catch {
        /* analyser wiring failed — element still plays directly */
      }

      audio.onended = () => {
        URL.revokeObjectURL(url);
        if (currentAudio === audio) {
          currentAudio = null;
          setSpeaking(false);
        }
      };
      audio.onerror = () => {
        URL.revokeObjectURL(url);
        if (currentAudio === audio) {
          currentAudio = null;
          setSpeaking(false);
        }
      };
      setSpeaking(true);
      await audio.play();
      return;
    }
  } catch {
    /* Supertonic unavailable — browser fallback */
  }
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    const utterance = new SpeechSynthesisUtterance(trimmed);
    utterance.lang = 'en-GB';
    utterance.rate = 1.05;
    utterance.onstart = () => setSpeaking(true);
    utterance.onend = () => setSpeaking(false);
    utterance.onerror = () => setSpeaking(false);
    window.speechSynthesis.speak(utterance);
  }
}
