import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir, userInfo } from 'node:os';
import { normalizeToRepoRelative, intersectsScope, touchesScopeBySuffix } from './scope.ts';
import { addCodexToolPaths } from './codex-paths.ts';

const MAX_JSONL_RECORD_BYTES = 8 * 1024 * 1024;

export interface SessionMeta {
  path: string;
  firstTs: number;
  lastTs: number;
  promptCount: number;
  filesTouched: Set<string>;
}

export type Session = SessionMeta;

export interface CommitRange {
  min: number;
  max: number;
  count?: number;
}

/** Bounds a transcript must overlap to matter. `{ notBefore: 0, notAfter: Infinity }` disables both. */
export interface SessionWindow {
  notBefore: number;
  notAfter: number;
}

const NO_WINDOW: SessionWindow = { notBefore: 0, notAfter: Number.POSITIVE_INFINITY };

export interface RangeSelectionScope {
  mode: 'time' | 'file' | 'both';
  /** The canonical checkout first, then its worktrees. Diff paths are relative to any of them. */
  repoRoot: string | readonly string[];
  commitRange: CommitRange;
  diffFiles: string[] | Set<string>;
}

/**
 * Cheap prefilter: can this transcript possibly contain a row at or after `notBefore`?
 *
 * Every `inspect*Session` reads its whole file to find the first and last timestamps. On a
 * machine that keeps its history that is the dominant cost of every run - measured at 173 of
 * 188 seconds for one PR, across ~18,600 files and ~15.5 GB, growing with every session ever
 * recorded.
 *
 * A file's mtime is the time of its LAST write, so mtime is an upper bound on the timestamp
 * of every row inside it. If that bound falls before the window, no row in the file can be in
 * the window, and the file can be skipped without reading it. The comparison is sound in one
 * direction only, which is the direction that matters: it can keep a file it did not need to
 * (mtime recent, rows old), but it can never drop one it needed.
 *
 * `notBefore = 0` disables the filter, for callers with no range (handoff).
 *
 * Shared rather than inlined because all three loaders (claude, codex, omp) must apply the
 * identical bound: a copy that drifted would silently drop sessions from the record, and a
 * one-sided comparison duplicated three times is precisely how that happens.
 */
export function isOlderThan(path: string, notBefore: number): boolean {
  if (notBefore <= 0) return false;
  try {
    return lstatSync(path).mtimeMs < notBefore;
  } catch {
    // Unreadable stat is not evidence of age. Fall through and let the reader decide, so a
    // permissions oddity cannot silently erase a session from the record.
    return false;
  }
}

export function encodeCwd(p: string): string {
  return p.replaceAll('/', '-').replaceAll('.', '-');
}

/**
 * Membership test for "was this cwd inside the repo": a root or any directory under one.
 *
 * Inside, not only equal: agents are routinely started from a subdirectory (on this machine
 * most sessions ran in `monorepo/apps/hoa`), and requiring equality silently dropped all of
 * them. Every root is the same repository (the canonical checkout and its worktrees), so a
 * worktree nested under the canonical checkout attributes to the same repo either way.
 *
 * Paths compare by resolved form and by realpath, so symlink-mediated spellings still match
 * (macOS /var/folders vs /private/var/folders). Each root's forms are computed once.
 */
function rootMatcher(roots: string | readonly string[]): (cwd: string) => boolean {
  const keys = new Set<string>();
  for (const r of typeof roots === 'string' ? [roots] : roots) {
    keys.add(resolve(r));
    try { keys.add(realpathSync(r)); } catch { /* resolved form already added */ }
  }
  const within = (p: string) => {
    for (let cur = p; ; cur = dirname(cur)) {
      if (keys.has(cur)) return true;
      if (dirname(cur) === cur) return false;
    }
  };
  return (cwd) => {
    if (within(resolve(cwd))) return true;
    try { return within(realpathSync(cwd)); } catch { return false; }
  };
}

export type SessionSource = 'claude' | 'codex' | 'omp' | 'auto';

export function loadRepoSessions(repoRoot: string, source: SessionSource = 'auto', claudeRoot = join(process.env.HOME ?? homedir(), '.claude', 'projects'), notBefore = 0): SessionMeta[] {
  return loadSessionsForRoots([repoRoot], source, claudeRoot, { ...NO_WINDOW, notBefore });
}

