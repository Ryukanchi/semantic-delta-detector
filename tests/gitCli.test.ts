import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const projectRoot = process.cwd();
const cliPath = join(projectRoot, "src", "cli.ts");
const tsxPath = join(
  projectRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tsx.cmd" : "tsx",
);

interface GitFixture {
  repositoryPath: string;
  baseRef: string;
  headRef: string;
}

function runGit(repositoryPath: string, args: string[]): string {
  const result = spawnSync("git", ["-C", repositoryPath, ...args], {
    encoding: "utf8",
    shell: false,
  });
  assert.equal(
    result.status,
    0,
    `Git command failed (${args.join(" ")}): ${result.stderr || result.error?.message}`,
  );
  return result.stdout.trim();
}

function writeFixtureFile(repositoryPath: string, path: string, contents: string): void {
  const fullPath = join(repositoryPath, path);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, contents, "utf8");
}

function createGitFixture(kind: "high" | "low" | "only-added" = "high"): GitFixture {
  const repositoryPath = mkdtempSync(join(tmpdir(), "semantic-delta-cli-"));
  runGit(repositoryPath, ["init"]);
  runGit(repositoryPath, ["config", "user.name", "Semantic Delta CLI Test"]);
  runGit(repositoryPath, ["config", "user.email", "semantic-delta@example.test"]);

  writeFixtureFile(repositoryPath, "README.md", "fixture\n");
  if (kind !== "only-added") {
    writeFixtureFile(
      repositoryPath,
      "models/metric.sql",
      "SELECT COUNT(DISTINCT user_id) FROM events WHERE event = 'login'\n",
    );
    writeFixtureFile(repositoryPath, "docs/example.sql", "SELECT 1\n");
  }
  runGit(repositoryPath, ["add", "--", "."]);
  runGit(repositoryPath, ["commit", "-m", "base"]);
  const baseRef = runGit(repositoryPath, ["rev-parse", "HEAD"]);

  if (kind === "high") {
    writeFixtureFile(
      repositoryPath,
      "models/metric.sql",
      "SELECT COUNT(*) FROM events WHERE event = 'login'\n",
    );
    writeFixtureFile(repositoryPath, "models/new.sql", "SELECT COUNT(*) FROM users\n");
    writeFixtureFile(repositoryPath, "docs/example.sql", "SELECT 2\n");
  } else if (kind === "low") {
    writeFixtureFile(
      repositoryPath,
      "models/metric.sql",
      "SELECT  COUNT(DISTINCT user_id)  FROM events WHERE event = 'login'\n",
    );
  } else {
    writeFixtureFile(repositoryPath, "models/new.sql", "SELECT COUNT(*) FROM users\n");
  }
  runGit(repositoryPath, ["add", "--", "."]);
  runGit(repositoryPath, ["commit", "-m", "head"]);
  const headRef = runGit(repositoryPath, ["rev-parse", "HEAD"]);

  writeFixtureFile(
    repositoryPath,
    "semantic-delta.yml",
    ["include:", "  - models/**", "ignore:", "  - docs/**", ""].join("\n"),
  );

  return { repositoryPath, baseRef, headRef };
}

function runCli(
  args: string[],
  cwd = projectRoot,
): SpawnSyncReturns<string> {
  return spawnSync(tsxPath, [cliPath, ...args], {
    cwd,
    encoding: "utf8",
    shell: false,
  });
}

function withFixture(
  callback: (fixture: GitFixture) => void,
  kind: "high" | "low" | "only-added" = "high",
): void {
  const fixture = createGitFixture(kind);
  try {
    callback(fixture);
  } finally {
    rmSync(fixture.repositoryPath, { recursive: true, force: true });
  }
}

