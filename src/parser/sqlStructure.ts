import type { ParsedSqlQuery, SqlJoinClause } from "../types.js";

const AGGREGATION_NAMES = new Set(["count", "sum", "avg", "min", "max"]);
const SOURCE_BOUNDARY_WORDS = new Set([
  "cross",
  "full",
  "inner",
  "join",
  "left",
  "on",
  "outer",
  "right",
  "using",
]);

export interface SqlAggregationSummary {
  functionName: string;
  argument: string;
  distinct: boolean;
  canonical: string;
  display: string;
}

export interface SqlSourceSummary {
  name: string;
  alias: string;
  joinType: SqlJoinClause["type"] | null;
}

export interface SqlQueryScopeSummary {
  sql: string;
  selectExpressions: string[];
  canonicalSelectExpressions: string[];
  sources: SqlSourceSummary[];
  aliases: ReadonlyMap<string, string>;
  aggregations: SqlAggregationSummary[];
  whereClause: string | null;
}

export interface SqlStructureSummary {
  root: SqlQueryScopeSummary;
}

const structureCache = new WeakMap<ParsedSqlQuery, SqlStructureSummary>();

export function stripSqlComments(input: string): string {
  let result = "";
  let index = 0;
  let state: "normal" | "line-comment" | "block-comment" | "single-quote" | "double-quote" =
    "normal";

  while (index < input.length) {
    const current = input[index];
    const next = input[index + 1];

    if (state === "line-comment") {
      if (current === "\n" || current === "\r") {
        result += current;
        state = "normal";
      }
      index += 1;
      continue;
    }

    if (state === "block-comment") {
      if (current === "*" && next === "/") {
        state = "normal";
        index += 2;
      } else {
        index += 1;
      }
      continue;
    }

    result += current;

    if (state === "single-quote") {
      if (current === "'" && next === "'") {
        result += next;
        index += 2;
        continue;
      }
      if (current === "'") {
        state = "normal";
      }
      index += 1;
      continue;
    }

    if (state === "double-quote") {
      if (current === '"' && next === '"') {
        result += next;
        index += 2;
        continue;
      }
      if (current === '"') {
        state = "normal";
      }
      index += 1;
      continue;
    }

    if (current === "-" && next === "-") {
      result = result.slice(0, -1);
      state = "line-comment";
      index += 2;
      continue;
    }

    if (current === "/" && next === "*") {
      result = result.slice(0, -1);
      state = "block-comment";
      index += 2;
      continue;
    }

    if (current === "'") {
      state = "single-quote";
    } else if (current === '"') {
      state = "double-quote";
    }
    index += 1;
  }

  return result;
}

function isIdentifierCharacter(value: string | undefined): boolean {
  return Boolean(value && /[a-zA-Z0-9_$]/.test(value));
}

function matchesKeyword(input: string, index: number, keyword: string): boolean {
  if (input.slice(index, index + keyword.length).toLowerCase() !== keyword) {
    return false;
  }

  return (
    !isIdentifierCharacter(input[index - 1]) &&
    !isIdentifierCharacter(input[index + keyword.length])
  );
}

function findTopLevelKeyword(input: string, keyword: string, start = 0): number {
  let depth = 0;
  let quote: "'" | '"' | null = null;

  for (let index = start; index < input.length; index += 1) {
    const current = input[index];
    const next = input[index + 1];

    if (quote) {
      if (current === quote && next === quote) {
        index += 1;
      } else if (current === quote) {
        quote = null;
      }
      continue;
    }

    if (current === "'" || current === '"') {
      quote = current;
      continue;
    }
    if (current === "(") {
      depth += 1;
      continue;
    }
    if (current === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth === 0 && matchesKeyword(input, index, keyword)) {
      return index;
    }
  }

  return -1;
}

