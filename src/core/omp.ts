import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { inspectOmpSession, type SessionMeta } from './session.ts';

/**
 * Load OMP (Oh-My-Pi) session metadata for sessions whose recorded cwd matches `repoRoot`.
 *
 * OMP sessions live at `~/.omp/agent/sessions/<encoded-cwd>/<timestamp>_<session-id>.jsonl`.
 * The encoded-cwd directory name is not authoritative for filtering — we scan all
 * sessions and trust the `cwd` field in the `{type: "session"}` header row, the same
 * way `inspectCodexSession` does. This survives encoding changes and worktree paths
 * that don't fit the home-relative encoding scheme.
 */
export function loadOmpSessions(
	repoRoot: string,
	sessionsRoot = join(process.env.HOME ?? homedir(), '.omp', 'agent', 'sessions'),
): SessionMeta[] {
	const root = resolve(repoRoot);
	const files = listJsonlFiles(sessionsRoot);
	const out: SessionMeta[] = [];

	for (const file of files) {
		const meta = inspectOmpSession(file, root);
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
