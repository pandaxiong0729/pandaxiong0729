import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { START, END, replaceContributions, loadStatuses, synchronize } from './update-contributions.mjs';

const author = 'pandaxiong0729';
const entry = { repo: 'example/project', number: 1, project: 'Example', title: 'Fix a real bug' };
const config = { owner: author, pull_requests: [entry] };
const prefix = '# About me\n\nFudan University\n\n## Awards\n\n**National Scholarship**\n\n';
const suffix = '\n\n---\n\nMy unchanged closing sentence.\n';
const document = `${prefix}${START}\n\nOld contribution content\n\n${END}${suffix}`;

function apiPr(overrides = {}) {
  return { number: 1, user: { login: author }, base: { repo: { full_name: entry.repo } }, state: 'open', merged: false, merged_at: null, ...overrides };
}
const respond = pr => async () => ({ ok: true, status: 200, json: async () => pr });

test('a newly merged PR moves out of More contributions and leaves bio/awards/footer intact', () => {
  const pending = replaceContributions(document, [{ ...entry, status: 'Open' }]);
  assert.match(pending, /1 open PR<\/summary>/);
  const merged = replaceContributions(pending, [{ ...entry, status: 'Merged' }]);
  assert.ok(merged.startsWith(prefix + START));
  assert.ok(merged.endsWith(END + suffix));
  assert.match(merged, /### Example\n\n- .* — Merged/);
  assert.doesNotMatch(merged, /<details>|— Open/);
  assert.equal(replaceContributions(merged, [{ ...entry, status: 'Merged' }]), merged);
});

test('closed without merging is omitted, with the remaining open count correct', async () => {
  const closed = await loadStatuses(config, { fetchImpl: respond(apiPr({ state: 'closed' })), token: '' });
  assert.equal(closed[0].status, 'Closed');
  const result = replaceContributions(document, [...closed, { ...entry, number: 2, status: 'Open' }]);
  assert.doesNotMatch(result, /pull\/1\)/);
  assert.match(result, /pull\/2\)/);
  assert.match(result, /1 open PR<\/summary>/);
  assert.doesNotMatch(result, /— Merged/);
});

test('merge is determined by merged metadata, not the closed state alone', async () => {
  const rows = await loadStatuses(config, { fetchImpl: respond(apiPr({ state: 'closed', merged: true, merged_at: '2026-11-17T00:00:00Z' })), token: '' });
  assert.equal(rows[0].status, 'Merged');
});

test('reject another author or repository and invalid merged metadata', async () => {
  for (const overrides of [
    { user: { login: 'somebody-else' } },
    { base: { repo: { full_name: 'other/project' } } },
    { merged: true, state: 'closed', merged_at: null }
  ]) {
    await assert.rejects(loadStatuses(config, { fetchImpl: respond(apiPr(overrides)), token: '' }), /Unexpected PR/);
  }
});

test('a partial API failure never changes the existing README', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'profile-sync-'));
  const path = join(directory, 'README.md');
  try {
    await writeFile(path, document);
    const pair = { ...config, pull_requests: [entry, { ...entry, number: 2 }] };
    await assert.rejects(synchronize(pair, path, {
      token: '',
      fetchImpl: async url => url.endsWith('/2')
        ? { ok: false, status: 503 }
        : { ok: true, json: async () => apiPr({ state: 'closed', merged: true, merged_at: '2026-11-17T00:00:00Z' }) }
    }), /HTTP 503/);
    assert.equal(await readFile(path, 'utf8'), document);
  } finally {
    await unlink(path);
    await rmdir(directory);
  }
});

test('writes a complete update once and is a no-op on the next run', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'profile-sync-'));
  const path = join(directory, 'README.md');
  try {
    await writeFile(path, document);
    const options = { fetchImpl: respond(apiPr()), token: '' };
    assert.equal((await synchronize(config, path, { ...options, check: true })).changed, true);
    assert.equal(await readFile(path, 'utf8'), document);
    assert.equal((await synchronize(config, path, options)).changed, true);
    assert.equal((await synchronize(config, path, options)).changed, false);
  } finally {
    await unlink(path);
    await rmdir(directory);
  }
});

test('bad or duplicate section markers fail without replacing unrelated content', () => {
  for (const bad of [prefix, `${END}${START}`, `${document}${START}`, `${document}${END}`]) {
    assert.throws(() => replaceContributions(bad, []), /exactly one ordered pair/);
  }
});

test('preserves CRLF and renders labels as text instead of HTML or extra links', () => {
  const unsafe = { ...entry, title: '<script>alert(1)</script> [fake](evil)\nnew line', status: 'Merged' };
  const result = replaceContributions(document.replaceAll('\n', '\r\n'), [unsafe]);
  assert.doesNotMatch(result, /(?<!\r)\n/);
  assert.doesNotMatch(result, /<script>/);
  assert.match(result, /&lt;script&gt;/);
  assert.ok(result.includes('\\[fake\\]'));
});
