import { createRequire } from "node:module";
import type {
  SqlJoinEdgeSummary,
  SqlSetBranchSourceSummary,
  SqlSetExpressionSummary,
  SqlSetOperator,
  SqlSetQuerySummary,
  SqlSourceOccurrenceSummary,
  SqlSourceUsageContext,
  SqlSourceUsageSummary,
  SqlSyntaxSummary,
  SqlWindowFrameSummary,
  SqlWindowOrderSummary,
  SqlWindowSummary,
} from "./sqlStructure.js";
import type {
  ExternalSqlParseResult,
  ExternalSqlParser,
} from "./externalSqlParser.js";

export const postgresqlParserResourceLimits = Object.freeze({
  maxSqlCharacters: 256_000,
  maxAstDepth: 64,
  maxAstNodes: 20_000,
  maxListItems: 4_096,
  maxSetOperationBranches: 64,
  maxWindowExpressions: 256,
  maxSourceOccurrences: 512,
  maxJoinEdges: 1_024,
  maxSourceUsages: 4_096,
});

interface VendorParser {
  astify(sql: string, options?: unknown): unknown;
}

interface VendorParserConstructor {
  new (): VendorParser;
}

interface VendorParserModule {
  Parser: VendorParserConstructor;
}

const require = createRequire(import.meta.url);
const { Parser } = require(
  "node-sql-parser/build/postgresql",
) as VendorParserModule;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertSqlInputWithinResourceBudget(sql: string): void {
  if (sql.length > postgresqlParserResourceLimits.maxSqlCharacters) {
    throw new Error(
      `SQL input exceeds the ${postgresqlParserResourceLimits.maxSqlCharacters} character resource limit`,
    );
  }
}

function isVendorSetOperationContinuation(
  parent: Record<string, unknown>,
  key: string,
  child: unknown,
): child is Record<string, unknown> {
  // node-sql-parser models a linear set chain as horizontal SELECT._next links.
  // Keep the surrounding depth for that one link; every branch child still adds depth.
  return (
    key === "_next" &&
    parent.type === "select" &&
    typeof parent.set_op === "string" &&
    isRecord(child) &&
    child.type === "select"
  );
}

