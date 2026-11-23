import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('browser chunks retain the last complete mesh while snapshots and edits are pending', async () => {
  const source = await readFile(new URL('../NetCraft/src/main.c', import.meta.url), 'utf8');
  const create = source.slice(source.indexOf('void create_chunk('), source.indexOf('\nvoid delete_chunks'));
  const force = source.slice(source.indexOf('void force_chunks('), source.indexOf('\nvoid ensure_chunks_worker'));
  const parse = source.slice(source.indexOf('void parse_buffer('), source.indexOf('\nvoid client_opened('));
  assert.match(create, /sync_pending = 1;[\s\S]*request_chunk\(p, q\)/);
  assert.match(force, /chunk->dirty && chunk_is_ready\(chunk\)/);
  assert.match(force, /sync_pending = 1;[\s\S]*client_chunk\(chunk->p, chunk->q, -1\)/);
  assert.match(parse, /line\[0\] == 'C'[\s\S]*chunk->sync_pending = 0;[\s\S]*dirty_chunk\(chunk\)/);
  const chunks = source.slice(source.indexOf('int render_chunks('), source.indexOf('\nvoid render_signs('));
  const signs = source.slice(source.indexOf('void render_signs('), source.indexOf('\nvoid render_sign('));
  assert.match(chunks, /if \(!chunk->buffer\) continue;/);
  assert.match(signs, /if \(!chunk->buffer\) continue;/);
  assert.doesNotMatch(chunks, /chunk->dirty\) continue/);
  assert.match(source, /!target \|\| !chunk_is_ready\(target\)/);
  assert.match(source, /online_ready && chunk->sync_pending/);
  assert.match(force, /syncing_chunk_count\(\) < MAX_SYNCING_CHUNKS/);
  assert.match(force, /syncing_chunk_count\(\) >= MAX_SYNCING_CHUNKS/);
});

test('mining overlay avoids depth writes and chunk shading stays within world bounds', async () => {
  const source = await readFile(new URL('../NetCraft/src/main.c', import.meta.url), 'utf8');
  const cover = source.slice(source.indexOf('void render_cover('), source.indexOf('\nstatic GLuint crosshair_buffer'));
  const compute = source.slice(source.indexOf('void compute_chunk('), source.indexOf('\nvoid generate_chunk('));
  assert.match(cover, /glDepthMask\(GL_FALSE\);[\s\S]*glEnable\(GL_POLYGON_OFFSET_FILL\);[\s\S]*draw_cube[\s\S]*glDisable\(GL_POLYGON_OFFSET_FILL\);[\s\S]*glDepthMask\(GL_TRUE\)/);
  assert.match(compute, /has_light \? .*calloc\(XZ_SIZE \* XZ_SIZE \* Y_SIZE/);
  assert.match(compute, /oy < 8 && y \+ dy \+ oy < Y_SIZE/);
});
