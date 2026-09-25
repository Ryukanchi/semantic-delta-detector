import { analyzeSqlStructure } from "../parser/sqlStructure.js";

/** This boundary checks for evidence Semantic Delta can analyze, not SQL validity. */
export type SqlAnalyzabilityReason =
  | "empty"
  | "multiple_statements"
  | "not_a_select_query"
  | "no_query_structure";

export type SqlAnalyzabilityAssessment =
  | { ok: true }
  | { ok: false; reason: SqlAnalyzabilityReason; detail?: string };

export const UNANALYZABLE_SQL_CODE = "SEMANTIC_DELTA_UNANALYZABLE_SQL" as const;

export class UnanalyzableSqlInputError extends Error {
  readonly code = UNANALYZABLE_SQL_CODE;
  readonly query: "A" | "B";
  readonly reason: SqlAnalyzabilityReason;

  constructor(query: "A" | "B", assessment: Extract<SqlAnalyzabilityAssessment, { ok: false }>) {
    const explanation =
      assessment.reason === "empty"
        ? `Query ${query} SQL input must contain analyzable content.`
        : assessment.reason === "multiple_statements"
          ? `Query ${query} SQL input contains multiple top-level statements; Semantic Delta analyzes one SELECT query expression at a time.`
          : assessment.reason === "not_a_select_query"
            ? `Query ${query} SQL input is outside Semantic Delta's current SELECT-query scope${assessment.detail ? ` (${assessment.detail})` : ""}.`
            : `Query ${query} SQL input does not contain enough supported query structure for a semantic assessment.`;
    super(explanation);
    this.name = "UnanalyzableSqlInputError";
    this.query = query;
    this.reason = assessment.reason;
  }
}

interface SqlToken {
  kind: "word" | "atom" | "template" | "symbol";
  value: string;
  depth: number;
}

interface ScanResult {
  tokens: SqlToken[];
  uncertain: boolean;
}

/** A lexical mask keeps protected semicolons out of the statement count. */
function scanSql(sql: string): ScanResult {
  const tokens: SqlToken[] = [];
  let uncertain = false;
  let depth = 0;
  let index = 0;

  function push(kind: SqlToken["kind"], value: string): void {
    tokens.push({ kind, value: value.toLowerCase(), depth });
  }

  while (index < sql.length) {
    const current = sql[index];
    const next = sql[index + 1];
    if (/\s|\uFEFF/.test(current)) {
      index += 1;
      continue;
    }
    if (current === "-" && next === "-") {
      const lineEnd = sql.slice(index + 2).search(/[\r\n]/);
      index = lineEnd < 0 ? sql.length : index + 2 + lineEnd;
      continue;
    }
    if (current === "/" && next === "*") {
      let level = 1;
      index += 2;
      while (index < sql.length && level > 0) {
        if (sql[index] === "/" && sql[index + 1] === "*") {
          level += 1;
          index += 2;
        } else if (sql[index] === "*" && sql[index + 1] === "/") {
          level -= 1;
          index += 2;
        } else {
          index += 1;
        }
      }
      if (level > 0) uncertain = true;
      continue;
    }
    if (current === "{" && (next === "{" || next === "%" || next === "#")) {
      const closing = next === "{" ? "}}" : next === "%" ? "%}" : "#}";
      const end = sql.indexOf(closing, index + 2);
      if (end < 0) {
        uncertain = true;
        push(next === "{" ? "template" : "atom", "template");
        break;
      }
      if (next === "{") push("template", "template");
      index = end + 2;
      continue;
    }
    if (current === "'" || current === '"' || current === "`" || current === "[") {
      const closing = current === "[" ? "]" : current;
      index += 1;
      let terminated = false;
      while (index < sql.length) {
        if (sql[index] === "\\" && current !== "[") {
          index += 2;
        } else if (sql[index] === closing && sql[index + 1] === closing) {
          index += 2;
        } else if (sql[index] === closing) {
          index += 1;
          terminated = true;
          break;
        } else {
          index += 1;
        }
      }
      if (!terminated) uncertain = true;
      push("atom", "quoted");
      continue;
    }
    if (current === "$") {
      const delimiter = sql.slice(index).match(/^\$(?:[a-z_][a-z0-9_]*)?\$/i)?.[0];
      if (delimiter) {
        const end = sql.indexOf(delimiter, index + delimiter.length);
        if (end < 0) {
          uncertain = true;
          index = sql.length;
        } else {
          index = end + delimiter.length;
        }
        push("atom", "quoted");
        continue;
      }
    }
    if (/[a-z_]/i.test(current)) {
      const start = index;
      index += 1;
      while (index < sql.length && /[a-z0-9_$]/i.test(sql[index])) index += 1;
      push("word", sql.slice(start, index));
      continue;
    }
    if (/[0-9]/.test(current)) {
      index += 1;
      while (index < sql.length && /[0-9._]/.test(sql[index])) index += 1;
      push("atom", "number");
      continue;
    }
    if (current === ")") depth = Math.max(0, depth - 1);
    push("symbol", current);
    if (current === "(") depth += 1;
    index += 1;
  }
  return { tokens, uncertain };
}

function isWord(token: SqlToken | undefined, value: string): boolean {
  return token?.kind === "word" && token.value === value;
}

function matchingClose(tokens: SqlToken[], openingIndex: number): number {
  const opening = tokens[openingIndex];
  if (opening?.value !== "(") return -1;
  for (let index = openingIndex + 1; index < tokens.length; index += 1) {
    if (tokens[index].value === ")" && tokens[index].depth === opening.depth) {
      return index;
    }
  }
  return -1;
}

