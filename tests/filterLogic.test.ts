import test from "node:test";
import assert from "node:assert/strict";
import { compareSqlQueries } from "../src/analyzer/differenceEngine.js";

test("AND to OR in WHERE is not treated as low risk", () => {
  const result = compareSqlQueries(
    "SELECT COUNT(*) FROM users WHERE is_paid AND is_active",
    "SELECT COUNT(*) FROM users WHERE is_paid OR is_active",
  );

  assert.notEqual(result.risk_level, "low");
  assert.ok(
    result.detected_differences.some(
      (difference) => difference.category === "filter_logic_mismatch",
    ),
  );
});

test("AND to OR explains broader population and changed filter logic", () => {
  const result = compareSqlQueries(
    "SELECT COUNT(*) FROM users WHERE is_paid AND is_active",
    "SELECT COUNT(*) FROM users WHERE is_paid OR is_active",
  );

  assert.ok(
    result.detected_differences.some(
      (difference) =>
        difference.category === "filter_logic_mismatch" &&
        /changed from AND to OR/i.test(difference.description) &&
        /population becomes broader/i.test(difference.description),
    ),
  );
  assert.match(result.recommendation, /changing AND to OR/i);
  assert.match(result.recommendation, /broadened/i);
  assert.match(result.explanation, /boolean filter logic changes the measured population/i);
});

test("OR to AND in WHERE is not treated as low risk and explains narrower population", () => {
  const result = compareSqlQueries(
    "SELECT COUNT(*) FROM users WHERE is_paid OR is_active",
    "SELECT COUNT(*) FROM users WHERE is_paid AND is_active",
  );

  assert.notEqual(result.risk_level, "low");
  assert.ok(
    result.detected_differences.some(
      (difference) =>
        difference.category === "filter_logic_mismatch" &&
        /changed from OR to AND/i.test(difference.description) &&
        /population becomes narrower/i.test(difference.description),
    ),
  );
  assert.match(result.recommendation, /changing OR to AND/i);
  assert.match(result.recommendation, /narrowed/i);
});

test("three-condition AND to OR is not treated as low risk and mentions population change", () => {
  const result = compareSqlQueries(
    "SELECT COUNT(*) FROM users WHERE is_paid AND is_active AND country = 'DE'",
    "SELECT COUNT(*) FROM users WHERE is_paid OR is_active OR country = 'DE'",
  );

  assert.notEqual(result.risk_level, "low");
  assert.ok(
    result.detected_differences.some(
      (difference) =>
        difference.category === "filter_logic_mismatch" &&
        /changed from AND to OR/i.test(difference.description) &&
        /population becomes broader/i.test(difference.description),
    ),
  );
});

test("AND-only to mixed AND/OR is not treated as low risk", () => {
  const result = compareSqlQueries(
    "SELECT COUNT(*) FROM users WHERE is_paid AND is_active AND country = 'DE'",
    "SELECT COUNT(*) FROM users WHERE is_paid AND is_active OR country = 'DE'",
  );

  assert.notEqual(result.risk_level, "low");
  assert.ok(
    result.detected_differences.some(
      (difference) =>
        difference.category === "filter_logic_mismatch" &&
        /boolean operator structure changed/i.test(difference.description),
    ),
  );
});

test("OR-only to mixed AND/OR is not treated as low risk", () => {
  const result = compareSqlQueries(
    "SELECT COUNT(*) FROM users WHERE is_paid OR is_active OR country = 'DE'",
    "SELECT COUNT(*) FROM users WHERE is_paid OR is_active AND country = 'DE'",
  );

  assert.notEqual(result.risk_level, "low");
  assert.ok(
    result.detected_differences.some(
      (difference) =>
        difference.category === "filter_logic_mismatch" &&
        /boolean operator structure changed/i.test(difference.description),
    ),
  );
});

test("boolean operator changes are detected regardless of keyword casing", () => {
  const result = compareSqlQueries(
    "SELECT COUNT(*) FROM users WHERE is_paid and is_active",
    "SELECT COUNT(*) FROM users WHERE is_paid Or is_active",
  );

  assert.notEqual(result.risk_level, "low");
  assert.ok(
    result.detected_differences.some(
      (difference) => difference.category === "filter_logic_mismatch",
    ),
  );
});

test("formatting-only changes with unchanged boolean operators stay low risk", () => {
  const result = compareSqlQueries(
    "SELECT COUNT(*) FROM users WHERE is_paid AND is_active",
    `SELECT COUNT(*)
FROM users
WHERE is_paid
  and is_active`,
  );

  assert.equal(result.risk_level, "low");
  assert.equal(result.detected_differences.length, 0);
  assert.ok(result.semantic_similarity_score >= 90);
});
