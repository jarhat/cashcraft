import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('root social metadata points to the CashCraft artwork without client-side rendering', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const image = await readFile(new URL('../public/craft-preview.png', import.meta.url));
  assert.match(html, /property="og:image" content='[^']+\/craft-preview\.png\?v=3'/);
  assert.match(html, /name="twitter:image" content='[^']+\/craft-preview\.png\?v=3'/);
  assert.match(html, /http\.request\.header\.X-Forwarded-Proto/);
  assert.deepEqual([...image.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.match(html, new RegExp(`property="og:image:width" content="${image.readUInt32BE(16)}"`));
  assert.match(html, new RegExp(`property="og:image:height" content="${image.readUInt32BE(20)}"`));
});

test('craft unfurlers use the static dragon artwork without relying on the backend', async () => {
  const html = await readFile(new URL('../public/craft-preview.html', import.meta.url), 'utf8');
  const image = await readFile(new URL('../public/craft-preview.png', import.meta.url));
  const caddy = await readFile(new URL('../Caddyfile', import.meta.url), 'utf8');
  assert.match(html, /property="og:title" content="CashCraft \| Bitcoin Cash voxel world"/);
  assert.match(html, /property="og:image" content='[^']+\/craft-preview\.png\?v=3'/);
  assert.match(html, /name="twitter:image" content='[^']+\/craft-preview\.png\?v=3'/);
  assert.match(html, /http\.request\.header\.X-Forwarded-Proto/);
  assert.match(caddy, /telegrambot.*applebot.*pinterest.*cardyb/);
  assert.deepEqual([...image.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.match(html, new RegExp(`property="og:image:width" content="${image.readUInt32BE(16)}"`));
  assert.match(html, new RegExp(`property="og:image:height" content="${image.readUInt32BE(20)}"`));
});
