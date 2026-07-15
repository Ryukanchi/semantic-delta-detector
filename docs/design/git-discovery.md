# Git Discovery Foundation

The current milestone adds only pure parsing and metadata mapping for future local
changed-file discovery.

`parseGitDiffNameStatus()` accepts the text format produced by a future
`git diff --name-status <base> <head>` adapter. It maps supported status rows,
preserves their order, and reports malformed rows without throwing.
`gitDiffFilesToCandidates()` then converts parsed rows into the existing
`CandidateFile` metadata consumed by discovery filtering and candidate pairing.

This milestone does not execute Git, read file contents, or change CLI behavior.
A future adapter can run `git diff --name-status` and obtain before/after content
through `git show` before sending comparable pairs to the semantic analyzer.
