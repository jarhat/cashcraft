import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildIso } from '../src/iso-build.js';

test('starts a build and returns completed profile downloads', async () => {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push([url, options]);
    return {
      ok: true,
      async json() {
        return calls.length === 1
          ? { id: 'run-1' }
          : { status: 'completed', downloads: [{ profile: 'desktop', filename: 'custom.iso', path: '/api/iso/download/run-1/desktop/custom.iso' }] };
      },
    };
  };
  const statuses = [];
  const result = await buildIso('https://api.example', (status) => statuses.push(status), fetcher);
  assert.equal(calls[0][1].method, 'POST');
  assert.equal(calls[0][1].headers['Content-Type'], 'application/json');
  assert.equal(calls[1][0], 'https://api.example/api/iso/builds/run-1');
  assert.deepEqual(statuses, ['completed']);
  assert.equal(result.downloads[0].filename, 'custom.iso');
});

test('returns failed builds with partial downloads', async () => {
  let calls = 0;
  const fetcher = async () => ({ ok: true, json: async () => ++calls === 1
    ? { id: 'run-2' }
    : { status: 'failed', downloads: [{ filename: 'good.iso' }] } });
  assert.equal((await buildIso('', () => {}, fetcher)).downloads[0].filename, 'good.iso');
});

test('aborts a stalled request after five minutes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fetcher = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
  });
  const build = buildIso('', () => {}, fetcher);
  t.mock.timers.tick(299999);
  t.mock.timers.tick(1);
  await assert.rejects(build, /timed out after five minutes/);
});