function findMatchingParenthesis(input: string, openingIndex: number): number {
  let depth = 0;
  let quote: "'" | '"' | null = null;

  for (let index = openingIndex; index < input.length; index += 1) {
    const current = input[index];
    const next = input[index + 1];

    if (quote) {
      if (current === quote && next === quote) {
        index += 1;
      } else if (current === quote) {
        quote = null;
      }
      continue;
    }

    if (current === "'" || current === '"') {
      quote = current;
    } else if (current === "(") {
      depth += 1;
    } else if (current === ")") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function normalizeWhitespace(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

function splitTopLevel(input: string, separator: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: "'" | '"' | null = null;

  for (let index = 0; index < input.length; index += 1) {
    const current = input[index];
    const next = input[index + 1];

    if (quote) {
      if (current === quote && next === quote) {
        index += 1;
      } else if (current === quote) {
        quote = null;
      }
      continue;
    }

    if (current === "'" || current === '"') {
      quote = current;
    } else if (current === "(") {
      depth += 1;
    } else if (current === ")") {
      depth = Math.max(0, depth - 1);
    } else if (depth === 0 && current === separator) {
      const part = normalizeWhitespace(input.slice(start, index));
      if (part) {
        parts.push(part);
      }
      start = index + 1;
    }
  }

  const tail = normalizeWhitespace(input.slice(start));
  if (tail) {
    parts.push(tail);
  }
  return parts;
}

function readIdentifier(input: string, start: number): { value: string; end: number } | null {
  let index = start;
  while (/\s/.test(input[index] ?? "")) {
    index += 1;
  }
  const begin = index;

  while (index < input.length && /[a-zA-Z0-9_$."]/i.test(input[index])) {
    index += 1;
  }

  if (index === begin) {
    return null;
  }

  return {
    value: input.slice(begin, index).replace(/"/g, "").toLowerCase(),
    end: index,
  };
}

function readOptionalAlias(
  input: string,
  start: number,
): { alias: string | null; end: number } {
  let index = start;
  while (/\s/.test(input[index] ?? "")) {
    index += 1;
  }

  if (matchesKeyword(input, index, "as")) {
    index += 2;
    const explicitAlias = readIdentifier(input, index);
    return explicitAlias
      ? { alias: explicitAlias.value, end: explicitAlias.end }
      : { alias: null, end: index };
  }

  const implicitAlias = readIdentifier(input, index);
  if (!implicitAlias || SOURCE_BOUNDARY_WORDS.has(implicitAlias.value)) {
    return { alias: null, end: start };
  }

  return { alias: implicitAlias.value, end: implicitAlias.end };
}

function normalizeJoinType(value: string): SqlJoinClause["type"] {
  if (/\bleft\b/i.test(value)) return "left";
  if (/\bright\b/i.test(value)) return "right";
  if (/\bfull\b/i.test(value)) return "full";
  if (/\bcross\b/i.test(value)) return "cross";
  return "inner";
}

function extractSources(fromClause: string): SqlSourceSummary[] {
  const sources: SqlSourceSummary[] = [];
  let index = 0;
  let expectSource = true;
  let pendingJoinType: SqlJoinClause["type"] | null = null;
  let depth = 0;
  let quote: "'" | '"' | null = null;
  let lastBoundary = 0;

  while (index < fromClause.length) {
    const current = fromClause[index];
    const next = fromClause[index + 1];

    if (quote) {
      if (current === quote && next === quote) {
        index += 2;
        continue;
      }
      if (current === quote) quote = null;
      index += 1;
      continue;
    }
    if (current === "'" || current === '"') {
      quote = current;
      index += 1;
      continue;
    }
    if (current === "(") {
      depth += 1;
      index += 1;
      continue;
    }
    if (current === ")") {
      depth = Math.max(0, depth - 1);
      index += 1;
      continue;
    }

    if (depth === 0 && expectSource) {
      const identifier = readIdentifier(fromClause, index);
      if (identifier) {
        const alias = readOptionalAlias(fromClause, identifier.end);
        const baseName = identifier.value.split(".").at(-1) ?? identifier.value;
        sources.push({
          name: identifier.value,
          alias: alias.alias ?? baseName,
          joinType: pendingJoinType,
        });
        index = Math.max(identifier.end, alias.end);
        expectSource = false;
        lastBoundary = index;
        continue;
      }
    }

    if (depth === 0 && current === ",") {
      expectSource = true;
      pendingJoinType = "inner";
      index += 1;
      lastBoundary = index;
      continue;
    }

    if (depth === 0 && matchesKeyword(fromClause, index, "join")) {
      pendingJoinType = normalizeJoinType(fromClause.slice(lastBoundary, index));
      expectSource = true;
      index += 4;
      lastBoundary = index;
      continue;
    }

    index += 1;
  }

  return sources;
}

function stripOutputAlias(expression: string): string {
  return expression
    .replace(/\s+as\s+[a-zA-Z_][a-zA-Z0-9_$]*\s*$/i, "")
    .trim();
}

export function canonicalizeSqlExpression(
  expression: string,
  aliases: ReadonlyMap<string, string>,
): string {
  const withoutAlias = stripOutputAlias(normalizeWhitespace(expression));
  const parts = withoutAlias.split(/('(?:''|[^'])*')/g);
  const sourceCount = new Set(aliases.values()).size;

  return parts
    .map((part, index) => {
      if (index % 2 === 1) {
        return part;
      }

      return part
        .toLowerCase()
        .replace(
          /\b([a-zA-Z_][a-zA-Z0-9_$]*)\s*\.\s*([a-zA-Z_][a-zA-Z0-9_$]*|\*)/g,
          (_match, qualifier: string, field: string) => {
            const resolvedSource = aliases.get(qualifier.toLowerCase());
            if (resolvedSource && sourceCount === 1) {
              return field.toLowerCase();
            }
            return `${resolvedSource ?? qualifier.toLowerCase()}.${field.toLowerCase()}`;
          },
        )
        .replace(/\s*([(),])\s*/g, "$1")
        .replace(/\s+/g, " ")
        ;
    })
    .join("")
    .trim();
}

function extractAggregations(
  expressions: string[],
  aliases: ReadonlyMap<string, string>,
): SqlAggregationSummary[] {
  const aggregations: SqlAggregationSummary[] = [];

  for (const expression of expressions) {
    const lower = expression.toLowerCase();
    for (let index = 0; index < expression.length; index += 1) {
      if (!/[a-z_]/i.test(expression[index])) {
        continue;
      }

      const nameMatch = lower.slice(index).match(/^([a-z_][a-z0-9_$]*)/);
      if (!nameMatch) continue;
      const functionName = nameMatch[1];
      index += functionName.length - 1;
      if (!AGGREGATION_NAMES.has(functionName)) continue;

      let openingIndex = index + 1;
      while (/\s/.test(expression[openingIndex] ?? "")) openingIndex += 1;
      if (expression[openingIndex] !== "(") continue;
      const closingIndex = findMatchingParenthesis(expression, openingIndex);
      if (closingIndex < 0) continue;

      const rawArgument = normalizeWhitespace(
        expression.slice(openingIndex + 1, closingIndex),
      );
      const distinctMatch = rawArgument.match(/^distinct\s+(.+)$/i);
      const distinct = Boolean(distinctMatch);
      const argument = canonicalizeSqlExpression(
        distinctMatch?.[1] ?? rawArgument,
        aliases,
      );
      const canonical = `${functionName}(${distinct ? "distinct " : ""}${argument})`;
      aggregations.push({
        functionName,
        argument,
        distinct,
        canonical,
        display: `${functionName.toUpperCase()}(${distinct ? "DISTINCT " : ""}${argument})`,
      });
      index = closingIndex;
    }
  }

  return aggregations;
}

function getClauseEnd(sql: string, fromIndex: number): number {
  const boundaries = ["where", "group", "having", "order", "limit", "union"]
    .map((keyword) => findTopLevelKeyword(sql, keyword, fromIndex))
    .filter((index) => index >= 0);
  return boundaries.length > 0 ? Math.min(...boundaries) : sql.length;
}

export function analyzeSqlStructure(rawQuery: string): SqlStructureSummary {
  const sql = stripSqlComments(rawQuery).trim().replace(/;+\s*$/, "");
  const selectIndex = findTopLevelKeyword(sql, "select");
  const fromIndex = selectIndex >= 0 ? findTopLevelKeyword(sql, "from", selectIndex + 6) : -1;
  const selectExpressions =
    selectIndex >= 0
      ? splitTopLevel(
          sql.slice(selectIndex + 6, fromIndex >= 0 ? fromIndex : sql.length),
          ",",
        )
      : [];
  const fromEnd = fromIndex >= 0 ? getClauseEnd(sql, fromIndex + 4) : -1;
  const fromClause = fromIndex >= 0 ? sql.slice(fromIndex + 4, fromEnd) : "";
  const sources = extractSources(fromClause);
  const aliases = new Map<string, string>();
  for (const source of sources) {
    aliases.set(source.alias, source.name);
    aliases.set(source.name.split(".").at(-1) ?? source.name, source.name);
  }
  const whereIndex = findTopLevelKeyword(sql, "where", fromIndex >= 0 ? fromIndex + 4 : 0);
  const whereClause =
    whereIndex >= 0
      ? normalizeWhitespace(sql.slice(whereIndex + 5, getClauseEnd(sql, whereIndex + 5)))
      : null;
  const canonicalSelectExpressions = selectExpressions.map((expression) =>
    canonicalizeSqlExpression(expression, aliases),
  );

  return {
    root: {
      sql,
      selectExpressions,
      canonicalSelectExpressions,
      sources,
      aliases,
      aggregations: extractAggregations(selectExpressions, aliases),
      whereClause,
    },
  };
}

export function cacheSqlStructure(
  query: ParsedSqlQuery,
  structure: SqlStructureSummary,
): void {
  structureCache.set(query, structure);
}

export function getSqlStructure(query: ParsedSqlQuery): SqlStructureSummary {
  const cached = structureCache.get(query);
  if (cached) return cached;

  const structure = analyzeSqlStructure(query.rawQuery);
  structureCache.set(query, structure);
  return structure;
}
