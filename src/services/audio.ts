import { OggOpusDecoder } from 'ogg-opus-decoder';

/**
 * Голосовые Telegram приходят в Ogg/Opus, а Live API принимает только
 * сырой PCM 16 бит / 16 кГц / моно (little-endian). Здесь весь путь между ними:
 * декодирование WASM-декодером (даёт 48 кГц float) и понижение частоты в 3 раза.
 */

export const PCM_SAMPLE_RATE = 16_000;
const DECODER_SAMPLE_RATE = 48_000;
const DECIMATION = DECODER_SAMPLE_RATE / PCM_SAMPLE_RATE;

/**
 * ФНЧ перед прореживанием: без него всё, что выше 8 кГц, зеркалится в речевой
 * диапазон и модель слышит «металл». Окно Хэмминга, срез 7.5 кГц.
 */
function lowPassTaps(length: number, cutoffRatio: number): Float32Array {
  const taps = new Float32Array(length);
  const middle = (length - 1) / 2;
  let sum = 0;
  for (let i = 0; i < length; i++) {
    const n = i - middle;
    const sinc = n === 0 ? 2 * cutoffRatio : Math.sin(2 * Math.PI * cutoffRatio * n) / (Math.PI * n);
    const window = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (length - 1));
    const value = sinc * window;
    taps[i] = value;
    sum += value;
  }
  for (let i = 0; i < length; i++) taps[i] /= sum;
  return taps;
}

const TAPS = lowPassTaps(31, 7_500 / DECODER_SAMPLE_RATE);
const TAPS_HALF = (TAPS.length - 1) / 2;

/** Несколько каналов сводим в моно простым усреднением */
function toMono(channelData: Float32Array[], samples: number): Float32Array {
  if (channelData.length === 1) return channelData[0].subarray(0, samples);
  const mono = new Float32Array(samples);
  for (const channel of channelData) {
    for (let i = 0; i < samples; i++) mono[i] += channel[i];
  }
  const scale = 1 / channelData.length;
  for (let i = 0; i < samples; i++) mono[i] *= scale;
  return mono;
}

/** Фильтрация + прореживание 48 → 16 кГц и упаковка в int16 LE одним проходом */
function resampleToPcm16(input: Float32Array): Buffer {
  const outLength = Math.floor(input.length / DECIMATION);
  const out = Buffer.allocUnsafe(outLength * 2);
  for (let i = 0; i < outLength; i++) {
    const center = i * DECIMATION;
    let acc = 0;
    for (let t = 0; t < TAPS.length; t++) {
      const index = center + t - TAPS_HALF;
      if (index < 0 || index >= input.length) continue;
      acc += input[index] * TAPS[t];
    }
    const clamped = acc > 1 ? 1 : acc < -1 ? -1 : acc;
    out.writeInt16LE(Math.round(clamped * 32_767), i * 2);
  }
  return out;
}

export interface DecodedAudio {
  /** PCM 16 бит, 16 кГц, моно */
  pcm: Buffer;
  durationSec: number;
}

export class AudioDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AudioDecodeError';
  }
}

/** Ogg/Opus (голосовое Telegram) → PCM, готовый к отправке в Live API */
export async function oggOpusToPcm16(data: Uint8Array): Promise<DecodedAudio> {
  const decoder = new OggOpusDecoder();
  try {
    await decoder.ready;
    const decoded = await decoder.decodeFile(data);
    if (!decoded.samplesDecoded || !decoded.channelData.length) {
      throw new AudioDecodeError('в файле не нашлось звука (Ogg/Opus не распознан)');
    }
    const pcm = resampleToPcm16(toMono(decoded.channelData, decoded.samplesDecoded));
    return { pcm, durationSec: decoded.samplesDecoded / decoded.sampleRate };
  } catch (err) {
    if (err instanceof AudioDecodeError) throw err;
    throw new AudioDecodeError(`не удалось декодировать аудио: ${(err as Error)?.message ?? String(err)}`);
  } finally {
    decoder.free();
  }
}
