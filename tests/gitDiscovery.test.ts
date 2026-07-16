import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  discoverGitChangedFiles,
  GitDiscoveryError,
  loadGitPairContent,
  type GitCommandResult,
  type GitCommandRunner,
  type GitPairContentResult,
  type VerifiedGitCommitHash,
} from "../src/gitDiscovery.js";

const baseCommit = "a".repeat(40) as VerifiedGitCommitHash;
const headCommit = "b".repeat(40) as VerifiedGitCommitHash;

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

function queuedRunner(
  results: GitCommandResult[],
  calls: string[][],
): GitCommandRunner {
  return (args) => {
    calls.push([...args]);
    const result = results.shift();
    assert.ok(result, `Unexpected Git call: ${args.join(" ")}`);
    return result;
  };
}

test("discovers changed files with argument-array Git commands", () => {
  const calls: string[][] = [];
  const runner = queuedRunner(
    [
      commandResult(0, "true\n"),
      commandResult(0, `${baseCommit}\n`),
      commandResult(0, `${headCommit}\n`),
      commandResult(
        0,
        [
          "M\tmodels/revenue.sql",
          "A\tmodels/new.sql",
          "R100\tmodels/old.sql\tmodels/renamed.sql",
          "T\tmodels/type-change.sql",
          "malformed",
        ].join("\n"),
      ),
    ],
    calls,
  );

  const result = discoverGitChangedFiles(
    {
      repositoryPath: process.cwd(),
      baseRef: "base; touch unsafe",
      headRef: "HEAD",
    },
    runner,
  );

  assert.deepEqual(calls[0], [
    "-C",
    process.cwd(),
    "rev-parse",
    "--is-inside-work-tree",
  ]);
  assert.deepEqual(calls[1], [
    "-C",
    process.cwd(),
    "rev-parse",
    "--verify",
    "--end-of-options",
    "base; touch unsafe^{commit}",
  ]);
  assert.deepEqual(calls[3], [
    "-C",
    process.cwd(),
    "diff",
    "--name-status",
    "--find-renames",
    baseCommit,
    headCommit,
    "--",
  ]);
  assert.deepEqual(
    result.files.map((file) => file.status),
    ["modified", "added", "renamed", "unknown"],
  );
  assert.equal(result.parserSkipped.length, 1);
  assert.match(result.parserSkipped[0].reason, /tab-separated/i);
  assert.equal(result.candidates[2].beforePath, "models/old.sql");
  assert.equal(result.candidates[2].afterPath, "models/renamed.sql");
});

test("surfaces successful Git stderr as warnings", () => {
  const calls: string[][] = [];
  const result = discoverGitChangedFiles(
    {
      repositoryPath: process.cwd(),
      baseRef: "BASE",
      headRef: "HEAD",
    },
    queuedRunner(
      [
        commandResult(0, "true\n", "repository warning"),
        commandResult(0, `${baseCommit}\n`, "base warning"),
        commandResult(0, `${headCommit}\n`, "head warning"),
        commandResult(0, "", "diff warning"),
      ],
      calls,
    ),
  );

  assert.equal(result.warnings.length, 4);
  assert.match(result.warnings.join("\n"), /repository warning/);
  assert.match(result.warnings.join("\n"), /diff warning/);
});

test("reports invalid repository paths without invoking Git", () => {
  let invoked = false;
  const runner: GitCommandRunner = () => {
    invoked = true;
    return commandResult(0);
  };

  assert.throws(
    () =>
      discoverGitChangedFiles(
        {
          repositoryPath: join(tmpdir(), `missing-semantic-delta-${Date.now()}`),
          baseRef: "BASE",
          headRef: "HEAD",
        },
        runner,
      ),
    /Repository path does not exist/,
  );
  assert.equal(invoked, false);
});

test("reports non-repositories and invalid refs clearly", () => {
  assert.throws(
    () =>
      discoverGitChangedFiles(
        {
          repositoryPath: process.cwd(),
          baseRef: "BASE",
          headRef: "HEAD",
        },
        () => commandResult(128, "", "fatal: not a git repository"),
      ),
    (error: unknown) =>
      error instanceof GitDiscoveryError &&
      /Path is not a Git repository/.test(error.message) &&
      /fatal: not a git repository/.test(error.message),
  );

  const calls: string[][] = [];
  assert.throws(
    () =>
      discoverGitChangedFiles(
        {
          repositoryPath: process.cwd(),
          baseRef: "missing-ref",
          headRef: "HEAD",
        },
        queuedRunner(
          [
            commandResult(0, "true\n"),
            commandResult(128, "", "fatal: Needed a single revision"),
          ],
          calls,
        ),
      ),
    /Unknown base ref "missing-ref": fatal: Needed a single revision/,
  );
});

