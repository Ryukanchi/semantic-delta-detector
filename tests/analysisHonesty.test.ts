import assert from "node:assert/strict";
import test from "node:test";
import { compareMetricDefinitions, compareSqlQueries } from "../src/index.js";
import * as postgresqlApi from "../src/postgresql.js";
import {
  detectUnsupportedSqlConstructs,
  type UnsupportedSqlConstructKind,
} from "../src/parser/unsupportedConstructs.js";

// The root and core entrypoints use the lightweight analyzer. Constructs it
// does not model must be reported as limitations instead of looking like a
// complete low-risk analysis, and must not be turned into invented findings.

function constructsOf(sql: string): UnsupportedSqlConstructKind[] {
  return detectUnsupportedSqlConstructs(sql).map((item) => item.construct);
}

function assertLimitedWithoutFindings(
  queryA: string,
  queryB: string,
  labelPattern: RegExp,
): ReturnType<typeof compareSqlQueries> {
  const result = compareSqlQueries(queryA, queryB);

  assert.deepEqual(result.detected_differences, []);
  assert.equal(result.risk_level, "low");
  assert.equal(result.confidence_level, "low");
  assert.equal(result.parser_limitations?.length, 2);
  assert.ok((result.parser_limitations ?? []).every((note) => labelPattern.test(note)));
  assert.notEqual(result.verdict, "LOW RISK: No meaningful semantic change detected.");
  return result;
}

for (const operator of ["UNION", "UNION ALL", "INTERSECT", "EXCEPT"]) {
  test(`${operator} is reported as a set-operation limitation`, () => {
    assert.ok(
      constructsOf(`SELECT user_id FROM users ${operator} SELECT user_id FROM archived_users`)
        .includes("set_operation"),
    );
  });
}

test("UNION to UNION ALL stays unmodeled but visibly limited on the root path", () => {
  assertLimitedWithoutFindings(
    "SELECT user_id FROM users UNION SELECT user_id FROM archived_users",
    "SELECT user_id FROM users UNION ALL SELECT user_id FROM archived_users",
    /UNION\/INTERSECT\/EXCEPT set operation/,
  );
});

test("a later set-operation branch change is not reported as fully analyzed", () => {
  assertLimitedWithoutFindings(
    "SELECT user_id FROM users INTERSECT SELECT user_id FROM paid_users",
    "SELECT user_id FROM users EXCEPT SELECT user_id FROM paid_users",
    /set operation/,
  );
});

test("column exclusion with SELECT * EXCEPT is not a set operation", () => {
  assert.ok(!constructsOf("SELECT * EXCEPT (email) FROM users").includes("set_operation"));
});

test("a window PARTITION BY change is limited without an invented window finding", () => {
  assertLimitedWithoutFindings(
    "SELECT ROW_NUMBER() OVER (PARTITION BY account_id ORDER BY created_at) AS rn FROM events",
    "SELECT ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at) AS rn FROM events",
    /OVER \(\.\.\.\) window specification/,
  );
});

test("named window definitions are reported as window specifications", () => {
  assert.deepEqual(
    constructsOf(
      "SELECT SUM(amount) OVER w FROM payments WINDOW w AS (PARTITION BY user_id ORDER BY paid_at)",
    ),
    ["window_specification"],
  );
});

test("a HAVING threshold change is limited instead of silently low risk", () => {
  assertLimitedWithoutFindings(
    "SELECT team, COUNT(*) FROM users GROUP BY team HAVING COUNT(*) > 10",
    "SELECT team, COUNT(*) FROM users GROUP BY team HAVING COUNT(*) > 1000",
    /HAVING clause/,
  );
});

test("a LIMIT change is limited instead of silently low risk", () => {
  assertLimitedWithoutFindings(
    "SELECT id FROM users LIMIT 10",
    "SELECT id FROM users LIMIT 100",
    /LIMIT\/OFFSET\/FETCH row limit/,
  );
});

test("OFFSET, FETCH FIRST and TOP are reported as row limits", () => {
  for (const sql of [
    "SELECT id FROM users OFFSET 20",
    "SELECT id FROM users FETCH FIRST 10 ROWS ONLY",
    "SELECT TOP 10 id FROM users",
  ]) {
    assert.ok(constructsOf(sql).includes("row_limit"), sql);
  }
});

test("an ORDER BY direction change is limited instead of silently low risk", () => {
  assertLimitedWithoutFindings(
    "SELECT id FROM users ORDER BY created_at ASC",
    "SELECT id FROM users ORDER BY created_at DESC",
    /ORDER BY clause/,
  );
});

test("ORDER BY inside a window specification is not reported as query ordering", () => {
  assert.deepEqual(
    constructsOf("SELECT ROW_NUMBER() OVER (ORDER BY created_at) AS rn FROM events"),
    ["window_specification"],
  );
});

