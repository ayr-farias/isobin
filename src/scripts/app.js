import { validateSettings, estimatedFileSize, formatBytes } from '../lib/synthesis.js';
import { encodeAudio, cancelEncoding } from '../lib/encoder.js';

const $ = (id) => document.getElementById(id);
const formIds = [
  'output-name', 'file-format', 'sample-rate', 'duration', 'fade-in', 'fade-out', 'master-volume',
  'bit-depth', 'flac-level', 'flac-bit-depth', 'mp3-mode', 'mp3-bitrate', 'mp3-quality',
  'opus-bitrate', 'opus-vbr', 'binaural-enabled', 'binaural-volume', 'binaural-glide',
  'binaural-mode', 'sync-tone', 'iso-enabled', 'iso-volume', 'iso-duty', 'iso-fade-in',
  'iso-fade-out', 'iso-mode',
];
const STORAGE_KEY = 'isobin.browser-settings.v1';
const PRESETS = {
  alpha: { sections: [['200', '210', '60s']], tones: [['300', '10']], binauralMode: 'constant', glide: '0' },
  theta: { sections: [['200', '206', '60s']], tones: [['250', '6']], binauralMode: 'constant', glide: '0' },
  delta: { sections: [['150', '152', '60s']], tones: [['200', '2']], binauralMode: 'constant', glide: '0' },
  beta: { sections: [['200', '218', '60s']], tones: [['300', '18']], binauralMode: 'constant', glide: '0' },
  sync: { sections: [['200', '210', '60s']], tones: [['300', '10']], binauralMode: 'sync', syncTone: '1', glide: '0' },
  descending: {
    duration: '90m', fadeIn: '1s', fadeOut: '1s',
    sections: Array.from({ length: 9 }, (_, index) => ['55', String(82 - index * 3), '10m']),
    tones: [['110', '3'], ['220', '6'], ['330', '9'], ['440', '12'], ['550', '15']],
    glide: '1', binauralMode: 'constant', isoMode: 'mono',
  },
};

let sections = [{ left: '200', right: '210', duration: '60s' }];
let tones = [{ frequency: '300', beat: '10' }];
let renderWorker = null;
let isRendering = false;
let isEncoding = false;
let downloadUrl = null;
let latestNormalized = null;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function renderRows() {
  $('sections-list').innerHTML = sections.map((row, index) => `
    <div class="data-row section-row" data-index="${index}">
      <label><span>LEFT · HZ</span><input type="number" min="0.1" step="any" value="${escapeHtml(row.left)}" data-field="left" aria-label="Section ${index + 1} left frequency" /></label>
      <label><span>RIGHT · HZ</span><input type="number" min="0.1" step="any" value="${escapeHtml(row.right)}" data-field="right" aria-label="Section ${index + 1} right frequency" /></label>
      <label><span>LENGTH</span><input type="text" value="${escapeHtml(row.duration)}" data-field="duration" aria-label="Section ${index + 1} length" /></label>
      <div class="row-actions">
        <button type="button" data-move="-1" data-index="${index}" aria-label="Move section up" ${index === 0 ? 'disabled' : ''}>↑</button>
        <button type="button" data-move="1" data-index="${index}" aria-label="Move section down" ${index === sections.length - 1 ? 'disabled' : ''}>↓</button>
        <button type="button" data-remove-section="${index}" aria-label="Remove section" ${sections.length === 1 ? 'disabled' : ''}>×</button>
      </div>
    </div>`).join('');

  $('tones-list').innerHTML = tones.map((row, index) => `
    <div class="data-row tone-row" data-index="${index}">
      <label><span>TONE · HZ</span><input type="number" min="0.1" step="any" value="${escapeHtml(row.frequency)}" data-field="frequency" aria-label="Tone ${index + 1} frequency" /></label>
      <label><span>BEAT · HZ</span><input type="number" min="0.1" step="any" value="${escapeHtml(row.beat)}" data-field="beat" aria-label="Tone ${index + 1} beat" /></label>
      <div class="row-actions"><button type="button" data-remove-tone="${index}" aria-label="Remove tone" ${tones.length === 1 ? 'disabled' : ''}>×</button></div>
    </div>`).join('');
  updateBeatReadout();
}

