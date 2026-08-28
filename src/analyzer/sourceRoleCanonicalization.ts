import type {
  SqlJoinEdgeSummary,
  SqlSourceOccurrenceSummary,
  SqlSourceUsageContext,
  SqlSourceUsageSummary,
  SqlSyntaxSummary,
} from "../parser/sqlStructure.js";

const COMMUTATIVE_OPERATORS = new Set(["=", "!=", "<>"]);

function normalizeOperator(operator: string): string {
  const normalized = operator.toLowerCase();
  return normalized === "<>" ? "!=" : normalized;
}

export interface CanonicalSourceRole {
  scopeId: string;
  physicalName: string;
  qualifier: string;
  signature: string;
  description: string;
}

export interface CanonicalSourceUsage {
  context: SqlSourceUsageContext;
  functionName: string | null;
  distinct: boolean;
  column: string;
  role: CanonicalSourceRole;
  signature: string;
}

export interface SourceRoleAnalysis {
  applicable: boolean;
  safe: boolean;
  graphSignature: string;
  graphDescription: string;
  roles: CanonicalSourceRole[];
  usages: CanonicalSourceUsage[];
  limitations: string[];
}

export interface SourceRoleComparison {
  applicable: boolean;
  safe: boolean;
  analysisA: SourceRoleAnalysis;
  analysisB: SourceRoleAnalysis;
}

function baseQualifier(physicalName: string): string {
  return physicalName.split(".").at(-1) ?? physicalName;
}

function occurrenceQualifier(source: SqlSourceOccurrenceSummary): string {
  return source.alias ?? baseQualifier(source.physicalName);
}

function groupByScope<T extends { scopeId: string }>(items: T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const values = grouped.get(item.scopeId) ?? [];
    values.push(item);
    grouped.set(item.scopeId, values);
  }
  return grouped;
}

function hasRepeatedPhysicalSource(sources: SqlSourceOccurrenceSummary[]): boolean {
  const counts = new Map<string, number>();
  for (const source of sources) {
    counts.set(source.physicalName, (counts.get(source.physicalName) ?? 0) + 1);
  }
  return [...counts.values()].some((count) => count > 1);
}

function buildQualifierMap(
  sources: SqlSourceOccurrenceSummary[],
): Map<string, SqlSourceOccurrenceSummary[]> {
  const qualifierMap = new Map<string, SqlSourceOccurrenceSummary[]>();
  for (const source of sources) {
    const qualifiers = new Set([
      occurrenceQualifier(source),
      baseQualifier(source.physicalName),
    ]);
    for (const qualifier of qualifiers) {
      const matches = qualifierMap.get(qualifier) ?? [];
      matches.push(source);
      qualifierMap.set(qualifier, matches);
    }
  }
  return qualifierMap;
}

function findUniqueSource(
  qualifierMap: Map<string, SqlSourceOccurrenceSummary[]>,
  qualifier: string,
): SqlSourceOccurrenceSummary | null {
  const matches = qualifierMap.get(qualifier) ?? [];
  return matches.length === 1 ? matches[0] : null;
}

function formatIncidentToken(
  edge: SqlJoinEdgeSummary,
  qualifier: string,
  neighbor: SqlSourceOccurrenceSummary,
): string | null {
  const operator = normalizeOperator(edge.operator);
  if (edge.leftQualifier === qualifier) {
    return COMMUTATIVE_OPERATORS.has(operator)
      ? `${edge.leftColumn} ${operator} ${neighbor.physicalName}.${edge.rightColumn}`
      : `left:${edge.leftColumn} ${operator} ${neighbor.physicalName}.${edge.rightColumn}`;
  }
  if (edge.rightQualifier === qualifier) {
    return COMMUTATIVE_OPERATORS.has(operator)
      ? `${edge.rightColumn} ${operator} ${neighbor.physicalName}.${edge.leftColumn}`
      : `right:${edge.rightColumn} ${operator} ${neighbor.physicalName}.${edge.leftColumn}`;
  }
  return null;
}

function buildRolesForScope(
  scopeId: string,
  sources: SqlSourceOccurrenceSummary[],
  edges: SqlJoinEdgeSummary[],
): { roles: CanonicalSourceRole[]; complete: boolean } {
  const qualifierMap = buildQualifierMap(sources);
  let complete = true;
  const roles = sources.map((source) => {
    const qualifier = occurrenceQualifier(source);
    const incidentTokens: string[] = [];
    for (const edge of edges) {
      let neighborQualifier: string | null = null;
      if (edge.leftQualifier === qualifier) {
        neighborQualifier = edge.rightQualifier;
      } else if (edge.rightQualifier === qualifier) {
        neighborQualifier = edge.leftQualifier;
      } else {
        continue;
      }
      const neighbor = findUniqueSource(qualifierMap, neighborQualifier);
      if (!neighbor) {
        complete = false;
        continue;
      }
      const token = formatIncidentToken(edge, qualifier, neighbor);
      if (token) {
        incidentTokens.push(token);
      }
    }
    incidentTokens.sort();
    const structuralRole = incidentTokens.join(" & ") || "no distinguishing join edge";
    return {
      scopeId,
      physicalName: source.physicalName,
      qualifier,
      signature: `${scopeId}:${source.physicalName}[${structuralRole}]`,
      description: `${source.physicalName} role [join signature: ${structuralRole}]`,
    };
  });
  return { roles, complete };
}

