import assert from "node:assert/strict";
import test from "node:test";
import {
  compareGitChanges,
  type GitComparisonResult,
} from "../src/gitComparison.js";
import type {
  GitCommandResult,
  GitCommandRunner,
} from "../src/gitDiscovery.js";

const baseCommit = "1".repeat(40);
const headCommit = "2".repeat(40);

function commandResult(
  status: number,
  stdout = "",
  stderr = "",
): GitCommandResult {
  return {
    status,
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(stderr),
  };
}

function comparisonRunner(
  diffOutput: string,
  contentResults: GitCommandResult[] = [],
): GitCommandRunner {
  assert.equal(
    contentResults.length % 2,
    0,
    "Content results must provide before/after Git show results for each pair.",
  );
  const verifiedContentResults: GitCommandResult[] = [];
  for (let index = 0; index < contentResults.length; index += 2) {
    verifiedContentResults.push(
      commandResult(0, "commit\n"),
      commandResult(0, "commit\n"),
      contentResults[index],
      contentResults[index + 1],
    );
  }
  const results = [
    commandResult(0, "true\n"),
    commandResult(0, `${baseCommit}\n`),
    commandResult(0, `${headCommit}\n`),
    commandResult(0, diffOutput),
    ...verifiedContentResults,
  ];

  return (args) => {
    const result = results.shift();
    assert.ok(result, `Unexpected Git command: ${args.join(" ")}`);
    return result;
  };
}

function compareWithRunner(
  diffOutput: string,
  contentResults: GitCommandResult[] = [],
): GitComparisonResult {
  return compareGitChanges(
    {
      repositoryPath: process.cwd(),
      baseRef: "BASE",
      headRef: "HEAD",
      include: ["models/**"],
      ignore: ["docs/**"],
    },
    comparisonRunner(diffOutput, contentResults),
  );
}

test("compares all valid pairs and accounts for every discovered row", () => {
  const result = compareWithRunner(
    [
      "M\tmodels/high.sql",
      "A\tmodels/new.sql",
      "D\tmodels/deleted.sql",
      "R100\tmodels/old.sql\tmodels/renamed.sql",
      "T\tmodels/type-change.sql",
      "M\tdocs/ignored.sql",
      "malformed",
      "M\tmodels/content-fail.sql",
      "M\tmodels/low.sql",
      "M\tmodels/duplicate.sql",
      "M\tmodels/duplicate.sql",
    ].join("\n"),
    [
      commandResult(
        0,
        "SELECT COUNT(DISTINCT user_id) FROM events WHERE event = 'login'",
      ),
      commandResult(0, "SELECT COUNT(*) FROM events WHERE event = 'login'"),
      commandResult(0, "SELECT COUNT(*) FROM stable_source"),
      commandResult(0, "SELECT COUNT(*) FROM stable_source"),
      commandResult(128, "", "fatal: before content missing"),
      commandResult(0, "SELECT COUNT(*) FROM available_after"),
      commandResult(0, "SELECT COUNT(*) FROM users WHERE country = 'DE'"),
      commandResult(0, "SELECT  COUNT(*)  FROM users WHERE country = 'DE'"),
      commandResult(0, "SELECT COUNT(*) FROM users"),
      commandResult(0, "SELECT COUNT(*) FROM users"),
      commandResult(0, "SELECT COUNT(*) FROM users"),
      commandResult(0, "SELECT COUNT(*) FROM users"),
    ],
  );

  assert.deepEqual(result.summary, {
    discoveredCount: 11,
    analyzedCount: 5,
    skippedCount: 6,
    highestSeverity: "high",
  });
  assert.equal(result.summary.discoveredCount, result.analyzed.length + result.skipped.length);
  assert.deepEqual(
    result.analyzed.map((file) => file.displayPath),
    [
      "models/high.sql",
      "models/old.sql -> models/renamed.sql",
      "models/low.sql",
      "models/duplicate.sql",
      "models/duplicate.sql",
    ],
  );
  assert.equal(result.analyzed[0].result.risk_level, "high");
  assert.equal(result.analyzed[1].beforePath, "models/old.sql");
  assert.equal(result.analyzed[1].afterPath, "models/renamed.sql");
  assert.deepEqual(
    result.skipped.map((item) => item.stage),
    ["git-parse", "path-filter", "pairing", "pairing", "pairing", "content-load"],
  );
  assert.match(
    result.skipped.find((item) => item.stage === "content-load")?.reason ?? "",
    /before content missing/i,
  );
});

test("returns a calm empty result when refs contain no changed files", () => {
  const result = compareWithRunner("");

  assert.deepEqual(result.summary, {
    discoveredCount: 0,
    analyzedCount: 0,
    skippedCount: 0,
    highestSeverity: "low",
  });
  assert.deepEqual(result.analyzed, []);
  assert.deepEqual(result.skipped, []);
});

test("treats only added and deleted files as transparent nonfatal skips", () => {
  const result = compareWithRunner(
    "A\tmodels/new.sql\nD\tmodels/deleted.sql",
  );

  assert.deepEqual(result.summary, {
    discoveredCount: 2,
    analyzedCount: 0,
    skippedCount: 2,
    highestSeverity: "low",
  });
  assert.deepEqual(
    result.skipped.map((item) => item.path),
    ["models/new.sql", "models/deleted.sql"],
  );
  assert.ok(result.skipped.every((item) => item.stage === "pairing"));
});

test("keeps parser-only malformed output observable", () => {
  const result = compareWithRunner("not-tab-separated");

  assert.equal(result.summary.discoveredCount, 1);
  assert.equal(result.summary.analyzedCount, 0);
  assert.equal(result.summary.skippedCount, 1);
  assert.equal(result.skipped[0].stage, "git-parse");
  assert.equal(result.skipped[0].line, "not-tab-separated");
});

test("uses SQL files as the safe default candidate set", () => {
  const result = compareGitChanges(
    {
      repositoryPath: process.cwd(),
      baseRef: "BASE",
      headRef: "HEAD",
    },
    comparisonRunner(
      "M\tREADME.md\nM\tmetric.sql",
      [
        commandResult(0, "SELECT COUNT(*) FROM users"),
        commandResult(0, "SELECT COUNT(*) FROM users"),
      ],
    ),
  );

  assert.equal(result.summary.discoveredCount, 2);
  assert.equal(result.summary.analyzedCount, 1);
  assert.equal(result.summary.skippedCount, 1);
  assert.equal(result.analyzed[0].path, "metric.sql");
  assert.equal(result.skipped[0].path, "README.md");
  assert.equal(result.skipped[0].stage, "path-filter");
});

test("preserves both rename paths when the new path is filtered out", () => {
  const result = compareWithRunner(
    "R100\tdocs/old_metric.sql\tdocs/new_metric.sql",
  );

  assert.equal(result.summary.discoveredCount, 1);
  assert.equal(result.summary.analyzedCount, 0);
  assert.deepEqual(result.skipped, [
    {
      stage: "path-filter",
      path: "docs/new_metric.sql",
      beforePath: "docs/old_metric.sql",
      afterPath: "docs/new_metric.sql",
      reason: "excluded by ignore pattern: docs/**",
    },
  ]);
});
