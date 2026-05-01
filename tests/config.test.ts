import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { loadSemanticDeltaConfig } from "../src/config.js";

const repoRoot = process.cwd();
const cliPath = join(repoRoot, "src", "cli.ts");
const tsxBinPath = join(repoRoot, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
const prBeforePath = join(repoRoot, "examples", "pr-before.sql");
const prAfterPath = join(repoRoot, "examples", "pr-after.sql");

function withTempDir<T>(callback: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "sdd-"));

  try {
    return callback(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("missing semantic-delta.yml does not enable CI gating", () => {
  withTempDir((dir) => {
    const result = spawnSync(
      tsxBinPath,
      [cliPath, "--before", prBeforePath, "--after", prAfterPath, "--pr"],
      {
        cwd: dir,
        encoding: "utf8",
      },
    );

    assert.equal(result.status, 0);
    assert.match(result.stdout, /🔴 HIGH RISK/);
  });
});

test("semantic-delta.yml default before and after paths are loaded", () => {
  withTempDir((dir) => {
    writeFileSync(
      join(dir, "semantic-delta.yml"),
      [
        "fail_on: high",
        "default_before_path: ./examples/pr-before.sql",
        "default_after_path: './examples/pr-after.sql'",
        "",
      ].join("\n"),
      "utf8",
    );

    const config = loadSemanticDeltaConfig(dir);

    assert.equal(config.failOn, "high");
    assert.equal(config.defaultBeforePath, "./examples/pr-before.sql");
    assert.equal(config.defaultAfterPath, "./examples/pr-after.sql");
  });
});

test("semantic-delta.yml fail_on high enables CI gating", () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, "semantic-delta.yml"), "fail_on: high\n", "utf8");

    const result = spawnSync(
      tsxBinPath,
      [cliPath, "--before", prBeforePath, "--after", prAfterPath, "--pr"],
      {
        cwd: dir,
        encoding: "utf8",
      },
    );

    assert.equal(result.status, 1);
    assert.match(result.stdout, /🔴 HIGH RISK/);
  });
});

test("semantic-delta.yml default paths are used when CLI paths are omitted", () => {
  withTempDir((dir) => {
    writeFileSync(
      join(dir, "semantic-delta.yml"),
      [
        "default_before_path: ./before.sql",
        "default_after_path: ./after.sql",
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      join(dir, "before.sql"),
      "SELECT COUNT(DISTINCT user_id) FROM events WHERE event = 'login'",
      "utf8",
    );
    writeFileSync(
      join(dir, "after.sql"),
      "SELECT COUNT(*) FROM events WHERE event = 'login'",
      "utf8",
    );

    const result = spawnSync(tsxBinPath, [cliPath, "--pr"], {
      cwd: dir,
      encoding: "utf8",
    });

    assert.equal(result.status, 0);
    assert.match(result.stdout, /🔴 HIGH RISK/);
    assert.match(result.stdout, /Aggregation changed from COUNT\(DISTINCT user_id\) to COUNT\(\*\)\./);
  });
});

test("CLI before and after paths override semantic-delta.yml defaults", () => {
  withTempDir((dir) => {
    writeFileSync(
      join(dir, "semantic-delta.yml"),
      [
        "default_before_path: ./before.sql",
        "default_after_path: ./after.sql",
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      join(dir, "before.sql"),
      "SELECT COUNT(*) FROM users WHERE country = 'DE'",
      "utf8",
    );
    writeFileSync(
      join(dir, "after.sql"),
      "SELECT COUNT(*) FROM users WHERE country = 'DE'",
      "utf8",
    );

    const result = spawnSync(
      tsxBinPath,
      [cliPath, "--before", prBeforePath, "--after", prAfterPath, "--pr"],
      {
        cwd: dir,
        encoding: "utf8",
      },
    );

    assert.equal(result.status, 0);
    assert.match(result.stdout, /🔴 HIGH RISK/);
    assert.match(result.stdout, /Aggregation changed from COUNT\(DISTINCT user_id\) to COUNT\(\*\)\./);
  });
});

test("CLI --fail-on overrides semantic-delta.yml fail_on", () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, "semantic-delta.yml"), "fail_on: high\n", "utf8");

    const result = spawnSync(
      tsxBinPath,
      [
        cliPath,
        "--before",
        prBeforePath,
        "--after",
        prAfterPath,
        "--pr",
        "--fail-on",
        "critical",
      ],
      {
        cwd: dir,
        encoding: "utf8",
      },
    );

    assert.equal(result.status, 0);
    assert.match(result.stdout, /🔴 HIGH RISK/);
  });
});

test("CLI example ignores semantic-delta.yml default paths", () => {
  withTempDir((dir) => {
    writeFileSync(
      join(dir, "semantic-delta.yml"),
      [
        "fail_on: high",
        "default_before_path: ./missing-before.sql",
        "default_after_path: ./missing-after.sql",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = spawnSync(
      tsxBinPath,
      [cliPath, "--example", "same-de-users-formatting", "--pr"],
      {
        cwd: dir,
        encoding: "utf8",
      },
    );

    assert.equal(result.status, 0);
    assert.match(result.stdout, /🟢 LOW RISK/);
    assert.match(result.stdout, /No meaningful semantic change detected\./);
  });
});

test("invalid semantic-delta.yml fail_on reports a clear error", () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, "semantic-delta.yml"), "fail_on: urgent\n", "utf8");

    const result = spawnSync(
      tsxBinPath,
      [cliPath, "--before", prBeforePath, "--after", prAfterPath, "--pr"],
      {
        cwd: dir,
        encoding: "utf8",
      },
    );

    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /Invalid semantic-delta\.yml fail_on value "urgent". Supported values: low, medium, high, critical\./,
    );
  });
});
