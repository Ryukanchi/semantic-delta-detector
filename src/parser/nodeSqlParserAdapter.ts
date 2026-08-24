import { createRequire } from "node:module";
import type {
  SqlJoinEdgeSummary,
  SqlSetBranchSourceSummary,
  SqlSetExpressionSummary,
  SqlSetOperator,
  SqlSourceOccurrenceSummary,
  SqlSyntaxSummary,
  SqlWindowFrameSummary,
  SqlWindowOrderSummary,
  SqlWindowSummary,
} from "./sqlStructure.js";
import type {
  ExternalSqlParseResult,
  ExternalSqlParser,
} from "./externalSqlParser.js";

const MAX_VENDOR_AST_DEPTH = 64;
const MAX_VENDOR_AST_NODES = 20_000;

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
  depth = 0,
): SqlSetExpressionSummary {
  if (depth > MAX_VENDOR_AST_DEPTH) {
    throw new Error("set-operation nesting exceeds the adapter depth limit");
  }

  const query: SqlSetExpressionSummary = {
    kind: "query",
    sources: extractBranchSources(statement),
  };
  if (statement._next === null || statement._next === undefined) {
    return query;
  }

  if (!isRecord(statement._next)) {
    throw new Error("encountered an unsupported set-operation branch");
  }

  return {
    kind: "set_operation",
    operator: normalizeSetOperator(statement.set_op),
    left: query,
    right: buildSetExpression(statement._next, depth + 1),
  };
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
            return {
              expression: formatExpression(entry.expr),
              direction: direction === "asc" || direction === "desc" ? direction : null,
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

  const visit = (value: unknown, depth: number): void => {
    if (depth > MAX_VENDOR_AST_DEPTH) {
      throw new Error("vendor AST traversal exceeds the adapter depth limit");
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (!isRecord(value) || seen.has(value)) {
      return;
    }
    seen.add(value);
    nodeCount += 1;
    if (nodeCount > MAX_VENDOR_AST_NODES) {
      throw new Error("vendor AST traversal exceeds the adapter node limit");
    }

    if ((value.type === "window_func" || value.type === "aggr_func") && value.over) {
      windows.push(extractWindowSummary(value));
    }

    for (const [key, child] of Object.entries(value)) {
      if (key !== "loc") visit(child, depth + 1);
    }
  };

  visit(root, 0);
  return windows;
}

function collectJoinEdges(
  expression: unknown,
  scopeId: string,
  edges: SqlJoinEdgeSummary[],
  depth = 0,
): void {
  if (depth > MAX_VENDOR_AST_DEPTH || !isRecord(expression)) {
    return;
  }

  const left = readColumnReference(expression.left);
  const right = readColumnReference(expression.right);
  const operator = readString(expression.operator);
  if (left?.qualifier && right?.qualifier && operator) {
    edges.push({
      scopeId,
      leftQualifier: left.qualifier,
      leftColumn: left.column,
      operator,
      rightQualifier: right.qualifier,
      rightColumn: right.column,
    });
    return;
  }

  collectJoinEdges(expression.left, scopeId, edges, depth + 1);
  collectJoinEdges(expression.right, scopeId, edges, depth + 1);
}

function collectSourceGraph(
  expression: SqlSetExpressionSummary,
  statement: Record<string, unknown>,
): { sourceOccurrences: SqlSourceOccurrenceSummary[]; joinEdges: SqlJoinEdgeSummary[] } {
  const sourceOccurrences: SqlSourceOccurrenceSummary[] = [];
  const joinEdges: SqlJoinEdgeSummary[] = [];
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
      sourceOccurrences.push({
        physicalName: source.name,
        alias: source.alias,
        scopeId,
      });
    }

    if (Array.isArray(currentStatement.from)) {
      for (const source of currentStatement.from) {
        if (isRecord(source) && source.on) {
          collectJoinEdges(source.on, scopeId, joinEdges);
        }
      }
    }
  };

  visit(expression, statement);
  return { sourceOccurrences, joinEdges };
}

function formatFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : "unknown parser failure";
  return message.replace(/\s+/g, " ").trim().slice(0, 240);
}

export class NodeSqlPostgresqlParserAdapter implements ExternalSqlParser {
  readonly dialect = "postgresql" as const;
  readonly #parser: VendorParser;

  constructor() {
    this.#parser = new Parser();
  }

  parse(sql: string): ExternalSqlParseResult {
    try {
      const parsed = this.#parser.astify(sql, {
        parseOptions: { includeLocations: true },
      });
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
