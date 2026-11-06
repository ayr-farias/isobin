let ffmpeg = null;
let loadPromise = null;
let active = false;
let cancelRequested = false;

const CORE_BASE = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd';

async function getFFmpeg(onProgress) {
  if (ffmpeg?.loaded) return ffmpeg;
  if (!loadPromise) {
    loadPromise = (async () => {
      onProgress?.(0, 'Loading audio encoder (first use only)…');
      const [{ FFmpeg }, { toBlobURL }] = await Promise.all([
        import('@ffmpeg/ffmpeg'),
        import('@ffmpeg/util'),
      ]);
      const instance = new FFmpeg();
      instance.on('log', ({ message }) => {
        if (message?.includes('Error')) console.warn('[Isobin encoder]', message);
      });
      instance.on('progress', ({ progress }) => {
        if (Number.isFinite(progress)) onProgress?.(Math.max(0, Math.min(1, progress)), 'Encoding audio…');
      });
      await instance.load({
        coreURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.js`, 'text/javascript'),
        wasmURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.wasm`, 'application/wasm'),
      });
      ffmpeg = instance;
      return instance;
    })().catch((error) => {
      loadPromise = null;
      throw new Error(`The browser audio encoder could not be loaded. Check your connection and try again. ${error?.message ?? ''}`);
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
    const mime = settings.format === 'mp3' ? 'audio/mpeg' : settings.format === 'flac' ? 'audio/flac' : 'audio/ogg';
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