function buildCanonicalEdgeSignature(
  edge: SqlJoinEdgeSummary,
  roleByQualifier: Map<string, CanonicalSourceRole[]>,
): string | null {
  const leftRoles =
    roleByQualifier.get(`${edge.scopeId}:${edge.leftQualifier}`) ?? [];
  const rightRoles =
    roleByQualifier.get(`${edge.scopeId}:${edge.rightQualifier}`) ?? [];
  if (leftRoles.length !== 1 || rightRoles.length !== 1) {
    return null;
  }
  const left = `${leftRoles[0].signature}.${edge.leftColumn}`;
  const right = `${rightRoles[0].signature}.${edge.rightColumn}`;
  const operator = normalizeOperator(edge.operator);
  if (COMMUTATIVE_OPERATORS.has(operator)) {
    const endpoints = [left, right].sort();
    return `${endpoints[0]} ${operator} ${endpoints[1]}`;
  }
  return `${left} ${operator} ${right}`;
}

function resolveUsageRole(
  usage: SqlSourceUsageSummary,
  scopeSources: SqlSourceOccurrenceSummary[],
  roles: CanonicalSourceRole[],
): CanonicalSourceRole | null {
  if (usage.qualifier) {
    const direct = roles.filter((role) => role.qualifier === usage.qualifier);
    if (direct.length === 1) {
      return direct[0];
    }
    const physical = roles.filter(
      (role) => baseQualifier(role.physicalName) === usage.qualifier,
    );
    return physical.length === 1 ? physical[0] : null;
  }
  if (usage.column === "*") {
    return null;
  }
  return scopeSources.length === 1 ? roles[0] ?? null : null;
}

function formatUsageSignature(
  usage: SqlSourceUsageSummary,
  role: CanonicalSourceRole,
): string {
  const aggregation =
    usage.context === "aggregation"
      ? `${usage.functionName ?? "aggregate"}:${usage.distinct ? "distinct" : "all"}:`
      : "";
  return `${usage.context}:${aggregation}${role.signature}.${usage.column}`;
}

export function analyzeSourceRoles(
  syntax: SqlSyntaxSummary | undefined,
): SourceRoleAnalysis {
  if (!syntax) {
    return {
      applicable: false,
      safe: false,
      graphSignature: "",
      graphDescription: "",
      roles: [],
      usages: [],
      limitations: [],
    };
  }

  const sourcesByScope = groupByScope(syntax.sourceOccurrences);
  const edgesByScope = groupByScope(syntax.joinEdges);
  const applicable = [...sourcesByScope.values()].some(hasRepeatedPhysicalSource);
  if (!applicable) {
    return {
      applicable: false,
      safe: true,
      graphSignature: "",
      graphDescription: "",
      roles: [],
      usages: [],
      limitations: [],
    };
  }

  const limitations: string[] = [];
  const roles: CanonicalSourceRole[] = [];
  let rolesComplete = syntax.sourceGraphComplete;
  for (const [scopeId, sources] of sourcesByScope) {
    const scopeRoles = buildRolesForScope(
      scopeId,
      sources,
      edgesByScope.get(scopeId) ?? [],
    );
    roles.push(...scopeRoles.roles);
    rolesComplete &&= scopeRoles.complete;
  }

  const roleGroups = new Map<string, CanonicalSourceRole[]>();
  for (const role of roles) {
    const group = roleGroups.get(role.signature) ?? [];
    group.push(role);
    roleGroups.set(role.signature, group);
  }
  const ambiguousRoles = [...roleGroups.values()].filter((group) => group.length > 1);
  if (ambiguousRoles.length > 0) {
    limitations.push(
      "source-role canonicalization is ambiguous because multiple occurrences of the same physical table have the same structural join role",
    );
  }
  if (!rolesComplete) {
    limitations.push(
      "source-role canonicalization is incomplete because at least one join predicate is not a fully qualified column-to-column graph edge",
    );
  }

  const rolesByScope = groupByScope(roles);
  const canonicalUsages: CanonicalSourceUsage[] = [];
  let usagesComplete = true;
  for (const usage of syntax.sourceUsages) {
    const scopeSources = sourcesByScope.get(usage.scopeId) ?? [];
    const scopeRoles = rolesByScope.get(usage.scopeId) ?? [];
    const role = resolveUsageRole(usage, scopeSources, scopeRoles);
    if (!role) {
      if (usage.column !== "*") {
        usagesComplete = false;
      }
      continue;
    }
    canonicalUsages.push({
      context: usage.context,
      functionName: usage.functionName,
      distinct: usage.distinct,
      column: usage.column,
      role,
      signature: formatUsageSignature(usage, role),
    });
  }
  if (!usagesComplete) {
    limitations.push(
      "source-role canonicalization is incomplete because a qualified column usage cannot be assigned to exactly one source role",
    );
  }

  const rolesByQualifier = new Map<string, CanonicalSourceRole[]>();
  for (const role of roles) {
    const key = `${role.scopeId}:${role.qualifier}`;
    const group = rolesByQualifier.get(key) ?? [];
    group.push(role);
    rolesByQualifier.set(key, group);
  }
  const edgeSignatures: string[] = [];
  const edgeDescriptions: string[] = [];
  for (const edge of syntax.joinEdges) {
    const signature = buildCanonicalEdgeSignature(edge, rolesByQualifier);
    if (!signature) {
      rolesComplete = false;
      continue;
    }
    edgeSignatures.push(signature);

    const leftRole = rolesByQualifier.get(
      `${edge.scopeId}:${edge.leftQualifier}`,
    )?.[0];
    const rightRole = rolesByQualifier.get(
      `${edge.scopeId}:${edge.rightQualifier}`,
    )?.[0];
    if (leftRole && rightRole) {
      const operator = normalizeOperator(edge.operator);
      const endpoints = [
        `${leftRole.description}, field ${edge.leftColumn}`,
        `${rightRole.description}, field ${edge.rightColumn}`,
      ];
      if (COMMUTATIVE_OPERATORS.has(edge.operator.toLowerCase())) {
        endpoints.sort();
      }
      edgeDescriptions.push(`${endpoints[0]} ${operator} ${endpoints[1]}`);
    }
  }
  const nodeSignatures = roles.map((role) => role.signature).sort();
  const graphSignature = `nodes=${nodeSignatures.join("|")};edges=${edgeSignatures.sort().join("|")}`;

  return {
    applicable,
    safe:
      rolesComplete && usagesComplete && ambiguousRoles.length === 0 && limitations.length === 0,
    graphSignature,
    graphDescription: edgeDescriptions.sort().join("; ") || "no qualified join edge",
    roles,
    usages: canonicalUsages,
    limitations,
  };
}

