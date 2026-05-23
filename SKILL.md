---
name: provenance
description: Capture Claude Code session transcripts as secret gists attached to GitHub PRs. USE WHEN user wants to attach AI provenance to a PR, run provenance collect/gist-create/pr-attach, or audit which sessions produced which PR.
---

# provenance

Captures Claude Code session JSONL transcripts as **secret GitHub gists**
linked from PR descriptions, so reviewers can audit "what was asked" without
polluting commit history.

## Architecture

```
Claude Code session in some repo
   ↓
~/.claude/projects/<encoded-cwd>/*.jsonl   ← deterministic capture (Claude writes this)
   ↓
provenance collect [--pr <num>]
   ↓ filter by time overlap with PR's commits
   ↓ strip noise (system messages, tool internals)
   ↓ run scrubbers (api keys, emails, home paths)
   ↓
cleaned markdown
   ↓
provenance gist-create     ← gh gist create --secret
   ↓
secret gist URL
   ↓
provenance pr-attach       ← appends to PR description
   ↓
"🤖 AI Provenance: <gist-url>"
```

## Commands

| Subcommand | What it does |
|---|---|
| `collect [--pr N]` | print cleaned markdown to stdout (no gist, no PR edit) |
| `sessions-since <ref>` | list sessions whose timestamps overlap commits since `<ref>` |
| `gist-create [--secret]` | collect + create a secret gist; print URL |
| `pr-attach [--pr N]` | gist-create + edit the named PR description (idempotent) |
| `scrub-rules` | show active scrubbing rules |

Common flags:
- `--pr <num>` — target PR (default: current branch's open PR via `gh`)
- `--base <ref>` — base ref for session-scoping (default: PR base branch)
- `--include-code` — include code blocks (default: omit)
- `--dry-run` — print what would happen; create no gist
- `--no-attach` — gist-create only; do not edit the PR

## Configuration

`~/.config/provenance/config.yaml`:

```yaml
scrubbers:
  - id: api-keys
    pattern: '(?i)(api[_-]?key|secret|token|password)["\s:=]+[A-Za-z0-9_\-./+=]{16,}'
    replacement: '[REDACTED-CREDENTIAL]'
  - id: emails
    pattern: '\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b'
    replacement: '[REDACTED-EMAIL]'
  - id: home-paths
    pattern: '/Users/[^/\s]+/'
    replacement: '/Users/REDACTED/'
```

## Privacy / security

- All gists default to **secret** (`gh gist create --secret`) — URL-protected,
  not indexed, not visible on profile. Anyone with the URL can read.
- Before posting, the gist body runs through `gitleaks protect` as a
  belt-and-suspenders check. If gitleaks finds anything, the post is
  aborted unless `--force` is set.
- Configurable scrubbers run before gitleaks. Default scrubbers strip
  api-key patterns, emails, and home directory paths.
- The PR description gets the gist URL appended. The PR is on a public repo;
  anyone reading the PR can see and visit the gist URL. **Do not put truly
  sensitive prompts in PRs of public repos.** Use the dry-run mode to
  preview the content first.

## Files

- `~/.pai/skills/provenance/cli.ts` — the CLI implementation (Bun/TS)
- `~/.local/bin/provenance` — shell shim invoking the skill
- `~/.config/provenance/config.yaml` — scrubber rules + thresholds (optional)

## Integrating with your PR workflow

Add to your shell rc (`~/.zshrc` or `~/.bashrc`) to auto-attach provenance on PR creation:

```bash
# After `gh pr create` succeeds, attach provenance.
gh() {
  command gh "$@"
  local rc=$?
  if [[ "$1" == "pr" && "$2" == "create" && $rc -eq 0 ]]; then
    provenance pr-attach 2>/dev/null || true
  fi
  return $rc
}

# Graphite users:
gt() {
  command gt "$@"
  local rc=$?
  if [[ "$1" == "submit" && $rc -eq 0 ]]; then
    provenance pr-attach 2>/dev/null || true
  fi
  return $rc
}
```

## Tests

```bash
bun test ~/.pai/skills/provenance/tests/cli.test.ts
```
