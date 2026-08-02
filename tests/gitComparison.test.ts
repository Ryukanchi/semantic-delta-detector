import assert from "node:assert/strict";
import test from "node:test";
import type { GitComparisonResult } from "../src/gitComparison.js";
import { compareGitChangesWithRunner as compareGitChanges } from "../src/internal/gitComparisonRuntime.js";
import type {
  GitCommandResult,
  GitCommandRunner,
} from "../src/internal/gitDiscoveryRuntime.js";

const baseCommit = "1".repeat(40);
const headCommit = "2".repeat(40);

function commandResult(
  status: number,
  stdout: string | Buffer = "",
  stderr = "",
): GitCommandResult {
  return {
    status,
    stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout),
    stderr: Buffer.from(stderr),
  };
}

function nameStatusZ(records: ReadonlyArray<readonly string[]>): Buffer {
  const fields = records.flat();
  return fields.length === 0
    ? Buffer.alloc(0)
    : Buffer.from(`${fields.join("\0")}\0`, "utf8");
}

function legacyFixtureToNameStatusZ(output: string): Buffer {
  if (!output) {
    return Buffer.alloc(0);
  }

  return nameStatusZ(
    output.split("\n").map((line) => {
      const fields = line.split("\t");
      return fields.length === 1 ? [fields[0], ""] : fields;
    }),
  );
}

function comparisonRunner(
  diffOutput: string | Buffer,
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
    commandResult(
      0,
      Buffer.isBuffer(diffOutput) ? diffOutput : legacyFixtureToNameStatusZ(diffOutput),
    ),
    ...verifiedContentResults,
  ];

  return (args) => {
    const result = results.shift();
    assert.ok(result, `Unexpected Git command: ${args.join(" ")}`);
    return result;
  };
}

function compareWithRunner(
  diffOutput: string | Buffer,
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
      "C100\tmodels/source.sql\tmodels/copied.sql",
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
    discoveredCount: 12,
    analyzedCount: 5,
    skippedCount: 7,
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
    [
      "git-parse",
      "path-filter",
      "pairing",
      "pairing",
      "pairing",
      "pairing",
      "content-load",
    ],
  );
  const copiedSkip = result.skipped.find((item) => item.path === "models/copied.sql");
  assert.deepEqual(copiedSkip, {
    stage: "pairing",
    path: "models/copied.sql",
    beforePath: "models/source.sql",
    afterPath: "models/copied.sql",
    reason: "skipped because candidate status is unknown",
  });
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

test("keeps parser-only malformed NUL output observable", () => {
  const result = compareWithRunner("not-tab-separated");

  assert.equal(result.summary.discoveredCount, 1);
  assert.equal(result.summary.analyzedCount, 0);
  assert.equal(result.summary.skippedCount, 1);
  assert.equal(result.skipped[0].stage, "git-parse");
  assert.match(result.skipped[0].line ?? "", /not-tab-separated/);
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

test("analyzes exact special-character paths and preserves accounting", () => {
  const modifiedPath = 'models/深い directory/tab\tline\nquote"slash\\.sql';
  const renamedBefore = 'models/old\t"\\名.sql';
  const renamedAfter = 'models/new\n"\\名.sql';
  const result = compareWithRunner(
    nameStatusZ([
      ["M", modifiedPath],
      ["R100", renamedBefore, renamedAfter],
    ]),
    [
      commandResult(0, "SELECT COUNT(*) FROM users"),
      commandResult(0, "SELECT COUNT(*) FROM users"),
      commandResult(0, "SELECT COUNT(*) FROM stable_source"),
      commandResult(0, "SELECT COUNT(*) FROM stable_source"),
    ],
  );

  assert.deepEqual(result.summary, {
    discoveredCount: 2,
    analyzedCount: 2,
    skippedCount: 0,
    highestSeverity: "low",
  });
  assert.deepEqual(
    result.analyzed.map((file) => [file.beforePath, file.afterPath]),
    [
      [modifiedPath, modifiedPath],
      [renamedBefore, renamedAfter],
    ],
  );
});

test("accounts for invalid UTF-8 without invoking Git content loading", () => {
  const calls: string[][] = [];
  const results = [
    commandResult(0, "true\n"),
    commandResult(0, `${baseCommit}\n`),
    commandResult(0, `${headCommit}\n`),
    commandResult(
      0,
      Buffer.concat([
        Buffer.from("M\0", "utf8"),
        Buffer.from([0xc3, 0x28, 0]),
      ]),
    ),
  ];
  const runner: GitCommandRunner = (args) => {
    calls.push([...args]);
    const result = results.shift();
    assert.ok(result, `Unexpected Git command: ${args.join(" ")}`);
    return result;
  };

  const result = compareGitChanges(
    {
      repositoryPath: process.cwd(),
      baseRef: "BASE",
      headRef: "HEAD",
    },
    runner,
  );

  assert.deepEqual(result.summary, {
    discoveredCount: 1,
    analyzedCount: 0,
    skippedCount: 1,
    highestSeverity: "low",
  });
  assert.equal(result.skipped[0].stage, "git-parse");
  assert.match(result.skipped[0].line ?? "", /0xc328/);
  assert.equal(calls.some((args) => args[2] === "show"), false);
});

test("keeps copy paths attached when another record has the same target path", () => {
  const result = compareWithRunner(
    nameStatusZ([
      ["M", "models/shared.sql"],
      ["C100", "models/source.sql", "models/shared.sql"],
    ]),
    [
      commandResult(0, "SELECT COUNT(*) FROM users"),
      commandResult(0, "SELECT COUNT(*) FROM users"),
    ],
  );

  assert.deepEqual(result.summary, {
    discoveredCount: 2,
    analyzedCount: 1,
    skippedCount: 1,
    highestSeverity: "low",
  });
  assert.deepEqual(result.skipped, [
    {
      stage: "pairing",
      path: "models/shared.sql",
      beforePath: "models/source.sql",
      afterPath: "models/shared.sql",
      reason: "skipped because candidate status is unknown",
    },
  ]);
});
