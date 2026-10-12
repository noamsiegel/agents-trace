# Releasing agents-trace

Use this checklist from a clean `main` checkout.

1. Run pre-release checks:
   ```bash
   bun test
   git status --short
   ```
   `bun test` must pass and `git status --short` must print nothing.
2. Bump both version sources to the same `X.Y.Z`:
   - `VERSION` const in `cli.ts` near line 38
   - `version` in `package.json`
   The version-match test enforces this drift check.
3. Prepend a `## [vX.Y.Z]` entry to `CHANGELOG.md` with `Added`, `Changed`, and/or `Fixed` subsections as appropriate.
4. Commit, tag, and push in order:
   ```bash
   git add -A
   git commit -m "Release vX.Y.Z"
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push origin main
   git push origin vX.Y.Z
   ```
   If the pre-push hook complains about `cmdGistCreate` or `cmdHandoff` complexity, retry with `SKIP_FALLOW=1`; this is known fallow noise and Q3 architectural debt.
5. Create the GitHub release after both pushes succeed:
   ```bash
   gh release create vX.Y.Z --notes "..."
   ```
6. Update the Homebrew tap formula `Formula/agents-trace.rb` URL and `sha256`.
   Its install block must include runtime dependencies in a self-contained Bun
   bundle:
   ```ruby
   system formula_opt_bin("bun")/"bun", "install", "--production", "--frozen-lockfile"
   system formula_opt_bin("bun")/"bun", "run", "build"
   libexec.install "dist/cli.js"
   ```
   Point the wrapper at `#{libexec}/cli.js` and run the formula's audit/install/test
   checks. The bundle must also pass a file-scope collection smoke test outside
   the source checkout.
7. PAI's skill is a usage pointer to Homebrew, not a vendored code mirror. Do not
   copy product source into it.
8. Upgrade and smoke test the installed tap package:
   ```bash
   brew update
   brew upgrade noamsiegel/tap/agents-trace
   agents-trace --help
   ```
   Help output must report `vX.Y.Z`.

## Recovery

- If push fails due to a stale guardrails shim, run `git-guardrails install --force` to refresh hooks, then retry the push.
- If `gh release create` ran before push succeeded, the remote tag may point at the wrong commit. Recover with `gh release delete vX.Y.Z --yes`, `git push origin --delete vX.Y.Z`, `git tag -d vX.Y.Z`, `git tag -a vX.Y.Z HEAD -m "vX.Y.Z"`, push the tag, then recreate the release.
- If the installed command cannot resolve Acorn, the formula shipped raw source.
  Build and install `dist/cli.js` as described above, then rerun the formula test
  and a file-scope collection smoke test.
