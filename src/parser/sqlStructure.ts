import type { ParsedSqlQuery, SqlJoinClause } from "../types.js";

const AGGREGATION_NAMES = new Set(["count", "sum", "avg", "min", "max"]);
const SOURCE_BOUNDARY_WORDS = new Set([
  "cross", "full", "inner", "join", "left", "on", "outer", "right", "using",
]);
const MAX_SCOPE_DEPTH = 12;

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
  kind: "table" | "cte" | "derived";
  scope?: SqlQueryScopeSummary;
}

export interface SqlCteSummary {
  name: string;
  scope: SqlQueryScopeSummary;
}

export interface SqlSubquerySummary {
  context: "select" | "filter";
  operator: "in" | "not in" | "exists" | "not exists" | "scalar";
  correlated: boolean;
  scope: SqlQueryScopeSummary;
}

export interface SqlCaseSummary {
  canonical: string;
  conditions: string[];
  results: string[];
}

export interface SqlBooleanExpressionSummary {
  kind: "predicate" | "not" | "and" | "or";
  canonical: string;
  predicates: string[];
  operators: Array<"and" | "or">;
  hasNegation: boolean;
  children: SqlBooleanExpressionSummary[];
}

export interface SqlQueryScopeSummary {
  kind: "root" | "cte" | "subquery" | "derived";
  name?: string;
  sql: string;
  selectExpressions: string[];
  canonicalSelectExpressions: string[];
  sources: SqlSourceSummary[];
  aliases: ReadonlyMap<string, string>;
  aggregations: SqlAggregationSummary[];
  groupByExpressions: string[];
  canonicalGroupByExpressions: string[];
  joinPredicates: string[];
  whereClause: string | null;
  canonicalWhereClause: string | null;
  ctes: SqlCteSummary[];
  subqueries: SqlSubquerySummary[];
  cases: SqlCaseSummary[];
  booleanExpression: SqlBooleanExpressionSummary | null;
  depthLimited: boolean;
}

export interface SqlStructureSummary {
  root: SqlQueryScopeSummary;
  depthLimited: boolean;
}

export interface ReachableNestedScope {
  label: string;
  operator: SqlSubquerySummary["operator"] | null;
  correlated: boolean;
  scope: SqlQueryScopeSummary;
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
      if (current === "'") state = "normal";
      index += 1;
      continue;
    }
    if (state === "double-quote") {
      if (current === '"' && next === '"') {
        result += next;
        index += 2;
        continue;
      }
      if (current === '"') state = "normal";
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
    if (current === "'") state = "single-quote";
    else if (current === '"') state = "double-quote";
    index += 1;
  }
  return result;
}

function normalizeWhitespace(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

function isIdentifierCharacter(value: string | undefined): boolean {
  return Boolean(value && /[a-zA-Z0-9_$]/.test(value));
}

function matchesKeyword(input: string, index: number, keyword: string): boolean {
  return (
    input.slice(index, index + keyword.length).toLowerCase() === keyword &&
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
      if (current === quote && next === quote) index += 1;
      else if (current === quote) quote = null;
      continue;
    }
    if (current === "'" || current === '"') quote = current;
    else if (current === "(") depth += 1;
    else if (current === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && matchesKeyword(input, index, keyword)) return index;
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
      if (current === quote && next === quote) index += 1;
      else if (current === quote) quote = null;
      continue;
    }
    if (current === "'" || current === '"') quote = current;
    else if (current === "(") depth += 1;
    else if (current === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
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
      if (current === quote && next === quote) index += 1;
      else if (current === quote) quote = null;
      continue;
    }
    if (current === "'" || current === '"') quote = current;
    else if (current === "(") depth += 1;
    else if (current === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && current === separator) {
      const part = normalizeWhitespace(input.slice(start, index));
      if (part) parts.push(part);
      start = index + 1;
    }
  }
  const tail = normalizeWhitespace(input.slice(start));
  if (tail) parts.push(tail);
  return parts;
}

function skipWhitespace(input: string, start: number): number {
  let index = start;
  while (/\s/.test(input[index] ?? "")) index += 1;
  return index;
}

