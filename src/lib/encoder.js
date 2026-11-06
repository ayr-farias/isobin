let ffmpeg = null;
let loadPromise = null;
let active = false;
let cancelRequested = false;

// Astro is built with Vite. FFmpeg's official Vite guidance requires the ESM
// core rather than the UMD build. Keep a second CDN as a network fallback.
const CORE_BASES = [
  'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm',
  'https://unpkg.com/@ffmpeg/core@0.12.10/dist/esm',
];

async function toLocalBlobURL(url, contentType) {
  let response;
  try {
    response = await fetch(url, { mode: 'cors', cache: 'force-cache' });
  } catch (error) {
    throw new Error(`Network request failed (${url}): ${error?.message ?? error}`);
  }

  if (!response.ok) {
    throw new Error(`Could not download encoder asset (HTTP ${response.status}): ${url}`);
  }

  const bytes = await response.arrayBuffer();
  if (!bytes.byteLength) throw new Error(`Downloaded encoder asset was empty: ${url}`);
  return URL.createObjectURL(new Blob([bytes], { type: contentType }));
}

async function loadFFmpegCore(FFmpeg, onProgress) {
  const failures = [];

  for (let index = 0; index < CORE_BASES.length; index += 1) {
    const base = CORE_BASES[index];
    const source = index === 0 ? 'jsDelivr' : 'unpkg';
    let coreURL = null;
    let wasmURL = null;
    let instance = null;

    try {
      onProgress?.(0, `Loading audio encoder from ${source}${index ? ' (fallback)' : ''}…`);
      coreURL = await toLocalBlobURL(`${base}/ffmpeg-core.js`, 'text/javascript');
      wasmURL = await toLocalBlobURL(`${base}/ffmpeg-core.wasm`, 'application/wasm');

      instance = new FFmpeg();
      instance.on('log', ({ message }) => {
        if (message?.toLowerCase().includes('error')) {
          console.warn('[Isobin encoder]', message);
        }
      });
      instance.on('progress', ({ progress }) => {
        if (Number.isFinite(progress)) {
          onProgress?.(Math.max(0, Math.min(1, progress)), 'Encoding audio…');
        }
      });

      await instance.load({ coreURL, wasmURL });
      ffmpeg = instance;
      return instance;
    } catch (error) {
      try { instance?.terminate(); } catch {}
      failures.push(`${source}: ${error?.message ?? String(error)}`);
    } finally {
      // FFmpeg has copied/loaded the core assets once load() resolves.
      if (coreURL) URL.revokeObjectURL(coreURL);
      if (wasmURL) URL.revokeObjectURL(wasmURL);
    }
  }

  throw new Error(
    'Could not initialize the browser audio encoder. WAV rendering completed, but the optional MP3/FLAC/Opus encoder could not start. ' +
    failures.join(' | ')
  );
}

async function getFFmpeg(onProgress) {
  if (ffmpeg?.loaded) return ffmpeg;

  if (!loadPromise) {
    loadPromise = (async () => {
      onProgress?.(0, 'Loading audio encoder (first use only; approximately 32 MB)…');
      const { FFmpeg } = await import('@ffmpeg/ffmpeg');
      return loadFFmpegCore(FFmpeg, onProgress);
    })().catch((error) => {
      loadPromise = null;
      console.error('[Isobin] FFmpeg WebAssembly loading failed:', error);
      throw new Error(
        `${error?.message ?? 'The audio encoder could not be loaded.'} ` +
        'Allow access to jsDelivr or unpkg and retry. WAV export does not require this encoder.'
      );
    });
  }

  return loadPromise;
}

export async function encodeAudio(wavBlob, settings, onProgress = () => {}) {
  cancelRequested = false;
  const instance = await getFFmpeg(onProgress);
  if (cancelRequested) {
    instance.terminate();
    ffmpeg = null;
    loadPromise = null;
    throw new DOMException('Encoding cancelled.', 'AbortError');
  }

  active = true;
  const inputName = 'isobin-source.wav';
  const outputName = `isobin-output.${settings.format}`;

  try {
    try { await instance.deleteFile(inputName); } catch {}
    try { await instance.deleteFile(outputName); } catch {}
    await instance.writeFile(inputName, new Uint8Array(await wavBlob.arrayBuffer()));

    const args = ['-hide_banner', '-y', '-i', inputName, '-ar', String(settings.sampleRate)];
    if (settings.format === 'mp3') {
      args.push('-c:a', 'libmp3lame');
      if (settings.mp3Mode === 'VBR') args.push('-q:a', String(settings.mp3Quality ?? 2));
      else args.push('-b:a', `${settings.mp3Bitrate ?? 192}k`);
    } else if (settings.format === 'flac') {
      args.push('-c:a', 'flac', '-compression_level', String(settings.flacLevel ?? 5));
    } else if (settings.format === 'opus') {
      args.push('-c:a', 'libopus', '-b:a', `${settings.opusBitrate ?? 128}k`, '-vbr', settings.opusVbr ?? 'on');
    } else {
      throw new Error(`Unsupported encoded format: ${settings.format}`);
    }

    args.push(outputName);
    const exitCode = await instance.exec(args);
    if (exitCode !== 0) throw new Error(`The encoder exited with code ${exitCode}.`);

    const data = await instance.readFile(outputName);
    const mime = settings.format === 'mp3'
      ? 'audio/mpeg'
      : settings.format === 'flac'
        ? 'audio/flac'
        : 'audio/ogg';
    return new Blob([data], { type: mime });
  } finally {
    active = false;
    try { await instance.deleteFile(inputName); } catch {}
    try { await instance.deleteFile(outputName); } catch {}
  }
}

export function cancelEncoding() {
  cancelRequested = true;
  if (active && ffmpeg) {
    ffmpeg.terminate();
    ffmpeg = null;
    loadPromise = null;
    active = false;
  }
}
