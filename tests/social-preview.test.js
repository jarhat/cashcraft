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

test('root social metadata points to the CashCraft gemstone and block preview without client-side rendering', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /property="og:image" content='[^']+\/api\/craft-preview\.png\?v=5'/);
  assert.match(html, /name="twitter:image" content='[^']+\/api\/craft-preview\.png\?v=5'/);
  assert.match(html, /green MINA gemstones and textured blocks/);
  assert.match(html, /http\.request\.header\.X-Forwarded-Proto/);
  assert.match(html, /property="og:image:width" content="1200"/);
  assert.match(html, /property="og:image:height" content="675"/);
  assert.match(html, /MINA CashTokens.*multiplayer/i);
  assert.doesNotMatch(html, /floating Bitcoin Cash island|dragon/i);
});

test('game query links use the root preview and no dedicated craft route', async () => {
  const invite = await readFile(new URL('../src/game-invite.js', import.meta.url), 'utf8');
  const main = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
  const caddy = await readFile(new URL('../Caddyfile', import.meta.url), 'utf8');
  assert.match(invite, /\/\?game=cashcraft/);
  assert.match(invite, /\/\?game=pk2/);
  assert.match(main, /game === 'pk2' \|\| game === 'cashcraft'/);
  assert.doesNotMatch(main, /craftRoute/);
  assert.doesNotMatch(caddy, /path \/craft/);
});

test('crawler image has a correctly sized local fallback for backend errors', async () => {
  const caddy = await readFile(new URL('../Caddyfile', import.meta.url), 'utf8');
  const image = await readFile(new URL('../public/craft-preview-fallback.png', import.meta.url));
  assert.deepEqual([...image.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(image.readUInt32BE(16), 1200);
  assert.equal(image.readUInt32BE(20), 675);
  assert.match(caddy, /@preview_unavailable status 5xx[\s\S]*?craft-preview-fallback\.png[\s\S]*?status 200/);
  assert.match(caddy, /handle_errors[\s\S]*?craft-preview-fallback\.png[\s\S]*?status 200/);
});