/**
 * Sessions recorded in any of `roots`: a canonical checkout and its worktrees.
 *
 * Claude Code keeps one directory per cwd. Codex and OMP each keep one global tree, which is
 * walked ONCE with every file matched against all roots. Walking it once per root read the
 * same ~22 GB of transcripts 35 times for a single PR on a machine with 35 worktrees, which is
 * what made the hourly sweep a multi-hundred-MB, multi-minute process.
 *
 * `auto` offers every source. It used to return the first source that had ANY sessions, which
 * let stale history from one tool hide the current work of another: four old Claude
 * transcripts for a repo shadowed 409 OMP sessions, none of the four overlapped the commit
 * range, and every run reported "no overlapping sessions". Which sessions belong to a range is
 * decided by the overlap test downstream, not by which tool wrote something first.
 */
export function loadSessionsForRoots(roots: readonly string[], source: SessionSource = 'auto', claudeRoot = join(process.env.HOME ?? homedir(), '.claude', 'projects'), window: SessionWindow = NO_WINDOW): SessionMeta[] {
  const home = process.env.HOME ?? homedir();
  const out = new Map<string, SessionMeta>();
  const add = (sessions: SessionMeta[]) => {
    for (const s of sessions) if (!out.has(s.path)) out.set(s.path, s);
  };
  if (source === 'claude' || source === 'auto') {
    add(loadClaudeSessionsForRoots(roots, claudeRoot, window));
  }
  if (source === 'codex' || source === 'auto') {
    add(loadTreeSessions(join(home, '.codex', 'sessions'), roots, window, inspectCodexSession));
  }
  if (source === 'omp' || source === 'auto') {
    add(loadTreeSessions(join(home, '.omp', 'agent', 'sessions'), roots, window, inspectOmpSession));
  }
  return [...out.values()];
}

export function loadClaudeSessions(repoRoot: string, claudeRoot: string, notBefore = 0): SessionMeta[] {
  return loadClaudeSessionsForRoots([repoRoot], claudeRoot, { ...NO_WINDOW, notBefore });
}

/**
 * Claude Code keeps one directory per cwd, named by `encodeCwd`. A root's own directory is
 * trusted, as it always was. Directories for subdirectories of a root are found by name prefix,
 * but the encoding is lossy (`/` and `.` both become `-`, so `monorepo-old` shares a prefix with
 * `monorepo/`), so each file there is kept only when the cwd it records is inside a root. A
 * file that records none is skipped: including another repository's transcript in a gist is
 * a disclosure, and missing one is not.
 */
function loadClaudeSessionsForRoots(roots: readonly string[], claudeRoot: string, window: SessionWindow): SessionMeta[] {
  if (!existsSync(claudeRoot)) return [];
  const uid = userInfo().uid;
  const exact = new Set(roots.map(encodeCwd));
  const prefixes = [...exact].map((e) => e + '-');
  const matches = rootMatcher(roots);
  const out: SessionMeta[] = [];
  let names: string[];
  try {
    names = readdirSync(claudeRoot);
  } catch {
    return [];
  }
  for (const name of names) {
    const trusted = exact.has(name);
    if (!trusted && !prefixes.some((p) => name.startsWith(p))) continue;
    const dir = join(claudeRoot, name);
    let dirStat;
    try {
      dirStat = lstatSync(dir);
    } catch {
      continue;
    }
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory() || dirStat.uid !== uid) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const fp = join(dir, f);
      if (skipUnread(fp, window, null)) continue;
      if (!trusted) {
        const cwd = readHeader(fp).cwd;
        if (cwd === null || !matches(cwd)) continue;
      }
      const meta = inspectSession(fp);
      if (meta && meta.promptCount > 0) out.push(meta);
    }
  }
  return out;
}

export function inspectSession(path: string): SessionMeta | null {
  const content = safeReadJsonl(path);
  if (content === null) return null;
  let firstTs = Number.POSITIVE_INFINITY;
  let lastTs = 0;
  let promptCount = 0;
  const filesTouched = new Set<string>();
  for (const row of content) {
    const t = timestampOf(row);
    if (t !== 0) {
      if (t < firstTs) firstTs = t;
      if (t > lastTs) lastTs = t;
    }
    if (isPromptRow(row)) promptCount++;
    extractFilePaths(row, filesTouched);
  }
  return finiteSession(path, firstTs, lastTs, promptCount, filesTouched);
}

