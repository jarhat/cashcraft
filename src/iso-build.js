const BUILD_TIMEOUT_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 5000;

export async function buildIso(apiBaseUrl, onStatus, fetchImpl = fetch) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BUILD_TIMEOUT_MS);
  const request = async (path, options = {}) => {
    const response = await fetchImpl(`${apiBaseUrl}${path}`, { ...options, signal: controller.signal });
    const result = await response.json();
    if (!response.ok) throw new Error(result.detail || `ISO service error (${response.status})`);
    return result;
  };
  try {
    const build = await request('/api/iso/builds', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    if (typeof build.id !== 'string' || !build.id) throw new Error('Invalid build ID.');
    while (true) {
      const result = await request(`/api/iso/builds/${encodeURIComponent(build.id)}`);
      if (typeof result.status !== 'string' || !Array.isArray(result.downloads)) throw new Error('Invalid build status.');
      onStatus(result.status);
      if (result.status === 'completed' || result.status === 'failed') return result;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          controller.signal.removeEventListener('abort', abort);
          resolve();
        }, POLL_INTERVAL_MS);
        const abort = () => {
          clearTimeout(timer);
          reject(new DOMException('Build timed out.', 'AbortError'));
        };
        controller.signal.addEventListener('abort', abort, { once: true });
        if (controller.signal.aborted) abort();
      });
    }
  } catch (error) {
    if (controller.signal.aborted) throw new Error('ISO build timed out after five minutes.');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
