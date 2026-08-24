import { analyzeSqlStructure } from "./sqlStructure.js";

export type UnsupportedSqlConstructKind =
  | "cte"
  | "case_expression"
  | "derived_table_subquery"
  | "in_subquery"
  | "exists_subquery"
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

const constructChecks: Array<{
  construct: UnsupportedSqlConstructKind;
  label: string;
  confidenceCap: ParserConfidenceCap;
  pattern: RegExp;
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
];

export function detectUnsupportedSqlConstructs(sql: string): UnsupportedSqlConstruct[] {
  const normalized = sql.replace(/\s+/g, " ");
  const constructs = constructChecks
    .filter((check) => check.pattern.test(normalized))
    .map((check) => ({
      construct: check.construct,
      label: check.label,
      confidenceCap: check.confidenceCap,
    }));

  if (analyzeSqlStructure(sql).depthLimited) {
    constructs.push({
      construct: "scope_depth_limit",
      label: "nested-query nesting depth limit",
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

export function analyzeParserLimitations(
  queryA: string,
  queryB: string,
): ParserLimitationAnalysis {
  const constructsA = detectUnsupportedSqlConstructs(queryA);
  const constructsB = detectUnsupportedSqlConstructs(queryB);
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
