/**
 * Read a 0..1 voice level from a Web Audio analyser.
 * Blends time-domain RMS + peak with voice-band frequency energy.
 */
export function readAnalyserLevel(analyser: AnalyserNode | null): number {
  if (!analyser) return 0;

  const timeData = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(timeData);

  let sumSq = 0;
  let peak = 0;
  for (let i = 0; i < timeData.length; i += 1) {
    const v = Math.abs((timeData[i] - 128) / 128);
    sumSq += v * v;
    if (v > peak) peak = v;
  }
  const rms = Math.sqrt(sumSq / timeData.length);

  const freq = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteFrequencyData(freq);
  const lo = Math.floor(freq.length * 0.04);
  const hi = Math.floor(freq.length * 0.58);
  let voiceSum = 0;
  for (let i = lo; i < hi; i += 1) voiceSum += freq[i];
  const voiceAvg = voiceSum / Math.max(1, hi - lo) / 255;

  const blend = rms * 0.5 + peak * 0.5;
  const combined = blend * 0.65 + voiceAvg * 0.35;
  return Math.min(1, Math.pow(combined * 5.5, 0.82));
}
