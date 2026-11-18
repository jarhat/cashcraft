import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('game restore and favicon share one icon, with appropriately sized PNG fallbacks', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /rel="icon" href="\/icon\.svg"/);
  assert.match(html, /id="game-restore"[\s\S]*?<img src="\/icon\.svg" alt="">/);
  for (const size of [192, 512]) {
    const icon = await readFile(new URL(`../public/icon-${size}.png`, import.meta.url));
    assert.equal(icon.readUInt32BE(16), size);
    assert.equal(icon.readUInt32BE(20), size);
  }
});

test('root social metadata points to the QR-enabled CashCraft preview without client-side rendering', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /property="og:image" content='[^']+\/api\/craft-preview\.png\?v=4'/);
  assert.match(html, /name="twitter:image" content='[^']+\/api\/craft-preview\.png\?v=4'/);
  assert.match(html, /http\.request\.header\.X-Forwarded-Proto/);
  assert.match(html, /property="og:image:width" content="1200"/);
  assert.match(html, /property="og:image:height" content="675"/);
  assert.match(html, /MINA CashTokens.*multiplayer/i);
  assert.doesNotMatch(html, /floating Bitcoin Cash island|dragon/i);
});

test('craft unfurlers use the same QR-enabled artwork and dimensions', async () => {
  const html = await readFile(new URL('../public/craft-preview.html', import.meta.url), 'utf8');
  const caddy = await readFile(new URL('../Caddyfile', import.meta.url), 'utf8');
  assert.match(html, /property="og:title" content="CashCraft \| Multiplayer MINA mining"/);
  assert.match(html, /property="og:image" content='[^']+\/api\/craft-preview\.png\?v=4'/);
  assert.match(html, /name="twitter:image" content='[^']+\/api\/craft-preview\.png\?v=4'/);
  assert.match(html, /http\.request\.header\.X-Forwarded-Proto/);
  assert.match(caddy, /telegrambot.*applebot.*pinterest.*cardyb/);
  assert.match(html, /property="og:image:width" content="1200"/);
  assert.match(html, /property="og:image:height" content="675"/);
  assert.doesNotMatch(html, /floating Bitcoin Cash island|dragon/i);
});
