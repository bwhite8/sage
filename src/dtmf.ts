/**
 * DTMF tone generation as g711 µ-law audio.
 *
 * Generates raw DTMF tones and encodes them as base64 µ-law,
 * suitable for injecting directly into a Twilio media stream.
 */

const SAMPLE_RATE = 8000;

// DTMF frequency pairs: [low frequency, high frequency]
const DTMF_FREQS: Record<string, [number, number]> = {
  '1': [697, 1209],
  '2': [697, 1336],
  '3': [697, 1477],
  'A': [697, 1633],
  '4': [770, 1209],
  '5': [770, 1336],
  '6': [770, 1477],
  'B': [770, 1633],
  '7': [852, 1209],
  '8': [852, 1336],
  '9': [852, 1477],
  'C': [852, 1633],
  '*': [941, 1209],
  '0': [941, 1336],
  '#': [941, 1477],
  'D': [941, 1633],
};

// Duration constants (in seconds)
const TONE_DURATION = 0.16;   // 160ms per digit
const GAP_DURATION = 0.08;    // 80ms silence between digits
const PAUSE_DURATION = 0.5;   // 500ms for 'w' (wait)

/**
 * Encode a 16-bit linear PCM sample to µ-law.
 * Standard ITU-T G.711 algorithm.
 */
function linearToUlaw(sample: number): number {
  const BIAS = 0x84; // 132
  const CLIP = 32635;

  const sign = sample < 0 ? 0x80 : 0;
  if (sample < 0) sample = -sample;
  if (sample > CLIP) sample = CLIP;

  sample += BIAS;

  let exponent = 7;
  const exponentMask = 0x4000;
  for (; exponent > 0; exponent--) {
    if (sample & (exponentMask >> (7 - exponent))) break;
  }

  const mantissa = (sample >> (exponent + 3)) & 0x0F;
  const ulawByte = ~(sign | (exponent << 4) | mantissa) & 0xFF;
  return ulawByte;
}

/**
 * Generate silence as µ-law samples.
 */
function generateSilence(durationSec: number): number[] {
  const numSamples = Math.round(SAMPLE_RATE * durationSec);
  const silence = linearToUlaw(0);
  return new Array(numSamples).fill(silence);
}

/**
 * Generate a single DTMF tone as µ-law samples.
 */
function generateTone(lowFreq: number, highFreq: number, durationSec: number): number[] {
  const numSamples = Math.round(SAMPLE_RATE * durationSec);
  const samples: number[] = new Array(numSamples);
  const amplitude = 8192; // ~25% of max 16-bit to avoid clipping when summed

  for (let i = 0; i < numSamples; i++) {
    const t = i / SAMPLE_RATE;
    const low = Math.sin(2 * Math.PI * lowFreq * t);
    const high = Math.sin(2 * Math.PI * highFreq * t);
    const pcm = Math.round(amplitude * (low + high));
    samples[i] = linearToUlaw(pcm);
  }

  return samples;
}

/**
 * Generate DTMF tones for a digit string as base64-encoded g711_ulaw audio.
 *
 * Supports digits: 0-9, *, #, A-D
 * Special characters: 'w' = 500ms pause
 *
 * @param digits - The DTMF digit string (e.g., '*6', 'w*6')
 * @returns Base64-encoded µ-law audio
 */
export function generateDtmfUlaw(digits: string): string {
  const allSamples: number[] = [];

  for (let i = 0; i < digits.length; i++) {
    const ch = digits[i];

    if (ch === 'w' || ch === 'W') {
      allSamples.push(...generateSilence(PAUSE_DURATION));
      continue;
    }

    const freqs = DTMF_FREQS[ch];
    if (!freqs) {
      console.warn(`[DTMF] Unknown digit: ${ch}, skipping`);
      continue;
    }

    // Add gap before this tone (if not the first sound)
    if (allSamples.length > 0) {
      allSamples.push(...generateSilence(GAP_DURATION));
    }

    allSamples.push(...generateTone(freqs[0], freqs[1], TONE_DURATION));
  }

  return Buffer.from(allSamples).toString('base64');
}
