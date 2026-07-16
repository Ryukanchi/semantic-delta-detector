# Local Git Discovery

Local Git mode compares SQL changes between two refs without mutating a repository or calling a remote API.

## Pipeline

```text
git diff --name-status <base> <head>
→ parse status rows
→ CandidateFile metadata
→ include/ignore filtering
→ conservative before/after pairing
→ git show <ref>:<path> content loading
→ compareSqlQueries() per valid pair
→ aggregate text, simulated PR, or JSON output
```

`discoverGitChangedFiles()` validates the repository, resolves user-provided refs to commit hashes, runs the name-status diff, and preserves parser skips and Git warnings. `loadGitPairContent()` reads only pairs that survived filtering and pairing. It rejects unavailable content, NUL-containing content, and invalid UTF-8 instead of claiming that content exists.

Git subprocesses use argument arrays without a shell. Refs are resolved with `rev-parse --verify --end-of-options`; subsequent diff and show operations use resolved hashes. Expected repository, ref, and content errors are reported without raw stack traces by the CLI.

## Accounting

The discovery composition derives its path list from candidate metadata, preventing a candidate from disappearing because of mismatched parallel inputs. The aggregate layer enforces:

```text
discovered rows = analyzed files + skipped rows
```

Each row ends as one of:

- analyzed;
- skipped during Git parsing;
- skipped by path filtering;
- skipped by candidate pairing; or
- skipped because before/after content could not be loaded safely.

Warnings from successful Git commands are preserved separately and do not change row accounting.

## Path and Rename Policy

When no `include` pattern is configured, Git mode defaults to `**/*.sql`. Configured `ignore` patterns win over `include` patterns.

Renames use the new/current path for include/ignore filtering. The old path remains attached to results and skipped output, and content is read from the old path at the base ref and the new path at the head ref.

Added files have no before version and deleted files have no after version, so both are transparently skipped in this milestone. Unknown statuses are also skipped. None of these skips automatically fails semantic gating.

## CLI and Gating

`--changed-from <ref>` enables Git mode and is required. `--changed-to` defaults to `HEAD`; `--repo` defaults to the current working directory. Git mode is exclusive with examples and explicit query/file pairs.

Text output shows complete findings and skips. `--pr` prints one concise simulated aggregate comment. `--format json` returns the complete structured result. `--fail-on` compares its threshold against the highest analyzed semantic severity; no analyzed files means no semantic gate failure. Invalid repositories, refs, or Git subprocess failures remain operational errors.

## Limitations

- No GitHub API calls or real PR comments.
- No semantic analysis for added or deleted metrics.
- No worktree or index comparison; both inputs are explicit commit refs.
- The name-status parser expects tab-separated text output and does not fully support pathological filenames containing tabs or newlines.
- Path patterns intentionally support only the repository's existing simple matching rules, not full glob syntax.
- SQL analysis remains heuristic; parser limitation notes continue to apply to CTEs, CASE expressions, and subqueries.
