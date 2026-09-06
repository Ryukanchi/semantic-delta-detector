import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getHighestSeverity,
  parseFailOnThreshold,
  SeverityThreshold,
  shouldFailForRisk,
} from "../src/ciGating.js";

test("CI severity gating compares risks against thresholds", () => {
  assert.equal(shouldFailForRisk("high", "high"), true);
  assert.equal(shouldFailForRisk("medium", "high"), false);
  assert.equal(shouldFailForRisk("low", "medium"), false);
  assert.equal(shouldFailForRisk("critical", "high"), true);
  assert.equal(parseFailOnThreshold("HIGH"), "high");
  assert.throws(
    () => parseFailOnThreshold("critical"),
    /Invalid --fail-on value "critical"\. Supported values: low, medium, high\./,
  );
  assert.throws(
    () => parseFailOnThreshold("urgent"),
    /Invalid --fail-on value "urgent"\. Supported values: low, medium, high\./,
  );

  const criticalRepresentation: SeverityThreshold = "critical";
  assert.equal(criticalRepresentation, "critical");
});

test("CI severity helpers return the highest discovered severity", () => {
  assert.equal(getHighestSeverity([]), "low");
  assert.equal(getHighestSeverity(["low", "medium", "high", "medium"]), "high");
  assert.equal(getHighestSeverity(["low", "medium"]), "medium");
});

test("CLI --fail-on exits non-zero only at or above the configured threshold", () => {
  const highThreshold = spawnSync(
    "npm",
    [
      "run",
      "compare",
      "--",
      "--before",
      "./examples/pr-before.sql",
      "--after",
      "./examples/pr-after.sql",
      "--pr",
      "--fail-on",
      "high",
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
    },
  );

  assert.equal(highThreshold.status, 1);
  assert.match(highThreshold.stdout, /🔴 HIGH RISK/);

  const criticalThreshold = spawnSync(
    "npm",
    [
      "run",
      "compare",
      "--",
      "--before",
      "./examples/pr-before.sql",
      "--after",
      "./examples/pr-after.sql",
      "--pr",
      "--fail-on",
      "critical",
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
    },
  );

  assert.equal(criticalThreshold.status, 2);
  assert.match(
    criticalThreshold.stderr,
    /Invalid --fail-on value "critical"\. Supported values: low, medium, high\./,
  );
});

test("CLI --fail-on reports invalid thresholds clearly with operational exit code 2", () => {
  const result = spawnSync(
    "npm",
    [
      "run",
      "compare",
      "--",
      "--before",
      "./examples/pr-before.sql",
      "--after",
      "./examples/pr-after.sql",
      "--pr",
      "--fail-on",
      "urgent",
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 2);
  assert.match(
    result.stderr,
    /Invalid --fail-on value "urgent"\. Supported values: low, medium, high\./,
  );
});

test("CLI --fail-on high triggers exit code 1 on MRR token gate removal", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "sd-ci-mrr-"));
  const beforePath = join(tempDir, "before.sql");
  const afterPath = join(tempDir, "after.sql");

  try {
    writeFileSync(beforePath, "SELECT COUNT(*) FROM users WHERE mrr_usd > 0;");
    writeFileSync(afterPath, "SELECT COUNT(*) FROM users;");

    const mrrGate = spawnSync(
      "node",
      [
        "--import",
        "tsx",
        "src/cli.ts",
        "--before",
        beforePath,
        "--after",
        afterPath,
        "--fail-on",
        "high",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    assert.equal(mrrGate.status, 1);
    assert.match(mrrGate.stdout, /HIGH RISK/);

    // Negative case: carrier_id dropped is medium risk, does not trigger high gate
    writeFileSync(beforePath, "SELECT COUNT(*) FROM shipments WHERE carrier_id = 5;");
    writeFileSync(afterPath, "SELECT COUNT(*) FROM shipments;");

    const carrierGate = spawnSync(
      "node",
      [
        "--import",
        "tsx",
        "src/cli.ts",
        "--before",
        beforePath,
        "--after",
        afterPath,
        "--fail-on",
        "high",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    assert.equal(carrierGate.status, 0);
    assert.match(carrierGate.stdout, /MEDIUM RISK/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
