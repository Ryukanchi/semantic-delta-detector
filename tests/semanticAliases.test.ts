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

test("self-join alias renames preserve source roles", () => {
  const result = compareSqlQueries(
    `SELECT COUNT(DISTINCT employee.id)
     FROM users employee
     JOIN users manager ON employee.manager_id = manager.id`,
    `SELECT COUNT(DISTINCT report.id)
     FROM users report
     JOIN users lead ON report.manager_id = lead.id`,
  );

  assert.equal(result.risk_level, "low");
  assert.equal(result.detected_differences.length, 0);
});

test("changing the counted source role in a self-join is semantic", () => {
  const result = compareSqlQueries(
    `SELECT COUNT(DISTINCT employee.id)
     FROM users employee
     JOIN users manager ON employee.manager_id = manager.id`,
    `SELECT COUNT(DISTINCT manager.id)
     FROM users employee
     JOIN users manager ON employee.manager_id = manager.id`,
  );

  assert.equal(result.risk_level, "high");
  assert.ok(
    result.detected_differences.some(
      (difference) => difference.category === "aggregation_mismatch",
    ),
  );
});

test("changing a join-key column remains visible", () => {
  const result = compareSqlQueries(
    `SELECT COUNT(*)
     FROM users u
     JOIN purchases p ON p.user_id = u.id`,
    `SELECT COUNT(*)
     FROM users u
     JOIN purchases p ON p.id = u.id`,
  );

  assert.equal(result.risk_level, "high");
  assert.ok(
    result.detected_differences.some(
      (difference) =>
        difference.category === "business_logic_mismatch" &&
        /join predicate/i.test(difference.description) &&
        /purchases\.user_id/i.test(difference.description) &&
        /purchases\.id/i.test(difference.description),
    ),
  );
});

test("adding a join is not double-reported as a missing join predicate", () => {
  const result = compareSqlQueries(
    `SELECT COUNT(*)
     FROM users u
     JOIN purchases p ON p.user_id = u.id`,
    "SELECT COUNT(*) FROM users",
  );

  assert.ok(
    result.detected_differences.some(
      (difference) =>
        difference.category === "business_logic_mismatch" &&
        /joins users to purchases/i.test(difference.description),
    ),
  );
  assert.ok(
    !result.detected_differences.some((difference) =>
      /join predicate changes from .* to none/i.test(difference.description),
    ),
  );
});

test("reversing equality operands in a join predicate is equivalent", () => {
  const result = compareSqlQueries(
    `SELECT COUNT(*)
     FROM users u
     JOIN purchases p ON p.user_id = u.id`,
    `SELECT COUNT(*)
     FROM users u
     JOIN purchases p ON u.id = p.user_id`,
  );

  assert.equal(result.risk_level, "low");
  assert.equal(result.detected_differences.length, 0);
});
