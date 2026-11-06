import { renderWav } from '../lib/synthesis.js';

let cancelled = false;

self.addEventListener('message', async (event) => {
  const { type, settings } = event.data ?? {};
  if (type === 'cancel') {
    cancelled = true;
    return;
  }
  if (type !== 'render') return;

  cancelled = false;
  try {
    const blob = await renderWav(
      settings,
      (progress) => self.postMessage({ type: 'progress', progress }),
      () => cancelled,
    );
    if (!cancelled) self.postMessage({ type: 'done', blob });
  } catch (error) {
    self.postMessage({ type: error?.name === 'AbortError' ? 'cancelled' : 'error', message: error?.message ?? String(error) });
  }
});
