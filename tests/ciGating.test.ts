import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { parseFailOnThreshold, shouldFailForRisk } from "../src/ciGating.js";

test("CI severity gating compares risks against thresholds", () => {
  assert.equal(shouldFailForRisk("high", "high"), true);
  assert.equal(shouldFailForRisk("medium", "high"), false);
  assert.equal(shouldFailForRisk("high", "critical"), false);
  assert.equal(shouldFailForRisk("critical", "high"), true);
  assert.equal(parseFailOnThreshold("HIGH"), "high");
  assert.throws(
    () => parseFailOnThreshold("urgent"),
    /Invalid --fail-on value "urgent". Supported values: low, medium, high, critical\./,
  );
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

  assert.equal(criticalThreshold.status, 0);
  assert.match(criticalThreshold.stdout, /🔴 HIGH RISK/);
});

test("CLI --fail-on reports invalid thresholds clearly", () => {
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

  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /Invalid --fail-on value "urgent". Supported values: low, medium, high, critical\./,
  );
});