function rowValueEvents(container, getCollection) {
  $(container).addEventListener('input', (event) => {
    const input = event.target.closest('input[data-field]');
    if (!input) return;
    const index = Number(input.closest('.data-row').dataset.index);
    const collection = getCollection();
    collection[index][input.dataset.field] = input.value;
    updateBeatReadout();
    saveSettings();
    updateEstimate();
  });
}

function updateBeatReadout() {
  const left = Number(sections[0]?.left);
  const right = Number(sections[0]?.right);
  const diff = Number.isFinite(left) && Number.isFinite(right) ? Math.abs(right - left) : NaN;
  $('beat-readout').innerHTML = `<span class="readout-pulse"></span>Beat difference: <strong>${Number.isFinite(diff) ? `${diff.toLocaleString(undefined, { maximumFractionDigits: 3 })} Hz` : '—'}</strong>`;
}

function readForm() {
  const value = (id) => $(id).value;
  const checked = (id) => $(id).checked;
  return {
    output: value('output-name').trim() || 'isobin_session',
    format: value('file-format'), sampleRate: value('sample-rate'),
    duration: value('duration'), fadeIn: value('fade-in'), fadeOut: value('fade-out'),
    amplitude: value('master-volume'), bitDepth: value('bit-depth'),
    flacLevel: value('flac-level'), flacBitDepth: value('flac-bit-depth'),
    mp3Mode: value('mp3-mode'), mp3Bitrate: value('mp3-bitrate'), mp3Quality: value('mp3-quality'),
    opusBitrate: value('opus-bitrate'), opusVbr: value('opus-vbr'),
    binauralEnabled: checked('binaural-enabled'), binauralAmplitude: value('binaural-volume'),
    binauralMode: value('binaural-mode'), syncTone: value('sync-tone'), glide: value('binaural-glide'),
    sections: sections.map((row) => ({ ...row })),
    isoEnabled: checked('iso-enabled'), isoAmplitude: value('iso-volume'),
    duty: value('iso-duty'), pulseFadeIn: value('iso-fade-in'), pulseFadeOut: value('iso-fade-out'),
    isoMode: value('iso-mode'), tones: tones.map((row) => ({ ...row })),
  };
}

function applyForm(state) {
  for (const [key, value] of Object.entries(state)) {
    if (key === 'sections' || key === 'tones') continue;
    const map = {
      output: 'output-name', format: 'file-format', sampleRate: 'sample-rate', duration: 'duration',
      fadeIn: 'fade-in', fadeOut: 'fade-out', amplitude: 'master-volume', bitDepth: 'bit-depth',
      flacLevel: 'flac-level', flacBitDepth: 'flac-bit-depth', mp3Mode: 'mp3-mode',
      mp3Bitrate: 'mp3-bitrate', mp3Quality: 'mp3-quality', opusBitrate: 'opus-bitrate',
      opusVbr: 'opus-vbr', binauralEnabled: 'binaural-enabled', binauralAmplitude: 'binaural-volume',
      binauralMode: 'binaural-mode', syncTone: 'sync-tone', glide: 'binaural-glide',
      isoEnabled: 'iso-enabled', isoAmplitude: 'iso-volume', duty: 'iso-duty',
      pulseFadeIn: 'iso-fade-in', pulseFadeOut: 'iso-fade-out', isoMode: 'iso-mode',
    };
    const id = map[key];
    if (!id || $(id) == null) continue;
    if ($(id).type === 'checkbox') $(id).checked = Boolean(value);
    else $(id).value = value;
  }
  if (Array.isArray(state.sections)) sections = state.sections.map((row) => ({ left: row.left ?? row[0], right: row.right ?? row[1], duration: row.duration ?? row[2] }));
  if (Array.isArray(state.tones)) tones = state.tones.map((row) => ({ frequency: row.frequency ?? row[0], beat: row.beat ?? row[1] }));
  renderRows();
  updateFormatUI();
  updateSliders();
  updateLayerStates();
  updateEstimate();
}