function assertVendorAstWithinResourceBudget(root: unknown): void {
  const seen = new Set<object>();
  let nodeCount = 0;
  const pending: Array<{ value: unknown; depth: number }> = [
    { value: root, depth: 0 },
  ];

  while (pending.length > 0) {
    const { value, depth } = pending.pop()!;
    if (depth > postgresqlParserResourceLimits.maxAstDepth) {
      throw new Error(
        `vendor AST depth exceeds the ${postgresqlParserResourceLimits.maxAstDepth} level resource limit`,
      );
    }
    if (Array.isArray(value)) {
      if (value.length > postgresqlParserResourceLimits.maxListItems) {
        throw new Error(
          `vendor AST list exceeds the ${postgresqlParserResourceLimits.maxListItems} item resource limit`,
        );
      }
      if (seen.has(value)) {
        continue;
      }
      seen.add(value);
      nodeCount += 1;
      if (nodeCount > postgresqlParserResourceLimits.maxAstNodes) {
        throw new Error(
          `vendor AST node count exceeds the ${postgresqlParserResourceLimits.maxAstNodes} node resource limit`,
        );
      }
      for (const item of value) {
        pending.push({ value: item, depth: depth + 1 });
      }
      continue;
    }
    if (!isRecord(value) || seen.has(value)) {
      continue;
    }
    seen.add(value);
    nodeCount += 1;
    if (nodeCount > postgresqlParserResourceLimits.maxAstNodes) {
      throw new Error(
        `vendor AST node count exceeds the ${postgresqlParserResourceLimits.maxAstNodes} node resource limit`,
      );
    }
    const entries = Object.entries(value);
    if (entries.length > postgresqlParserResourceLimits.maxListItems) {
      throw new Error(
        `vendor AST object exceeds the ${postgresqlParserResourceLimits.maxListItems} property resource limit`,
      );
    }
    for (const [key, child] of entries) {
      pending.push({
        value: child,
        depth: isVendorSetOperationContinuation(value, key, child)
          ? depth
          : depth + 1,
      });
    }
  }
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function normalizeIdentifier(value: string): string {
  return value.trim().toLowerCase();
}

function readColumnName(value: unknown): string | null {
  const direct = readString(value);
  if (direct) {
    return normalizeIdentifier(direct);
  }

  if (!isRecord(value) || !isRecord(value.expr)) {
    return null;
  }

  const nested = readString(value.expr.value);
  return nested ? normalizeIdentifier(nested) : null;
}

function readColumnReference(
  value: unknown,
): { qualifier: string | null; column: string } | null {
  if (!isRecord(value) || value.type !== "column_ref") {
    return null;
  }

  const column = readColumnName(value.column);
  if (!column) {
    return null;
  }

  const table = readString(value.table);
  return {
    qualifier: table ? normalizeIdentifier(table) : null,
    column,
  };
}

function formatExpression(value: unknown): string {
  const column = readColumnReference(value);
  if (column) {
    return column.qualifier ? `${column.qualifier}.${column.column}` : column.column;
  }

  if (isRecord(value)) {
    const scalar = readString(value.value);
    if (scalar) {
      return normalizeIdentifier(scalar);
    }
  }

  throw new Error("encountered an unsupported expression shape");
}

function readPhysicalTableName(value: Record<string, unknown>): string | null {
  const table = readString(value.table);
  if (!table) {
    return null;
  }

  const qualifiers = [readString(value.db), readString(value.schema), table]
    .filter((part): part is string => Boolean(part))
    .map(normalizeIdentifier);
  return qualifiers.join(".");
}

function extractBranchSources(statement: Record<string, unknown>): SqlSetBranchSourceSummary[] {
  if (statement.from === null || statement.from === undefined) {
    return [];
  }

  if (!Array.isArray(statement.from)) {
    throw new Error("encountered an unsupported FROM shape");
  }

  return statement.from.map((source) => {
    if (!isRecord(source)) {
      throw new Error("encountered an unsupported source node");
    }

    const name = readPhysicalTableName(source);
    if (!name) {
      throw new Error("encountered a non-table set-operation source");
    }

    const alias = readString(source.as);
    return {
      name,
      alias: alias ? normalizeIdentifier(alias) : null,
    };
  });
}

function normalizeSetOperator(value: unknown): SqlSetOperator {
  switch (typeof value === "string" ? value.toLowerCase() : value) {
    case "union":
      return "union";
    case "union all":
      return "union_all";
    case "intersect":
      return "intersect";
    case "except":
      return "except";
    default:
      throw new Error("encountered an unsupported set-operation operator");
  }
}

function buildSetExpression(
  statement: Record<string, unknown>,
): SqlSetExpressionSummary {
  const branches: Array<{
    query: SqlSetQuerySummary;
    operator: SqlSetOperator | null;
  }> = [];
  let currentStatement = statement;

  while (true) {
    if (
      branches.length >=
      postgresqlParserResourceLimits.maxSetOperationBranches
    ) {
      throw new Error(
        `set-operation branch count exceeds the ${postgresqlParserResourceLimits.maxSetOperationBranches} branch resource limit`,
      );
    }

    const query: SqlSetQuerySummary = {
      kind: "query",
      sources: extractBranchSources(currentStatement),
    };
    const nextStatement = currentStatement._next;
    if (nextStatement === null || nextStatement === undefined) {
      branches.push({ query, operator: null });
      break;
    }
    if (!isRecord(nextStatement)) {
      throw new Error("encountered an unsupported set-operation branch");
    }

    branches.push({
      query,
      operator: normalizeSetOperator(currentStatement.set_op),
    });
    currentStatement = nextStatement;
  }

  let expression: SqlSetExpressionSummary = branches.at(-1)!.query;
  for (let index = branches.length - 2; index >= 0; index -= 1) {
    expression = {
      kind: "set_operation",
      operator: branches[index].operator!,
      left: branches[index].query,
      right: expression,
    };
  }
  return expression;
}

function readWindowFrame(value: unknown): SqlWindowFrameSummary | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (
    !isRecord(value) ||
    value.type !== "binary_expr" ||
    value.operator !== "BETWEEN" ||
    !isRecord(value.left) ||
    !isRecord(value.right) ||
    !Array.isArray(value.right.value)
  ) {
    throw new Error("encountered an unsupported window frame shape");
  }

  const unitValue = readString(value.left.value)?.toLowerCase();
  if (unitValue !== "rows" && unitValue !== "range" && unitValue !== "groups") {
    throw new Error("encountered an unsupported window frame unit");
  }

  const bounds = value.right.value.map((bound) => {
    if (!isRecord(bound)) {
      throw new Error("encountered an unsupported window frame bound");
    }
    const text = readString(bound.value);
    if (!text) {
      throw new Error("encountered an unsupported window frame bound");
    }
    return text.toLowerCase();
  });
  if (bounds.length !== 2) {
    throw new Error("encountered an incomplete window frame");
  }

  return {
    unit: unitValue,
    start: bounds[0],
    end: bounds[1],
  };
}

