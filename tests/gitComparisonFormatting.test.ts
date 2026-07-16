import assert from "node:assert/strict";
import test from "node:test";
import { compareSqlQueries } from "../src/analyzer/differenceEngine.js";
import type { GitComparisonResult } from "../src/gitComparison.js";
import {
  formatGitComparisonPrComment,
  formatGitComparisonReport,
} from "../src/output/formatGitComparison.js";

function buildResult(): GitComparisonResult {
  const lowResult = compareSqlQueries(
    "SELECT COUNT(*) FROM users WHERE country = 'DE'",
    "SELECT  COUNT(*) FROM users WHERE country = 'DE'",
  );
  const highResult = compareSqlQueries(
    "SELECT COUNT(DISTINCT user_id) FROM events WHERE event = 'login' AND CASE WHEN active THEN 1 ELSE 0 END = 1",
    "SELECT COUNT(*) FROM events WHERE event = 'login' AND CASE WHEN active THEN 1 ELSE 0 END = 1",
  );

  return {
    repositoryPath: "/tmp/example repo",
    baseRef: "origin/main",
    headRef: "HEAD",
    resolvedBaseRef: "a".repeat(40),
    resolvedHeadRef: "b".repeat(40),
    analyzed: [
      {
        path: "models/low.sql",
        displayPath: "models/low.sql",
        beforePath: "models/low.sql",
        afterPath: "models/low.sql",
        result: lowResult,
      },
      {
        path: "models/new_name.sql",
        displayPath: "models/old_name.sql -> models/new_name.sql",
        beforePath: "models/old_name.sql",
        afterPath: "models/new_name.sql",
        result: highResult,
      },
    ],
    skipped: [
      {
        stage: "pairing",
        path: "models/new.sql",
        reason: "skipped because no before version exists",
      },
      {
        stage: "path-filter",
        path: "docs/example.sql",
        reason: "excluded by ignore pattern: docs/**",
      },
    ],
    warnings: ["Git diff produced stderr: example warning"],
    summary: {
      discoveredCount: 4,
      analyzedCount: 2,
      skippedCount: 2,
      highestSeverity: "high",
    },
  };
}

test("formats a concise readable multi-file Git report", () => {
  const report = formatGitComparisonReport(buildResult());

  assert.match(report, /^# Semantic Delta Git Comparison/);
  assert.match(report, /- Highest risk: HIGH/);
  assert.match(report, /- Changed files discovered: 4/);
  assert.match(report, /- Files analyzed: 2/);
  assert.match(report, /### models\/low\.sql — LOW/);
  assert.match(
    report,
    /### models\/old_name\.sql -> models\/new_name\.sql — HIGH/,
  );
  assert.match(report, /Analysis limits:/);
  assert.match(report, /CASE expression/);
  assert.match(
    report,
    /\[pairing\] models\/new\.sql — skipped because no before version exists/,
  );
  assert.match(report, /## Git Warnings/);
  assert.match(report, /- Base: origin\/main/);
  assert.match(report, /- Head: HEAD/);
  assert.doesNotMatch(report, /```sql/);
});

test("formats high-risk findings before low-risk findings in PR output", () => {
  const comment = formatGitComparisonPrComment(buildResult());
  const highIndex = comment.indexOf("models/old_name.sql -> models/new_name.sql");
  const lowIndex = comment.indexOf("models/low.sql");

  assert.match(comment, /^🔴 HIGH RISK — 2 analyzed, 2 skipped/);
  assert.ok(highIndex >= 0 && lowIndex >= 0 && highIndex < lowIndex);
  assert.match(comment, /Skipped: 2/);
  assert.match(comment, /Stages: path-filter: 1, pairing: 1/);
  assert.match(comment, /Refs: origin\/main → HEAD/);
  assert.match(comment, /Git warnings: 1/);
  assert.ok(comment.split("\n").length < 25);
});

test("formats a calm report when no files are comparable", () => {
  const result: GitComparisonResult = {
    repositoryPath: "/tmp/repo",
    baseRef: "BASE",
    headRef: "HEAD",
    resolvedBaseRef: "a".repeat(40),
    resolvedHeadRef: "b".repeat(40),
    analyzed: [],
    skipped: [
      {
        stage: "pairing",
        path: "models/new.sql",
        reason: "skipped because no before version exists",
      },
    ],
    warnings: [],
    summary: {
      discoveredCount: 1,
      analyzedCount: 0,
      skippedCount: 1,
      highestSeverity: "low",
    },
  };

  const report = formatGitComparisonReport(result);
  const comment = formatGitComparisonPrComment(result);

  assert.match(report, /No comparable files were analyzed\. No semantic gate was applied\./);
  assert.match(comment, /^🟢 LOW RISK — 0 analyzed, 1 skipped/);
  assert.match(comment, /No comparable files were analyzed/);
  assert.doesNotMatch(comment, /alters the meaning/i);
});

test("distinguishes no changed files from non-comparable changed files", () => {
  const result: GitComparisonResult = {
    repositoryPath: "/tmp/repo",
    baseRef: "HEAD",
    headRef: "HEAD",
    resolvedBaseRef: "a".repeat(40),
    resolvedHeadRef: "a".repeat(40),
    analyzed: [],
    skipped: [],
    warnings: [],
    summary: {
      discoveredCount: 0,
      analyzedCount: 0,
      skippedCount: 0,
      highestSeverity: "low",
    },
  };

  const comment = formatGitComparisonPrComment(result);

  assert.match(comment, /No changed files were discovered between these refs\./);
  assert.doesNotMatch(comment, /Skipped changes are listed below/);
});
