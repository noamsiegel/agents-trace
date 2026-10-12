import { afterEach, beforeEach, expect, test } from 'bun:test';
import { appendFileSync, linkSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { inspectCodexSession, loadSessionsForRoots, readHeader, safeReadJsonl } from '../src/core/session.ts';
import { collectMarkdown } from '../src/core/sanitize.ts';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'trace-jsonl-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

test('large sessions retain the last prompt and file reference beyond 50,000 rows in the CLI', () => {
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  const git = (...args: string[]) => {
    const r = spawnSync('git', ['-C', repo, ...args]);
    expect(r.status).toBe(0);
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.test');
  git('config', 'user.name', 'Test');
  writeFileSync(join(repo, 'a.txt'), 'before');
  git('add', '.'); git('commit', '-q', '-m', 'initial');
  git('switch', '-q', '-c', 'feature');
  writeFileSync(join(repo, 'a.txt'), 'after');
  git('commit', '-qam', 'change');

  const sessions = join(dir, '.codex', 'sessions');
  mkdirSync(sessions, { recursive: true });
  const file = join(sessions, 'large.jsonl');
  const timestamp = new Date().toISOString();
  writeFileSync(file, JSON.stringify({ type: 'session_meta', timestamp, payload: { cwd: repo } }) + '\n');
  const noise = JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', output: 'x'.repeat(512) } }) + '\n';
  // More than the former file-size and row-count limits, without buffering the fixture.
  for (let n = 0; n < 501; n++) appendFileSync(file, noise.repeat(100));
  appendFileSync(file, JSON.stringify({ type: 'event_msg', timestamp, payload: { type: 'user_message', message: 'last prompt survives' } }) + '\n');
  appendFileSync(file, JSON.stringify({ type: 'response_item', timestamp, payload: { type: 'function_call', name: 'apply_patch', arguments: JSON.stringify({ file_path: join(repo, 'a.txt') }) } }));
  expect(statSync(file).size).toBeGreaterThan(20 * 1024 * 1024);
  expect(readHeader(file).cwd).toBe(repo);
  const meta = inspectCodexSession(file, repo);
  expect(meta?.promptCount).toBe(1);
  expect(meta?.filesTouched).toEqual(new Set([join(repo, 'a.txt')]));
  const md = collectMarkdown(repo, 1, 'main', [meta!], { includeCode: false, scrubbers: [] });
  expect(md).toContain('last prompt survives');
  const cli = new URL('../cli.ts', import.meta.url).pathname;
  const env = { ...process.env, HOME: dir };
  const scoped = spawnSync('bun', [cli, 'sessions-since', 'main', '--root', repo, '--source', 'codex', '--scope', 'file'], { env, encoding: 'utf8' });
  expect(scoped.status).toBe(0);
  expect(scoped.stdout).toContain('large.jsonl  prompts=1');
  const handoff = spawnSync('bun', [cli, 'handoff', '--root', repo, '--source', 'codex'], { env, encoding: 'utf8' });
  expect(handoff.status).toBe(0);
  expect(handoff.stdout).toContain('last prompt survives');
});

test('chunk boundaries preserve UTF-8, CRLF, and an unterminated final row', () => {
  const file = join(dir, 'rows.jsonl');
  const text = 'é'.repeat(40000);
  writeFileSync(file, JSON.stringify({ text }) + '\r\ninvalid\nnull\n[]\n' + JSON.stringify({ last: true }));
  expect(Array.from(safeReadJsonl(file)!)).toEqual([{ text }, { last: true }]);
});

test('header byte limits never parse a partial row', () => {
  const file = join(dir, 'header.jsonl');
  const first = JSON.stringify({ first: true }) + '\n';
  const partial = JSON.stringify({ next: true });
  writeFileSync(file, first + partial + 'invalid tail\n');
  expect(Array.from(safeReadJsonl(file, Buffer.byteLength(first + partial))!)).toEqual([{ first: true }]);
});

test('reading uses a finite file snapshot even when more rows are appended', () => {
  const file = join(dir, 'live.jsonl');
  writeFileSync(file, '{"first":true}\n');
  const rows = safeReadJsonl(file)!;
  appendFileSync(file, '{"later":true}\n');
  expect(Array.from(rows)).toEqual([{ first: true }]);
});

test('unsafe files remain rejected', () => {
  const file = join(dir, 'real.jsonl');
  writeFileSync(file, '{}\n');
  const symlink = join(dir, 'symlink.jsonl');
  symlinkSync(file, symlink);
  expect(safeReadJsonl(symlink)).toBeNull();
  const hardlink = join(dir, 'hardlink.jsonl');
  linkSync(file, hardlink);
  expect(safeReadJsonl(file)).toBeNull();
  expect(safeReadJsonl(hardlink)).toBeNull();
  expect(safeReadJsonl(dir)).toBeNull();
});

test('an oversized individual record fails explicitly instead of returning a partial trace', () => {
  const file = join(dir, 'oversized.jsonl');
  writeFileSync(file, JSON.stringify({ text: 'x'.repeat(8 * 1024 * 1024) }));
  expect(() => Array.from(safeReadJsonl(file)!)).toThrow('record exceeds 8 MiB');
});

test('unknown headers survive the time prefilter and resolve relative patches against each turn cwd', () => {
  const sessions = join(dir, '.codex', 'sessions');
  mkdirSync(sessions, { recursive: true });
  const repo = join(dir, 'repo');
  const timestamp = new Date().toISOString();
  const patch = '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** End Patch';
  const call = { type: 'response_item', timestamp, payload: { type: 'custom_tool_call', name: 'exec', input: `text(await tools.apply_patch(${JSON.stringify(patch)}))` } };
  writeFileSync(join(sessions, 'context.jsonl'), [
    { type: 'noise', text: 'x'.repeat(70000) },
    { type: 'session_meta', timestamp, payload: { cwd: repo } },
    { type: 'event_msg', timestamp, payload: { type: 'user_message', message: 'edit both turns' } },
    call,
    { type: 'turn_context', timestamp, payload: { cwd: join(repo, 'apps/web') } },
    call,
  ].map(row => JSON.stringify(row)).join('\n'));
  const original = process.env.HOME;
  try {
    process.env.HOME = dir;
    const result = loadSessionsForRoots([repo], 'codex', undefined, { notBefore: Date.now() - 60000, notAfter: Date.now() + 60000 });
    expect(result).toHaveLength(1);
    expect(result[0]!.filesTouched).toEqual(new Set([join(repo, 'src/a.ts'), join(repo, 'apps/web/src/a.ts')]));
  } finally { process.env.HOME = original; }
});
