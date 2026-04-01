import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { compareMetricDefinitions } from "../src/analyzer/differenceEngine.js";
import { fixtures } from "./fixtures.js";

test("happy path returns strong similarity for equivalent queries", () => {
  const result = compareMetricDefinitions(fixtures.happyPath.inputA, fixtures.happyPath.inputB);

  assert.equal(result.risk_level, "low");
  assert.ok(result.semantic_similarity_score >= 90);
  assert.equal(result.detected_differences.length, 0);
  assert.equal(result.confidence_level, "low");
  assert.deepEqual(result.evidence_sources, ["sql_only"]);
});

test("semantic mismatch flags engagement vs monetization clearly", () => {
  const result = compareMetricDefinitions(
    fixtures.semanticMismatch.inputA,
    fixtures.semanticMismatch.inputB,
  );

  assert.equal(result.risk_level, "high");
  assert.ok(result.semantic_similarity_score < 45);
  assert.ok(
    result.detected_differences.some(
      (difference) => difference.category === "monetization_mismatch",
    ),
  );
  assert.ok(
    result.detected_differences.some(
      (difference) => difference.category === "metric_intent_mismatch",
    ),
  );
});

test("alias-only differences do not create fake metric or aggregation mismatches", () => {
  const result = compareMetricDefinitions(
    fixtures.aliasEdgeCase.inputA,
    fixtures.aliasEdgeCase.inputB,
  );

  assert.equal(result.metric_name_a, "users_metric");
  assert.equal(result.metric_name_b, "users_metric");
  assert.ok(
    !result.detected_differences.some(
      (difference) => difference.category === "aggregation_mismatch",
    ),
  );
  assert.equal(result.risk_level, "low");
});

test("metadata raises confidence when naming and context confirm divergence", () => {
  const result = compareMetricDefinitions(
    fixtures.metadataMismatch.inputA,
    fixtures.metadataMismatch.inputB,
  );

  assert.equal(result.metric_name_a, "active_users");
  assert.equal(result.metric_name_b, "active_users");
  assert.equal(result.confidence_level, "high");
  assert.ok(result.evidence_sources.includes("metric_name"));
  assert.ok(result.evidence_sources.includes("description"));
  assert.ok(result.evidence_sources.includes("team_context"));
  assert.ok(result.evidence_sources.includes("intended_use"));
  assert.ok(
    result.detected_differences.some(
      (difference) => difference.category === "naming_alignment_mismatch",
    ),
  );
});

test("partial metadata is called out accurately in the explanation", () => {
  const result = compareMetricDefinitions(
    fixtures.partialMetadata.inputA,
    fixtures.partialMetadata.inputB,
  );

  assert.equal(result.confidence_level, "high");
  assert.ok(result.evidence_sources.includes("metric_name"));
  assert.ok(result.evidence_sources.includes("description"));
  assert.match(result.explanation, /Partial metadata was available\./);
  assert.match(result.explanation, /Available on only one side: team context, intended use\./);
});

test("cli reports friendly validation errors for malformed json metadata", () => {
  const dir = mkdtempSync(join(tmpdir(), "sdd-"));
  const badAPath = join(dir, "bad-a.json");
  const badBPath = join(dir, "bad-b.json");

  writeFileSync(
    badAPath,
    JSON.stringify({ metric_name: 123, query: "SELECT COUNT(*) FROM users" }),
    "utf8",
  );
  writeFileSync(
    badBPath,
    JSON.stringify({ query: "SELECT COUNT(*) FROM users" }),
    "utf8",
  );

  assert.throws(
    () =>
      execFileSync(
        "corepack",
        [
          "pnpm",
          "compare",
          "--json-a",
          badAPath,
          "--json-b",
          badBPath,
          "--format",
          "json",
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          stdio: "pipe",
        },
      ),
    /field "metric_name" must be a string if provided/,
  );
});
