import assert from "node:assert/strict";
import test from "node:test";
import { compareSqlQueries } from "../src/core.js";

test("different nested AND/OR grouping is a structural population change", () => {
  const result = compareSqlQueries(
    `SELECT COUNT(*) FROM users
     WHERE country = 'DE' AND (plan = 'pro' OR plan = 'enterprise')`,
    `SELECT COUNT(*) FROM users
     WHERE (country = 'DE' AND plan = 'pro') OR plan = 'enterprise'`,
  );

  assert.equal(result.risk_level, "high");
  assert.ok(
    result.detected_differences.some(
      (difference) =>
        difference.category === "filter_logic_mismatch" &&
        /grouping/i.test(difference.description) &&
        /AND\/OR/i.test(difference.description),
    ),
  );
});

test("adding NOT is an explicit high-risk filter-logic change", () => {
  const result = compareSqlQueries(
    "SELECT COUNT(*) FROM users WHERE active = true AND country = 'DE'",
    "SELECT COUNT(*) FROM users WHERE NOT (active = true AND country = 'DE')",
  );

  assert.equal(result.risk_level, "high");
  assert.ok(
    result.detected_differences.some(
      (difference) =>
        difference.category === "filter_logic_mismatch" &&
        /negation/i.test(difference.description),
    ),
  );
});

test("double negation is treated as equivalent", () => {
  const result = compareSqlQueries(
    "SELECT COUNT(*) FROM users WHERE active = true",
    "SELECT COUNT(*) FROM users WHERE NOT NOT active = true",
  );

  assert.equal(result.risk_level, "low");
  assert.equal(result.detected_differences.length, 0);
});

test("reordering predicates within an AND group is equivalent", () => {
  const result = compareSqlQueries(
    "SELECT COUNT(*) FROM users WHERE active = true AND country = 'DE' AND plan = 'pro'",
    "SELECT COUNT(*) FROM users WHERE plan = 'pro' AND active = true AND country = 'DE'",
  );

  assert.equal(result.risk_level, "low");
  assert.equal(result.detected_differences.length, 0);
});

test("nested NOT changes remain visible across multiple levels", () => {
  const result = compareSqlQueries(
    "SELECT COUNT(*) FROM users WHERE active = true AND (country = 'DE' OR plan = 'pro')",
    "SELECT COUNT(*) FROM users WHERE active = true AND NOT (country = 'DE' OR plan = 'pro')",
  );

  assert.equal(result.risk_level, "high");
  assert.ok(
    result.detected_differences.some(
      (difference) => difference.category === "filter_logic_mismatch",
    ),
  );
});

test("identical complex boolean logic stays low risk", () => {
  const sql = `SELECT COUNT(*) FROM users
    WHERE active = true AND (country = 'DE' OR (plan = 'pro' AND verified = true))`;
  const result = compareSqlQueries(sql, sql);

  assert.equal(result.risk_level, "low");
  assert.equal(result.detected_differences.length, 0);
});
