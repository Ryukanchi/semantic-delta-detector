import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  compareMetricDefinitions,
  compareSqlQueries,
} from "../src/postgresql.js";
import { nodeSqlPostgresqlParser } from "../src/parser/nodeSqlParserAdapter.js";
import {
  getSourceGraphSignature,
  getWindowSpecificationSignature,
} from "../src/parser/sqlStructure.js";

function parseSuccessfully(sql: string) {
  const result = nodeSqlPostgresqlParser.parse(sql);
  assert.equal(result.ok, true, result.ok ? undefined : result.reason);
  return result.syntax;
}

test("node-sql-parser is pinned to the evaluated version", () => {
  const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
    dependencies: Record<string, string>;
  };

  assert.equal(packageJson.dependencies["node-sql-parser"], "5.4.0");
});

test("the adapter maps window partitioning and ordering into Semantic Delta IR", () => {
  const accountWindow = parseSuccessfully(
    `SELECT ROW_NUMBER() OVER (
       PARTITION BY account_id
       ORDER BY created_at DESC
     )
     FROM events;`,
  );
  const regionWindow = parseSuccessfully(
    `SELECT ROW_NUMBER() OVER (
       PARTITION BY region_id
       ORDER BY event_at ASC
     )
     FROM events;`,
  );

  assert.deepEqual(accountWindow.windows, [
    {
      functionName: "row_number",
      partitionBy: ["account_id"],
      orderBy: [{ expression: "created_at", direction: "desc" }],
      frame: null,
    },
  ]);
  assert.notEqual(
    getWindowSpecificationSignature(accountWindow),
    getWindowSpecificationSignature(regionWindow),
  );
});

test("the adapter maps PostgreSQL window frames into Semantic Delta IR", () => {
  const thirtyRows = parseSuccessfully(
    `SELECT SUM(amount) OVER (
       ORDER BY created_at
       ROWS BETWEEN 30 PRECEDING AND CURRENT ROW
     )
     FROM payments;`,
  );
  const unboundedRows = parseSuccessfully(
    `SELECT SUM(amount) OVER (
       ORDER BY created_at
       ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
     )
     FROM payments;`,
  );

  assert.deepEqual(thirtyRows.windows[0].frame, {
    unit: "rows",
    start: "30 preceding",
    end: "current row",
  });
  assert.notEqual(
    getWindowSpecificationSignature(thirtyRows),
    getWindowSpecificationSignature(unboundedRows),
  );
});

test("self-join source identity is role-based instead of FROM-position-based", () => {
  const employeeFirst = parseSuccessfully(
    `SELECT employee.id
     FROM users employee
     JOIN users manager ON employee.manager_id = manager.id;`,
  );
  const managerFirst = parseSuccessfully(
    `SELECT employee.id
     FROM users manager
     JOIN users employee ON employee.manager_id = manager.id;`,
  );

  assert.deepEqual(
    employeeFirst.sourceOccurrences.map((source) => ({
      physicalName: source.physicalName,
      alias: source.alias,
      scopeId: source.scopeId,
    })),
    [
      { physicalName: "users", alias: "employee", scopeId: "root" },
      { physicalName: "users", alias: "manager", scopeId: "root" },
    ],
  );
  assert.deepEqual(employeeFirst.joinEdges, [
    {
      scopeId: "root",
      leftQualifier: "employee",
      leftColumn: "manager_id",
      operator: "=",
      rightQualifier: "manager",
      rightColumn: "id",
    },
  ]);
  assert.equal(
    getSourceGraphSignature(employeeFirst),
    getSourceGraphSignature(managerFirst),
  );
});

test("external parser failures retain fallback output and expose uncertainty", () => {
  const result = compareSqlQueries("SELECT FROM WHERE;", "SELECT FROM WHERE;");

  assert.equal(result.confidence_level, "low");
  assert.equal(result.parser_limitations?.length, 2);
  assert.match(result.parser_limitations?.[0] ?? "", /Query A could not be analyzed/);
  assert.match(result.parser_limitations?.[1] ?? "", /Query B could not be analyzed/);
});

test("external parser failure caps confidence without lowering semantic risk", () => {
  const result = compareMetricDefinitions(
    {
      query: "DELETE FROM users;",
      description: "User population",
      team_context: "Growth",
    },
    {
      query: "DELETE FROM payments;",
      description: "Payment population",
      team_context: "Finance",
    },
  );

  assert.equal(result.risk_level, "high");
  assert.equal(result.confidence_level, "low");
  assert.ok((result.parser_limitations?.length ?? 0) >= 2);
});

test("unsupported statement and CTE mappings fail closed inside the adapter", () => {
  const mutation = nodeSqlPostgresqlParser.parse("DELETE FROM users;");
  const cte = nodeSqlPostgresqlParser.parse(
    "WITH active AS (SELECT id FROM users) SELECT id FROM active;",
  );

  assert.equal(mutation.ok, false);
  assert.equal(cte.ok, false);
  if (!cte.ok) {
    assert.match(cte.reason, /does not yet map CTE source identity/i);
  }
});
