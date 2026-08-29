import assert from "node:assert/strict";
import test from "node:test";
import {
  compareMetricDefinitions,
  compareSqlQueries,
} from "../src/core.js";

test("compareSqlQueries rejects empty and whitespace-only SQL", () => {
  for (const [queryA, queryB] of [
    ["", ""],
    ["   ", "\n\t"],
    ["\n", "SELECT 1"],
    ["SELECT 1", "\t   "],
  ] as const) {
    const invalidSide = queryA.trim().length === 0 ? "A" : "B";
    assert.throws(
      () => compareSqlQueries(queryA, queryB),
      new RegExp(`Query ${invalidSide} SQL input must contain analyzable content\\.`),
    );
  }
});

test("compareMetricDefinitions rejects empty SQL consistently", () => {
  assert.throws(
    () =>
      compareMetricDefinitions(
        { query: "", metric_name: "empty_a" },
        { query: "SELECT 1", metric_name: "valid_b" },
      ),
    /Query A SQL input must contain analyzable content\./,
  );
  assert.throws(
    () =>
      compareMetricDefinitions(
        { query: "SELECT 1", metric_name: "valid_a" },
        { query: "\n\t ", metric_name: "empty_b" },
      ),
    /Query B SQL input must contain analyzable content\./,
  );
});

test("public comparison APIs reject comment-only SQL", () => {
  for (const commentOnlySql of [
    "-- nothing here",
    "/* nothing here */",
    " \n -- first comment\n /* second comment */ \n ",
  ]) {
    assert.throws(
      () => compareSqlQueries(commentOnlySql, "SELECT 1"),
      /Query A SQL input must contain analyzable content\./,
    );
    assert.throws(
      () =>
        compareMetricDefinitions(
          { query: "SELECT 1" },
          { query: commentOnlySql },
        ),
      /Query B SQL input must contain analyzable content\./,
    );
  }
});

test("minimal valid SQL remains analyzable", () => {
  const directResult = compareSqlQueries("SELECT 1", "SELECT 1");
  const metricResult = compareMetricDefinitions(
    { query: "SELECT 1", metric_name: "constant_a" },
    { query: "SELECT 1", metric_name: "constant_b" },
  );

  assert.equal(directResult.risk_level, "low");
  assert.equal(metricResult.risk_level, "low");
});
