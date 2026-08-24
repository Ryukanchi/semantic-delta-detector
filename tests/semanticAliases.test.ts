import assert from "node:assert/strict";
import test from "node:test";
import { compareSqlQueries } from "../src/core.js";

test("table alias renames do not change semantic meaning", () => {
  const result = compareSqlQueries(
    `SELECT COUNT(DISTINCT u.id)
     FROM users u
     JOIN purchases p ON p.user_id = u.id`,
    `SELECT COUNT(DISTINCT customer.id)
     FROM users AS customer
     JOIN purchases AS purchase ON purchase.user_id = customer.id`,
  );

  assert.equal(result.risk_level, "low");
  assert.equal(result.detected_differences.length, 0);
});

test("changing a qualified aggregate target to another source is semantic", () => {
  const result = compareSqlQueries(
    `SELECT COUNT(DISTINCT u.id)
     FROM users u
     JOIN purchases p ON p.user_id = u.id`,
    `SELECT COUNT(DISTINCT p.id)
     FROM users u
     JOIN purchases p ON p.user_id = u.id`,
  );

  assert.equal(result.risk_level, "high");
  assert.ok(
    result.detected_differences.some(
      (difference) =>
        difference.category === "aggregation_mismatch" &&
        /users\.id/i.test(difference.description) &&
        /purchases\.id/i.test(difference.description),
    ),
  );
});

test("alias-only changes inside join predicates remain equivalent", () => {
  const result = compareSqlQueries(
    `SELECT COUNT(*)
     FROM users u
     JOIN purchases p ON p.user_id = u.id
     WHERE p.status = 'paid'`,
    `SELECT COUNT(*)
     FROM users customer
     JOIN purchases purchase ON purchase.user_id = customer.id
     WHERE purchase.status = 'paid'`,
  );

  assert.equal(result.risk_level, "low");
  assert.equal(result.detected_differences.length, 0);
});