function saveSettings() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(readForm())); } catch { /* Private browsing may disable storage. */ }
}

function restoreSettings() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (stored && typeof stored === 'object') applyForm(stored);
  } catch { /* Ignore stale or unavailable settings. */ }
}

function updateSliders() {
  for (const [id, outputId] of [['master-volume', 'master-volume-value'], ['binaural-volume', 'binaural-volume-value'], ['iso-volume', 'iso-volume-value'], ['iso-duty', 'iso-duty-value']]) {
    $(outputId).value = Number($(id).value).toFixed(2);
    $(outputId).textContent = Number($(id).value).toFixed(2);
  }
}

function updateLayerStates() {
  $('binaural-card')?.classList.toggle('is-disabled', !$('binaural-enabled').checked);
  $('iso-card')?.classList.toggle('is-disabled', !$('iso-enabled').checked);
  $('sync-tone-field').classList.toggle('hidden', $('binaural-mode').value !== 'sync');
}

function updateFormatUI() {
  const format = $('file-format').value;
  for (const name of ['wav', 'flac', 'mp3', 'opus']) {
    $(`format-settings-${name}`).classList.toggle('hidden', format !== name);
  }
  $('mp3-bitrate-wrap').classList.toggle('hidden', $('mp3-mode').value === 'VBR');
  $('mp3-quality-wrap').classList.toggle('hidden', $('mp3-mode').value !== 'VBR');
  const sample = $('sample-rate');
  const valid = {
    opus: ['', '8000', '12000', '16000', '24000', '48000'],
    mp3: ['', '11025', '12000', '16000', '22050', '24000', '32000', '44100', '48000'],
    wav: ['', '8000', '11025', '12000', '16000', '22050', '24000', '32000', '44100', '48000', '88200', '96000', '192000'],
    flac: ['', '8000', '11025', '12000', '16000', '22050', '24000', '32000', '44100', '48000', '88200', '96000', '192000'],
  }[format];
  for (const option of sample.options) option.hidden = !valid.includes(option.value);
  if (!valid.includes(sample.value)) sample.value = '';
  updateEstimate();
}

function updateEstimate() {
  try {
    const estimate = estimatedFileSize(readForm());
    $('estimate-size').textContent = formatBytes(estimate);
    $('estimate-caption').textContent = 'Estimated download size';
    $('estimate-box').classList.toggle('estimate-large', estimate > 500 * 1024 * 1024);
  } catch {
    $('estimate-size').textContent = '—';
    $('estimate-caption').textContent = 'Enter a valid session length';
    $('estimate-box').classList.remove('estimate-large');
  }
}

function setMessage(message, tone = '') {
  $('render-message').textContent = message;
  $('render-message').dataset.tone = tone;
}

function setProgress(percent, message) {
  const safe = Math.max(0, Math.min(100, percent));
  $('render-progress').classList.remove('hidden');
  $('progress-fill').style.width = `${safe}%`;
  $('render-percent').textContent = `${Math.round(safe)}%`;
  if (message) $('render-status').textContent = message;
}

function setBusy(busy, label = 'Generate audio') {
  $('generate-button').classList.toggle('is-cancel', busy);
  $('generate-button').querySelector('.generate-label').textContent = busy ? 'Cancel generation' : label;
  $('generate-button').querySelector('.generate-arrow').textContent = busy ? '×' : '↗';
  isRendering = busy;
}

