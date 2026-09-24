import {
  analyzeSqlStructure,
  getReachableNestedScopes,
} from "./sqlStructure.js";

export type UnsupportedSqlConstructKind =
  | "cte"
  | "case_expression"
  | "derived_table_subquery"
  | "in_subquery"
  | "exists_subquery"
  | "set_operation"
  | "window_specification"
  | "having_clause"
  | "distinct_on"
  | "row_limit"
  | "order_by"
  | "scalar_subquery"
  | "scope_depth_limit";

export type ParserConfidenceCap = "low" | "medium";

export interface UnsupportedSqlConstruct {
  construct: UnsupportedSqlConstructKind;
  label: string;
  confidenceCap: ParserConfidenceCap;
}

export interface ParserLimitationAnalysis {
  notes: string[];
  confidenceCap?: ParserConfidenceCap;
}

export interface ParserLimitationOptions {
  /** Constructs an enhanced syntax frontend already modeled for Query A. */
  modeledConstructsA?: ReadonlySet<UnsupportedSqlConstructKind>;
  /** Constructs an enhanced syntax frontend already modeled for Query B. */
  modeledConstructsB?: ReadonlySet<UnsupportedSqlConstructKind>;
}

const constructChecks: Array<{
  construct: UnsupportedSqlConstructKind;
  label: string;
  confidenceCap: ParserConfidenceCap;
  pattern: RegExp;
  ignoreWindowSpecifications?: boolean;
}> = [
  {
    construct: "cte",
    label: "WITH/CTE",
    confidenceCap: "medium",
    pattern: /^\s*with\b/i,
  },
  {
    construct: "case_expression",
    label: "CASE expression",
    confidenceCap: "medium",
    pattern: /\bcase\s+when\b|\bcase\s+[a-z_][\w.]*\s+when\b/i,
  },
  {
    construct: "derived_table_subquery",
    label: "subquery in FROM/JOIN",
    confidenceCap: "low",
    pattern: /\b(?:from|join)\s*\(\s*select\b/i,
  },
  {
    construct: "in_subquery",
    label: "IN (SELECT ...) subquery",
    confidenceCap: "low",
    pattern: /\bin\s*\(\s*select\b/i,
  },
  {
    construct: "exists_subquery",
    label: "EXISTS (SELECT ...) subquery",
    confidenceCap: "low",
    pattern: /\bexists\s*\(\s*select\b/i,
  },
  // The lightweight structure analyzes only the first set-operation branch,
  // so operator and later-branch changes can go entirely unnoticed.
  // BigQuery-style `SELECT * EXCEPT (...)` column exclusion is not a set operation.
  {
    construct: "set_operation",
    label: "UNION/INTERSECT/EXCEPT set operation",
    confidenceCap: "low",
    pattern: /\bunion\b|\bintersect\b|(?<!\*\s?)\bexcept\b/i,
  },
  // Window partitions, ordering and frames are not compared.
  {
    construct: "window_specification",
    label: "OVER (...) window specification",
    confidenceCap: "low",
    pattern: /\bover\s*\(|\bwindow\s+[a-z_][\w$]*\s+as\s*\(/i,
  },
  // HAVING aggregates are extracted, but its predicates are not compared.
  {
    construct: "having_clause",
    label: "HAVING clause",
    confidenceCap: "low",
    pattern: /\bhaving\b/i,
  },
  // Which row survives per DISTINCT ON key depends on unmodeled ordering.
  {
    construct: "distinct_on",
    label: "DISTINCT ON",
    confidenceCap: "low",
    pattern: /\bdistinct\s+on\s*\(/i,
  },
  // Row limits change which rows are returned and are not compared.
  {
    construct: "row_limit",
    label: "LIMIT/OFFSET/FETCH row limit",
    confidenceCap: "low",
    pattern:
      /\blimit\b|\boffset\b(?!\s*\()|\bfetch\s+(?:first|next)\b|\bselect\s+(?:all\s+|distinct\s+)?top\b/i,
  },
  // Result ordering is not compared. On its own it does not change which rows
  // are returned; combined with row limits the stricter row-limit cap applies.
  {
    construct: "order_by",
    label: "ORDER BY clause",
    confidenceCap: "medium",
    pattern: /\border\s+by\b/i,
    ignoreWindowSpecifications: true,
  },
];

/**
 * Prepares SQL for construct detection: comments become whitespace and the
 * contents of terminated quoted literals or identifiers are blanked, so words
 * inside comments or strings do not count as syntax. Quotes follow the
 * analyzer's own rules (doubled quotes escape a quote). An unterminated comment
 * or quote leaves the remaining text unmasked, which errs toward reporting a
 * limitation rather than hiding one.
 */
function maskCommentsAndQuotedText(sql: string): string {
  let result = "";
  let index = 0;
  while (index < sql.length) {
    const current = sql[index];
    const next = sql[index + 1];

    if (current === "-" && next === "-") {
      const lineEnd = sql.slice(index).search(/[\r\n]/);
      index = lineEnd < 0 ? sql.length : index + lineEnd;
      result += " ";
      continue;
    }

    if (current === "/" && next === "*") {
      const commentEnd = sql.indexOf("*/", index + 2);
      if (commentEnd < 0) {
        return result + sql.slice(index);
      }
      index = commentEnd + 2;
      result += " ";
      continue;
    }

    if (current === "'" || current === '"') {
      let closing = -1;
      for (let cursor = index + 1; cursor < sql.length; cursor += 1) {
        if (sql[cursor] !== current) continue;
        if (sql[cursor + 1] === current) {
          cursor += 1;
          continue;
        }
        closing = cursor;
        break;
      }
      if (closing < 0) {
        return result + sql.slice(index);
      }
      result += `${current} ${current}`;
      index = closing + 1;
      continue;
    }

    result += current;
    index += 1;
  }
  return result;
}

function removeWindowSpecifications(scanText: string): string {
  const windowStart = /\bover\s*\(|\bwindow\s+[a-z_][\w$]*\s+as\s*\(/gi;
  let result = "";
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = windowStart.exec(scanText)) !== null) {
    const openingIndex = match.index + match[0].length - 1;
    let depth = 0;
    let closingIndex = scanText.length - 1;
    for (let index = openingIndex; index < scanText.length; index += 1) {
      if (scanText[index] === "(") {
        depth += 1;
      } else if (scanText[index] === ")") {
        depth -= 1;
        if (depth === 0) {
          closingIndex = index;
          break;
        }
      }
    }
    result += `${scanText.slice(cursor, match.index)} `;
    cursor = closingIndex + 1;
    windowStart.lastIndex = cursor;
  }
  return result + scanText.slice(cursor);
}

export function detectUnsupportedSqlConstructs(sql: string): UnsupportedSqlConstruct[] {
  const scanText = maskCommentsAndQuotedText(sql).replace(/\s+/g, " ");
  const scanTextWithoutWindows = removeWindowSpecifications(scanText);
  const structure = analyzeSqlStructure(sql);
  const constructs = constructChecks
    .filter((check) =>
      check.pattern.test(
        check.ignoreWindowSpecifications ? scanTextWithoutWindows : scanText,
      ),
    )
    .map((check) => ({
      construct: check.construct,
      label: check.label,
      confidenceCap: check.confidenceCap,
    }));

  if (
    getReachableNestedScopes(structure.root).some(
      (nested) => nested.scope.kind === "subquery" && nested.operator === "scalar",
    )
  ) {
    constructs.push({
      construct: "scalar_subquery",
      label: "scalar subquery",
      confidenceCap: "low",
    });
  }

  if (structure.depthLimited) {
    constructs.push({
      construct: "scope_depth_limit",
      label: "parser nesting depth limit",
      confidenceCap: "low",
    });
  }

  return constructs;
}

function buildQueryLimitationNote(
  queryLabel: string,
  constructs: UnsupportedSqlConstruct[],
): string | null {
  if (constructs.length === 0) {
    return null;
  }

  const labels = constructs.map((item) => item.label).join(", ");
  return `${queryLabel} uses SQL constructs this heuristic analyzer does not fully model (${labels}). The comparison still ran, but confidence in the semantic verdict is limited for this query; review it manually.`;
}

function getMostRestrictiveConfidenceCap(
  constructs: UnsupportedSqlConstruct[],
): ParserConfidenceCap | undefined {
  if (constructs.some((construct) => construct.confidenceCap === "low")) {
    return "low";
  }

  if (constructs.some((construct) => construct.confidenceCap === "medium")) {
    return "medium";
  }

  return undefined;
}

function withoutModeledConstructs(
  constructs: UnsupportedSqlConstruct[],
  modeledConstructs: ReadonlySet<UnsupportedSqlConstructKind> | undefined,
): UnsupportedSqlConstruct[] {
  return modeledConstructs
    ? constructs.filter((item) => !modeledConstructs.has(item.construct))
    : constructs;
}

export function analyzeParserLimitations(
  queryA: string,
  queryB: string,
  options: ParserLimitationOptions = {},
): ParserLimitationAnalysis {
  const constructsA = withoutModeledConstructs(
    detectUnsupportedSqlConstructs(queryA),
    options.modeledConstructsA,
  );
  const constructsB = withoutModeledConstructs(
    detectUnsupportedSqlConstructs(queryB),
    options.modeledConstructsB,
  );
  const allConstructs = [...constructsA, ...constructsB];
  const notes: string[] = [];
  const noteA = buildQueryLimitationNote("Query A", constructsA);
  const noteB = buildQueryLimitationNote("Query B", constructsB);

  if (noteA) {
    notes.push(noteA);
  }

  if (noteB) {
    notes.push(noteB);
  }

  const confidenceCap = getMostRestrictiveConfidenceCap(allConstructs);
  return {
    notes,
    ...(confidenceCap ? { confidenceCap } : {}),
  };
}

export function buildParserLimitationNotes(queryA: string, queryB: string): string[] {
  return analyzeParserLimitations(queryA, queryB).notes;
}