test("loads before and after contents using resolved refs and pair paths", () => {
  const calls: string[][] = [];
  const result = loadGitPairContent(
    {
      repositoryPath: "/repo path",
      baseRef: baseCommit,
      headRef: headCommit,
      pair: {
        beforePath: "models/old name.sql",
        afterPath: "models/new name.sql",
        displayPath: "models/old name.sql -> models/new name.sql",
      },
    },
    queuedRunner(
      [
        commandResult(0, "SELECT COUNT(*) FROM old_table\n"),
        commandResult(0, "SELECT COUNT(*) FROM new_table\n"),
      ],
      calls,
    ),
  );

  assert.deepEqual(calls[0], [
    "-C",
    "/repo path",
    "show",
    "--no-ext-diff",
    "--no-textconv",
    "--format=",
    `${baseCommit}:models/old name.sql`,
    "--",
  ]);
  assert.deepEqual(calls[1], [
    "-C",
    "/repo path",
    "show",
    "--no-ext-diff",
    "--no-textconv",
    "--format=",
    `${headCommit}:models/new name.sql`,
    "--",
  ]);
  assert.equal(result.beforeContent, "SELECT COUNT(*) FROM old_table\n");
  assert.equal(result.afterContent, "SELECT COUNT(*) FROM new_table\n");
  assert.deepEqual(result.failures, []);
});

const invalidContentLoaderRefs = [
  {
    name: "an option-like ref",
    baseRef: "-L1,2",
    headRef: headCommit,
  },
  {
    name: "a symbolic ref",
    baseRef: baseCommit,
    headRef: "HEAD",
  },
  {
    name: "a branch name",
    baseRef: "feature/local-git-mvp",
    headRef: headCommit,
  },
  {
    name: "a malformed hash",
    baseRef: "g".repeat(40),
    headRef: headCommit,
  },
  {
    name: "an abbreviated hash",
    baseRef: "a".repeat(12),
    headRef: headCommit,
  },
];

for (const invalidCase of invalidContentLoaderRefs) {
  test(`rejects ${invalidCase.name} before loading Git content`, () => {
    let gitCallCount = 0;
    let result: GitPairContentResult | undefined;
    const runner: GitCommandRunner = () => {
      gitCallCount += 1;
      return commandResult(0, "fake history or diff output");
    };

    assert.throws(
      () => {
        result = loadGitPairContent(
          {
            repositoryPath: process.cwd(),
            baseRef: invalidCase.baseRef as VerifiedGitCommitHash,
            headRef: invalidCase.headRef as VerifiedGitCommitHash,
            pair: {
              beforePath: "README.md",
              afterPath: "README.md",
              displayPath: "README.md",
            },
          },
          runner,
        );
      },
      (error: unknown) =>
        error instanceof GitDiscoveryError &&
        /requires a full 40- or 64-character hexadecimal commit hash/.test(error.message),
    );

    assert.equal(gitCallCount, 0);
    assert.equal(result, undefined);
  });
}

test("does not claim unavailable or non-text Git content exists", () => {
  const runner = queuedRunner(
    [
      commandResult(128, "", "fatal: path does not exist in base"),
      {
        status: 0,
        stdout: Buffer.from([0x53, 0x00, 0x51, 0x4c]),
        stderr: Buffer.alloc(0),
      },
    ],
    [],
  );

  const result = loadGitPairContent(
    {
      repositoryPath: process.cwd(),
      baseRef: baseCommit,
      headRef: headCommit,
      pair: {
        beforePath: "models/missing.sql",
        afterPath: "models/binary.sql",
        displayPath: "models/missing.sql -> models/binary.sql",
      },
    },
    runner,
  );

  assert.equal(result.beforeContent, undefined);
  assert.equal(result.afterContent, undefined);
  assert.equal(result.failures.length, 2);
  assert.match(result.failures[0].reason, /path does not exist in base/i);
  assert.match(result.failures[1].reason, /NUL bytes/i);
});

test("reports invalid UTF-8 content as a content-load failure", () => {
  const result = loadGitPairContent(
    {
      repositoryPath: process.cwd(),
      baseRef: baseCommit,
      headRef: headCommit,
      pair: {
        beforePath: "models/query.sql",
        afterPath: "models/query.sql",
        displayPath: "models/query.sql",
      },
    },
    queuedRunner(
      [
        {
          status: 0,
          stdout: Buffer.from([0xc3, 0x28]),
          stderr: Buffer.alloc(0),
        },
        commandResult(0, "SELECT COUNT(*) FROM users"),
      ],
      [],
    ),
  );

  assert.equal(result.beforeContent, undefined);
  assert.equal(result.afterContent, "SELECT COUNT(*) FROM users");
  assert.match(result.failures[0].reason, /not valid UTF-8/i);
});