function makeFilename(settings) {
  const base = (settings.output || 'isobin_session').replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[\\/:*?"<>|]+/g, '-').trim() || 'isobin_session';
  return `${base}.${settings.format}`;
}

function pythonCommand(s) {
  const args = ['-o', makeFilename(s), '--format', s.format, '-d', s.duration, '-a', Number(s.amplitude).toFixed(3), '--fade-in', s.fadeIn, '--fade-out', s.fadeOut];
  if (s.sampleRate) args.push('--sample-rate', s.sampleRate);
  if (s.format === 'wav') args.push('--bit-depth', s.bitDepth);
  if (s.format === 'flac') args.push('--bit-depth', s.flacBitDepth, '--flac-level', s.flacLevel);
  if (s.format === 'mp3') {
    if (s.mp3Mode === 'VBR') args.push('--mp3-vbr-quality', s.mp3Quality);
    else args.push('--bitrate', s.mp3Bitrate);
  }
  if (s.format === 'opus') args.push('--bitrate', s.opusBitrate, '--opus-vbr', s.opusVbr);
  if (s.binauralEnabled) {
    args.push('--binaural-amplitude', Number(s.binauralAmplitude).toFixed(3), '--binaural-mode', s.binauralMode, '--binaural-glide', s.glide || '0');
    for (const row of s.sections) args.push('--binaural', `${row.left},${row.right}`);
    args.push('--binaural-section-duration', s.sections.map((row) => row.duration).join(','));
    if (s.binauralMode === 'sync') args.push('--binaural-sync-tone', s.syncTone);
  } else args.push('--binaural-amplitude', '0');
  if (s.tones.length) args.push('--iso-tones', String(s.tones.length), '--iso-tone-freq', s.tones.map((row) => row.frequency).join(','), '--iso-beat-freq', s.tones.map((row) => row.beat).join(','));
  args.push('--iso-amplitude', s.isoEnabled ? Number(s.isoAmplitude).toFixed(3) : '0', '--iso-fade-in-ms', s.pulseFadeIn, '--iso-fade-out-ms', s.pulseFadeOut, '--iso-duty', Number(s.duty).toFixed(3), '--iso-mode', s.isoMode);
  return `python3 isobin.py ${args.map((arg) => `'${String(arg).replace(/'/g, "'\\''")}'`).join(' ')}`;
}

function revokeDownload() {
  const preview = $('preview-audio');
  preview?.pause();
  preview?.removeAttribute('src');
  preview?.load();
  $('preview-panel')?.classList.add('hidden');
  if (downloadUrl) URL.revokeObjectURL(downloadUrl);
  downloadUrl = null;
  $('download-link').classList.add('hidden');
}

