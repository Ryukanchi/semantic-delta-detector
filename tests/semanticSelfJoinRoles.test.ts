import assert from "node:assert/strict";
import test from "node:test";
import { compareSqlQueries } from "../src/postgresql.js";

function assertEquivalentSelfJoin(
  queryA: string,
  queryB: string,
): void {
  const result = compareSqlQueries(queryA, queryB);

  assert.equal(result.risk_level, "low");
  assert.equal(result.semantic_similarity_score, 100);
  assert.deepEqual(result.detected_differences, []);
  assert.equal(result.parser_limitations, undefined);
}

test("self-join FROM order does not change the counted manager role", () => {
  assertEquivalentSelfJoin(
    `SELECT COUNT(DISTINCT manager.id)
     FROM users employee
     JOIN users manager ON employee.manager_id = manager.id;`,
    `SELECT COUNT(DISTINCT manager.id)
     FROM users manager
     JOIN users employee ON employee.manager_id = manager.id;`,
  );
});

test("self-join alias renames preserve source roles", () => {
  assertEquivalentSelfJoin(
    `SELECT COUNT(DISTINCT manager.id)
     FROM users employee
     JOIN users manager ON employee.manager_id = manager.id;`,
    `SELECT COUNT(DISTINCT lead.id)
     FROM users report
     JOIN users lead ON report.manager_id = lead.id;`,
  );
});

test("alias renames and reversed self-join order remain equivalent together", () => {
  assertEquivalentSelfJoin(
    `SELECT COUNT(DISTINCT manager.id)
     FROM users employee
     JOIN users manager ON employee.manager_id = manager.id;`,
    `SELECT COUNT(DISTINCT lead.id)
     FROM users lead
     JOIN users report ON report.manager_id = lead.id;`,
  );
});

test("commutative join operands and conjunct order do not redefine source roles", () => {
  assertEquivalentSelfJoin(
    `SELECT COUNT(DISTINCT manager.id)
     FROM users employee
     JOIN users manager
       ON employee.manager_id = manager.id
      AND employee.tenant_id = manager.tenant_id;`,
    `SELECT COUNT(DISTINCT lead.id)
     FROM users lead
     JOIN users report
       ON lead.tenant_id = report.tenant_id
      AND lead.id = report.manager_id;`,
  );
});

test("three occurrences of the same table are canonicalized by hierarchy role", () => {
  assertEquivalentSelfJoin(
    `SELECT COUNT(DISTINCT director.id)
     FROM users employee
     JOIN users manager ON employee.manager_id = manager.id
     JOIN users director ON manager.manager_id = director.id;`,
    `SELECT COUNT(DISTINCT executive.id)
     FROM users executive
     JOIN users lead ON lead.manager_id = executive.id
     JOIN users report ON report.manager_id = lead.id;`,
  );
});

test("changing the aggregated self-join role remains high risk", () => {
  const result = compareSqlQueries(
    `SELECT COUNT(DISTINCT manager.id)
     FROM users employee
     JOIN users manager ON employee.manager_id = manager.id;`,
    `SELECT COUNT(DISTINCT employee.id)
     FROM users employee
     JOIN users manager ON employee.manager_id = manager.id;`,
  );

  assert.equal(result.risk_level, "high");
  assert.equal(result.confidence_level, "medium");
  assert.ok(result.semantic_similarity_score < 100);
  assert.ok(
    result.detected_differences.some(
      (difference) =>
        difference.category === "aggregation_mismatch" &&
        /source role/i.test(difference.description) &&
        /manager_id/i.test(difference.description),
    ),
  );
});

test("changing a self-join key field remains high risk", () => {
  const result = compareSqlQueries(
    `SELECT COUNT(DISTINCT manager.id)
     FROM users employee
     JOIN users manager ON employee.manager_id = manager.id;`,
    `SELECT COUNT(DISTINCT manager.id)
     FROM users employee
     JOIN users manager ON employee.mentor_id = manager.id;`,
  );

  assert.equal(result.risk_level, "high");
  assert.ok(
    result.detected_differences.some(
      (difference) =>
        difference.category === "business_logic_mismatch" &&
        /source-role join graph/i.test(difference.description) &&
        /manager_id/i.test(difference.description) &&
        /mentor_id/i.test(difference.description),
    ),
  );
});

test("changing a join edge in a three-role self-join remains visible", () => {
  const result = compareSqlQueries(
    `SELECT COUNT(DISTINCT director.id)
     FROM users employee
     JOIN users manager ON employee.manager_id = manager.id
     JOIN users director ON manager.manager_id = director.id;`,
    `SELECT COUNT(DISTINCT director.id)
     FROM users employee
     JOIN users manager ON employee.manager_id = manager.id
     JOIN users director ON employee.director_id = director.id;`,
  );

  assert.equal(result.risk_level, "high");
  assert.ok(
    result.detected_differences.some(
      (difference) =>
        difference.category === "business_logic_mismatch" &&
        /source-role join graph/i.test(difference.description),
    ),
  );
});

test("different projection roles from the same table do not collapse", () => {
  const result = compareSqlQueries(
    `SELECT manager.email
     FROM users employee
     JOIN users manager ON employee.manager_id = manager.id;`,
    `SELECT employee.email
     FROM users employee
     JOIN users manager ON employee.manager_id = manager.id;`,
  );

  assert.equal(result.risk_level, "high");
  assert.ok(
    result.detected_differences.some(
      (difference) =>
        difference.category === "business_logic_mismatch" &&
        /projection.*source role/i.test(difference.description),
    ),
  );
});

test("structurally symmetric self-join roles remain conservative and explicit", () => {
  const result = compareSqlQueries(
    `SELECT COUNT(DISTINCT left_user.id)
     FROM users left_user
     JOIN users right_user ON left_user.peer_id = right_user.peer_id;`,
    `SELECT COUNT(DISTINCT peer_b.id)
     FROM users peer_b
     JOIN users peer_a ON peer_a.peer_id = peer_b.peer_id;`,
  );

  assert.equal(result.confidence_level, "low");
  assert.ok((result.parser_limitations?.length ?? 0) >= 2);
  assert.match(
    result.parser_limitations?.join(" ") ?? "",
    /source-role canonicalization.*ambiguous/i,
  );
});

test("an incomplete self-join predicate keeps role uncertainty visible", () => {
  const result = compareSqlQueries(
    `SELECT COUNT(DISTINCT manager.id)
     FROM users employee
     JOIN users manager
       ON employee.manager_id = manager.id AND manager.active = true;`,
    `SELECT COUNT(DISTINCT lead.id)
     FROM users lead
     JOIN users report
       ON report.manager_id = lead.id AND lead.active = true;`,
  );

  assert.equal(result.confidence_level, "low");
  assert.match(
    result.parser_limitations?.join(" ") ?? "",
    /source-role canonicalization.*incomplete/i,
  );
});
