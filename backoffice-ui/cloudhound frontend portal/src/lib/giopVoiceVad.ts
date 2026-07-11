import { readAnalyserLevel } from './giopVoiceLevel';

export interface VoiceVadConfig {
  /** Gated level above noise floor — counts as speech. */
  speechThreshold: number;
  /** Minimum voiced duration before end-of-utterance can fire. */
  minSpeechMs: number;
  /** Trailing silence after speech that triggers send (longer utterances). */
  silenceMs: number;
  /** Utterances shorter than this use shortSilenceMs. */
  shortUtteranceMs?: number;
  /** Faster end-of-speech for short commands ("zoom in"). */
  shortSilenceMs?: number;
}

export const DEFAULT_VOICE_VAD: VoiceVadConfig = {
  speechThreshold: 0.075,
  minSpeechMs: 280,
  silenceMs: 550,
  shortUtteranceMs: 1400,
  shortSilenceMs: 420,
};

export class VoiceVadMonitor {
  private noiseFloor = 0.03;
  private heardSpeech = false;
  private speechStartedAt: number | null = null;
  private silenceStartedAt: number | null = null;
  private speaking = false;

  reset(): void {
    this.noiseFloor = 0.03;
    this.heardSpeech = false;
    this.speechStartedAt = null;
    this.silenceStartedAt = null;
    this.speaking = false;
  }

  hasHeardSpeech(): boolean {
    return this.heardSpeech;
  }

  isSpeaking(): boolean {
    return this.speaking;
  }

  private gatedLevel(analyser: AnalyserNode): number {
    const raw = readAnalyserLevel(analyser);
    this.noiseFloor =
      this.noiseFloor * 0.96 + Math.min(raw, this.noiseFloor + 0.02) * 0.04;
    return Math.max(0, raw - this.noiseFloor * 0.85);
  }

  /** Update speech/silence state from the current analyser frame. */
  tick(analyser: AnalyserNode, now: number, config: VoiceVadConfig): void {
    const level = this.gatedLevel(analyser);
    this.speaking = level >= config.speechThreshold;

    if (this.speaking) {
      this.heardSpeech = true;
      if (this.speechStartedAt === null) this.speechStartedAt = now;
      this.silenceStartedAt = null;
      return;
    }

    if (!this.heardSpeech || this.speechStartedAt === null) return;
    if (this.silenceStartedAt === null) this.silenceStartedAt = now;
  }

  /**
   * Returns true when trailing silence indicates the user finished speaking.
   * Call after tick() in the same poll frame.
   */
  shouldSend(now: number, config: VoiceVadConfig): boolean {
    if (this.speaking || !this.heardSpeech || this.speechStartedAt === null) return false;

    const speechMs = now - this.speechStartedAt;
    if (speechMs < config.minSpeechMs) return false;
    if (this.silenceStartedAt === null) return false;

    const shortLimit = config.shortUtteranceMs ?? Number.POSITIVE_INFINITY;
    const silenceTarget =
      speechMs < shortLimit ? (config.shortSilenceMs ?? config.silenceMs) : config.silenceMs;
    return now - this.silenceStartedAt >= silenceTarget;
  }
}
