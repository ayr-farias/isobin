const TWO_PI = Math.PI * 2;
const CHUNK_SAMPLES = 131072;
const MAX_RENDER_BYTES = 1.5 * 1024 * 1024 * 1024;

export function parseTime(value) {
  const text = String(value ?? '').trim().toLowerCase().replace(',', '.');
  if (!text) throw new Error('Enter a duration.');
  if (text.includes(':')) {
    const parts = text.split(':').map(Number);
    if (parts.length > 3 || parts.some((part) => !Number.isFinite(part) || part < 0)) {
      throw new Error(`Invalid time value: ${value}`);
    }
    return parts.reduce((total, part) => total * 60 + part, 0);
  }
  const suffix = text.slice(-1);
  const amount = Number(['h', 'm', 's'].includes(suffix) ? text.slice(0, -1) : text);
  if (!Number.isFinite(amount) || amount < 0) throw new Error(`Invalid time value: ${value}`);
  return amount * (suffix === 'h' ? 3600 : suffix === 'm' ? 60 : 1);
}

const number = (value, label, { min = -Infinity, max = Infinity, exclusiveMin = false } = {}) => {
  const parsed = Number(String(value).trim().replace(',', '.'));
  if (!Number.isFinite(parsed) || (exclusiveMin ? parsed <= min : parsed < min) || parsed > max) {
    const lower = exclusiveMin ? 'greater than' : 'at least';
    throw new Error(`${label} must be ${lower} ${min}${Number.isFinite(max) ? ` and no more than ${max}` : ''}.`);
  }
  return parsed;
};