function extractWindowSummary(node: Record<string, unknown>): SqlWindowSummary {
  if (!isRecord(node.over) || !isRecord(node.over.as_window_specification)) {
    throw new Error("encountered an unsupported OVER clause");
  }

  const specification = node.over.as_window_specification.window_specification;
  if (!isRecord(specification)) {
    throw new Error("encountered an unsupported window specification");
  }

  const partitionBy = specification.partitionby;
  const partitions =
    partitionBy === null || partitionBy === undefined
      ? []
      : Array.isArray(partitionBy)
        ? partitionBy.map((entry) => {
            if (!isRecord(entry)) {
              throw new Error("encountered an unsupported window partition");
            }
            return formatExpression(entry.expr);
          })
        : (() => {
            throw new Error("encountered an unsupported window partition list");
          })();

  const orderBy = specification.orderby;
  const orders: SqlWindowOrderSummary[] =
    orderBy === null || orderBy === undefined
      ? []
      : Array.isArray(orderBy)
        ? orderBy.map((entry) => {
            if (!isRecord(entry)) {
              throw new Error("encountered an unsupported window order item");
            }
            const direction = readString(entry.type)?.toLowerCase();
            if (direction && direction !== "asc" && direction !== "desc") {
              throw new Error("encountered an unsupported window order direction");
            }
            const nullsValue = readString(entry.nulls)?.toLowerCase();
            if (
              nullsValue &&
              nullsValue !== "nulls first" &&
              nullsValue !== "nulls last"
            ) {
              throw new Error("encountered an unsupported window NULLS ordering");
            }
            return {
              expression: formatExpression(entry.expr),
              direction: direction === "asc" || direction === "desc" ? direction : null,
              nulls:
                nullsValue === "nulls first"
                  ? "first"
                  : nullsValue === "nulls last"
                    ? "last"
                    : null,
            };
          })
        : (() => {
            throw new Error("encountered an unsupported window order list");
          })();

  const functionName = readString(node.name);
  if (!functionName) {
    throw new Error("encountered a window function without a name");
  }

  return {
    functionName: functionName.toLowerCase(),
    partitionBy: partitions,
    orderBy: orders,
    frame: readWindowFrame(specification.window_frame_clause),
  };
}

function collectWindows(root: unknown): SqlWindowSummary[] {
  const windows: SqlWindowSummary[] = [];
  const seen = new Set<object>();
  let nodeCount = 0;
  const pending: Array<{ value: unknown; depth: number }> = [
    { value: root, depth: 0 },
  ];

  while (pending.length > 0) {
    const { value, depth } = pending.pop()!;
    if (depth > postgresqlParserResourceLimits.maxAstDepth) {
      throw new Error("window traversal exceeds the AST depth resource limit");
    }
    if (Array.isArray(value)) {
      if (seen.has(value)) {
        continue;
      }
      seen.add(value);
      for (const item of value) {
        pending.push({ value: item, depth: depth + 1 });
      }
      continue;
    }
    if (!isRecord(value) || seen.has(value)) {
      continue;
    }
    seen.add(value);
    nodeCount += 1;
    if (nodeCount > postgresqlParserResourceLimits.maxAstNodes) {
      throw new Error("window traversal exceeds the AST node resource limit");
    }

    if ((value.type === "window_func" || value.type === "aggr_func") && value.over) {
      if (
        windows.length >=
        postgresqlParserResourceLimits.maxWindowExpressions
      ) {
        throw new Error(
          `window expression count exceeds the ${postgresqlParserResourceLimits.maxWindowExpressions} expression resource limit`,
        );
      }
      windows.push(extractWindowSummary(value));
    }

    for (const [key, child] of Object.entries(value)) {
      if (key !== "loc") {
        pending.push({
          value: child,
          depth: isVendorSetOperationContinuation(value, key, child)
            ? depth
            : depth + 1,
        });
      }
    }
  }
  return windows;
}

