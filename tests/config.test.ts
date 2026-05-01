import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

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