export function validateSettings(raw) {
  const format = raw.format;
  if (!['wav', 'flac', 'mp3', 'opus'].includes(format)) throw new Error('Choose a supported file format.');
  const duration = parseTime(raw.duration);
  if (duration <= 0) throw new Error('Length must be greater than zero.');
  const fadeIn = parseTime(raw.fadeIn);
  const fadeOut = parseTime(raw.fadeOut);
  if (fadeIn + fadeOut > duration) throw new Error('File fade-in and fade-out cannot exceed the session length.');

  const sampleRate = raw.sampleRate ? number(raw.sampleRate, 'Sample rate', { min: 8000, max: 192000 }) : (format === 'opus' ? 48000 : 44100);
  if (format === 'opus' && ![8000, 12000, 16000, 24000, 48000].includes(sampleRate)) {
    throw new Error('Opus supports sample rates of 8000, 12000, 16000, 24000, or 48000 Hz.');
  }
  if (format === 'mp3' && ![8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000].includes(sampleRate)) {
    throw new Error('MP3 requires a standard sample rate between 8000 and 48000 Hz.');
  }

  const amplitude = number(raw.amplitude, 'Master volume', { min: 0, max: 1 });
  const binauralEnabled = Boolean(raw.binauralEnabled);
  const isoEnabled = Boolean(raw.isoEnabled);
  const binauralAmplitude = binauralEnabled ? number(raw.binauralAmplitude, 'Binaural volume', { min: 0, max: 1 }) : 0;
  const isoAmplitude = isoEnabled ? number(raw.isoAmplitude, 'Isochronic volume', { min: 0, max: 1 }) : 0;
  if (binauralAmplitude === 0 && isoAmplitude === 0) throw new Error('Enable at least one layer and set its volume above zero.');

  const bits = format === 'mp3' || format === 'opus'
    ? 24
    : number(format === 'flac' ? raw.flacBitDepth : raw.bitDepth, 'Bit depth', { min: 16, max: 24 });
  if (format === 'flac') {
    const level = number(raw.flacLevel, 'FLAC compression', { min: 0, max: 12 });
    if (!Number.isInteger(level)) throw new Error('FLAC compression must be a whole number from 0 to 12.');
  }
  if (format === 'mp3') {
    if (raw.mp3Mode === 'VBR') {
      const quality = number(raw.mp3Quality, 'MP3 VBR quality', { min: 0, max: 9 });
      if (!Number.isInteger(quality)) throw new Error('MP3 VBR quality must be a whole number from 0 to 9.');
    } else {
      const bitrate = number(raw.mp3Bitrate, 'MP3 bitrate', { min: 8, max: 320 });
      if (!Number.isInteger(bitrate)) throw new Error('MP3 bitrate must be a whole number from 8 to 320 kbps.');
    }
  }
  if (format === 'opus') {
    number(raw.opusBitrate, 'Opus bitrate', { min: 6, max: 510 });
    if (!['on', 'off', 'constrained'].includes(raw.opusVbr)) throw new Error('Choose a valid Opus rate-control mode.');
  }
  if (![16, 24].includes(bits)) throw new Error('Bit depth must be 16 or 24.');

  const sections = (raw.sections ?? []).map((row, index) => ({
    left: number(row.left, `Section ${index + 1} left frequency`, { min: 0, exclusiveMin: true, max: sampleRate / 2 }),
    right: number(row.right, `Section ${index + 1} right frequency`, { min: 0, exclusiveMin: true, max: sampleRate / 2 }),
    duration: parseTime(row.duration),
  }));
  if (binauralEnabled && sections.length === 0) throw new Error('Add at least one binaural section or turn the binaural layer off.');
  if (sections.some((section) => section.duration <= 0)) throw new Error('Binaural section lengths must be greater than zero.');
  const glide = number(raw.glide, 'Glide', { min: 0 });
  if (sections.length > 1 && glide > Math.min(...sections.map((section) => section.duration))) {
    throw new Error('Glide cannot be longer than the shortest binaural section.');
  }

  const tones = (raw.tones ?? []).map((row, index) => ({
    frequency: number(row.frequency, `Tone ${index + 1} frequency`, { min: 0, exclusiveMin: true, max: sampleRate / 2 }),
    beat: number(row.beat, `Tone ${index + 1} beat`, { min: 0, exclusiveMin: true }),
  }));
  const sync = binauralEnabled && raw.binauralMode === 'sync';
  if ((isoEnabled || sync) && tones.length === 0) throw new Error('Add at least one isochronic tone for the enabled layer or sync mode.');
  const duty = number(raw.duty, 'Duty cycle', { min: 0, exclusiveMin: true, max: 1 });
  const pulseFadeIn = number(raw.pulseFadeIn, 'Pulse fade-in', { min: 0 }) / 1000;
  const pulseFadeOut = number(raw.pulseFadeOut, 'Pulse fade-out', { min: 0 }) / 1000;
  for (const tone of tones) {
    if (pulseFadeIn + pulseFadeOut > duty / tone.beat) {
      throw new Error(`Pulse fades exceed the on-time at ${tone.beat} Hz. Shorten the pulse fades or raise the duty cycle.`);
    }
  }
  const syncTone = number(raw.syncTone, 'Follow tone number', { min: 1, max: Math.max(1, tones.length) });
  if (!Number.isInteger(syncTone)) throw new Error('Follow tone number must be a whole number.');
  const totalSamples = Math.round(duration * sampleRate);
  const dataBytes = totalSamples * 2 * (bits / 8);
  if (dataBytes + 44 > MAX_RENDER_BYTES) {
    throw new Error('This session would exceed the browser renderer’s 1.5 GB safety limit. Reduce the length, sample rate, or bit depth.');
  }
  if (format !== 'wav' && dataBytes > 950 * 1024 * 1024) {
    throw new Error('This file is too large for reliable browser-side encoding. Choose WAV or reduce the duration, sample rate, or bit depth.');
  }

  return {
    ...raw,
    format,
    duration,
    fadeIn,
    fadeOut,
    amplitude,
    sampleRate,
    bits,
    binauralEnabled: binauralAmplitude > 0,
    binauralAmplitude,
    isoEnabled: isoAmplitude > 0,
    isoAmplitude,
    sections,
    glide,
    tones,
    duty,
    pulseFadeIn,
    pulseFadeOut,
    sync,
    syncTone: Math.trunc(syncTone) - 1,
    totalSamples,
    dataBytes,
  };
}

