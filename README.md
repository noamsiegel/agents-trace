# provenance

> Capture Claude Code session transcripts as secret gists linked from GitHub PRs.

`provenance` reads your Claude Code session JSONL files
(`~/.claude/projects/<encoded-cwd>/*.jsonl`), scrubs them, and attaches the
cleaned markdown as a **secret GitHub gist** linked from your PR description.

Reviewers see one line in the PR body: `🤖 AI Provenance: <gist-url>`. That
gist contains the prompts that produced the code, so auditors can trace
intent without polluting commit history.

## Why this design

| Approach | What it captures | Where it lives | Adoption friction |
|---|---|---|---|
| Co-authored-by trailer | "AI helped" flag | git commit history (permanent, public) | Low. VS Code rolled back automatic injection. |
| Commit-message provenance block | All prompts | git commit history (permanent, public) | High noise. Long commits. |
| **PR-link to secret gist (this)** | All prompts | Off-history (deletable, URL-protected) | One line in PR body |
| MCP server / DB query | Session metadata + replay | Local DB | Heavy runtime. Single-user. |

PR-attachment puts provenance where reviewers already look (PR body), keeps
commit history clean, and lets you delete the gist later if needed.

## ⚠️ Public-repo safety

**Secret gists are URL-protected, not access-controlled.** Anyone with the URL
can read the gist. If you put that URL in a public PR body, the transcript is
effectively public.

`provenance pr-attach` **refuses to attach to public-repo PRs by default**.
Override with `--public-ok` after confirming the dry-run output is safe to
make public. Better: keep this tool to private repos.

## What it does

```
Claude session → ~/.claude/projects/<encoded-cwd>/*.jsonl
                          ↓ filter by time overlap with PR commits (default ±30 min grace)
                          ↓ strip code blocks (configurable)
                          ↓ run scrubbers (15+ default patterns: GitHub PAT, AWS, GCP, Stripe, OpenAI, Anthropic, JWT, private keys, email, home paths)
                          ↓ neutralize markdown smuggling (links/images/HTML stripped or escaped)
                          ↓ wrap in fenced "untrusted transcript" blocks
                          ↓ hard gitleaks gate (refuses to post if secrets found, unless --force)
                          ↓ gh gist create --secret
                          ↓ gh pr edit --body  (appends "🤖 AI Provenance: <url>")
```

## Install

Requires [`bun`](https://bun.sh), [`gh`](https://cli.github.com), and
[`gitleaks`](https://github.com/gitleaks/gitleaks).

```bash
git clone https://github.com/noamsiegel/provenance.git ~/.local/share/provenance
ln -s ~/.local/share/provenance/bin/provenance ~/.local/bin/provenance
```

Authenticate `gh`:

```bash
gh auth status
gh auth refresh -h github.com -s gist,repo
```

## Usage

```bash
provenance collect [--pr N]              # print cleaned markdown to stdout
provenance sessions-since <ref>          # list overlapping sessions for commits since <ref>
provenance gist-create [--pr N]          # create secret gist; print URL
provenance pr-attach [--pr N]            # gist-create + edit PR description (idempotent)
provenance scrub-rules                   # show active scrubbers
```

Common flags: `--dry-run`, `--no-attach`, `--force`, `--public-ok`,
`--include-code`, `--grace-min N`, `--base <ref>`.

## Configuration

`provenance` reads optional JSON config from `~/.config/provenance/config.json`.

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
Run `provenance scrub-rules` to inspect the effective scrubber pipeline.

## Integrating with your workflow

Add to your shell rc to auto-attach on PR creation:

```bash
# ~/.zshrc or ~/.bashrc
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

## Security model

Pentested by an adversarial security agent. Properties:

- **C1 — Public-repo block.** Attaching to public-repo PRs is refused by default.
- **C2 — Untrusted transcript content.** Prompts are wrapped in fenced code
  blocks. Markdown links (`[](url)`) are flattened to plain text. HTML tags
  stripped. Fence-escape attempts (` ``` `) are neutralized.
- **C3 — Safe file reading.** `lstat`+`fstat`-based session reads. Symlinks,
  hardlinks, non-regular files, files not owned by current uid, and files
  larger than 20MB are all rejected. Row count capped at 50000 per session.
- **Hard gitleaks gate.** The gist body runs through `gitleaks detect` before
  posting; refuses to post on any finding unless `--force`.
- **15+ default scrubbers.** GitHub tokens, AWS/GCP/Slack/Stripe/OpenAI/Anthropic
  keys, JWTs, private-key blocks, DB URLs with basic auth, emails, home paths.

## Tests

```bash
bun test
```

## Companions

- [git-wt](https://github.com/noamsiegel/git-wt) — parallel-safe worktree CLI for agentic coding. Knows the worktree↔branch↔session mapping.
- [guardrails](https://github.com/noamsiegel/guardrails) — pre-commit secret scanning. Complementary to provenance's pre-post gitleaks check.

## Status

v0.7.0 completes the roadmap target architecture: pure core modules, concrete
GitHub/gitleaks adapters, centralized posting-plan gates, and registry-based
scrubber composition.

## License

MIT. See [LICENSE](./LICENSE).