test("Git CLI compares configured paths and defaults changed-to to HEAD", () => {
  withFixture(({ repositoryPath, baseRef }) => {
    const result = runCli([
      "--changed-from",
      baseRef,
      "--repo",
      repositoryPath,
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^# Semantic Delta Git Comparison/);
    assert.match(result.stdout, /- Highest risk: HIGH/);
    assert.match(result.stdout, /- Changed files discovered: 3/);
    assert.match(result.stdout, /- Files analyzed: 1/);
    assert.match(result.stdout, /- Files skipped: 2/);
    assert.match(result.stdout, /\[path-filter\] docs\/example\.sql/);
    assert.match(result.stdout, /\[pairing\] models\/new\.sql/);
    assert.match(result.stdout, /- Head: HEAD/);
  });
});

test("Git CLI supports concise PR-style output", () => {
  withFixture(({ repositoryPath, baseRef, headRef }) => {
    const result = runCli([
      "--changed-from",
      baseRef,
      "--changed-to",
      headRef,
      "--repo",
      repositoryPath,
      "--pr",
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^🔴 HIGH RISK — 1 analyzed, 2 skipped/);
    assert.match(result.stdout, /models\/metric\.sql — HIGH/);
    assert.match(result.stdout, /Stages: path-filter: 1, pairing: 1/);
    assert.doesNotMatch(result.stdout, /```sql/);
  });
});

test("Git CLI emits structured JSON with complete accounting", () => {
  withFixture(({ repositoryPath, baseRef, headRef }) => {
    const result = runCli([
      "--changed-from",
      baseRef,
      "--changed-to",
      headRef,
      "--repo",
      repositoryPath,
      "--format",
      "json",
    ]);

    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout) as {
      analyzed: unknown[];
      skipped: Array<{ stage: string }>;
      summary: {
        discoveredCount: number;
        analyzedCount: number;
        skippedCount: number;
        highestSeverity: string;
      };
    };
    assert.deepEqual(parsed.summary, {
      discoveredCount: 3,
      analyzedCount: 1,
      skippedCount: 2,
      highestSeverity: "high",
    });
    assert.equal(parsed.analyzed.length, 1);
    assert.deepEqual(
      parsed.skipped.map((item) => item.stage),
      ["path-filter", "pairing"],
    );
  });
});

test("Git CLI gates against the highest analyzed severity", () => {
  withFixture(({ repositoryPath, baseRef }) => {
    const highGate = runCli([
      "--changed-from",
      baseRef,
      "--repo",
      repositoryPath,
      "--fail-on",
      "high",
      "--pr",
    ]);
    const criticalGate = runCli([
      "--changed-from",
      baseRef,
      "--repo",
      repositoryPath,
      "--fail-on",
      "critical",
      "--pr",
    ]);

    assert.equal(highGate.status, 1);
    assert.match(highGate.stdout, /^🔴 HIGH RISK/);
    assert.equal(criticalGate.status, 0, criticalGate.stderr);
  });
});

test("Git CLI lets CLI fail-on override repository config", () => {
  withFixture(({ repositoryPath, baseRef }) => {
    writeFixtureFile(
      repositoryPath,
      "semantic-delta.yml",
      [
        "fail_on: high",
        "include:",
        "  - models/**",
        "ignore:",
        "  - docs/**",
        "",
      ].join("\n"),
    );
    const configuredGate = runCli([
      "--changed-from",
      baseRef,
      "--repo",
      repositoryPath,
      "--pr",
    ]);
    const cliOverride = runCli([
      "--changed-from",
      baseRef,
      "--repo",
      repositoryPath,
      "--pr",
      "--fail-on",
      "critical",
    ]);

    assert.equal(configuredGate.status, 1);
    assert.equal(cliOverride.status, 0, cliOverride.stderr);
  });
});

test("Git CLI keeps all-low comparisons below a high gate", () => {
  withFixture(({ repositoryPath, baseRef }) => {
    const result = runCli([
      "--changed-from",
      baseRef,
      "--repo",
      repositoryPath,
      "--fail-on",
      "high",
      "--pr",
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^🟢 LOW RISK — 1 analyzed, 0 skipped/);
  }, "low");
});

test("Git CLI does not fail semantic gating when no file is comparable", () => {
  withFixture(({ repositoryPath, baseRef }) => {
    const result = runCli([
      "--changed-from",
      baseRef,
      "--repo",
      repositoryPath,
      "--fail-on",
      "low",
      "--pr",
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^🟢 LOW RISK — 0 analyzed, 1 skipped/);
    assert.match(result.stdout, /No comparable files were analyzed/);
  }, "only-added");
});

test("Git CLI reports invalid refs as operational errors", () => {
  withFixture(({ repositoryPath, baseRef }) => {
    const invalidBase = runCli([
      "--changed-from",
      "missing-ref",
      "--repo",
      repositoryPath,
    ]);
    const invalidHead = runCli([
      "--changed-from",
      baseRef,
      "--changed-to",
      "missing-head",
      "--repo",
      repositoryPath,
    ]);

    assert.equal(invalidBase.status, 1);
    assert.equal(invalidBase.stdout, "");
    assert.match(invalidBase.stderr, /Error: Unknown base ref "missing-ref"/);
    assert.match(invalidBase.stderr, /Needed a single revision|unknown revision/i);
    assert.doesNotMatch(invalidBase.stderr, /GitDiscoveryError|at discoverGitChangedFiles/);
    assert.equal(invalidHead.status, 1);
    assert.match(invalidHead.stderr, /Error: Unknown head ref "missing-head"/);
  });
});

test("Git CLI reports identical refs as a calm no-change result", () => {
  withFixture(({ repositoryPath, headRef }) => {
    const result = runCli([
      "--changed-from",
      headRef,
      "--changed-to",
      headRef,
      "--repo",
      repositoryPath,
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /- Changed files discovered: 0/);
    assert.match(result.stdout, /- Files analyzed: 0/);
    assert.match(result.stdout, /No comparable files were analyzed/);
  });
});

test("Git CLI rejects missing base refs and conflicting modes", () => {
  const missingBase = runCli(["--changed-to", "HEAD"]);
  const conflict = runCli([
    "--changed-from",
    "HEAD~1",
    "--example",
    "same-de-users-formatting",
  ]);

  assert.equal(missingBase.status, 1);
  assert.match(missingBase.stderr, /requires --changed-from/);
  assert.equal(conflict.status, 1);
  assert.match(conflict.stderr, /cannot be combined/);
});

test("CLI help documents local Git mode honestly", () => {
  const result = runCli(["--help"]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--changed-from/);
  assert.match(result.stdout, /--changed-to/);
  assert.match(result.stdout, /--repo/);
  assert.match(result.stdout, /nothing is posted/);
});