export function inspectCodexSession(path: string, repoRoot: string | readonly string[]): SessionMeta | null {
  const content = safeReadJsonl(path);
  if (content === null) return null;
  let cwd: string | null = null;
  let toolCwd: string | null = null;
  let firstTs = Number.POSITIVE_INFINITY;
  let lastTs = 0;
  let promptCount = 0;
  const filesTouched = new Set<string>();
  const recordedPaths = new Set<string>();

  for (const row of content) {
    const t = timestampOf(row);
    if (t !== 0) {
      if (t < firstTs) firstTs = t;
      if (t > lastTs) lastTs = t;
    }

    const payload = row.payload && typeof row.payload === 'object' ? row.payload as Record<string, unknown> : null;
    if (row.type === 'session_meta' && typeof payload?.cwd === 'string') {
      cwd = resolve(payload.cwd);
      toolCwd = cwd;
    }
    if (row.type === 'turn_context' && typeof payload?.cwd === 'string') {
      cwd ??= resolve(payload.cwd);
      toolCwd = resolve(payload.cwd);
    }

    if (isPromptRow(row)) promptCount++;
    recordedPaths.clear();
    extractFilePaths(row, recordedPaths);
    for (const file of recordedPaths) {
      if (file.startsWith('/')) filesTouched.add(resolve(file));
      else if (toolCwd !== null) filesTouched.add(resolve(toolCwd, file));
    }
    addCodexToolPaths(row, filesTouched, toolCwd);
  }

  // Codex stores sessions in a global tree rather than a cwd-encoded directory.
  // Scan every session file and keep only transcripts whose recorded cwd is the target repo.
  if (cwd === null || !rootMatcher(repoRoot)(cwd)) return null;
  return finiteSession(path, firstTs, lastTs, promptCount, filesTouched);
}

export function inspectOmpSession(path: string, repoRoot: string | readonly string[]): SessionMeta | null {
  // OMP (Oh-My-Pi) session JSONL.
  //
  // Header row: { type: "session", id, timestamp, cwd: "...", title }
  // User prompts: { type: "message", timestamp, message: { role: "user", attribution: "user", content: [{type: "text", text: "..."}] } }
  // Other roles seen (NOT prompts): toolResult, assistant, developer (with attribution: "agent").
  //
  // OMP encodes the cwd in the parent directory name, but the encoding does not
  // round-trip (HOME prefix is stripped, dots are preserved). The session header
  // row is the authoritative source for cwd \u2014 same approach codex uses.
  const content = safeReadJsonl(path);
  if (content === null) return null;
  let cwd: string | null = null;
  let firstTs = Number.POSITIVE_INFINITY;
  let lastTs = 0;
  let promptCount = 0;
  const filesTouched = new Set<string>();

  for (const row of content) {
    const t = timestampOf(row);
    if (t !== 0) {
      if (t < firstTs) firstTs = t;
      if (t > lastTs) lastTs = t;
    }

    if (row.type === 'session' && typeof row.cwd === 'string') {
      cwd = resolve(row.cwd);
    }

    if (isPromptRow(row)) promptCount++;
    extractFilePaths(row, filesTouched);
  }

  if (cwd === null || !rootMatcher(repoRoot)(cwd)) return null;
  return finiteSession(path, firstTs, lastTs, promptCount, filesTouched);
}

export function extractFilePaths(row: unknown, out: Set<string>): void {
  if (!row || typeof row !== 'object') return;
  const stack: unknown[] = [row];
  while (stack.length > 0) {
    const v = stack.pop();
    if (!v || typeof v !== 'object') continue;
    if (Array.isArray(v)) {
      for (const item of v) stack.push(item);
      continue;
    }
    addOmpToolPaths(v as Record<string, unknown>, out);
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (k === 'file_path' && typeof val === 'string' && val.length > 0) {
        out.add(val);
      } else if (k === 'arguments' && typeof val === 'string') {
        try {
          stack.push(JSON.parse(val));
        } catch {
          // Tool arguments may be arbitrary strings; ignore non-JSON values.
        }
      } else if (val && typeof val === 'object') {
        stack.push(val);
      }
    }
  }
}