export function buildSourceRoleComparison(
  syntaxA: SqlSyntaxSummary | undefined,
  syntaxB: SqlSyntaxSummary | undefined,
): SourceRoleComparison {
  const analysisA = analyzeSourceRoles(syntaxA);
  const analysisB = analyzeSourceRoles(syntaxB);
  return {
    applicable: analysisA.applicable && analysisB.applicable,
    safe:
      analysisA.applicable &&
      analysisB.applicable &&
      analysisA.safe &&
      analysisB.safe,
    analysisA,
    analysisB,
  };
}

export function getSourceUsageSignatures(
  analysis: SourceRoleAnalysis,
  contexts: SqlSourceUsageContext[],
): string[] {
  const allowedContexts = new Set(contexts);
  return analysis.usages
    .filter((usage) => allowedContexts.has(usage.context))
    .map((usage) => usage.signature)
    .sort();
}

export function describeSourceUsages(
  usages: CanonicalSourceUsage[],
  contexts: SqlSourceUsageContext[],
): string {
  const allowedContexts = new Set(contexts);
  return (
    usages
      .filter((usage) => allowedContexts.has(usage.context))
      .map((usage) => `${usage.role.description}, column ${usage.column}`)
      .sort()
      .join(", ") || "no qualified source role"
  );
}

function canonicalizeRootWindowExpression(
  expression: string,
  analysis: SourceRoleAnalysis,
): string | null {
  const match = expression.match(
    /^([a-z_][a-z0-9_$]*)\.([a-z_][a-z0-9_$]*)$/i,
  );
  if (!match) {
    return null;
  }
  const roles = analysis.roles.filter(
    (role) => role.scopeId === "root" && role.qualifier === match[1].toLowerCase(),
  );
  return roles.length === 1
    ? `${roles[0].signature}.${match[2].toLowerCase()}`
    : null;
}

export function getCanonicalSourceRoleWindowSignatures(
  syntax: SqlSyntaxSummary | undefined,
  analysis: SourceRoleAnalysis,
): string[] | null {
  if (
    !syntax ||
    !analysis.safe ||
    analysis.roles.some((role) => role.scopeId !== "root")
  ) {
    return null;
  }

  const signatures: string[] = [];
  for (const window of syntax.windows) {
    const partitionBy = window.partitionBy.map((expression) =>
      canonicalizeRootWindowExpression(expression, analysis),
    );
    const orderBy = window.orderBy.map((item) => {
      const expression = canonicalizeRootWindowExpression(
        item.expression,
        analysis,
      );
      if (!expression) {
        return null;
      }
      const direction = item.direction ?? "asc";
      const nulls = item.nulls ?? (direction === "asc" ? "last" : "first");
      return `${expression}:${direction}:nulls_${nulls}`;
    });
    if (
      partitionBy.some((expression) => expression === null) ||
      orderBy.some((expression) => expression === null)
    ) {
      return null;
    }
    const frame = window.frame
      ? `${window.frame.unit}:${window.frame.start}:${window.frame.end ?? ""}`
      : "";
    signatures.push(
      `${window.functionName}(partition=${[...new Set(partitionBy)].sort().join(",")};order=${orderBy.join(",")};frame=${frame})`,
    );
  }
  return signatures.sort();
}
