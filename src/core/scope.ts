import { isAbsolute, relative, normalize } from 'node:path';
import type { SessionMeta } from './session.ts';

export interface FileScope {
  repoRelative: Set<string>;
}

export function normalizeToRepoRelative(paths: string[], repoRoot: string): FileScope {
  const normalizedRepo = normalizePath(repoRoot);
  const repoRelative = new Set<string>();

  for (const path of paths) {
    if (!path) continue;
    const normalized = normalizePath(path);
    if (isAbsolute(path)) {
      const rel = normalizePath(relative(normalizedRepo, normalized));
      if (rel && rel !== '.' && !rel.startsWith('../') && rel !== '..') repoRelative.add(rel);
    } else {
      const rel = normalizePath(normalized);
      if (rel && rel !== '.' && !rel.startsWith('../') && rel !== '..') repoRelative.add(rel);
    }
  }

  return { repoRelative };
}

export function intersectsScope(session: SessionMeta, scope: FileScope, repoRoot?: string): boolean {
  if (scope.repoRelative.size === 0 || session.filesTouched.size === 0) return false;
  const touched = repoRoot
    ? normalizeToRepoRelative([...session.filesTouched], repoRoot).repoRelative
    : new Set([...session.filesTouched].map(normalizePath).filter((p) => p && p !== '.' && !p.startsWith('../') && p !== '..'));

  for (const path of touched) {
    if (scope.repoRelative.has(path)) return true;
  }
  return false;
}

function normalizePath(path: string): string {
  return normalize(path).replaceAll('\\', '/');
}

/**
 * Did the session touch a diff file at any checkout of the repo, including one since removed?
 *
 * Agents work in worktrees, and worktrees are reaped once merged or abandoned. A session's
 * absolute paths then point under a directory that is no longer any root, so relativizing
 * against the current roots can never match. The repo-relative path survives as the tail:
 * `/…/.worktrees/monorepo/HOA-6310-x/apps/hoa/etl/a.py` ends with `/apps/hoa/etl/a.py`.
 *
 * Only diff paths with a directory component match this way. A bare `README.md` or
 * `package.json` tail would match the same name in any other project the session touched.
 */
export function touchesScopeBySuffix(session: SessionMeta, scope: FileScope): boolean {
  if (scope.repoRelative.size === 0) return false;
  for (const raw of session.filesTouched) {
    const path = normalizePath(raw);
    for (let i = path.indexOf('/'); i >= 0; i = path.indexOf('/', i + 1)) {
      const tail = path.slice(i + 1);
      if (!tail.includes('/')) break;
      if (scope.repoRelative.has(tail)) return true;
    }
  }
  return false;
}
