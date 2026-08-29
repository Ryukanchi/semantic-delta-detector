import assert from "node:assert/strict";
import test from "node:test";
import { compareSqlQueries } from "../src/postgresql.js";

test("a source change in the second UNION ALL branch remains visible", () => {
  const result = compareSqlQueries(
    `SELECT user_id
     FROM users

     UNION ALL

     SELECT user_id
     FROM purchases;`,
    `SELECT user_id
     FROM users

     UNION ALL

     SELECT user_id
     FROM refunds;`,
  );

  assert.equal(result.risk_level, "high");
  assert.ok(result.semantic_similarity_score < 100);
  assert.ok(
    result.detected_differences.some(
      (difference) =>
        difference.category === "source_domain_mismatch" &&
        /second set-operation branch/i.test(difference.description) &&
        /purchases/i.test(difference.description) &&
        /refunds/i.test(difference.description),
    ),
  );
});

test("identical UNION ALL branches remain low risk", () => {
  const sql = `SELECT user_id
               FROM users

               UNION ALL

               SELECT user_id
               FROM purchases;`;

  const result = compareSqlQueries(sql, sql);

  assert.equal(result.risk_level, "low");
  assert.equal(result.semantic_similarity_score, 100);
  assert.deepEqual(result.detected_differences, []);
});

test("UNION and UNION ALL remain semantically distinct", () => {
  const union = `SELECT user_id FROM users
                 UNION
                 SELECT user_id FROM purchases;`;
  const unionAll = `SELECT user_id FROM users
                    UNION ALL
                    SELECT user_id FROM purchases;`;

  const result = compareSqlQueries(union, unionAll);

  assert.equal(result.risk_level, "high");
  assert.ok(
    result.detected_differences.some(
      (difference) =>
        difference.category === "business_logic_mismatch" &&
        /duplicate handling/i.test(difference.description),
    ),
  );
});

test("a source change in the third UNION ALL branch remains visible", () => {
  const result = compareSqlQueries(
    `SELECT user_id FROM users
     UNION ALL
     SELECT user_id FROM purchases
     UNION ALL
     SELECT user_id FROM trials;`,
    `SELECT user_id FROM users
     UNION ALL
     SELECT user_id FROM purchases
     UNION ALL
     SELECT user_id FROM refunds;`,
  );

  assert.equal(result.risk_level, "high");
  assert.ok(
    result.detected_differences.some(
      (difference) =>
        difference.category === "source_domain_mismatch" &&
        /third set-operation branch/i.test(difference.description) &&
        /trials/i.test(difference.description) &&
        /refunds/i.test(difference.description),
    ),
  );
});
