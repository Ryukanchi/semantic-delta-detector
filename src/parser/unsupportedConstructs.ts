export type UnsupportedSqlConstructKind =
  | "cte"
  | "case_expression"
  | "derived_table_subquery"
  | "in_subquery"
  | "exists_subquery";

export interface UnsupportedSqlConstruct {
  construct: UnsupportedSqlConstructKind;
  label: string;
}

const constructChecks: Array<{
  construct: UnsupportedSqlConstructKind;
  label: string;
  pattern: RegExp;
}> = [
  {
    construct: "cte",
    label: "WITH/CTE",
    pattern: /^\s*with\b/i,
  },
  {
    construct: "case_expression",
    label: "CASE expression",
    pattern: /\bcase\s+when\b|\bcase\s+[a-z_][\w.]*\s+when\b/i,
  },
  {
    construct: "derived_table_subquery",
    label: "subquery in FROM/JOIN",
    pattern: /\b(?:from|join)\s*\(\s*select\b/i,
  },
  {
    construct: "in_subquery",
    label: "IN (SELECT ...) subquery",
    pattern: /\bin\s*\(\s*select\b/i,
  },
  {
    construct: "exists_subquery",
    label: "EXISTS (SELECT ...) subquery",
    pattern: /\bexists\s*\(\s*select\b/i,
  },
];

export function detectUnsupportedSqlConstructs(sql: string): UnsupportedSqlConstruct[] {
  const normalized = sql.replace(/\s+/g, " ");

  return constructChecks
    .filter((check) => check.pattern.test(normalized))
    .map((check) => ({ construct: check.construct, label: check.label }));
}

function buildQueryLimitationNote(queryLabel: string, sql: string): string | null {
  const constructs = detectUnsupportedSqlConstructs(sql);
  if (constructs.length === 0) {
    return null;
  }

  const labels = constructs.map((item) => item.label).join(", ");
  return `${queryLabel} uses SQL constructs this heuristic analyzer does not fully model (${labels}). The comparison still ran, but confidence in the semantic verdict is limited for this query; review it manually.`;
}

export function buildParserLimitationNotes(queryA: string, queryB: string): string[] {
  const notes: string[] = [];
  const noteA = buildQueryLimitationNote("Query A", queryA);
  const noteB = buildQueryLimitationNote("Query B", queryB);

  if (noteA) {
    notes.push(noteA);
  }

  if (noteB) {
    notes.push(noteB);
  }

  return notes;
}
