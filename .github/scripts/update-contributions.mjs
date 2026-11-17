import { readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const START = '<!-- CONTRIBUTIONS:START -->';
export const END = '<!-- CONTRIBUTIONS:END -->';

export function validateConfig(config) {
  if (!/^[a-z\d-]+$/i.test(config.owner ?? '') || !Array.isArray(config.pull_requests) || !config.pull_requests.length) {
    throw new Error('Expected an owner and a non-empty curated pull_requests list.');
  }
  const seen = new Set();
  for (const entry of config.pull_requests) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(entry.repo ?? '') || !Number.isSafeInteger(entry.number) || entry.number < 1 ||
        typeof entry.title !== 'string' || !entry.title.trim() || typeof entry.project !== 'string' || !entry.project.trim()) {
      throw new Error('Invalid contribution entry.');
    }
    const key = `${entry.repo.toLowerCase()}#${entry.number}`;
    if (seen.has(key)) throw new Error(`Duplicate contribution: ${key}`);
    seen.add(key);
  }
}

export async function loadStatuses(config, { fetchImpl = fetch, token = process.env.GITHUB_TOKEN } = {}) {
  validateConfig(config);
  // Fail the whole refresh if any PR cannot be read; incomplete data must not erase entries.
  return Promise.all(config.pull_requests.map(async entry => {
    const headers = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'github-profile-contribution-sync'
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetchImpl(`https://api.github.com/repos/${entry.repo}/pulls/${entry.number}`, {
      headers,
      signal: AbortSignal.timeout(20_000)
    });
    if (!response.ok) throw new Error(`Could not read ${entry.repo}#${entry.number}: HTTP ${response.status}`);
    const pr = await response.json();
    if (pr.number !== entry.number || pr.user?.login?.toLowerCase() !== config.owner.toLowerCase() ||
        pr.base?.repo?.full_name?.toLowerCase() !== entry.repo.toLowerCase() ||
        !['open', 'closed'].includes(pr.state) || typeof pr.merged !== 'boolean' ||
        (pr.merged && (pr.state !== 'closed' || !pr.merged_at))) {
      throw new Error(`Unexpected PR identity or status for ${entry.repo}#${entry.number}`);
    }
    return { ...entry, status: pr.merged ? 'Merged' : pr.state === 'open' ? 'Open' : 'Closed' };
  }));
}

function escapeText(value) {
  return value.replace(/[\r\n]+/g, ' ').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/[\\`*_[\]#|]/g, '\\$&');
}

function link(entry) {
  return `[${escapeText(entry.title)} · #${entry.number}](https://github.com/${entry.repo}/pull/${entry.number})`;
}

export function renderContributions(entries) {
  const lines = ['## Open source'];
  const projects = new Map();
  for (const entry of entries.filter(entry => entry.status === 'Merged')) {
    const key = entry.repo.toLowerCase();
    if (!projects.has(key)) projects.set(key, []);
    projects.get(key).push(entry);
  }
  for (const group of projects.values()) {
    lines.push('', `### ${escapeText(group[0].project)}`, '', ...group.map(entry => `- ${link(entry)} — Merged`));
  }
  const open = entries.filter(entry => entry.status === 'Open');
  if (open.length) {
    lines.push('', '<details>', `<summary><strong>More contributions</strong> · ${open.length} open ${open.length === 1 ? 'PR' : 'PRs'}</summary>`, '');
    lines.push(...open.map(entry => `- **${escapeText(entry.project)}** — ${link(entry)} — Open`));
    lines.push('', '</details>');
  }
  return lines.join('\n');
}

export function replaceContributions(readme, entries) {
  const start = readme.indexOf(START);
  const end = readme.indexOf(END);
  if (start < 0 || end <= start || readme.indexOf(START, start + START.length) !== -1 || readme.indexOf(END, end + END.length) !== -1) {
    throw new Error('README must have exactly one ordered pair of contribution markers.');
  }
  const newline = readme.includes('\r\n') ? '\r\n' : '\n';
  const generated = renderContributions(entries).replace(/\n/g, newline);
  return readme.slice(0, start + START.length) + newline + newline + generated + newline + newline + readme.slice(end);
}

export async function synchronize(config, readmePath, options = {}) {
  const original = await readFile(readmePath, 'utf8');
  // Validate the boundaries before making API requests.
  replaceContributions(original, []);
  const entries = await loadStatuses(config, options);
  const updated = replaceContributions(original, entries);
  const changed = updated !== original;
  if (changed && !options.check) {
    const stagingPath = `${readmePath}.sync-${process.pid}.tmp`;
    await writeFile(stagingPath, updated, 'utf8');
    await rename(stagingPath, readmePath);
  }
  return {
    changed,
    merged: entries.filter(entry => entry.status === 'Merged').length,
    open: entries.filter(entry => entry.status === 'Open').length,
    closed: entries.filter(entry => entry.status === 'Closed').length
  };
}

async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const config = JSON.parse(await readFile(resolve(root, '.github/contributions.json'), 'utf8'));
  const check = process.argv.includes('--check');
  const result = await synchronize(config, resolve(root, 'README.md'), { check });
  console.log(`${result.merged} merged, ${result.open} open, ${result.closed} closed without merging. README ${result.changed ? (check ? 'would change' : 'updated') : 'unchanged'}.`);
  if (check && result.changed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
