# Changed-File Discovery Design

## 1. Problem

Semantic Delta can compare explicit before/after SQL files today through `--before` and `--after`. That is a safe starting point because the user decides exactly which two SQL definitions should be compared.

Future PR and CI workflows need a way to discover changed SQL files automatically. That discovery layer needs careful design. A naive scanner could compare unrelated files, miss renamed models, treat new files as risky changes, or surprise users by failing CI for files they did not expect Semantic Delta to inspect.

The goal is to make changed-file discovery predictable before wiring `include` and `ignore` config into automated behavior.

## 2. Goals

- Support explicit file-pair comparison as the simplest and most predictable mode.
- Support future Git/GitHub changed-file discovery.
- Support `include` and `ignore` filtering from `semantic-delta.yml`.
- Keep default behavior safe and predictable.
- Avoid real PR comments for now.
- Avoid blocking PRs unless the user explicitly configures blocking behavior.
- Make discovered and skipped files visible in CI logs.

## 3. Non-Goals

- No full repository scanner yet.
- No GitHub API integration yet.
- No dbt-specific behavior yet.
- No real PR commenting yet.
- No production-readiness claim.
- No automatic semantic analysis of every SQL file in a repository.

## 4. Proposed Phases

### Phase 1: Explicit File Pairing

Keep the current behavior:

- `--before <path>` and `--after <path>` compare one explicit SQL pair.
- `semantic-delta.yml` `default_before_path` and `default_after_path` are used only when CLI paths are omitted.
- `--example` remains separate from config path defaults.

This phase is already implemented and should remain the baseline.

### Phase 2: Explicit File-List Mode

Add a local explicit file-list mode if it proves useful.

Possible shape:

- A text or JSON file containing before/after pairs.
- Each pair is intentionally provided by the user or CI job.
- Semantic Delta reports each comparison separately and returns an aggregate status only when gating is configured.

This avoids Git discovery at first while supporting more than one pair.

### Phase 3: Git-Based Changed-File Discovery

Add local Git discovery.

Possible behavior:

- Compare changed files between `--changed-from <git-ref>` and `--changed-to <git-ref>`.
- Read before content from the base ref.
- Read after content from the head ref or working tree.
- Apply `include` and `ignore` filters from `semantic-delta.yml`.
- Print discovered files before analysis.
- Print skipped files with reasons.

This phase should not require GitHub API access.

### Phase 4: GitHub Actions Integration

Use GitHub Actions context to provide PR base/head refs.

Initial behavior should still print CI logs only:

- Use PR base/head refs to discover changed SQL files.
- Apply `semantic-delta.yml` filters.
- Keep pull request runs non-blocking by default.
- Later, consider real PR comments only after the logged output and filtering behavior are trusted.

## 5. File Matching Strategy

Changed-file discovery needs a conservative matching policy.

Important cases:

- Exact same path changed between refs.
- Renamed files.
- New files with no before version.
- Deleted files with no after version.

Recommended initial policy:

- Compare only files that have both before and after content.
- Skip new files with a clear note such as `skipped: no before version`.
- Skip deleted files with a clear note such as `skipped: no after version`.
- Handle renames later, after deciding whether rename detection should rely on Git similarity heuristics or explicit configuration.

This keeps the first implementation focused on semantic changes to existing metric definitions, not lifecycle events.

## 6. Include / Ignore Semantics

`semantic-delta.yml` supports simple path pattern config:

```yaml
include:
  - metrics/**
  - models/**
ignore:
  - docs/**
  - README.md
```

Proposed semantics:

- `include` limits candidate files when present.
- `ignore` excludes candidate files.
- `ignore` wins over `include`.
- Patterns should be path-like glob patterns relative to the repository root.
- If `include` is empty, discovery can use the default candidate set.
- A future default candidate set should probably be SQL files only, such as `**/*.sql`.

Current behavior: these fields are parsed and exposed only. They do not trigger scanning or filtering yet.

## 7. CLI Design Ideas

Possible future flags:

- `--changed-from <git-ref>`
- `--changed-to <git-ref>`
- `--files <path-to-pairs-file>`
- `--config <path>`
- `--dry-run`

These are design candidates only. They should not be implemented until the filtering helper and output format are settled.

## 8. Safety / UX Rules

- Never fail CI by default.
- Print discovered files before analysis.
- Print skipped files and reasons.
- Require explicit `--fail-on` or config `fail_on` for blocking behavior.
- Keep manual `--before` / `--after` mode as the simplest path.
- Do not call the GitHub API until local Git behavior is useful and predictable.
- Do not post PR comments until the CI log output is clear enough to trust.
- Avoid comparing files unless the pairing is obvious.

## 9. Open Questions

- Should `semantic-delta.yml` `fail_on` affect pull request runs automatically?
- Should config `include` and `ignore` apply to explicit `--before` / `--after`?
- How should renamed files be handled?
- Should new files be analyzed later as "new metric" cases?
- How should dbt models be handled?
- Should SQL file detection be extension-based only, or should configured patterns decide all candidates?
- Should discovery output be human-readable only at first, or should it also support JSON?

## 10. Recommended Next Implementation Step

Implement a small pure helper for include/ignore filtering first.

Suggested scope:

- Input: candidate paths, include patterns, ignore patterns.
- Output: included paths and skipped paths with reasons.
- No Git calls.
- No filesystem scanning.
- No CLI behavior change.
- Unit tests for include-only, ignore-only, ignore-over-include, empty config, and path normalization.

After that helper is stable, use it inside a separate changed-file discovery layer.
