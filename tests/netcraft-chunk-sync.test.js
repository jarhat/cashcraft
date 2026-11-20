import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('browser chunks wait for the complete server snapshot before rendering or accepting edits', async () => {
  const source = await readFile(new URL('../NetCraft/src/main.c', import.meta.url), 'utf8');
  const create = source.slice(source.indexOf('void create_chunk('), source.indexOf('\nvoid delete_chunks'));
  const force = source.slice(source.indexOf('void force_chunks('), source.indexOf('\nvoid ensure_chunks_worker'));
  const parse = source.slice(source.indexOf('void parse_buffer('), source.indexOf('\nvoid client_opened('));
  assert.match(create, /sync_pending = 1;[\s\S]*request_chunk\(p, q\)/);
  assert.match(force, /chunk->dirty && chunk_is_ready\(chunk\)/);
  assert.match(force, /sync_pending = 1;[\s\S]*client_chunk\(chunk->p, chunk->q, -1\)/);
  assert.match(parse, /line\[0\] == 'C'[\s\S]*chunk->sync_pending = 0;[\s\S]*dirty_chunk\(chunk\)/);
  assert.match(source, /if \(!chunk_is_ready\(chunk\) \|\| chunk->dirty\) continue;/);
  assert.match(source, /!target \|\| !chunk_is_ready\(target\)/);
  assert.match(source, /online_ready && chunk->sync_pending/);
  assert.match(force, /syncing_chunk_count\(\) < MAX_SYNCING_CHUNKS/);
  assert.match(force, /syncing_chunk_count\(\) >= MAX_SYNCING_CHUNKS/);
});