function collectJoinEdges(
  expression: unknown,
  scopeId: string,
  edges: SqlJoinEdgeSummary[],
  depth = 0,
): boolean {
  if (depth > postgresqlParserResourceLimits.maxAstDepth) {
    throw new Error("join-edge traversal exceeds the AST depth resource limit");
  }
  if (!isRecord(expression)) {
    return false;
  }

  const left = readColumnReference(expression.left);
  const right = readColumnReference(expression.right);
  const operator = readString(expression.operator);
  if (left?.qualifier && right?.qualifier && operator) {
    if (edges.length >= postgresqlParserResourceLimits.maxJoinEdges) {
      throw new Error(
        `join-edge count exceeds the ${postgresqlParserResourceLimits.maxJoinEdges} edge resource limit`,
      );
    }
    edges.push({
      scopeId,
      leftQualifier: left.qualifier,
      leftColumn: left.column,
      operator,
      rightQualifier: right.qualifier,
      rightColumn: right.column,
    });
    return true;
  }

  if (operator?.toLowerCase() === "and") {
    const leftComplete = collectJoinEdges(
      expression.left,
      scopeId,
      edges,
      depth + 1,
    );
    const rightComplete = collectJoinEdges(
      expression.right,
      scopeId,
      edges,
      depth + 1,
    );
    return leftComplete && rightComplete;
  }

  return false;
}

interface SourceUsageMetadata {
  functionName: string | null;
  distinct: boolean;
}

function collectSourceUsagesFromExpression(
  value: unknown,
  scopeId: string,
  context: SqlSourceUsageContext,
  usages: SqlSourceUsageSummary[],
  metadata: SourceUsageMetadata = { functionName: null, distinct: false },
  depth = 0,
  seen = new Set<object>(),
): void {
  if (depth > postgresqlParserResourceLimits.maxAstDepth) {
    throw new Error("source-usage traversal exceeds the AST depth resource limit");
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectSourceUsagesFromExpression(
        item,
        scopeId,
        context,
        usages,
        metadata,
        depth + 1,
        seen,
      );
    }
    return;
  }
  if (!isRecord(value) || seen.has(value)) {
    return;
  }
  seen.add(value);

  const column = readColumnReference(value);
  if (column) {
    if (usages.length >= postgresqlParserResourceLimits.maxSourceUsages) {
      throw new Error(
        `source-usage count exceeds the ${postgresqlParserResourceLimits.maxSourceUsages} usage resource limit`,
      );
    }
    usages.push({
      scopeId,
      qualifier: column.qualifier,
      column: column.column,
      context,
      functionName: metadata.functionName,
      distinct: metadata.distinct,
    });
    return;
  }

  if (value.type === "aggr_func" && isRecord(value.args)) {
    const functionName = readString(value.name)?.toLowerCase() ?? null;
    collectSourceUsagesFromExpression(
      value.args.expr,
      scopeId,
      "aggregation",
      usages,
      {
        functionName,
        distinct: Boolean(readString(value.args.distinct)),
      },
      depth + 1,
      seen,
    );
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    if (key !== "loc" && key !== "over") {
      collectSourceUsagesFromExpression(
        child,
        scopeId,
        context,
        usages,
        metadata,
        depth + 1,
        seen,
      );
    }
  }
}

function collectStatementSourceUsages(
  statement: Record<string, unknown>,
  scopeId: string,
  usages: SqlSourceUsageSummary[],
): void {
  const contexts: Array<[unknown, SqlSourceUsageContext]> = [
    [statement.columns, "projection"],
    [statement.where, "filter"],
    [statement.groupby, "grouping"],
    [statement.having, "having"],
    [statement.orderby, "ordering"],
  ];
  for (const [value, context] of contexts) {
    collectSourceUsagesFromExpression(value, scopeId, context, usages);
  }
}