function readIdentifier(input: string, start: number): { value: string; end: number } | null {
  let index = skipWhitespace(input, start);
  const begin = index;
  while (index < input.length && /[a-zA-Z0-9_$."]/i.test(input[index])) index += 1;
  if (index === begin) return null;
  return {
    value: input.slice(begin, index).replace(/"/g, "").toLowerCase(),
    end: index,
  };
}

function readOptionalAlias(input: string, start: number): { alias: string | null; end: number } {
  let index = skipWhitespace(input, start);
  if (matchesKeyword(input, index, "as")) {
    index = skipWhitespace(input, index + 2);
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

function stripOutputAlias(expression: string): string {
  const explicit = expression.replace(
    /\s+as\s+[a-zA-Z_][a-zA-Z0-9_$]*\s*$/i,
    "",
  );
  if (explicit !== expression) return explicit.trim();

  const implicit = expression.match(/^(.*\S)\s+([a-zA-Z_][a-zA-Z0-9_$]*)\s*$/);
  if (!implicit) return expression.trim();
  const candidateExpression = implicit[1].trim();
  const candidateAlias = implicit[2].toLowerCase();
  const nonAliasKeywords = new Set([
    "and", "asc", "desc", "distinct", "else", "end", "from", "nulls", "or",
    "then", "when",
  ]);
  if (
    nonAliasKeywords.has(candidateAlias) ||
    /(?:^|\s)distinct$/i.test(candidateExpression) ||
    /[+\-*/%<>=.,]$/.test(candidateExpression)
  ) {
    return expression.trim();
  }
  return candidateExpression;
}

export function canonicalizeSqlExpression(
  expression: string,
  aliases: ReadonlyMap<string, string>,
  removeOutputAlias = false,
): string {
  const normalizedExpression = normalizeWhitespace(expression);
  const withoutAlias = removeOutputAlias
    ? stripOutputAlias(normalizedExpression)
    : normalizedExpression;
  const parts = withoutAlias.split(/('(?:''|[^'])*')/g);
  const sourceCount = new Set(aliases.values()).size;
  return parts
    .map((part, index) => {
      if (index % 2 === 1) return part;
      return part
        .toLowerCase()
        .replace(
          /\b([a-zA-Z_][a-zA-Z0-9_$]*)\s*\.\s*([a-zA-Z_][a-zA-Z0-9_$]*|\*)/g,
          (_match, qualifier: string, field: string) => {
            const resolvedSource = aliases.get(qualifier.toLowerCase());
            if (resolvedSource && sourceCount === 1) return field.toLowerCase();
            return (resolvedSource ?? qualifier.toLowerCase()) + "." + field.toLowerCase();
          },
        )
        .replace(/\s*([(),])\s*/g, "$1")
        .replace(/\s+/g, " ");
    })
    .join("")
    .trim();
}

function findCaseRanges(input: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let quote: "'" | '"' | null = null;
  let caseDepth = 0;
  let start = -1;

  for (let index = 0; index < input.length; index += 1) {
    const current = input[index];
    const next = input[index + 1];
    if (quote) {
      if (current === quote && next === quote) index += 1;
      else if (current === quote) quote = null;
      continue;
    }
    if (current === "'" || current === '"') {
      quote = current;
      continue;
    }
    if (matchesKeyword(input, index, "case")) {
      if (caseDepth === 0) start = index;
      caseDepth += 1;
      index += 3;
      continue;
    }
    if (caseDepth > 0 && matchesKeyword(input, index, "end")) {
      caseDepth -= 1;
      if (caseDepth === 0 && start >= 0) {
        ranges.push({ start, end: index + 3 });
        start = -1;
      }
      index += 2;
    }
  }
  return ranges;
}

function findTopLevelCaseKeywords(
  caseExpression: string,
): Array<{ keyword: "when" | "then" | "else" | "end"; start: number; end: number }> {
  const keywords: Array<{
    keyword: "when" | "then" | "else" | "end";
    start: number;
    end: number;
  }> = [];
  let nestedCaseDepth = 0;
  let quote: "'" | '"' | null = null;

  for (let index = 4; index < caseExpression.length; index += 1) {
    const current = caseExpression[index];
    const next = caseExpression[index + 1];
    if (quote) {
      if (current === quote && next === quote) index += 1;
      else if (current === quote) quote = null;
      continue;
    }
    if (current === "'" || current === '"') {
      quote = current;
      continue;
    }
    if (matchesKeyword(caseExpression, index, "case")) {
      nestedCaseDepth += 1;
      index += 3;
      continue;
    }
    if (matchesKeyword(caseExpression, index, "end")) {
      if (nestedCaseDepth > 0) {
        nestedCaseDepth -= 1;
      } else {
        keywords.push({ keyword: "end", start: index, end: index + 3 });
        break;
      }
      index += 2;
      continue;
    }
    if (nestedCaseDepth > 0) continue;
    for (const keyword of ["when", "then", "else"] as const) {
      if (matchesKeyword(caseExpression, index, keyword)) {
        keywords.push({ keyword, start: index, end: index + keyword.length });
        index += keyword.length - 1;
        break;
      }
    }
  }
  return keywords;
}

function summarizeCaseExpression(
  caseExpression: string,
  aliases: ReadonlyMap<string, string>,
): SqlCaseSummary {
  const keywords = findTopLevelCaseKeywords(caseExpression);
  const conditions: string[] = [];
  const results: string[] = [];
  const firstWhen = keywords.find((item) => item.keyword === "when");
  const baseExpression = firstWhen
    ? canonicalizeSqlExpression(caseExpression.slice(4, firstWhen.start), aliases)
    : "";

  for (let index = 0; index < keywords.length; index += 1) {
    const current = keywords[index];
    if (current.keyword === "when") {
      const then = keywords[index + 1];
      if (then?.keyword !== "then") continue;
      const condition = canonicalizeSqlExpression(
        caseExpression.slice(current.end, then.start),
        aliases,
      );
      conditions.push(baseExpression ? baseExpression + "=" + condition : condition);
      const nextBoundary = keywords[index + 2];
      results.push(
        canonicalizeSqlExpression(
          caseExpression.slice(then.end, nextBoundary?.start ?? caseExpression.length),
          aliases,
        ),
      );
    } else if (current.keyword === "else") {
      const end = keywords[index + 1];
      results.push(
        canonicalizeSqlExpression(
          caseExpression.slice(current.end, end?.start ?? caseExpression.length),
          aliases,
        ),
      );
    }
  }

  return {
    canonical:
      "case(" + conditions.join("|") + "=>" + results.join("|") + ")",
    conditions,
    results,
  };
}

function extractCaseSummaries(
  fragments: string[],
  aliases: ReadonlyMap<string, string>,
): SqlCaseSummary[] {
  return fragments.flatMap((fragment) =>
    findCaseRanges(fragment).map((range) =>
      summarizeCaseExpression(fragment.slice(range.start, range.end), aliases),
    ),
  );
}

function replaceCaseExpressions(input: string): string {
  const ranges = findCaseRanges(input);
  if (ranges.length === 0) return input;
  let result = "";
  let cursor = 0;
  for (const range of ranges) {
    result += input.slice(cursor, range.start) + "__case_expression__";
    cursor = range.end;
  }
  return result + input.slice(cursor);
}

function stripBalancedOuterParentheses(input: string): string {
  let result = normalizeWhitespace(input);
  while (result.startsWith("(")) {
    const closing = findMatchingParenthesis(result, 0);
    if (closing !== result.length - 1) break;
    result = normalizeWhitespace(result.slice(1, -1));
  }
  return result;
}

function splitTopLevelBoolean(input: string, operator: "and" | "or"): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let caseDepth = 0;
  let betweenPending = false;
  let quote: "'" | '"' | null = null;

  for (let index = 0; index < input.length; index += 1) {
    const current = input[index];
    const next = input[index + 1];
    if (quote) {
      if (current === quote && next === quote) index += 1;
      else if (current === quote) quote = null;
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
    if (depth > 0) continue;
    if (matchesKeyword(input, index, "case")) {
      caseDepth += 1;
      index += 3;
      continue;
    }
    if (caseDepth > 0 && matchesKeyword(input, index, "end")) {
      caseDepth -= 1;
      index += 2;
      continue;
    }
    if (caseDepth > 0) continue;
    if (matchesKeyword(input, index, "between")) {
      betweenPending = true;
      index += 6;
      continue;
    }
    if (betweenPending && matchesKeyword(input, index, "and")) {
      betweenPending = false;
      index += 2;
      continue;
    }
    if (matchesKeyword(input, index, operator)) {
      parts.push(normalizeWhitespace(input.slice(start, index)));
      start = index + operator.length;
      index += operator.length - 1;
    }
  }

  if (parts.length === 0) return [normalizeWhitespace(input)];
  parts.push(normalizeWhitespace(input.slice(start)));
  return parts.filter(Boolean);
}

function buildBooleanNode(
  kind: "and" | "or",
  children: SqlBooleanExpressionSummary[],
): SqlBooleanExpressionSummary {
  const canonicalChildren = children.map((child) => child.canonical).sort();
  return {
    kind,
    canonical: kind + "(" + canonicalChildren.join(",") + ")",
    predicates: [...new Set(children.flatMap((child) => child.predicates))].sort(),
    operators: [kind, ...children.flatMap((child) => child.operators)],
    hasNegation: children.some((child) => child.hasNegation),
    children,
  };
}

function normalizeCommutativeComparison(input: string): string {
  let depth = 0;
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < input.length; index += 1) {
    const current = input[index];
    const next = input[index + 1];
    if (quote) {
      if (current === quote && next === quote) index += 1;
      else if (current === quote) quote = null;
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
    if (depth !== 0) continue;

    const twoCharacterOperator = input.slice(index, index + 2);
    const isEquality =
      current === "=" &&
      input[index - 1] !== "<" &&
      input[index - 1] !== ">" &&
      input[index - 1] !== "!" &&
      next !== "=";
    if (!isEquality && twoCharacterOperator !== "<>" && twoCharacterOperator !== "!=") {
      continue;
    }

    const operatorLength = isEquality ? 1 : 2;
    const left = normalizeWhitespace(input.slice(0, index));
    const right = normalizeWhitespace(input.slice(index + operatorLength));
    if (!left || !right) return input;
    const operandRank = (operand: string): number =>
      /^[a-z_][a-z0-9_$.#]*$/i.test(operand) &&
      !/^(?:false|null|true)$/i.test(operand)
        ? 0
        : 1;
    const operands = [left, right].sort(
      (a, b) => operandRank(a) - operandRank(b) || a.localeCompare(b),
    );
    return operands[0] + " " + (isEquality ? "=" : "!=") + " " + operands[1];
  }
  return input;
}

function negateBooleanNode(
  child: SqlBooleanExpressionSummary,
): SqlBooleanExpressionSummary {
  if (child.kind === "not") {
    return child.children[0] ?? child;
  }
  if (child.kind === "and" || child.kind === "or") {
    return buildBooleanNode(
      child.kind === "and" ? "or" : "and",
      child.children.map((nested) => negateBooleanNode(nested)),
    );
  }
  return {
    kind: "not",
    canonical: "not(" + child.canonical + ")",
    predicates: child.predicates,
    operators: child.operators,
    hasNegation: true,
    children: [child],
  };
}

function parseBooleanExpression(input: string): SqlBooleanExpressionSummary | null {
  const normalized = stripBalancedOuterParentheses(input);
  if (!normalized) return null;

  const orParts = splitTopLevelBoolean(normalized, "or");
  if (orParts.length > 1) {
    return buildBooleanNode(
      "or",
      orParts.map((part) => parseBooleanExpression(part)).filter(Boolean) as SqlBooleanExpressionSummary[],
    );
  }
  const andParts = splitTopLevelBoolean(normalized, "and");
  if (andParts.length > 1) {
    return buildBooleanNode(
      "and",
      andParts.map((part) => parseBooleanExpression(part)).filter(Boolean) as SqlBooleanExpressionSummary[],
    );
  }

  let remainder = normalized;
  let negations = 0;
  while (matchesKeyword(remainder, 0, "not")) {
    negations += 1;
    remainder = stripBalancedOuterParentheses(remainder.slice(3));
  }
  if (negations > 0) {
    const child = parseBooleanExpression(remainder);
    if (!child) return null;
    if (negations % 2 === 0) return child;
    return negateBooleanNode(child);
  }

  return {
    kind: "predicate",
    canonical: "predicate(" + normalizeCommutativeComparison(normalized) + ")",
    predicates: [normalizeCommutativeComparison(normalized)],
    operators: [],
    hasNegation: false,
    children: [],
  };
}

function extractAggregations(
  expressions: string[],
  aliases: ReadonlyMap<string, string>,
): SqlAggregationSummary[] {
  const aggregations: SqlAggregationSummary[] = [];
  for (const expression of expressions) {
    const lower = expression.toLowerCase();
    for (let index = 0; index < expression.length; index += 1) {
      if (!/[a-z_]/i.test(expression[index])) continue;
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
      const rawArgument = normalizeWhitespace(expression.slice(openingIndex + 1, closingIndex));
      const distinctMatch = rawArgument.match(/^distinct\s+(.+)$/i);
      const distinct = Boolean(distinctMatch);
      const argument = canonicalizeSqlExpression(
        replaceCaseExpressions(distinctMatch?.[1] ?? rawArgument),
        aliases,
      );
      const canonical =
        functionName + "(" + (distinct ? "distinct " : "") + argument + ")";
      aggregations.push({
        functionName,
        argument,
        distinct,
        canonical,
        display:
          functionName.toUpperCase() +
          "(" +
          (distinct ? "DISTINCT " : "") +
          argument +
          ")",
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

function findNextJoinBoundary(input: string, start: number): number {
  let depth = 0;
  let quote: "'" | '"' | null = null;
  for (let index = start; index < input.length; index += 1) {
    const current = input[index];
    const next = input[index + 1];
    if (quote) {
      if (current === quote && next === quote) index += 1;
      else if (current === quote) quote = null;
      continue;
    }
    if (current === "'" || current === '"') quote = current;
    else if (current === "(") depth += 1;
    else if (current === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && current === ",") return index;
    else if (depth === 0 && matchesKeyword(input, index, "join")) return index;
  }
  return input.length;
}

function extractJoinPredicates(
  fromClause: string,
  aliases: ReadonlyMap<string, string>,
): string[] {
  const predicates: string[] = [];
  let depth = 0;
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < fromClause.length; index += 1) {
    const current = fromClause[index];
    const next = fromClause[index + 1];
    if (quote) {
      if (current === quote && next === quote) index += 1;
      else if (current === quote) quote = null;
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
    if (depth !== 0) continue;

    if (matchesKeyword(fromClause, index, "using")) {
      const openingIndex = skipWhitespace(fromClause, index + 5);
      if (fromClause[openingIndex] !== "(") continue;
      const closingIndex = findMatchingParenthesis(fromClause, openingIndex);
      if (closingIndex < 0) continue;
      const fields = splitTopLevel(fromClause.slice(openingIndex + 1, closingIndex), ",")
        .map((field) => canonicalizeSqlExpression(field, aliases))
        .sort();
      predicates.push("using(" + fields.join(",") + ")");
      index = closingIndex;
      continue;
    }

    if (!matchesKeyword(fromClause, index, "on")) continue;
    const conditionStart = skipWhitespace(fromClause, index + 2);
    const boundary = findNextJoinBoundary(fromClause, conditionStart);
    const rawCondition = fromClause
      .slice(conditionStart, boundary)
      .replace(/\s+(?:(?:left|right|full|inner|cross)(?:\s+outer)?)\s*$/i, "")
      .trim();
    const canonical = canonicalizeSqlExpression(rawCondition, aliases);
    const booleanExpression = parseBooleanExpression(canonical);
    if (booleanExpression) predicates.push(booleanExpression.canonical);
    index = Math.max(index, boundary - 1);
  }
  return predicates;
}

function extractCtePrefix(
  sql: string,
  inheritedCtes: ReadonlyMap<string, SqlQueryScopeSummary>,
  depth: number,
): { mainSql: string; ctes: SqlCteSummary[]; availableCtes: Map<string, SqlQueryScopeSummary> } {
  const availableCtes = new Map(inheritedCtes);
  if (!matchesKeyword(sql, 0, "with")) return { mainSql: sql, ctes: [], availableCtes };
  const ctes: SqlCteSummary[] = [];
  let index = skipWhitespace(sql, 4);
  if (matchesKeyword(sql, index, "recursive")) index = skipWhitespace(sql, index + 9);
  while (index < sql.length) {
    const nameToken = readIdentifier(sql, index);
    if (!nameToken) break;
    const name = nameToken.value;
    index = skipWhitespace(sql, nameToken.end);
    if (sql[index] === "(") {
      const columnListEnd = findMatchingParenthesis(sql, index);
      if (columnListEnd < 0) break;
      index = skipWhitespace(sql, columnListEnd + 1);
    }
    if (!matchesKeyword(sql, index, "as")) break;
    index = skipWhitespace(sql, index + 2);
    if (sql[index] !== "(") break;
    const bodyEnd = findMatchingParenthesis(sql, index);
    if (bodyEnd < 0) break;
    const scope = parseSqlScope(
      sql.slice(index + 1, bodyEnd),
      "cte",
      name,
      availableCtes,
      new Map(),
      depth + 1,
    );
    ctes.push({ name, scope });
    availableCtes.set(name, scope);
    index = skipWhitespace(sql, bodyEnd + 1);
    if (sql[index] !== ",") {
      return { mainSql: sql.slice(index).trim(), ctes, availableCtes };
    }
    index = skipWhitespace(sql, index + 1);
  }
  return { mainSql: sql, ctes: [], availableCtes: new Map(inheritedCtes) };
}

function inferSubqueryOperator(prefix: string): SqlSubquerySummary["operator"] {
  const normalized = normalizeWhitespace(prefix).toLowerCase();
  if (/\bnot\s+exists\s*$/.test(normalized)) return "not exists";
  if (/\bexists\s*$/.test(normalized)) return "exists";
  if (/\bnot\s+in\s*$/.test(normalized)) return "not in";
  if (/\bin\s*$/.test(normalized)) return "in";
  return "scalar";
}

function scopeReferencesOuterSource(
  scope: SqlQueryScopeSummary,
  inheritedAliases: ReadonlyMap<string, string>,
): boolean {
  const where = scope.canonicalWhereClause ?? "";
  return [...new Set(inheritedAliases.values())].some((source) =>
    where.includes(source.toLowerCase() + "."),
  );
}

function extractSubqueries(
  fragment: string,
  context: SqlSubquerySummary["context"],
  cteScopes: ReadonlyMap<string, SqlQueryScopeSummary>,
  aliases: ReadonlyMap<string, string>,
  depth: number,
): { canonicalFragment: string; subqueries: SqlSubquerySummary[] } {
  const subqueries: SqlSubquerySummary[] = [];
  let result = "";
  let cursor = 0;
  let index = 0;
  let quote: "'" | '"' | null = null;
  while (index < fragment.length) {
    const current = fragment[index];
    const next = fragment[index + 1];
    if (quote) {
      if (current === quote && next === quote) index += 2;
      else {
        if (current === quote) quote = null;
        index += 1;
      }
      continue;
    }
    if (current === "'" || current === '"') {
      quote = current;
      index += 1;
      continue;
    }
    if (current !== "(") {
      index += 1;
      continue;
    }
    const closingIndex = findMatchingParenthesis(fragment, index);
    if (closingIndex < 0) break;
    const nestedSql = fragment.slice(index + 1, closingIndex).trim();
    if (!/^(?:select|with)\b/i.test(nestedSql)) {
      index += 1;
      continue;
    }
    const scope = parseSqlScope(
      nestedSql,
      "subquery",
      undefined,
      cteScopes,
      aliases,
      depth + 1,
    );
    subqueries.push({
      context,
      operator: inferSubqueryOperator(fragment.slice(0, index)),
      correlated: scopeReferencesOuterSource(scope, aliases),
      scope,
    });
    result += fragment.slice(cursor, index);
    result += "__subquery_" + subqueries.length + "__";
    cursor = closingIndex + 1;
    index = closingIndex + 1;
  }
  result += fragment.slice(cursor);
  return { canonicalFragment: result, subqueries };
}

function extractSources(
  fromClause: string,
  cteScopes: ReadonlyMap<string, SqlQueryScopeSummary>,
  inheritedAliases: ReadonlyMap<string, string>,
  scopeDepth: number,
): SqlSourceSummary[] {
  const sources: SqlSourceSummary[] = [];
  let index = 0;
  let expectSource = true;
  let pendingJoinType: SqlJoinClause["type"] | null = null;
  let parenthesisDepth = 0;
  let quote: "'" | '"' | null = null;
  let lastBoundary = 0;
  while (index < fromClause.length) {
    const current = fromClause[index];
    const next = fromClause[index + 1];
    if (quote) {
      if (current === quote && next === quote) index += 2;
      else {
        if (current === quote) quote = null;
        index += 1;
      }
      continue;
    }
    if (current === "'" || current === '"') {
      quote = current;
      index += 1;
      continue;
    }
    if (parenthesisDepth === 0 && expectSource && current === "(") {
      const closingIndex = findMatchingParenthesis(fromClause, index);
      if (closingIndex > index) {
        const nestedSql = fromClause.slice(index + 1, closingIndex).trim();
        const alias = readOptionalAlias(fromClause, closingIndex + 1);
        if (/^(?:select|with)\b/i.test(nestedSql)) {
          const sourceName = "derived_" + (sources.length + 1);
          sources.push({
            name: sourceName,
            alias: alias.alias ?? sourceName,
            joinType: pendingJoinType,
            kind: "derived",
            scope: parseSqlScope(
              nestedSql,
              "derived",
              sourceName,
              cteScopes,
              inheritedAliases,
              scopeDepth + 1,
            ),
          });
          index = Math.max(closingIndex + 1, alias.end);
          expectSource = false;
          lastBoundary = index;
          continue;
        }
      }
    }
    if (current === "(") {
      parenthesisDepth += 1;
      index += 1;
      continue;
    }
    if (current === ")") {
      parenthesisDepth = Math.max(0, parenthesisDepth - 1);
      index += 1;
      continue;
    }
    if (parenthesisDepth === 0 && expectSource) {
      const identifier = readIdentifier(fromClause, index);
      if (identifier) {
        const alias = readOptionalAlias(fromClause, identifier.end);
        const baseName = identifier.value.split(".").at(-1) ?? identifier.value;
        const cteScope = cteScopes.get(identifier.value);
        sources.push({
          name: identifier.value,
          alias: alias.alias ?? baseName,
          joinType: pendingJoinType,
          kind: cteScope ? "cte" : "table",
          ...(cteScope ? { scope: cteScope } : {}),
        });
        index = Math.max(identifier.end, alias.end);
        expectSource = false;
        lastBoundary = index;
        continue;
      }
    }
    if (parenthesisDepth === 0 && current === ",") {
      expectSource = true;
      pendingJoinType = "inner";
      index += 1;
      lastBoundary = index;
      continue;
    }
    if (parenthesisDepth === 0 && matchesKeyword(fromClause, index, "join")) {
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

function emptyScope(
  sql: string,
  kind: SqlQueryScopeSummary["kind"],
  name?: string,
): SqlQueryScopeSummary {
  return {
    kind,
    ...(name ? { name } : {}),
    sql,
    selectExpressions: [],
    canonicalSelectExpressions: [],
    sources: [],
    aliases: new Map(),
    aggregations: [],
    groupByExpressions: [],
    canonicalGroupByExpressions: [],
    joinPredicates: [],
    whereClause: null,
    canonicalWhereClause: null,
    ctes: [],
    subqueries: [],
    cases: [],
    booleanExpression: null,
    depthLimited: true,
  };
}

function parseSqlScope(
  rawSql: string,
  kind: SqlQueryScopeSummary["kind"],
  name: string | undefined,
  inheritedCtes: ReadonlyMap<string, SqlQueryScopeSummary>,
  inheritedAliases: ReadonlyMap<string, string>,
  depth: number,
): SqlQueryScopeSummary {
  const sql = stripSqlComments(rawSql).trim().replace(/;+\s*$/, "");
  if (depth > MAX_SCOPE_DEPTH) return emptyScope(sql, kind, name);
  const ctePrefix = extractCtePrefix(sql, inheritedCtes, depth);
  const mainSql = ctePrefix.mainSql;
  const selectIndex = findTopLevelKeyword(mainSql, "select");
  const fromIndex =
    selectIndex >= 0 ? findTopLevelKeyword(mainSql, "from", selectIndex + 6) : -1;
  const selectExpressions =
    selectIndex >= 0
      ? splitTopLevel(
          mainSql.slice(selectIndex + 6, fromIndex >= 0 ? fromIndex : mainSql.length),
          ",",
        )
      : [];
  const fromEnd = fromIndex >= 0 ? getClauseEnd(mainSql, fromIndex + 4) : -1;
  const fromClause = fromIndex >= 0 ? mainSql.slice(fromIndex + 4, fromEnd) : "";
  const sources = extractSources(
    fromClause,
    ctePrefix.availableCtes,
    inheritedAliases,
    depth,
  );
  const aliases = new Map(inheritedAliases);
  for (const source of sources) {
    const baseResolvedName =
      source.kind === "table" ? source.name : source.kind + ":" + source.name;
    const existingSourceNames = new Set(aliases.values());
    let sourceInstance = 1;
    let resolvedName = baseResolvedName;
    while (existingSourceNames.has(resolvedName)) {
      sourceInstance += 1;
      resolvedName = baseResolvedName + "#" + sourceInstance;
    }
    aliases.set(source.alias, resolvedName);
    const baseQualifier = source.name.split(".").at(-1) ?? source.name;
    if (source.alias === baseQualifier || !aliases.has(baseQualifier)) {
      aliases.set(baseQualifier, resolvedName);
    }
  }

  const joinPredicates = extractJoinPredicates(fromClause, aliases);

  const processedSelectExpressions: string[] = [];
  const selectSubqueries: SqlSubquerySummary[] = [];
  for (const expression of selectExpressions) {
    const processed = extractSubqueries(
      expression,
      "select",
      ctePrefix.availableCtes,
      aliases,
      depth,
    );
    processedSelectExpressions.push(processed.canonicalFragment);
    selectSubqueries.push(...processed.subqueries);
  }
  const whereIndex = findTopLevelKeyword(
    mainSql,
    "where",
    fromIndex >= 0 ? fromIndex + 4 : 0,
  );
  const whereClause =
    whereIndex >= 0
      ? normalizeWhitespace(mainSql.slice(whereIndex + 5, getClauseEnd(mainSql, whereIndex + 5)))
      : null;
  const processedWhere = whereClause
    ? extractSubqueries(
        whereClause,
        "filter",
        ctePrefix.availableCtes,
        aliases,
        depth,
      )
    : { canonicalFragment: "", subqueries: [] };
  const havingIndex = findTopLevelKeyword(
    mainSql,
    "having",
    fromIndex >= 0 ? fromIndex + 4 : 0,
  );
  const havingClause =
    havingIndex >= 0
      ? normalizeWhitespace(mainSql.slice(havingIndex + 6, getClauseEnd(mainSql, havingIndex + 6)))
      : null;
  const groupIndex = findTopLevelKeyword(
    mainSql,
    "group",
    fromIndex >= 0 ? fromIndex + 4 : 0,
  );
  const byIndex = groupIndex >= 0 ? skipWhitespace(mainSql, groupIndex + 5) : -1;
  const groupByExpressions =
    byIndex >= 0 && matchesKeyword(mainSql, byIndex, "by")
      ? splitTopLevel(
          mainSql.slice(byIndex + 2, getClauseEnd(mainSql, byIndex + 2)),
          ",",
        )
      : [];

  return {
    kind,
    ...(name ? { name } : {}),
    sql: mainSql,
    selectExpressions,
    canonicalSelectExpressions: processedSelectExpressions.map((expression) =>
      canonicalizeSqlExpression(expression, aliases, true),
    ),
    sources,
    aliases,
    aggregations: extractAggregations(
      [...processedSelectExpressions, ...(havingClause ? [havingClause] : [])],
      aliases,
    ),
    groupByExpressions,
    canonicalGroupByExpressions: groupByExpressions.map((expression) =>
      canonicalizeSqlExpression(expression, aliases),
    ),
    joinPredicates,
    whereClause,
    canonicalWhereClause: whereClause
      ? canonicalizeSqlExpression(processedWhere.canonicalFragment, aliases)
      : null,
    ctes: ctePrefix.ctes,
    subqueries: [...selectSubqueries, ...processedWhere.subqueries],
    cases: extractCaseSummaries(
      [...processedSelectExpressions, ...(whereClause ? [processedWhere.canonicalFragment] : [])],
      aliases,
    ),
    booleanExpression: whereClause
      ? parseBooleanExpression(
          canonicalizeSqlExpression(processedWhere.canonicalFragment, aliases),
        )
      : null,
    depthLimited: false,
  };
}

function hasDepthLimitedScope(
  scope: SqlQueryScopeSummary,
  seen = new Set<SqlQueryScopeSummary>(),
): boolean {
  if (seen.has(scope)) return false;
  seen.add(scope);
  if (scope.depthLimited) return true;
  return (
    scope.ctes.some((cte) => hasDepthLimitedScope(cte.scope, seen)) ||
    scope.sources.some((source) => source.scope && hasDepthLimitedScope(source.scope, seen)) ||
    scope.subqueries.some((subquery) => hasDepthLimitedScope(subquery.scope, seen))
  );
}

export function analyzeSqlStructure(rawQuery: string): SqlStructureSummary {
  const root = parseSqlScope(rawQuery, "root", undefined, new Map(), new Map(), 0);
  return { root, depthLimited: hasDepthLimitedScope(root) };
}

export function getDirectBaseTables(scope: SqlQueryScopeSummary): string[] {
  return scope.sources
    .filter((source) => source.kind === "table")
    .map((source) => source.name);
}

export function getReachableNestedScopes(root: SqlQueryScopeSummary): ReachableNestedScope[] {
  const nested: ReachableNestedScope[] = [];
  const seen = new Set<SqlQueryScopeSummary>();
  let derivedIndex = 0;
  let subqueryIndex = 0;
  const visit = (scope: SqlQueryScopeSummary): void => {
    for (const source of scope.sources) {
      if (!source.scope || seen.has(source.scope)) continue;
      seen.add(source.scope);
      if (source.kind === "cte") {
        nested.push({
          label: "CTE " + source.name,
          operator: null,
          correlated: false,
          scope: source.scope,
        });
      } else {
        derivedIndex += 1;
        nested.push({
          label: "derived-table subquery #" + derivedIndex,
          operator: null,
          correlated: false,
          scope: source.scope,
        });
      }
      visit(source.scope);
    }
    for (const subquery of scope.subqueries) {
      if (seen.has(subquery.scope)) continue;
      seen.add(subquery.scope);
      subqueryIndex += 1;
      const label =
        subquery.operator === "scalar"
          ? subquery.context + " subquery"
          : (subquery.correlated ? "correlated " : "") +
            subquery.operator.toUpperCase() +
            " subquery";
      nested.push({
        label: label + " #" + subqueryIndex,
        operator: subquery.operator,
        correlated: subquery.correlated,
        scope: subquery.scope,
      });
      visit(subquery.scope);
    }
  };
  visit(root);
  return nested;
}

function getLocalScopeSignature(scope: SqlQueryScopeSummary): string {
  const tables = getDirectBaseTables(scope).sort().join(",");
  const selections = [...scope.canonicalSelectExpressions].sort().join(",");
  const aggregations = scope.aggregations
    .map((aggregation) => aggregation.canonical)
    .sort()
    .join(",");
  const cases = scope.cases.map((item) => item.canonical).sort().join(",");
  const groupBy = [...scope.canonicalGroupByExpressions].sort().join(",");
  const joins = [...scope.joinPredicates].sort().join(",");
  return [
    "tables=" + tables,
    "select=" + selections,
    "aggregations=" + aggregations,
    "cases=" + cases,
    "group=" + groupBy,
    "joins=" + joins,
    "filter=" + (scope.booleanExpression?.canonical ?? scope.canonicalWhereClause ?? ""),
  ].join(";");
}

export function getReachableNestedSignature(root: SqlQueryScopeSummary): string {
  return getReachableNestedScopes(root)
    .map((nested) =>
      [nested.operator ?? "scope", getLocalScopeSignature(nested.scope)].join(":"),
    )
    .join("|");
}

export function getReachableSemanticSignals(root: SqlQueryScopeSummary): string[] {
  const signals: string[] = [];
  const seen = new Set<SqlQueryScopeSummary>();
  const visit = (scope: SqlQueryScopeSummary): void => {
    if (seen.has(scope)) return;
    seen.add(scope);
    signals.push(...getDirectBaseTables(scope));
    signals.push(...scope.canonicalSelectExpressions);
    if (scope.canonicalWhereClause) signals.push(scope.canonicalWhereClause);
    for (const source of scope.sources) if (source.scope) visit(source.scope);
    for (const subquery of scope.subqueries) visit(subquery.scope);
  };
  visit(root);
  return signals;
}

export function cacheSqlStructure(query: ParsedSqlQuery, structure: SqlStructureSummary): void {
  structureCache.set(query, structure);
}

export function getSqlStructure(query: ParsedSqlQuery): SqlStructureSummary {
  const cached = structureCache.get(query);
  if (cached) return cached;
  const structure = analyzeSqlStructure(query.rawQuery);
  structureCache.set(query, structure);
  return structure;
}