const CLAUSE_START = new Set([
  "from", "where", "group", "having", "window", "qualify", "order", "limit", "offset",
  "fetch", "for", "union", "intersect", "except",
]);
const SOURCE_END = new Set([
  "where", "group", "having", "window", "qualify", "order", "limit", "offset",
  "fetch", "for", "union", "intersect", "except",
]);
const INVALID_BARE_SOURCE_START = new Set([
  "all", "as", "by", "cross", "distinct", "full", "inner", "join", "left", "natural",
  "on", "outer", "right", "select", "using",
]);

function mainStatementIndex(tokens: SqlToken[], start: number): number | null {
  let index = start;
  while (tokens[index]?.value === "(") index += 1;
  if (!isWord(tokens[index], "with")) return index;
  index += 1;
  if (isWord(tokens[index], "recursive")) index += 1;

  while (index < tokens.length) {
    if (tokens[index]?.kind !== "word" && tokens[index]?.kind !== "atom") return null;
    index += 1;
    if (tokens[index]?.value === "(") {
      const close = matchingClose(tokens, index);
      if (close < 0) return null;
      index = close + 1;
    }
    if (!isWord(tokens[index], "as")) return null;
    index += 1;
    if (isWord(tokens[index], "not")) index += 1;
    if (isWord(tokens[index], "materialized")) index += 1;
    if (tokens[index]?.value !== "(") return null;
    const close = matchingClose(tokens, index);
    if (close < 0) return null;
    index = close + 1;
    if (tokens[index]?.value !== ",") return index;
    index += 1;
  }
  return null;
}

function hasRootStructure(tokens: SqlToken[], selectIndex: number): boolean {
  const rootDepth = tokens[selectIndex].depth;
  let index = selectIndex + 1;
  if (isWord(tokens[index], "distinct") || isWord(tokens[index], "all")) {
    const distinct = isWord(tokens[index], "distinct");
    index += 1;
    if (distinct && isWord(tokens[index], "on")) {
      if (tokens[index + 1]?.value !== "(") return false;
      const close = matchingClose(tokens, index + 1);
      if (close < 0) return false;
      index = close + 1;
    }
  }
  if (isWord(tokens[index], "top")) {
    index += 1;
    if (tokens[index]?.value === "(") {
      const close = matchingClose(tokens, index);
      if (close >= 0) index = close + 1;
    } else if (tokens[index]?.kind === "atom") {
      index += 1;
    }
    if (isWord(tokens[index], "percent")) index += 1;
    if (isWord(tokens[index], "with") && isWord(tokens[index + 1], "ties")) index += 2;
  }

  let projection = false;
  let fromIndex = -1;
  for (; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.depth < rootDepth || (token.depth === rootDepth && token.value === ";")) break;
    if (token.depth === rootDepth && token.kind === "word" && CLAUSE_START.has(token.value)) {
      if (token.value === "from") fromIndex = index;
      break;
    }
    if (token.depth === rootDepth && token.value === ")") break;
    if (token.kind !== "symbol" || token.value === "*") {
      projection = true;
    }
  }
  if (projection) return true;
  if (fromIndex < 0) return false;

  for (index = fromIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.depth < rootDepth || (token.depth === rootDepth && token.value === ";")) break;
    if (token.depth === rootDepth && token.kind === "word" && SOURCE_END.has(token.value)) break;
    if (token.depth === rootDepth && token.kind === "word" && ["lateral", "only"].includes(token.value)) continue;
    if (token.depth === rootDepth && token.kind === "word" && INVALID_BARE_SOURCE_START.has(token.value)) break;
    if (token.kind === "word" || token.kind === "atom" || token.kind === "template" || token.value === "(") {
      return true;
    }
  }
  return false;
}

export function assessSqlAnalyzability(sql: string): SqlAnalyzabilityAssessment {
  const { tokens, uncertain } = scanSql(sql);
  const content = tokens.filter((token) => token.value !== ";" && token.kind !== "template");
  if (content.length === 0) return { ok: false, reason: "empty" };

  if (!uncertain) {
    const firstSeparator = tokens.findIndex((token) => token.value === ";" && token.depth === 0);
    if (
      firstSeparator >= 0 &&
      tokens.slice(firstSeparator + 1).some((token) => token.value !== ";" && token.kind !== "template")
    ) {
      return { ok: false, reason: "multiple_statements" };
    }
  }

  const first = tokens.findIndex((token) => token.kind !== "template");
  const mainIndex = mainStatementIndex(tokens, first);
  if (mainIndex === null || !tokens[mainIndex] || tokens[mainIndex].value === ";") {
    return { ok: false, reason: "no_query_structure" };
  }
  if (!isWord(tokens[mainIndex], "select")) {
    return {
      ok: false,
      reason: "not_a_select_query",
      detail: tokens[mainIndex].kind === "word" ? tokens[mainIndex].value.toUpperCase() : undefined,
    };
  }
  if (!hasRootStructure(tokens, mainIndex)) {
    return { ok: false, reason: "no_query_structure" };
  }

  // The verdict engine uses this lightweight root, so lexical evidence alone
  // must not admit a query expression that the engine cannot actually see.
  const root = analyzeSqlStructure(sql).root;
  return root.selectExpressions.length > 0 || root.sources.length > 0
    ? { ok: true }
    : { ok: false, reason: "no_query_structure" };
}