/** OMP's edit patch names each file on a header line: `[/abs/path/file.py#D5C0]`. */
const OMP_EDIT_HEADER = /^\[([^\]\n#]+)#[0-9A-Za-z]+\]$/gm;

/**
 * OMP tool calls (`{type:"toolCall", name, arguments}`) do not use `file_path`: `read` and
 * `write` take `arguments.path`, and `edit` takes a patch in `arguments.input` whose header
 * lines name the files. Without this, an OMP session recorded no touched files at all, so it
 * could never match a PR by file overlap, and selection fell back to time alone.
 */
function addOmpToolPaths(v: Record<string, unknown>, out: Set<string>): void {
  if (v.type !== 'toolCall' || !v.arguments || typeof v.arguments !== 'object') return;
  const args = v.arguments as { path?: unknown; input?: unknown };
  if ((v.name === 'read' || v.name === 'write') && typeof args.path === 'string' && args.path.length > 0) {
    out.add(args.path);
  }
  if (v.name === 'edit' && typeof args.input === 'string') {
    for (const m of args.input.matchAll(OMP_EDIT_HEADER)) out.add(m[1]!);
  }
}

export function selectSessionsForRange(
  sessions: SessionMeta[],
  _baseRef: string,
  scope: RangeSelectionScope,
  graceMin: number,
): SessionMeta[] {
  const roots = typeof scope.repoRoot === 'string' ? [scope.repoRoot] : scope.repoRoot;
  const fileScope = normalizeToRepoRelative([...scope.diffFiles], roots[0]!);
  // A session in a worktree records absolute paths under THAT worktree. Relative to the
  // canonical checkout they read `.claude/worktrees/<name>/apps/...` and never match the diff,
  // so file overlap is tested against every root, and by repo-relative tail for worktrees that
  // no longer exist (see touchesScopeBySuffix).
  const touchesDiff = (session: SessionMeta) =>
    roots.some((root) => intersectsScope(session, fileScope, root)) || touchesScopeBySuffix(session, fileScope);
  return sessions.filter((session) => {
    const timeMatch = overlapsRange(session, scope.commitRange, graceMin);
    switch (scope.mode) {
      case 'time':
        return timeMatch;
      case 'file':
        return touchesDiff(session);
      case 'both':
        return timeMatch && touchesDiff(session);
    }
  });
}

export function selectHandoffSession(sessions: SessionMeta[], name?: string): SessionMeta | undefined {
  if (name) return sessions.find((s) => s.path.endsWith(`${name}.jsonl`));
  return [...sessions].sort((a, b) => b.lastTs - a.lastTs)[0];
}

/** A finite file snapshot, streamed with bounded records; unsafe files are never opened for parsing. */
export function safeReadJsonl(path: string, maxBytes = Number.POSITIVE_INFINITY): Generator<Record<string, unknown>> | null {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  if (stat.isSymbolicLink()) return null;
  if (stat.nlink > 1) return null;
  if (stat.uid !== userInfo().uid) return null;

  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  let snapshot;
  try { snapshot = fstatSync(fd); } catch (err) {
    closeSync(fd);
    throw err;
  }
  if (!snapshot.isFile() || snapshot.uid !== stat.uid || snapshot.nlink > 1 || snapshot.ino !== stat.ino || snapshot.dev !== stat.dev) {
    closeSync(fd);
    return null;
  }
  const size = Math.min(snapshot.size, maxBytes);
  return (function* () {
    const buf = Buffer.alloc(64 * 1024);
    let parts: Buffer[] = [];
    let recordBytes = 0;
    const parseRow = () => {
      const line = Buffer.concat(parts, recordBytes).toString('utf8');
      parts = [];
      recordBytes = 0;
      let row: unknown;
      try { row = JSON.parse(line); } catch { return null; }
      return row !== null && typeof row === 'object' && !Array.isArray(row) ? row as Record<string, unknown> : null;
    };
    try {
      let offset = 0;
      while (offset < size) {
        const n = readSync(fd, buf, 0, Math.min(buf.length, size - offset), offset);
        if (n === 0) throw new Error(`session file truncated while reading: ${path}`);
        offset += n;
        for (let start = 0; start < n;) {
          const newline = buf.indexOf(10, start);
          const end = newline < 0 || newline >= n ? n : newline;
          recordBytes += end - start;
          if (recordBytes > MAX_JSONL_RECORD_BYTES) throw new Error(`JSONL record exceeds 8 MiB: ${path}`);
          parts.push(Buffer.from(buf.subarray(start, end)));
          start = end + 1;
          if (end === n) break;
          const row = parseRow();
          if (row !== null) yield row;
        }
      }
      // A header byte cap may end inside a row; only the full file's final row is parseable.
      if (size === snapshot.size && recordBytes > 0) {
        const row = parseRow();
        if (row !== null) yield row;
      }
    } finally {
      closeSync(fd);
    }
  })();
}

export function isPromptRow(row: unknown): boolean {
  const text = extractPromptText(row);
  return isRealPrompt(text);
}

export function extractPromptText(row: unknown): string {
  if (!row || typeof row !== 'object') return '';
  const r = row as { type?: string; message?: { content?: unknown }; payload?: unknown };

  if (r.type === 'user') return extractTextFromContent(r.message?.content);

  // OMP shape: { type: "message", message: { role: "user", attribution: "user", content: [...] } }
  if (r.type === 'message' && r.message && typeof r.message === 'object') {
    const msg = r.message as { role?: string; content?: unknown; attribution?: string };
    if (msg.role === 'user' && (msg.attribution === undefined || msg.attribution === 'user')) {
      return extractTextFromContent(msg.content);
    }
  }

  const payload = r.payload && typeof r.payload === 'object' ? r.payload as { type?: string; role?: string; message?: string; content?: unknown } : null;
  if (!payload) return '';

  if (r.type === 'event_msg' && payload.type === 'user_message' && typeof payload.message === 'string') return payload.message;
  if (r.type === 'response_item' && payload.type === 'message' && payload.role === 'user') return extractTextFromContent(payload.content);
  return '';
}

export function isRealPrompt(content: unknown): boolean {
  if (typeof content === 'string') {
    if (content.includes('<command-name>')) return false;
    if (content.includes('<local-command-caveat>')) return false;
    if (content.trim().length === 0) return false;
    return true;
  }
  if (Array.isArray(content)) {
    return content.some((block) => block && typeof block === 'object' && (block as { type?: string }).type === 'text');
  }
  return false;
}

export function extractTextFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block && typeof block === 'object') {
        const b = block as { type?: string; text?: string };
        if ((b.type === 'text' || b.type === 'input_text' || b.type === 'output_text') && typeof b.text === 'string') parts.push(b.text);
      }
    }
    return parts.join('\n');
  }
  return '';
}

