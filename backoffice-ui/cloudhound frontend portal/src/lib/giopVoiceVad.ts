import { readAnalyserLevel } from './giopVoiceLevel';

export interface VoiceVadConfig {
  /** Gated level above noise floor — counts as speech. */
  speechThreshold: number;
  /** Minimum voiced duration before end-of-utterance can fire. */
  minSpeechMs: number;
  /** Trailing silence after speech that triggers send. */
  silenceMs: number;
}

export const DEFAULT_VOICE_VAD: VoiceVadConfig = {
  speechThreshold: 0.075,
  minSpeechMs: 320,
  silenceMs: 850,
};

export class VoiceVadMonitor {
  private noiseFloor = 0.03;
  private heardSpeech = false;
  private speechStartedAt: number | null = null;
  private silenceStartedAt: number | null = null;

  reset(): void {
    this.noiseFloor = 0.03;
    this.heardSpeech = false;
    this.speechStartedAt = null;
    this.silenceStartedAt = null;
  }

  private gatedLevel(analyser: AnalyserNode): number {
    const raw = readAnalyserLevel(analyser);
    this.noiseFloor =
      this.noiseFloor * 0.96 + Math.min(raw, this.noiseFloor + 0.02) * 0.04;
    return Math.max(0, raw - this.noiseFloor * 0.85);
  }

  /**
   * Returns true when trailing silence indicates the user finished speaking.
   */
  shouldSend(analyser: AnalyserNode, now: number, config: VoiceVadConfig): boolean {
    const level = this.gatedLevel(analyser);
    const speaking = level >= config.speechThreshold;

    if (speaking) {
      this.heardSpeech = true;
      if (this.speechStartedAt === null) this.speechStartedAt = now;
      this.silenceStartedAt = null;
      return false;
    }

    if (!this.heardSpeech || this.speechStartedAt === null) return false;

    const speechMs = now - this.speechStartedAt;
    if (speechMs < config.minSpeechMs) return false;

    if (this.silenceStartedAt === null) this.silenceStartedAt = now;
    return now - this.silenceStartedAt >= config.silenceMs;
  }
}
