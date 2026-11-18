import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('social metadata points to a real 1200 by 630 image without client-side rendering', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const image = await readFile(new URL('../public/social-preview.png', import.meta.url));
  assert.match(html, /property="og:image" content='[^']+\/social-preview\.png'/);
  assert.match(html, /name="twitter:image" content='[^']+\/social-preview\.png'/);
  assert.deepEqual([...image.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(image.readUInt32BE(16), 1200);
  assert.equal(image.readUInt32BE(20), 630);
});

test('craft unfurlers use the server-generated donation preview', async () => {
  const html = await readFile(new URL('../public/craft-preview.html', import.meta.url), 'utf8');
  assert.match(html, /property="og:title" content="CashCraft \| Bitcoin Cash voxel world"/);
  assert.match(html, /property="og:image" content='[^']+\/api\/craft-preview\.png'/);
  assert.match(html, /name="twitter:image" content='[^']+\/api\/craft-preview\.png'/);
  assert.match(html, /property="og:image:width" content="1200"/);
  assert.match(html, /property="og:image:height" content="675"/);
});
