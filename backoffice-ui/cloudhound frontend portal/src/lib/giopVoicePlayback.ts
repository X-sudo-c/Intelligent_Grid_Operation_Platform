/** Play copilot spoken replies via Supertonic (server) or browser TTS fallback. */

let currentAudio: HTMLAudioElement | null = null;

export function stopCopilotSpeech(): void {
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    window.speechSynthesis.cancel();
  }
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
      audio.onended = () => {
        URL.revokeObjectURL(url);
        if (currentAudio === audio) currentAudio = null;
      };
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
    window.speechSynthesis.speak(utterance);
  }
}