// Extract assistant-side message text. Mirrors extractPromptText but for role=assistant.
// Returns empty string for non-assistant rows or when no text content is found.
export function extractAssistantText(row: unknown): string {
  if (!row || typeof row !== 'object') return '';
  const r = row as { type?: string; message?: { role?: string; content?: unknown }; payload?: unknown };

  // Claude shape: { type: "assistant", message: { content: [...] } }
  if (r.type === 'assistant') return extractTextFromContent(r.message?.content);

  // OMP shape: { type: "message", message: { role: "assistant", content: [...] } }
  if (r.type === 'message' && r.message && typeof r.message === 'object') {
    const msg = r.message as { role?: string; content?: unknown };
    if (msg.role === 'assistant') return extractTextFromContent(msg.content);
  }

  // Codex shape: { type: "response_item", payload: { type: "message", role: "assistant", content: [...] } }
  const payload = r.payload && typeof r.payload === 'object' ? r.payload as { type?: string; role?: string; content?: unknown } : null;
  if (payload && r.type === 'response_item' && payload.type === 'message' && payload.role === 'assistant') {
    return extractTextFromContent(payload.content);
  }
  return '';
}

// Detect whether a user-prompt row is a `/plan` slash-command invocation.
// Pattern: <command-name>/plan</command-name> or <command-name>plan</command-name>.
export function isPlanCommandRow(row: unknown): boolean {
  const r = row as { type?: string; message?: { content?: unknown } };
  // Pull the raw text without going through the isPromptRow filter (which strips command rows).
  const text = extractPromptTextRaw(r);
  return /<command-name>\/?plan<\/command-name>/i.test(text);
}

// Same as extractPromptText but skips the isRealPrompt filter, so command rows are visible.
function extractPromptTextRaw(row: unknown): string {
  if (!row || typeof row !== 'object') return '';
  const r = row as { type?: string; message?: { content?: unknown }; payload?: unknown };
  if (r.type === 'user') return extractTextFromContent(r.message?.content);
  if (r.type === 'message' && r.message && typeof r.message === 'object') {
    const msg = r.message as { role?: string; content?: unknown; attribution?: string };
    if (msg.role === 'user') return extractTextFromContent(msg.content);
  }
  const payload = r.payload && typeof r.payload === 'object' ? r.payload as { type?: string; role?: string; message?: string; content?: unknown } : null;
  if (payload) {
    if (r.type === 'event_msg' && payload.type === 'user_message' && typeof payload.message === 'string') return payload.message;
    if (r.type === 'response_item' && payload.type === 'message' && payload.role === 'user') return extractTextFromContent(payload.content);
  }
  return '';
}

// Detect any user row (filtered or not) \u2014 used to terminate plan-capture state.
export function isAnyUserRow(row: unknown): boolean {
  return extractPromptTextRaw(row).length > 0;
}