function finishWithBlob(blob, settings) {
  revokeDownload();
  downloadUrl = URL.createObjectURL(blob);
  const link = $('download-link');
  link.href = downloadUrl;
  link.download = makeFilename(settings);
  link.classList.remove('hidden');

  const preview = $('preview-audio');
  preview.src = downloadUrl;
  preview.load();
  $('preview-panel').classList.remove('hidden');

  setProgress(100, 'Your file is ready.');
  setBusy(false, 'Generate another file');
  $('render-message').textContent = `${link.download} is ready (${formatBytes(blob.size)}). Download it to save a copy on your device.`;
  $('render-message').dataset.tone = 'success';
  $('generate-button').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

async function beginGeneration() {
  if (isRendering) {
    cancelGeneration();
    return;
  }
  const raw = readForm();
  let normalized;
  try {
    normalized = validateSettings(raw);
  } catch (error) {
    setMessage(error.message, 'error');
    return;
  }
  const size = estimatedFileSize(raw);
  if (size > 500 * 1024 * 1024 && !window.confirm(`This session may create a file of approximately ${formatBytes(size)}. Long renders use significant browser memory. Continue?`)) return;

  latestNormalized = normalized;
  revokeDownload();
  setBusy(true);
  setProgress(0, 'Preparing the sound…');
  setMessage('Rendering locally in your browser. Keep this tab open until the file is ready.');
  $('generate-button').disabled = false;
  saveSettings();

  renderWorker = new Worker(new URL('../workers/render.worker.js', import.meta.url), { type: 'module' });
  renderWorker.addEventListener('message', async (event) => {
    const data = event.data ?? {};
    if (data.type === 'progress') {
      setProgress(data.progress * 0.78, 'Synthesizing audio…');
    } else if (data.type === 'done') {
      renderWorker?.terminate();
      renderWorker = null;
      if (normalized.format === 'wav') {
        finishWithBlob(data.blob, normalized);
        return;
      }
      isEncoding = true;
      try {
        const encoded = await encodeAudio(data.blob, normalized, (progress, message) => {
          setProgress(78 + (progress * 22), message);
        });
        isEncoding = false;
        finishWithBlob(encoded, normalized);
      } catch (error) {
        isEncoding = false;
        setBusy(false);
        if (error?.name === 'AbortError') setMessage('Encoding cancelled.');
        else setMessage(error.message || 'Encoding failed. Try WAV or a shorter session.', 'error');
      }
    } else if (data.type === 'cancelled') {
      renderWorker?.terminate();
      renderWorker = null;
      setBusy(false);
      setMessage('Generation cancelled. No file was downloaded.');
      $('render-progress').classList.add('hidden');
    } else if (data.type === 'error') {
      renderWorker?.terminate();
      renderWorker = null;
      setBusy(false);
      setMessage(data.message || 'Could not generate the audio file.', 'error');
    }
  });
  renderWorker.addEventListener('error', (event) => {
    renderWorker?.terminate();
    renderWorker = null;
    setBusy(false);
    setMessage(`Audio worker error: ${event.message || 'unknown error'}`, 'error');
  });
  renderWorker.postMessage({ type: 'render', settings: raw });
}

function cancelGeneration() {
  if (renderWorker) {
    renderWorker.postMessage({ type: 'cancel' });
    renderWorker.terminate();
    renderWorker = null;
    setBusy(false);
    setMessage('Generation cancelled.');
    $('render-progress').classList.add('hidden');
  } else if (isEncoding) {
    cancelEncoding();
    setMessage('Cancelling the encoder…');
  }
}

function bindEvents() {
  formIds.forEach((id) => {
    const node = $(id);
    if (!node) return;
    node.addEventListener('input', () => {
      updateSliders();
      updateLayerStates();
      if (id === 'file-format' || id === 'mp3-mode') updateFormatUI();
      saveSettings();
      updateEstimate();
    });
    node.addEventListener('change', () => {
      if (id === 'file-format' || id === 'mp3-mode') updateFormatUI();
      saveSettings();
      updateEstimate();
    });
  });

  rowValueEvents('sections-list', () => sections);
  rowValueEvents('tones-list', () => tones);
  $('sections-list').addEventListener('click', (event) => {
    const remove = event.target.closest('[data-remove-section]');
    const move = event.target.closest('[data-move]');
    if (remove && sections.length > 1) sections.splice(Number(remove.dataset.removeSection), 1);
    if (move) {
      const index = Number(move.dataset.index);
      const next = index + Number(move.dataset.move);
      if (next >= 0 && next < sections.length) [sections[index], sections[next]] = [sections[next], sections[index]];
    }
    renderRows(); saveSettings(); updateEstimate();
  });
  $('tones-list').addEventListener('click', (event) => {
    const remove = event.target.closest('[data-remove-tone]');
    if (remove && tones.length > 1) tones.splice(Number(remove.dataset.removeTone), 1);
    renderRows(); saveSettings(); updateEstimate();
  });
  $('add-section').addEventListener('click', () => {
    const last = sections.at(-1) ?? { left: '200', right: '210', duration: '60s' };
    sections.push({ ...last }); renderRows(); saveSettings();
  });
  $('add-tone').addEventListener('click', () => {
    const last = tones.at(-1) ?? { frequency: '300', beat: '10' };
    tones.push({ ...last }); renderRows(); saveSettings();
  });
  $('preset-select').addEventListener('change', (event) => {
    const preset = PRESETS[event.target.value];
    if (!preset) return;
    applyForm(preset);
    $('preset-message').textContent = `${event.target.options[event.target.selectedIndex].text} preset loaded.`;
    saveSettings();
  });
  $('generate-button').addEventListener('click', beginGeneration);
  $('copy-command').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(pythonCommand(readForm()));
      setMessage('Equivalent Python command copied to your clipboard.');
    } catch {
      setMessage('Clipboard access is unavailable in this browser.');
    }
  });
}

bindEvents();
restoreSettings();
renderRows();
updateFormatUI();
updateSliders();
updateLayerStates();
updateEstimate();
