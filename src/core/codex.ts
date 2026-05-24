import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { inspectCodexSession, type SessionMeta } from './session.ts';

export function loadCodexSessions(repoRoot: string, sessionsRoot = join(process.env.HOME ?? homedir(), '.codex', 'sessions')): SessionMeta[] {
  const root = resolve(repoRoot);
  const files = listJsonlFiles(sessionsRoot);
  const out: SessionMeta[] = [];

  for (const file of files) {
    const meta = inspectCodexSession(file, root);
    if (meta && meta.promptCount > 0) out.push(meta);
  }

  return out;
}

function listJsonlFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const uid = userInfo().uid;
  const out: string[] = [];
  const stack = [root];

  while (stack.length > 0) {
    const dir = stack.pop()!;
    let stat;
    try {
      stat = lstatSync(dir);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory() || stat.uid !== uid) continue;

    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }

    for (const entry of entries) {
      const path = join(dir, entry);
      if (entry.endsWith('.jsonl')) {
        out.push(path);
      } else {
        stack.push(path);
      }
    }
  }

  return out;
}