function collectSourceGraph(
  expression: SqlSetExpressionSummary,
  statement: Record<string, unknown>,
): {
  sourceOccurrences: SqlSourceOccurrenceSummary[];
  joinEdges: SqlJoinEdgeSummary[];
  sourceUsages: SqlSourceUsageSummary[];
  sourceGraphComplete: boolean;
} {
  const sourceOccurrences: SqlSourceOccurrenceSummary[] = [];
  const joinEdges: SqlJoinEdgeSummary[] = [];
  const sourceUsages: SqlSourceUsageSummary[] = [];
  let sourceGraphComplete = true;
  let branchIndex = 0;

  const visit = (
    currentExpression: SqlSetExpressionSummary,
    currentStatement: Record<string, unknown>,
  ): void => {
    if (currentExpression.kind === "set_operation") {
      visit(currentExpression.left, currentStatement);
      if (!isRecord(currentStatement._next)) {
        throw new Error("set-operation source graph lost its right branch");
      }
      visit(currentExpression.right, currentStatement._next);
      return;
    }

    branchIndex += 1;
    const scopeId = branchIndex === 1 ? "root" : `set-branch-${branchIndex}`;
    for (const source of currentExpression.sources) {
      if (
        sourceOccurrences.length >=
        postgresqlParserResourceLimits.maxSourceOccurrences
      ) {
        throw new Error(
          `source occurrence count exceeds the ${postgresqlParserResourceLimits.maxSourceOccurrences} occurrence resource limit`,
        );
      }
      sourceOccurrences.push({
        physicalName: source.name,
        alias: source.alias,
        scopeId,
      });
    }

    if (Array.isArray(currentStatement.from)) {
      for (const source of currentStatement.from) {
        if (!isRecord(source) || !source.join) {
          continue;
        }
        if (source.on) {
          sourceGraphComplete =
            collectJoinEdges(source.on, scopeId, joinEdges) &&
            sourceGraphComplete;
        } else if (readString(source.join)?.toLowerCase() !== "cross join") {
          sourceGraphComplete = false;
        }
      }
    }
    collectStatementSourceUsages(currentStatement, scopeId, sourceUsages);
  };

  visit(expression, statement);
  return {
    sourceOccurrences,
    joinEdges,
    sourceUsages,
    sourceGraphComplete,
  };
}

function formatFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : "unknown parser failure";
  return message.replace(/\s+/g, " ").trim().slice(0, 240);
}

export class NodeSqlPostgresqlParserAdapter implements ExternalSqlParser {
  readonly dialect = "postgresql" as const;
  readonly #parser: VendorParser;

  constructor(parser: VendorParser = new Parser()) {
    this.#parser = parser;
  }

  parse(sql: string): ExternalSqlParseResult {
    try {
      assertSqlInputWithinResourceBudget(sql);
      const parsed = this.#parser.astify(sql);
      assertVendorAstWithinResourceBudget(parsed);
      const statements = Array.isArray(parsed) ? parsed : [parsed];
      if (statements.length !== 1 || !isRecord(statements[0])) {
        throw new Error("the PostgreSQL adapter requires exactly one SQL statement");
      }
      const statement = statements[0];
      if (statement.type !== "select") {
        throw new Error("the PostgreSQL adapter currently supports SELECT statements only");
      }
      if (statement.with !== null && statement.with !== undefined) {
        throw new Error("the PostgreSQL adapter does not yet map CTE source identity");
      }

      const setExpression = buildSetExpression(statement);
      const sourceGraph = collectSourceGraph(setExpression, statement);
      const syntax: SqlSyntaxSummary = {
        setExpression: setExpression.kind === "set_operation" ? setExpression : null,
        windows: collectWindows(statement),
        sourceOccurrences: sourceGraph.sourceOccurrences,
        joinEdges: sourceGraph.joinEdges,
        sourceUsages: sourceGraph.sourceUsages,
        sourceGraphComplete: sourceGraph.sourceGraphComplete,
      };
      return { ok: true, syntax };
    } catch (error) {
      return {
        ok: false,
        dialect: this.dialect,
        reason: formatFailureReason(error),
      };
    }
  }
}

export const nodeSqlPostgresqlParser = new NodeSqlPostgresqlParserAdapter();