function pulseEnvelope(time, beat, duty, fadeIn, fadeOut) {
  const position = time * beat;
  const periodIndex = Math.floor(position);
  const tau = (position - periodIndex) / beat;
  const onTime = duty / beat;
  if (tau >= onTime) return { envelope: 0, periodIndex };
  let envelope = 1;
  if (fadeIn > 0) {
    const x = Math.max(0, Math.min(1, tau / fadeIn));
    envelope *= 0.5 * (1 - Math.cos(Math.PI * x));
  }
  if (fadeOut > 0) {
    const x = Math.max(0, Math.min(1, (tau - (onTime - fadeOut)) / fadeOut));
    envelope *= 0.5 * (1 + Math.cos(Math.PI * x));
  }
  return { envelope, periodIndex };
}

function wavHeader(sampleRate, bits, dataBytes) {
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const write = (offset, value) => {
    for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i));
  };
  write(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2 * (bits / 8), true);
  view.setUint16(32, 2 * (bits / 8), true);
  view.setUint16(34, bits, true);
  write(36, 'data');
  view.setUint32(40, dataBytes, true);
  return header;
}

export async function renderWav(rawSettings, onProgress = () => {}, isCancelled = () => false) {
  const s = validateSettings(rawSettings);
  const parts = [wavHeader(s.sampleRate, s.bits, s.dataBytes)];
  const sectionStarts = [];
  const sectionEnds = [];
  let sectionCycle = 0;
  for (const section of s.sections) {
    sectionStarts.push(sectionCycle);
    sectionCycle += section.duration;
    sectionEnds.push(sectionCycle);
  }

  const binActive = s.binauralEnabled;
  const isoActive = s.isoEnabled;
  const worstCase = s.amplitude * (s.binauralAmplitude + s.isoAmplitude);
  const normalization = worstCase > 1 ? 1 / worstCase : 1;
  const scale = s.amplitude * normalization;
  const leftCarrier = s.sections.map((section) => section.left);
  const rightCarrier = s.sections.map((section) => section.right);
  const isoCount = s.tones.length;
  const cycle = sectionCycle || 1;
  let phaseLeft = 0;
  let phaseRight = 0;
  let currentSection = 0;
  let processed = 0;
  let lastProgress = -1;

  while (processed < s.totalSamples) {
    if (isCancelled()) throw new DOMException('Generation cancelled.', 'AbortError');
    const count = Math.min(CHUNK_SAMPLES, s.totalSamples - processed);
    const bytesPerSample = s.bits / 8;
    const output = new Uint8Array(count * 2 * bytesPerSample);
    let offset = 0;

    for (let j = 0; j < count; j += 1) {
      const sampleIndex = processed + j;
      const time = sampleIndex / s.sampleRate;
      const fileGainIn = s.fadeIn > 0 ? 0.5 * (1 - Math.cos(Math.PI * Math.max(0, Math.min(1, (sampleIndex + 0.5) / (s.fadeIn * s.sampleRate))))) : 1;
      const fileGainOut = s.fadeOut > 0 ? 0.5 * (1 - Math.cos(Math.PI * Math.max(0, Math.min(1, (s.totalSamples - sampleIndex - 0.5) / (s.fadeOut * s.sampleRate))))) : 1;
      const fileGain = fileGainIn * fileGainOut;

      let binauralLeft = 0;
      let binauralRight = 0;
      let isoLeft = 0;
      let isoRight = 0;
      let syncEnvelope = 1;
      if (binActive) {
        const inCycle = time % cycle;
        if (inCycle < sectionStarts[currentSection]) currentSection = 0;
        while (currentSection < sectionEnds.length - 1 && inCycle >= sectionEnds[currentSection]) currentSection += 1;
        let fLeft = leftCarrier[currentSection];
        let fRight = rightCarrier[currentSection];
        if (s.glide > 0 && s.sections.length > 1) {
          let amount = Math.max(0, Math.min(1, (inCycle - sectionStarts[currentSection]) / s.glide));
          amount = amount * amount * (3 - 2 * amount);
          if (time < s.sections[0].duration) amount = 1;
          const previous = (currentSection - 1 + s.sections.length) % s.sections.length;
          fLeft = leftCarrier[previous] + (fLeft - leftCarrier[previous]) * amount;
          fRight = rightCarrier[previous] + (fRight - rightCarrier[previous]) * amount;
        }
        binauralLeft = Math.sin(phaseLeft);
        binauralRight = Math.sin(phaseRight);
        phaseLeft = (phaseLeft + TWO_PI * fLeft / s.sampleRate) % TWO_PI;
        phaseRight = (phaseRight + TWO_PI * fRight / s.sampleRate) % TWO_PI;
      }

      if (isoActive || s.sync) {
        for (let toneIndex = 0; toneIndex < isoCount; toneIndex += 1) {
          const tone = s.tones[toneIndex];
          const { envelope, periodIndex } = pulseEnvelope(time, tone.beat, s.duty, s.pulseFadeIn, s.pulseFadeOut);
          const wave = Math.sin(TWO_PI * ((tone.frequency * time) % 1)) * envelope;
          if (s.isoMode === 'stereo') {
            if (periodIndex % 2 === 0) isoLeft += wave;
            else isoRight += wave;
          } else {
            isoLeft += wave;
            isoRight += wave;
          }
          if (s.sync && toneIndex === s.syncTone) syncEnvelope = envelope;
        }
      }
      const binauralGate = s.sync && binActive ? syncEnvelope : 1;
      let left = binauralLeft * s.binauralAmplitude * binauralGate;
      let right = binauralRight * s.binauralAmplitude * binauralGate;
      if (isoActive && isoCount > 0) {
        left += (isoLeft / isoCount) * s.isoAmplitude;
        right += (isoRight / isoCount) * s.isoAmplitude;
      }

      left *= scale * fileGain;
      right *= scale * fileGain;
      if (s.bits === 16) {
        const l = Math.max(-32768, Math.min(32767, Math.round(left * 32767 + Math.random() - Math.random())));
        const r = Math.max(-32768, Math.min(32767, Math.round(right * 32767 + Math.random() - Math.random())));
        output[offset++] = l & 255; output[offset++] = (l >> 8) & 255;
        output[offset++] = r & 255; output[offset++] = (r >> 8) & 255;
      } else {
        const l = Math.max(-8388608, Math.min(8388607, Math.round(left * 8388607)));
        const r = Math.max(-8388608, Math.min(8388607, Math.round(right * 8388607)));
        output[offset++] = l & 255; output[offset++] = (l >> 8) & 255; output[offset++] = (l >> 16) & 255;
        output[offset++] = r & 255; output[offset++] = (r >> 8) & 255; output[offset++] = (r >> 16) & 255;
      }
    }

    parts.push(output);
    processed += count;
    const progress = Math.floor((processed / s.totalSamples) * 100);
    if (progress !== lastProgress) {
      lastProgress = progress;
      onProgress(progress);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  return new Blob(parts, { type: 'audio/wav' });
}

export function estimatedFileSize(settings) {
  const seconds = parseTime(settings.duration);
  const rate = Number(settings.sampleRate) || (settings.format === 'opus' ? 48000 : 44100);
  if (settings.format === 'mp3') return seconds * (settings.mp3Mode === 'VBR' ? 245000 : Number(settings.mp3Bitrate || 192) * 1000) / 8;
  if (settings.format === 'opus') return seconds * Number(settings.opusBitrate || 128) * 1000 / 8;
  const bits = Number(settings.format === 'flac' ? settings.flacBitDepth : settings.bitDepth) || 16;
  const raw = seconds * rate * 2 * (bits / 8);
  return settings.format === 'flac' ? raw * 0.65 : raw;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