test("DISTINCT ON is reported while plain DISTINCT stays supported", () => {
  assert.ok(
    constructsOf("SELECT DISTINCT ON (user_id) user_id, ts FROM events ORDER BY user_id, ts DESC")
      .includes("distinct_on"),
  );
  assert.deepEqual(constructsOf("SELECT DISTINCT user_id FROM events"), []);

  const result = compareSqlQueries(
    "SELECT DISTINCT ON (user_id) user_id, ts FROM events ORDER BY user_id, ts DESC",
    "SELECT DISTINCT ON (user_id) user_id, ts FROM events ORDER BY user_id, ts ASC",
  );
  assert.equal(result.confidence_level, "low");
  assert.ok(result.parser_limitations?.every((note) => /DISTINCT ON/.test(note)));
});

test("ORDER BY alone caps structured confidence at medium", () => {
  const inputA = {
    query: "SELECT COUNT(DISTINCT user_id) FROM events WHERE event = 'login'",
    metric_name: "login_users",
    description: "Unique users who logged in",
    team_context: "product analytics",
  };
  const inputB = {
    query: "SELECT SUM(amount) FROM payments WHERE status = 'paid'",
    metric_name: "paid_revenue",
    description: "Revenue from paid payments",
    team_context: "finance",
  };
  assert.equal(compareMetricDefinitions(inputA, inputB).confidence_level, "high");

  const ordered = compareMetricDefinitions(inputA, {
    ...inputB,
    query: `${inputB.query} ORDER BY 1`,
  });
  assert.equal(ordered.risk_level, "high");
  assert.equal(ordered.confidence_level, "medium");
});

test("an unsupported construct caps confidence without raising or lowering risk", () => {
  const lowRisk = compareSqlQueries(
    "SELECT id FROM users LIMIT 10",
    "SELECT id FROM users LIMIT 10",
  );
  assert.equal(lowRisk.risk_level, "low");

  const highRisk = compareSqlQueries(
    "SELECT COUNT(*) FROM users u LEFT JOIN orders o ON u.id = o.user_id LIMIT 10",
    "SELECT COUNT(*) FROM users u JOIN orders o ON u.id = o.user_id LIMIT 10",
  );
  assert.equal(highRisk.risk_level, "high");
  assert.equal(highRisk.confidence_level, "low");
  assert.ok(
    highRisk.detected_differences.some(
      (difference) => difference.category === "join_type_mismatch",
    ),
  );
});

test("keywords inside comments and string literals are not reported", () => {
  assert.deepEqual(
    constructsOf(
      `-- union all, order by, limit, having
       SELECT COUNT(*) FROM users /* over (partition by x) */
       WHERE note = 'union all order by limit 10 having over ('`,
    ),
    [],
  );
});

test("an unterminated string literal errs toward reporting a limitation", () => {
  assert.ok(
    constructsOf("SELECT 'open FROM users UNION SELECT id FROM archived_users")
      .includes("set_operation"),
  );
});

test("a CTE is reported with and without leading comments", () => {
  const cte = "WITH active AS (SELECT user_id FROM events) SELECT COUNT(*) FROM active";
  const variants = [
    cte,
    `-- model: active users\n${cte}`,
    `/* model: active users */ ${cte}`,
  ];

  const baseline = compareSqlQueries(cte, cte.replace("events", "sessions"));
  for (const sql of variants) {
    assert.deepEqual(constructsOf(sql), ["cte"], sql);

    const result = compareSqlQueries(sql, sql.replace("events", "sessions"));
    assert.equal(result.confidence_level, baseline.confidence_level, sql);
    assert.deepEqual(result.parser_limitations, baseline.parser_limitations, sql);
  }
});

test("no findings with limitations do not claim a complete analysis", () => {
  const result = compareSqlQueries(
    "SELECT id FROM users ORDER BY created_at ASC",
    "SELECT id FROM users ORDER BY created_at DESC",
  );

  assert.equal(
    result.verdict,
    "LOW RISK: No modeled semantic differences were detected within the analyzed constructs; parts of the SQL were not fully analyzed.",
  );
  assert.equal(
    result.impact?.decisionRisk,
    "No significant business impact was detected within the analyzed constructs; parts of the SQL were not fully analyzed.",
  );
  assert.match(result.explanation, /not fully analyzed/);
  assert.match(result.recommendation, /analysis limitations manually/);
  assert.equal(result.impact?.recommendedAction, result.recommendation);
});

test("the PostgreSQL entrypoint keeps modeling set operations and windows itself", () => {
  const union = "SELECT user_id FROM users UNION SELECT user_id FROM archived_users";
  const unionAll = "SELECT user_id FROM users UNION ALL SELECT user_id FROM archived_users";

  const rootResult = compareSqlQueries(union, unionAll);
  const postgresqlResult = postgresqlApi.compareSqlQueries(union, unionAll);

  assert.ok(rootResult.parser_limitations?.some((note) => /set operation/.test(note)));
  assert.equal(postgresqlResult.parser_limitations, undefined);
  assert.equal(postgresqlResult.risk_level, "high");
});
