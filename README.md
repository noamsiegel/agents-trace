# ai-trace

> Capture Claude Code and Codex CLI session transcripts as scrubbed secret gists linked from GitHub PRs.

`ai-trace` reads local AI coding-session JSONL from Claude Code
(`~/.claude/projects/<encoded-cwd>/*.jsonl`) and Codex CLI
(`~/.codex/sessions/**/*.jsonl`), scrubs it, and attaches cleaned markdown as a
**secret GitHub gist** linked from your PR description.

Reviewers see one line in the PR body: `🤖 ai-trace: <gist-url>`. The gist
contains prompts that produced code, so auditors can trace intent without
polluting commit history. Re-attach is idempotent for both the new marker and the
old `🤖 AI Provenance:` marker.

## Why renamed from provenance

SLSA, Sigstore, in-toto, and GitHub artifact attestations already own
"provenance" in software security: signed statements about build artifacts,
subjects, predicates, and supply-chain integrity. This tool is narrower: AI
session tracing for code review. `ai-trace` names that job directly and avoids
confusing a reviewer who expects cryptographic supply-chain provenance.

## Adjacent tools

| Tool | What they do | What ai-trace does that they don't |
|---|---|---|
| Goose | Agent runtime with JSON/Markdown session export. | Scrubs transcripts, gates with gitleaks, and attaches a secret gist to a PR. |
| Aider | Pair-programming CLI with chat/LLM history files. | Publishes review-ready evidence for GitHub PRs with public-repo safety checks. |
| Codex CLI | Stores local JSONL sessions for resume. | Converts Codex sessions into the same scrubbed PR audit artifact as Claude Code. |
| OpenInference | OpenTelemetry-compatible AI observability trace schema. | Produces a human-readable PR artifact without requiring instrumentation or OTLP. |
| GitHub artifact attestations | Signed SLSA/in-toto provenance for build artifacts. | Captures prompts and AI coding intent; not a build attestation system. |

## Why this design

| Approach | What it captures | Where it lives | Adoption friction |
|---|---|---|---|
| Co-authored-by trailer | "AI helped" flag | git commit history (permanent, public) | Low. VS Code rolled back automatic injection. |
| Commit-message context block | All prompts | git commit history (permanent, public) | High noise. Long commits. |
| **PR-link to secret gist (this)** | All prompts | Off-history (deletable, URL-protected) | One line in PR body |
| MCP server / DB query | Session metadata + replay | Local DB | Heavy runtime. Single-user. |

PR attachment puts trace data where reviewers already look, keeps commit history
clean, and lets you delete the gist later if needed.

## Public-repo safety

**Secret gists are URL-protected, not access-controlled.** Anyone with the URL
can read the gist. If you put that URL in a public PR body, the transcript is
effectively public.

`ai-trace pr-attach` **refuses to attach to public-repo PRs by default**.
Override with `--public-ok` after confirming dry-run output is safe to make
public. Better: keep this tool to private repos.

## What it does

```text
Claude session → ~/.claude/projects/<encoded-cwd>/*.jsonl
Codex session  → ~/.codex/sessions/**/*.jsonl (filtered by recorded cwd)
                          ↓ filter by time/file overlap with PR commits
                          ↓ strip code blocks (configurable)
                          ↓ run scrubbers (15+ default patterns)
                          ↓ neutralize markdown smuggling
                          ↓ wrap in fenced "untrusted transcript" blocks
                          ↓ hard gitleaks gate
                          ↓ gh gist create --secret
                          ↓ gh pr edit --body (appends or updates "🤖 ai-trace: <url>")
```

## Install

Requires [`bun`](https://bun.sh), [`gh`](https://cli.github.com), and
[`gitleaks`](https://github.com/gitleaks/gitleaks).

```bash
git clone https://github.com/noamsiegel/ai-trace.git ~/.local/share/ai-trace
ln -s ~/.local/share/ai-trace/bin/ai-trace ~/.local/bin/ai-trace
```

Authenticate `gh`:

```bash
gh auth status
gh auth refresh -h github.com -s gist,repo
```

## Usage

```bash
ai-trace collect [--pr N] [--source auto|claude|codex]
ai-trace sessions-since <ref> [--source auto|claude|codex]
ai-trace gist-create [--pr N] [--source auto|claude|codex]
ai-trace pr-attach [--pr N] [--source auto|claude|codex]
ai-trace handoff [--session ID] [--source auto|claude|codex]
ai-trace scrub-rules
```

Common flags: `--source auto|claude|codex`, `--dry-run`, `--no-attach`,
`--force`, `--public-ok`, `--include-code`, `--grace-min N`, `--base <ref>`.

`--source auto` is default. It tries Claude Code sessions for the current repo
first, then Codex sessions. Codex sessions are global, so `ai-trace` scans the
session tree and keeps only files whose recorded `cwd` equals the repo root.

## Configuration

`ai-trace` reads optional JSON config from `~/.config/ai-trace/config.json`.

Built-in scrubbers run first, in registry order. User-added scrubbers run after
built-ins. `disable` removes matching built-ins by name. If a user-added
scrubber uses the same name as a built-in, the user scrubber replaces that
built-in.

```json
{
  "scrubbers": {
    "disable": ["github-pat"],
    "add": [
      {
        "name": "internal-id",
        "pattern": "INT-\\d+",
        "replacement": "[INT-ID]"
      }
    ]
  }
}
```

Each `add` entry requires `name`, `pattern`, and `replacement`; `flags` is
optional and defaults to `g`. Invalid regexes are warned to stderr and skipped.
Run `ai-trace scrub-rules` to inspect the effective scrubber pipeline.

## Marker migration

`ai-trace pr-attach` recognizes both markers when re-attaching:

- `🤖 ai-trace: <gist-url>`
- `🤖 AI Provenance: <gist-url>`

If either marker exists, `ai-trace` edits the existing gist and rewrites the PR
body to the new `ai-trace` marker instead of appending a duplicate line.

## Integrating with your workflow

Add to your shell rc to auto-attach on PR creation:

```bash
# ~/.zshrc or ~/.bashrc
gh() {
  command gh "$@"
  local rc=$?
  if [[ "$1" == "pr" && "$2" == "create" && $rc -eq 0 ]]; then
    ai-trace pr-attach 2>/dev/null || true
  fi
  return $rc
}

# Graphite users:
gt() {
  command gt "$@"
  local rc=$?
  if [[ "$1" == "submit" && $rc -eq 0 ]]; then
    ai-trace pr-attach 2>/dev/null || true
  fi
  return $rc
}
```

## Related tools

- [git-wt](https://github.com/noamsiegel/git-wt) — parallel-safe worktree CLI for agentic coding.
- [ai-git-guardrails](https://github.com/noamsiegel/ai-git-guardrails) — pre-commit secret scanning. Complementary to ai-trace's pre-post gitleaks check.

## Status

Private-use tool. Default posture: safe for private repos, conservative for
public repos.
