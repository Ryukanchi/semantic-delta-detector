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

test("removing plan_tier filter broadens population and is not suppressed", () => {
  const result = compareSqlQueries(
    `SELECT COUNT(*) AS c
FROM users
WHERE plan_tier = 'enterprise'
  AND region = 'us';`,
    `SELECT COUNT(*) AS c
FROM users
WHERE region = 'us';`,
  );

  assert.notEqual(result.risk_level, "low");
  assert.ok(
    result.detected_differences.some(
      (difference) =>
        difference.category === "business_logic_mismatch" &&
        /plan_tier = 'enterprise'/i.test(difference.description) &&
        /measured population becomes broader/i.test(difference.description),
    ),
  );
});

test("filter predicates with substring collisions are not misclassified as monetization gates", () => {
  const cases = [
    {
      sqlA: "SELECT COUNT(*) FROM flights WHERE arrival_status = 'ontime'",
      sqlB: "SELECT COUNT(*) FROM flights",
      filterText: "arrival_status = 'ontime'",
    },
    {
      sqlA: "SELECT COUNT(*) FROM shipments WHERE carrier_id = 5",
      sqlB: "SELECT COUNT(*) FROM shipments",
      filterText: "carrier_id = 5",
    },
    {
      sqlA: "SELECT COUNT(*) FROM notes WHERE explanation is not null",
      sqlB: "SELECT COUNT(*) FROM notes",
      filterText: "explanation is not null",
    },
    {
      sqlA: "SELECT COUNT(*) FROM products WHERE warranty_expired = true",
      sqlB: "SELECT COUNT(*) FROM products",
      filterText: "warranty_expired = true",
    },
    {
      sqlA: "SELECT COUNT(*) FROM users WHERE created_at > '2024-01-01'",
      sqlB: "SELECT COUNT(*) FROM users",
      filterText: "created_at > '2024-01-01'",
    },
  ];

  for (const { sqlA, sqlB, filterText } of cases) {
    const result = compareSqlQueries(sqlA, sqlB);
    assert.notEqual(result.risk_level, "low");
    assert.ok(
      !result.detected_differences.some(
        (difference) => difference.category === "monetization_mismatch",
      ),
      `Expected ${filterText} not to produce monetization_mismatch`,
    );
    assert.ok(
      result.detected_differences.some(
        (difference) =>
          difference.category === "business_logic_mismatch" &&
          difference.description.includes(filterText),
      ),
      `Expected ${filterText} to be reported under business_logic_mismatch`,
    );
  }
});

test("monetization gate filter is deduplicated from general filter removal", () => {
  const result = compareSqlQueries(
    "SELECT COUNT(*) FROM users WHERE plan = 'paid' AND region = 'us'",
    "SELECT COUNT(*) FROM users WHERE region = 'us'",
  );

  assert.equal(result.risk_level, "high");
  assert.ok(
    result.detected_differences.some(
      (difference) =>
        difference.category === "monetization_mismatch" &&
        /removes the monetization gate/i.test(difference.description),
    ),
  );
  assert.ok(
    !result.detected_differences.some(
      (difference) =>
        difference.category === "business_logic_mismatch" &&
        /plan = 'paid'/i.test(difference.description),
    ),
  );
});

test("recognizes MRR and ARR tokens separated by underscores as monetization gates", () => {
  const monetizationTokens = [
    "mrr",
    "arr",
    "mrr_usd",
    "arr_usd",
    "monthly_mrr",
    "annual_arr",
  ];

  for (const token of monetizationTokens) {
    const sqlA = `SELECT COUNT(*) FROM users WHERE ${token} > 0 AND region = 'us'`;
    const sqlB = `SELECT COUNT(*) FROM users WHERE region = 'us'`;
    const result = compareSqlQueries(sqlA, sqlB);

    assert.equal(result.risk_level, "high", `Expected high risk for dropped ${token}`);
    assert.ok(
      result.detected_differences.some(
        (difference) =>
          difference.category === "monetization_mismatch" &&
          difference.impact === "high" &&
          difference.description.includes(token),
      ),
      `Expected ${token} to produce monetization_mismatch`,
    );
  }
});

test("unrelated words containing arr or mrr sequences are not classified as monetization", () => {
  const negativeCases = [
    {
      sqlA: "SELECT COUNT(*) FROM shipments WHERE carrier_id = 5",
      sqlB: "SELECT COUNT(*) FROM shipments",
      field: "carrier_id = 5",
    },
    {
      sqlA: "SELECT COUNT(*) FROM flights WHERE arrival_status = 'ontime'",
      sqlB: "SELECT COUNT(*) FROM flights",
      field: "arrival_status = 'ontime'",
    },
    {
      sqlA: "SELECT COUNT(*) FROM products WHERE warranty_expired = true",
      sqlB: "SELECT COUNT(*) FROM products",
      field: "warranty_expired = true",
    },
  ];

  for (const { sqlA, sqlB, field } of negativeCases) {
    const result = compareSqlQueries(sqlA, sqlB);
    assert.notEqual(result.risk_level, "high", `Expected ${field} not to be high risk`);
    assert.ok(
      !result.detected_differences.some(
        (difference) => difference.category === "monetization_mismatch",
      ),
      `Expected ${field} NOT to trigger monetization_mismatch`,
    );
    assert.ok(
      result.detected_differences.some(
        (difference) =>
          difference.category === "business_logic_mismatch" &&
          difference.description.includes(field),
      ),
      `Expected ${field} to be classified as business_logic_mismatch`,
    );
  }
});