function finiteSession(path: string, firstTs: number, lastTs: number, promptCount: number, filesTouched: Set<string>): SessionMeta | null {
  if (!Number.isFinite(firstTs) || lastTs === 0) return null;
  return { path, firstTs, lastTs, promptCount, filesTouched };
}

function timestampOf(row: { timestamp?: unknown }): number {
  if (typeof row.timestamp !== 'string') return 0;
  const t = Date.parse(row.timestamp);
  return Number.isNaN(t) ? 0 : t;
}

/** Bytes read to find a transcript's cwd. Codex's session_meta row is ~23 KB; OMP's is ~256 B. */
const HEADER_BYTES = 64 * 1024;

/** Rows examined for a cwd before giving up. OMP now writes a `title` row before its header. */
const HEADER_ROWS = 16;

/**
 * What a transcript records near its start: its cwd (OMP `{type:"session", cwd}`, Codex
 * `{type:"session_meta", payload:{cwd}}`, Claude Code's per-row `cwd`) and its start time (the
 * earliest `timestamp` among those rows). Looks at the first complete rows of the first 64 KB.
 *
 * A prefilter: `cwd: null` / `startTs: Infinity` mean "unknown, read the whole file", never
 * "skip". It goes through the same safe read as a full load, just with a byte cap.
 */
export function readHeader(path: string): { cwd: string | null; startTs: number } {
  const unknown = { cwd: null, startTs: Number.POSITIVE_INFINITY };
  const head = safeReadJsonl(path, HEADER_BYTES);
  if (head === null) return unknown;
  let cwd: string | null = null;
  let startTs = Number.POSITIVE_INFINITY;
  let rowCount = 0;
  for (const row of head) {
    const t = timestampOf(row);
    if (t !== 0 && t < startTs) startTs = t;
    if (cwd === null && typeof row.cwd === 'string') cwd = row.cwd;
    const payload = row.payload !== null && typeof row.payload === 'object' ? row.payload as { cwd?: unknown } : null;
    if (cwd === null && row.type === 'session_meta' && typeof payload?.cwd === 'string') cwd = payload.cwd;
    if (++rowCount >= HEADER_ROWS) break;
  }
  return { cwd, startTs };
}

/**
 * Can this transcript be skipped without a full read? Two bounds, each sound in the direction
 * that matters (it may keep a file it did not need, never drop one it did):
 *
 * - `isOlderThan`: mtime is the LAST write, an upper bound on every row, so a file last written
 *   before `notBefore` has no row in the window.
 * - start time after `notAfter`: rows are appended in order, so the earliest header timestamp
 *   is the session's start, and a session that began after the PR's last commit (plus grace)
 *   cannot overlap it. On a long-lived machine the mtime bound alone keeps every session since
 *   the PR began, which for a month-old PR is nearly all of them.
 *
 * With a matcher, a header cwd outside every root also skips; a null matcher means the caller
 * already trusts the file's location.
 */
function skipUnread(path: string, window: SessionWindow, matches: ((cwd: string) => boolean) | null): boolean {
  if (isOlderThan(path, window.notBefore)) return true;
  const header = readHeader(path);
  if (Number.isFinite(header.startTs) && header.startTs > window.notAfter) return true;
  return matches !== null && header.cwd !== null && !matches(header.cwd);
}

/**
 * Walk one global transcript tree (Codex or OMP) once for all roots, skipping by `skipUnread`
 * before any full read. On this machine nearly every transcript belongs to some other repo or
 * time, and the header settles that in 64 KB instead of up to 20 MB.
 */
function loadTreeSessions(
  treeRoot: string,
  roots: readonly string[],
  window: SessionWindow,
  inspect: (path: string, roots: readonly string[]) => SessionMeta | null,
): SessionMeta[] {
  if (!existsSync(treeRoot)) return [];
  const matches = rootMatcher(roots);
  const uid = userInfo().uid;
  const out: SessionMeta[] = [];
  const stack = [treeRoot];
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
      if (!entry.endsWith('.jsonl')) {
        stack.push(path);
        continue;
      }
      if (skipUnread(path, window, matches)) continue;
      const meta = inspect(path, roots);
      if (meta && meta.promptCount > 0) out.push(meta);
    }
  }
  return out;
}

function overlapsRange(s: SessionMeta, range: CommitRange, graceMin: number): boolean {
  const grace = graceMin * 60 * 1000;
  return s.lastTs >= range.min - grace && s.firstTs <= range.max + grace;
}
