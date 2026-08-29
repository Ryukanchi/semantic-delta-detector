import {
  hasAnalyzableSqlContent,
  tokenizeSql,
} from "../parser/sqlTokenizer.js";
import {
  getDirectBaseTables,
  getReachableNestedScopes,
  getSetOperationBranches,
  getSetOperationOperators,
  getSqlStructure,
  getWindowFrameSignature,
  getWindowOrderSignature,
  getWindowPartitionSignature,
  getWindowSummarySignature,
  type ReachableNestedScope,
  type SqlAggregationSummary,
  type SqlQueryScopeSummary,
  type SqlStructureSummary,
  type SqlWindowSummary,
} from "../parser/sqlStructure.js";
import {
  analyzeParserLimitations,
  type ParserConfidenceCap,
} from "../parser/unsupportedConstructs.js";
import {
  buildSemanticProfile,
  estimateBaseSimilarity,
  inferDimensionFromMetadata,
  inferRiskLevel,
  normalizeText,
} from "./semanticHeuristics.js";
import {
  buildSourceRoleComparison,
  describeSourceUsages,
  getCanonicalSourceRoleWindowSignatures,
  getSourceUsageSignatures,
  normalizePositionalSourceIdentity,
  type SourceRoleComparison,
} from "./sourceRoleCanonicalization.js";
import {
  ConfidenceLevel,
  DetectedDifference,
  EvidenceSource,
  ImpactLayer,
  MetricDefinitionInput,
  ParsedSqlQuery,
  QuerySemanticProfile,
  RiskLevel,
  SemanticComparisonResult,
} from "../types.js";

function pushDifference(
  differences: DetectedDifference[],
  difference: DetectedDifference | null,
): void {
  if (difference) {
    differences.push(difference);
  }
}

function normalizeMetricInput(input: MetricDefinitionInput): MetricDefinitionInput {
  return {
    query: input.query.trim(),
    metric_name: input.metric_name?.trim() || undefined,
    team_context: input.team_context?.trim() || undefined,
    description: input.description?.trim() || undefined,
    intended_use: input.intended_use?.trim() || undefined,
  };
}

function requireAnalyzableSqlInput(
  input: MetricDefinitionInput,
  queryLabel: "A" | "B",
): void {
  if (!hasAnalyzableSqlContent(input.query)) {
    throw new Error(`Query ${queryLabel} SQL input must contain analyzable content.`);
  }
}

function getDisplayMetricName(
  input: MetricDefinitionInput,
  parsedQuery: ParsedSqlQuery,
): string {
  return input.metric_name || parsedQuery.metricName;
}

function compareMetricNameAlignment(
  inputA: MetricDefinitionInput,
  inputB: MetricDefinitionInput,
  profileA: QuerySemanticProfile,
  profileB: QuerySemanticProfile,
): DetectedDifference | null {
  const nameA = normalizeText(inputA.metric_name);
  const nameB = normalizeText(inputB.metric_name);
  if (!nameA || !nameB || nameA !== nameB) {
    return null;
  }

  if (profileA.primaryDimension === profileB.primaryDimension) {
    return null;
  }

  return {
    category: "naming_alignment_mismatch",
    description: `Both inputs use the same metric name (${inputA.metric_name}), but the underlying logic points to different meanings: Query A is ${profileA.primaryDimension}, while Query B is ${profileB.primaryDimension}.`,
    impact: "high",
  };
}

function compareSourceDomain(
  queryA: ParsedSqlQuery,
  queryB: ParsedSqlQuery,
  profileA: QuerySemanticProfile,
  profileB: QuerySemanticProfile,
): DetectedDifference | null {
  const sameTable = queryA.tables.some((table) => queryB.tables.includes(table));
  if (sameTable) {
    return null;
  }

  if (isOrdersPaymentsSourceChange(queryA, queryB)) {
    return {
      category: "source_domain_mismatch",
      description: `The queries use different commerce source tables: Query A reads from ${queryA.tables.join(", ")}, while Query B reads from ${queryB.tables.join(", ")}. Orders and payments may not be interchangeable: one order can have multiple payment attempts, payment records may include refunds, retries, failures, or provider-specific states, and order status and payment status may not represent the same business lifecycle.`,
      impact: "high",
    };
  }

  if (profileA.sourceDomain === profileB.sourceDomain) {
    return null;
  }

  return {
    category: "source_domain_mismatch",
    description: `The queries pull from different source domains: Query A uses ${profileA.sourceDomain} data (${queryA.tables.join(", ") || "unknown"}), while Query B uses ${profileB.sourceDomain} data (${queryB.tables.join(", ") || "unknown"}).`,
    impact: "high",
  };
}

function describeBranchPosition(index: number): string {
  const labels = ["first", "second", "third", "fourth", "fifth"];
  return labels[index] ?? `branch #${index + 1}`;
}

function compareSetOperations(
  queryA: ParsedSqlQuery,
  queryB: ParsedSqlQuery,
): DetectedDifference[] {
  const expressionA = getSqlStructure(queryA).syntax?.setExpression ?? null;
  const expressionB = getSqlStructure(queryB).syntax?.setExpression ?? null;
  if (!expressionA && !expressionB) {
    return [];
  }

  if (!expressionA || !expressionB) {
    return [
      {
        category: "business_logic_mismatch",
        description:
          "One query uses a set operation while the other does not. UNION, INTERSECT, and EXCEPT change how branch result sets are combined.",
        impact: "high",
      },
    ];
  }

  const differences: DetectedDifference[] = [];
  const operatorsA = getSetOperationOperators(expressionA);
  const operatorsB = getSetOperationOperators(expressionB);
  if (operatorsA.join("|") !== operatorsB.join("|")) {
    differences.push({
      category: "business_logic_mismatch",
      description: `The set-operation sequence changes from ${operatorsA.join(", ").toUpperCase()} to ${operatorsB.join(", ").toUpperCase()}. In particular, UNION and UNION ALL differ in duplicate handling, while INTERSECT and EXCEPT select different populations.`,
      impact: "high",
    });
  }

  const branchesA = getSetOperationBranches(expressionA);
  const branchesB = getSetOperationBranches(expressionB);
  if (branchesA.length !== branchesB.length) {
    differences.push({
      category: "business_logic_mismatch",
      description: `The set operation changes from ${branchesA.length} branches in Query A to ${branchesB.length} branches in Query B. Adding or removing a branch changes the combined population.`,
      impact: "high",
    });
    return differences;
  }

  const sourceSignaturesA = branchesA.map((branch) =>
    sortedUnique(branch.sources.map((source) => source.name)).join("|"),
  );
  const sourceSignaturesB = branchesB.map((branch) =>
    sortedUnique(branch.sources.map((source) => source.name)).join("|"),
  );
  if (
    [...sourceSignaturesA].sort().join("||") ===
    [...sourceSignaturesB].sort().join("||")
  ) {
    return differences;
  }

  for (let index = 0; index < branchesA.length; index += 1) {
    if (sourceSignaturesA[index] === sourceSignaturesB[index]) {
      continue;
    }

    const sourcesA = sortedUnique(branchesA[index].sources.map((source) => source.name));
    const sourcesB = sortedUnique(branchesB[index].sources.map((source) => source.name));
    differences.push({
      category: "source_domain_mismatch",
      description: `The ${describeBranchPosition(index)} set-operation branch changes its source from ${sourcesA.join(", ") || "no physical table"} to ${sourcesB.join(", ") || "no physical table"}. This changes the population contributed by that branch.`,
      impact: "high",
    });
  }

  return differences;
}

function formatWindowFunctionName(functionName: string): string {
  return functionName.toUpperCase();
}

function formatWindowPartition(window: SqlWindowSummary): string {
  return [...new Set(window.partitionBy)].sort().join(", ") || "no partition";
}

function formatWindowOrder(window: SqlWindowSummary): string {
  return (
    window.orderBy
      .map((item) => {
        const direction = item.direction ?? "asc";
        const nulls = item.nulls ?? (direction === "asc" ? "last" : "first");
        return `${item.expression} ${direction.toUpperCase()} NULLS ${nulls.toUpperCase()}`;
      })
      .join(", ") || "no ordering"
  );
}

function formatWindowFrame(window: SqlWindowSummary): string {
  if (!window.frame) {
    return "the default frame";
  }

  const unit = window.frame.unit.toUpperCase();
  const start = window.frame.start.toUpperCase();
  return window.frame.end
    ? `${unit} BETWEEN ${start} AND ${window.frame.end.toUpperCase()}`
    : `${unit} ${start}`;
}

function getWindowPairingCost(
  windowA: SqlWindowSummary,
  windowB: SqlWindowSummary,
): number {
  let cost = windowA.functionName === windowB.functionName ? 0 : 8;
  if (
    getWindowPartitionSignature(windowA) !==
    getWindowPartitionSignature(windowB)
  ) {
    cost += 1;
  }
  if (getWindowOrderSignature(windowA) !== getWindowOrderSignature(windowB)) {
    cost += 1;
  }
  if (getWindowFrameSignature(windowA) !== getWindowFrameSignature(windowB)) {
    cost += 1;
  }
  return cost;
}

interface WindowPair {
  windowA: SqlWindowSummary;
  windowB: SqlWindowSummary;
}

function pairChangedWindows(
  windowsA: SqlWindowSummary[],
  windowsB: SqlWindowSummary[],
): WindowPair[] {
  const unmatchedA = [...windowsA].sort((first, second) =>
    getWindowSummarySignature(first).localeCompare(
      getWindowSummarySignature(second),
    ),
  );
  const unmatchedB = [...windowsB].sort((first, second) =>
    getWindowSummarySignature(first).localeCompare(
      getWindowSummarySignature(second),
    ),
  );

  for (let index = unmatchedA.length - 1; index >= 0; index -= 1) {
    const signature = getWindowSummarySignature(unmatchedA[index]);
    const exactIndex = unmatchedB.findIndex(
      (window) => getWindowSummarySignature(window) === signature,
    );
    if (exactIndex >= 0) {
      unmatchedA.splice(index, 1);
      unmatchedB.splice(exactIndex, 1);
    }
  }

  const pairs: WindowPair[] = [];
  while (unmatchedA.length > 0 && unmatchedB.length > 0) {
    const windowA = unmatchedA.shift() as SqlWindowSummary;
    let bestIndex = 0;
    let bestCost = getWindowPairingCost(windowA, unmatchedB[0]);
    for (let index = 1; index < unmatchedB.length; index += 1) {
      const candidateCost = getWindowPairingCost(windowA, unmatchedB[index]);
      if (candidateCost < bestCost) {
        bestCost = candidateCost;
        bestIndex = index;
      }
    }
    const [windowB] = unmatchedB.splice(bestIndex, 1);
    pairs.push({ windowA, windowB });
  }
  return pairs;
}

function compareWindowSpecifications(
  queryA: ParsedSqlQuery,
  queryB: ParsedSqlQuery,
  sourceRoles?: SourceRoleComparison,
): DetectedDifference[] {
  const syntaxA = getSqlStructure(queryA).syntax;
  const syntaxB = getSqlStructure(queryB).syntax;
  const windowsA = syntaxA?.windows ?? [];
  const windowsB = syntaxB?.windows ?? [];
  const signaturesA = windowsA.map(getWindowSummarySignature).sort();
  const signaturesB = windowsB.map(getWindowSummarySignature).sort();
  if (signaturesA.join("|") === signaturesB.join("|")) {
    return [];
  }
  if (sourceRoles?.safe) {
    const roleSignaturesA = getCanonicalSourceRoleWindowSignatures(
      syntaxA,
      sourceRoles.analysisA,
    );
    const roleSignaturesB = getCanonicalSourceRoleWindowSignatures(
      syntaxB,
      sourceRoles.analysisB,
    );
    if (
      roleSignaturesA &&
      roleSignaturesB &&
      arraysEqual(roleSignaturesA, roleSignaturesB)
    ) {
      return [];
    }
  }

  const differences: DetectedDifference[] = [];
  if (windowsA.length !== windowsB.length) {
    differences.push({
      category: "business_logic_mismatch",
      description: `The window expression count changed from ${windowsA.length} to ${windowsB.length}. Adding or removing a window calculation changes which ranked, offset, or rolling values the query produces.`,
      impact: "high",
    });
  }

  for (const { windowA, windowB } of pairChangedWindows(windowsA, windowsB)) {
    const functionA = formatWindowFunctionName(windowA.functionName);
    const functionB = formatWindowFunctionName(windowB.functionName);
    const functionLabel =
      windowA.functionName === windowB.functionName
        ? `${functionA} window`
        : `${functionA}/${functionB} window`;

    if (windowA.functionName !== windowB.functionName) {
      differences.push({
        category: "business_logic_mismatch",
        description: `The window function changes from ${functionA} to ${functionB}. Different window functions can produce different rankings, offsets, or aggregates even when their window specification is unchanged.`,
        impact: "high",
      });
    }

    if (
      getWindowPartitionSignature(windowA) !==
      getWindowPartitionSignature(windowB)
    ) {
      differences.push({
        category: "business_logic_mismatch",
        description: `The ${functionLabel} changes its PARTITION BY definition from ${formatWindowPartition(windowA)} to ${formatWindowPartition(windowB)}. This changes which rows are ranked or aggregated together inside each window partition.`,
        impact: "high",
      });
    }

    if (getWindowOrderSignature(windowA) !== getWindowOrderSignature(windowB)) {
      differences.push({
        category: "business_logic_mismatch",
        description: `The ${functionLabel} changes its ORDER BY definition from ${formatWindowOrder(windowA)} to ${formatWindowOrder(windowB)}. This changes the ordering used for ranking, offsets, or cumulative window calculations.`,
        impact: "high",
      });
    }

    if (getWindowFrameSignature(windowA) !== getWindowFrameSignature(windowB)) {
      differences.push({
        category: "business_logic_mismatch",
        description: `The ${functionLabel} changes its frame from ${formatWindowFrame(windowA)} to ${formatWindowFrame(windowB)}. This changes which rows contribute to the window result for each current row.`,
        impact: "high",
      });
    }
  }

  return differences;
}

function compareAggregation(
  queryA: ParsedSqlQuery,
  queryB: ParsedSqlQuery,
  sourceRoles?: SourceRoleComparison,
): DetectedDifference | null {
  const aggregationsA = getSqlStructure(queryA).root.aggregations;
  const aggregationsB = getSqlStructure(queryB).root.aggregations;
  const canonicalA = aggregationsA.map((item) => item.canonical).sort();
  const canonicalB = aggregationsB.map((item) => item.canonical).sort();

  if (
    sourceRoles?.safe &&
    sourceRoles.analysisA.graphSignature === sourceRoles.analysisB.graphSignature
  ) {
    const roleUsagesA = getSourceUsageSignatures(
      sourceRoles.analysisA,
      ["aggregation"],
    );
    const roleUsagesB = getSourceUsageSignatures(
      sourceRoles.analysisB,
      ["aggregation"],
    );
    const neutralCanonicalA = canonicalA.map(normalizePositionalSourceIdentity);
    const neutralCanonicalB = canonicalB.map(normalizePositionalSourceIdentity);
    const neutralAggregationsMatch = arraysEqual(
      neutralCanonicalA,
      neutralCanonicalB,
    );

    if (neutralAggregationsMatch && arraysEqual(roleUsagesA, roleUsagesB)) {
      return null;
    }
    if (neutralAggregationsMatch) {
      return {
        category: "aggregation_mismatch",
        description: `The aggregation changes its qualified source role from ${describeSourceUsages(sourceRoles.analysisA.usages, ["aggregation"])} to ${describeSourceUsages(sourceRoles.analysisB.usages, ["aggregation"])}. Although both occurrences come from the same physical table, their join fields show that they measure different semantic roles.`,
        impact: "high",
      };
    }
  }

  if (arraysEqual(canonicalA, canonicalB)) {
    return null;
  }

  return {
    category: "aggregation_mismatch",
    description: buildAggregationDifferenceDescription(
      queryA,
      queryB,
      aggregationsA,
      aggregationsB,
    ),
    impact: "high",
  };
}

function arraysEqual(valuesA: string[], valuesB: string[]): boolean {
  return valuesA.join("|") === valuesB.join("|");
}

function compareSourceRoleUsages(
  sourceRoles: SourceRoleComparison,
): DetectedDifference[] {
  if (
    !sourceRoles.safe ||
    sourceRoles.analysisA.graphSignature !== sourceRoles.analysisB.graphSignature
  ) {
    return [];
  }

  const contexts = [
    ["projection", "projection"],
    ["filter", "filter"],
    ["grouping", "grouping"],
    ["having", "HAVING"],
    ["ordering", "ordering"],
  ] as const;
  const differences: DetectedDifference[] = [];
  for (const [context, label] of contexts) {
    const signaturesA = getSourceUsageSignatures(sourceRoles.analysisA, [context]);
    const signaturesB = getSourceUsageSignatures(sourceRoles.analysisB, [context]);
    if (arraysEqual(signaturesA, signaturesB)) {
      continue;
    }
    differences.push({
      category: "business_logic_mismatch",
      description: `The qualified ${label} source role changes from ${describeSourceUsages(sourceRoles.analysisA.usages, [context])} to ${describeSourceUsages(sourceRoles.analysisB.usages, [context])}. The physical table is unchanged, but the referenced occurrence has a different role in the self-join graph.`,
      impact: "high",
    });
  }
  return differences;
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function formatScopeAggregations(scope: ReachableNestedScope["scope"]): string {
  return scope.aggregations.map((aggregation) => aggregation.display).join(", ") || "none";
}

function comparableNestedLabel(scope: ReachableNestedScope): string {
  return scope.label.replace(/\s+#\d+$/, "");
}

function compareCaseCollections(
  scopeA: SqlQueryScopeSummary,
  scopeB: SqlQueryScopeSummary,
  contextLabel = "",
  sourceRoles?: SourceRoleComparison,
): DetectedDifference | null {
  const canonicalA = scopeA.cases.map((item) => item.canonical).sort();
  const canonicalB = scopeB.cases.map((item) => item.canonical).sort();
  if (canonicalA.join("|") === canonicalB.join("|")) {
    return null;
  }
  if (
    sourceRoles?.safe &&
    sourceRoles.analysisA.graphSignature === sourceRoles.analysisB.graphSignature &&
    arraysEqual(
      canonicalA.map(normalizePositionalSourceIdentity),
      canonicalB.map(normalizePositionalSourceIdentity),
    ) &&
    arraysEqual(
      getSourceUsageSignatures(sourceRoles.analysisA, [
        "projection",
        "aggregation",
        "filter",
        "grouping",
        "having",
        "ordering",
      ]),
      getSourceUsageSignatures(sourceRoles.analysisB, [
        "projection",
        "aggregation",
        "filter",
        "grouping",
        "having",
        "ordering",
      ]),
    )
  ) {
    return null;
  }

  if (scopeA.cases.length !== scopeB.cases.length) {
    return {
      category: "business_logic_mismatch",
      description: `${contextLabel ? `${contextLabel} ` : ""}CASE expression count changed from ${scopeA.cases.length} to ${scopeB.cases.length}. CASE expressions can change which values contribute to the metric.`,
      impact: "high",
    };
  }

  for (let index = 0; index < scopeA.cases.length; index += 1) {
    const caseA = scopeA.cases[index];
    const caseB = scopeB.cases[index];
    const label = `${contextLabel ? `${contextLabel} ` : ""}CASE expression #${index + 1}`;
    if (caseA.conditions.join("|") !== caseB.conditions.join("|")) {
      return {
        category: "business_logic_mismatch",
        description: `${label} changes its condition from ${caseA.conditions.join("; ") || "none"} to ${caseB.conditions.join("; ") || "none"}. This changes which rows or values qualify inside the metric definition.`,
        impact: "high",
      };
    }
    if (caseA.results.join("|") !== caseB.results.join("|")) {
      return {
        category: "business_logic_mismatch",
        description: `${label} changes its result from ${caseA.results.join("; ") || "none"} to ${caseB.results.join("; ") || "none"}. This changes the value produced by the metric definition.`,
        impact: "high",
      };
    }
  }

  return {
    category: "business_logic_mismatch",
    description: `${contextLabel ? `${contextLabel} ` : ""}CASE expression structure changed and may alter the metric definition.`,
    impact: "high",
  };
}

function compareNestedQueryScopes(
  queryA: ParsedSqlQuery,
  queryB: ParsedSqlQuery,
): DetectedDifference[] {
  const scopesA = getReachableNestedScopes(getSqlStructure(queryA).root);
  const scopesB = getReachableNestedScopes(getSqlStructure(queryB).root);
  const differences: DetectedDifference[] = [];
  const scopeCount = Math.max(scopesA.length, scopesB.length);

  for (let index = 0; index < scopeCount; index += 1) {
    const nestedA = scopesA[index];
    const nestedB = scopesB[index];
    if (!nestedA || !nestedB) {
      differences.push({
        category: "business_logic_mismatch",
        description: `The reachable nested-query structure changed. Query A has ${scopesA.length} reachable CTE/subquery scopes, while Query B has ${scopesB.length}.`,
        impact: "high",
      });
      break;
    }

    const labelA = comparableNestedLabel(nestedA);
    const labelB = comparableNestedLabel(nestedB);
    const scopeLabel = labelA === labelB ? labelA : `${labelA} / ${labelB}`;

    if (nestedA.correlated !== nestedB.correlated) {
      differences.push({
        category: "filter_logic_mismatch",
        description: `${scopeLabel} changed from ${nestedA.correlated ? "correlated" : "uncorrelated"} to ${nestedB.correlated ? "correlated" : "uncorrelated"}. This changes whether the inner predicate depends on each outer record and can materially change which outer records qualify.`,
        impact: "high",
      });
      continue;
    }

    const inverseExistence =
      (nestedA.operator === "exists" && nestedB.operator === "not exists") ||
      (nestedA.operator === "not exists" && nestedB.operator === "exists");
    const inverseMembership =
      (nestedA.operator === "in" && nestedB.operator === "not in") ||
      (nestedA.operator === "not in" && nestedB.operator === "in");
    if (inverseExistence || inverseMembership) {
      differences.push({
        category: "filter_logic_mismatch",
        description: `${scopeLabel} changed from ${nestedA.operator?.toUpperCase()} to ${nestedB.operator?.toUpperCase()}. This negation inverts which outer records qualify for the metric.`,
        impact: "high",
      });
      continue;
    }

    const tablesA = sortedUnique(getDirectBaseTables(nestedA.scope));
    const tablesB = sortedUnique(getDirectBaseTables(nestedB.scope));
    if (tablesA.join("|") !== tablesB.join("|")) {
      const outerTablesA = sortedUnique(getDirectBaseTables(getSqlStructure(queryA).root));
      const outerTablesB = sortedUnique(getDirectBaseTables(getSqlStructure(queryB).root));
      const outerNote =
        outerTablesA.length > 0 && outerTablesA.join("|") === outerTablesB.join("|")
          ? ` The outer source ${outerTablesA.join(", ")} remains unchanged.`
          : "";
      differences.push({
        category: "source_domain_mismatch",
        description: `${scopeLabel} changes its source from ${tablesA.join(", ") || "no direct table"} to ${tablesB.join(", ") || "no direct table"}.${outerNote}`,
        impact: "high",
      });
      continue;
    }

    const caseDifference = compareCaseCollections(
      nestedA.scope,
      nestedB.scope,
      scopeLabel,
    );
    if (caseDifference) {
      differences.push(caseDifference);
      continue;
    }

    const aggregationsA = nestedA.scope.aggregations
      .map((aggregation) => aggregation.canonical)
      .sort();
    const aggregationsB = nestedB.scope.aggregations
      .map((aggregation) => aggregation.canonical)
      .sort();
    if (aggregationsA.join("|") !== aggregationsB.join("|")) {
      differences.push({
        category: "aggregation_mismatch",
        description: `${scopeLabel} changes its aggregation set from ${formatScopeAggregations(nestedA.scope)} to ${formatScopeAggregations(nestedB.scope)}.`,
        impact: "high",
      });
      continue;
    }

    const selectionsA = [...nestedA.scope.canonicalSelectExpressions].sort();
    const selectionsB = [...nestedB.scope.canonicalSelectExpressions].sort();
    if (selectionsA.join("|") !== selectionsB.join("|")) {
      differences.push({
        category: "business_logic_mismatch",
        description: `${scopeLabel} changes its selected expressions from ${selectionsA.join(", ") || "none"} to ${selectionsB.join(", ") || "none"}. This changes the values produced by that scope.`,
        impact: "high",
      });
      continue;
    }

    const groupsA = [...nestedA.scope.canonicalGroupByExpressions].sort();
    const groupsB = [...nestedB.scope.canonicalGroupByExpressions].sort();
    if (groupsA.join("|") !== groupsB.join("|")) {
      differences.push({
        category: "reporting_grain_mismatch",
        description: `${scopeLabel} changes its grouping from ${groupsA.join(", ") || "ungrouped"} to ${groupsB.join(", ") || "ungrouped"}. This changes the grain produced by that scope without attributing it to the outer query.`,
        impact: "medium",
      });
      continue;
    }

    const joinPredicatesA = [...nestedA.scope.joinPredicates].sort();
    const joinPredicatesB = [...nestedB.scope.joinPredicates].sort();
    if (joinPredicatesA.join("|") !== joinPredicatesB.join("|")) {
      differences.push({
        category: "business_logic_mismatch",
        description: `${scopeLabel} changes its join predicate from ${joinPredicatesA.join(", ") || "none"} to ${joinPredicatesB.join(", ") || "none"}. Different join keys can change matches, row multiplication, and the population produced by that scope.`,
        impact: "high",
      });
      continue;
    }

    if (nestedA.scope.canonicalWhereClause !== nestedB.scope.canonicalWhereClause) {
      differences.push({
        category: "business_logic_mismatch",
        description: `${scopeLabel} changes its filter from ${nestedA.scope.canonicalWhereClause || "no filter"} to ${nestedB.scope.canonicalWhereClause || "no filter"}. This changes the population produced by that scope without attributing the change to the outer query.`,
        impact: /correlated/i.test(scopeLabel) ? "high" : "medium",
      });
    }
  }

  return differences;
}

function compareJoinPredicates(
  queryA: ParsedSqlQuery,
  queryB: ParsedSqlQuery,
  sourceRoles?: SourceRoleComparison,
): DetectedDifference | null {
  if (
    queryA.joinClauses.length === 0 ||
    queryA.joinClauses.length !== queryB.joinClauses.length
  ) {
    return null;
  }
  if (sourceRoles?.safe) {
    if (
      sourceRoles.analysisA.graphSignature === sourceRoles.analysisB.graphSignature
    ) {
      return null;
    }
    return {
      category: "business_logic_mismatch",
      description: `The source-role join graph changes from ${sourceRoles.analysisA.graphDescription} to ${sourceRoles.analysisB.graphDescription}. Different role edges or join-key fields can change matches, row multiplication, and the measured population even when every occurrence comes from the same physical table.`,
      impact: "high",
    };
  }
  const predicatesA = [...getSqlStructure(queryA).root.joinPredicates].sort();
  const predicatesB = [...getSqlStructure(queryB).root.joinPredicates].sort();
  if (predicatesA.join("|") === predicatesB.join("|")) {
    return null;
  }

  return {
    category: "business_logic_mismatch",
    description: `The join predicate changes from ${predicatesA.join(", ") || "none"} to ${predicatesB.join(", ") || "none"}. Different join keys can change matches, row multiplication, and the measured population.`,
    impact: "high",
  };
}

function compareJoinPopulation(
  queryA: ParsedSqlQuery,
  queryB: ParsedSqlQuery,
): DetectedDifference | null {
  const sharedTables = queryA.tables.filter((table) => queryB.tables.includes(table));
  if (sharedTables.length === 0 || queryA.tables.length === queryB.tables.length) {
    return null;
  }

  const joinedQueryLabel = queryA.tables.length > queryB.tables.length ? "Query A" : "Query B";
  const simpleQueryLabel = joinedQueryLabel === "Query A" ? "Query B" : "Query A";
  const joinedQuery = joinedQueryLabel === "Query A" ? queryA : queryB;
  const simpleQuery = joinedQueryLabel === "Query A" ? queryB : queryA;
  const extraTables = joinedQuery.tables.filter((table) => !simpleQuery.tables.includes(table));

  if (extraTables.length === 0) {
    return null;
  }

  return {
    category: "business_logic_mismatch",
    description: `${joinedQueryLabel} joins ${sharedTables.join(", ")} to ${extraTables.join(", ")}, while ${simpleQueryLabel} reads only ${simpleQuery.tables.join(", ")}. The JOIN can restrict the population to records with matching rows from ${extraTables.join(", ")} and may multiply rows when the relationship is one-to-many.`,
    impact: "high",
  };
}

function formatJoinType(type: ParsedSqlQuery["joinClauses"][number]["type"]): string {
  if (type === "inner") {
    return "INNER JOIN";
  }

  return `${type.toUpperCase()} JOIN`;
}

function compareJoinType(
  queryA: ParsedSqlQuery,
  queryB: ParsedSqlQuery,
): DetectedDifference | null {
  if (queryA.joinClauses.length === 0 || queryA.joinClauses.length !== queryB.joinClauses.length) {
    return null;
  }

  for (let index = 0; index < queryA.joinClauses.length; index += 1) {
    const joinA = queryA.joinClauses[index];
    const joinB = queryB.joinClauses[index];

    if (joinA.table !== joinB.table || joinA.type === joinB.type) {
      continue;
    }

    const leftToInner = joinA.type === "left" && joinB.type === "inner";
    const exclusionNote = leftToInner
      ? "LEFT JOIN preserves users without matching orders, while INNER JOIN keeps only users with matching order records. Users without orders may be excluded in Query B."
      : "Changing the join type can change which base-table records are preserved when there is no matching joined row.";

    return {
      category: "join_type_mismatch",
      description: `The join type changed from ${formatJoinType(joinA.type)} to ${formatJoinType(joinB.type)} for ${joinA.table}. ${exclusionNote} Results may not be directly comparable.`,
      impact: "high",
    };
  }

  return null;
}

function compareTimeReference(
  profileA: QuerySemanticProfile,
  profileB: QuerySemanticProfile,
): DetectedDifference | null {
  if (!profileA.timeField && !profileB.timeField && !profileA.timeHorizon && !profileB.timeHorizon) {
    return null;
  }

  if (profileA.timeHorizon && profileA.timeHorizon === profileB.timeHorizon) {
    const engagementInvolved =
      profileA.primaryDimension === "engagement" ||
      profileB.primaryDimension === "engagement" ||
      profileA.secondaryDimensions.includes("engagement") ||
      profileB.secondaryDimensions.includes("engagement");

    if (engagementInvolved && profileA.timeField !== profileB.timeField) {
      return null;
    }

    if (profileA.timeField && profileB.timeField && profileA.timeField !== profileB.timeField) {
      return {
        category: "time_reference_mismatch",
        description: `Both queries use the same ${profileA.timeHorizon} horizon, but anchor it to different fields: Query A uses ${profileA.timeField}, while Query B uses ${profileB.timeField}. This changes what "recent" means operationally.`,
        impact: "medium",
      };
    }

    return null;
  }

  if (profileA.timeHorizon !== profileB.timeHorizon) {
    return {
      category: "time_reference_mismatch",
      description: `The queries use different recency windows: ${profileA.timeHorizon || "unspecified"} in Query A vs ${profileB.timeHorizon || "unspecified"} in Query B.`,
      impact: "medium",
    };
  }

  return null;
}

function inferReportingGrain(query: ParsedSqlQuery): string | null {
  const groupText = query.groupByExpressions.join(" | ").toLowerCase();
  if (!groupText) {
    return null;
  }

  if (/\bdate_trunc\s*\(\s*['"]month['"]/.test(groupText)) {
    return "monthly";
  }

  if (/\bdate_trunc\s*\(\s*['"]week['"]/.test(groupText)) {
    return "weekly";
  }

  if (
    /\bdate_trunc\s*\(\s*['"]day['"]/.test(groupText) ||
    /\bdate\s*\(/.test(groupText) ||
    /::\s*date\b/.test(groupText)
  ) {
    return "daily";
  }

  return query.groupByExpressions.length > 0 ? groupText : null;
}

function compareReportingGrain(
  queryA: ParsedSqlQuery,
  queryB: ParsedSqlQuery,
  sourceRoles?: SourceRoleComparison,
): DetectedDifference | null {
  const grainA = inferReportingGrain(queryA);
  const grainB = inferReportingGrain(queryB);

  if (!grainA && !grainB) {
    return null;
  }

  if (grainA === grainB) {
    return null;
  }

  if (
    sourceRoles?.safe &&
    sourceRoles.analysisA.graphSignature === sourceRoles.analysisB.graphSignature &&
    normalizePositionalSourceIdentity(grainA ?? "") ===
      normalizePositionalSourceIdentity(grainB ?? "") &&
    arraysEqual(
      getSourceUsageSignatures(sourceRoles.analysisA, ["grouping"]),
      getSourceUsageSignatures(sourceRoles.analysisB, ["grouping"]),
    )
  ) {
    return null;
  }

  return {
    category: "reporting_grain_mismatch",
    description: `The reporting grain changed from ${grainA || "ungrouped"} to ${grainB || "ungrouped"}. Daily, weekly, monthly, and ungrouped trend points are not directly comparable even when the table, filters, and aggregation match.`,
    impact: "medium",
  };
}

function compareActivityBasis(
  profileA: QuerySemanticProfile,
  profileB: QuerySemanticProfile,
): DetectedDifference | null {
  const engagementInvolved =
    profileA.primaryDimension === "engagement" ||
    profileB.primaryDimension === "engagement" ||
    profileA.secondaryDimensions.includes("engagement") ||
    profileB.secondaryDimensions.includes("engagement");

  if (!engagementInvolved) {
    return null;
  }

  if (!profileA.timeField && !profileB.timeField && profileA.sourceDomain === profileB.sourceDomain) {
    return null;
  }

  if (profileA.timeField === profileB.timeField && profileA.primaryDimension === profileB.primaryDimension) {
    return null;
  }

  return {
    category: "activity_basis_mismatch",
    description: `The activity basis is different. Query A defines recency through ${profileA.timeField || profileA.sourceDomain}, while Query B defines it through ${profileB.timeField || profileB.sourceDomain}. They do not use the same operational definition of activity.`,
    impact: "high",
  };
}

function compareMonetization(
  profileA: QuerySemanticProfile,
  profileB: QuerySemanticProfile,
  queryA: ParsedSqlQuery,
  queryB: ParsedSqlQuery,
): DetectedDifference | null {
  const aMonetized =
    profileA.primaryDimension === "monetization" ||
    profileA.secondaryDimensions.includes("monetization");
  const bMonetized =
    profileB.primaryDimension === "monetization" ||
    profileB.secondaryDimensions.includes("monetization");

  if (aMonetized === bMonetized) {
    return null;
  }

  const aSignal = queryA.filters.find(isMonetizationFilter);
  const bSignal = queryB.filters.find(isMonetizationFilter);

  if (aSignal && !bSignal) {
    return {
      category: "monetization_mismatch",
      description: `Query B removes the monetization gate from Query A (${formatFilterList([aSignal])}). The measured population becomes broader: Query A measures monetized ${profileA.entityLabel}, while Query B measures all ${profileB.entityLabel}.`,
      impact: "high",
    };
  }

  if (bSignal && !aSignal) {
    return {
      category: "monetization_mismatch",
      description: `Query B adds a monetization gate that Query A does not have (${formatFilterList([bSignal])}). The measured population becomes narrower: Query A measures all ${profileA.entityLabel}, while Query B measures monetized ${profileB.entityLabel}.`,
      impact: "high",
    };
  }

  return {
    category: "monetization_mismatch",
    description: `Only one query includes a monetization gate. Query A: ${aSignal || "no monetization condition detected"}. Query B: ${bSignal || "no monetization condition detected"}.`,
    impact: "high",
  };
}

function isMonetizationFilter(filter: string): boolean {
  return /paid|subscription|mrr|arr|is_paid|revenue\s*>\s*0/i.test(filter);
}

function isRevenueField(field: string | null): boolean {
  return Boolean(field && /^(amount|total|revenue|price)$/i.test(field));
}

function hasTableMatching(query: ParsedSqlQuery, pattern: RegExp): boolean {
  return query.tables.some((table) => pattern.test(table));
}

function isOrdersPaymentsSourceChange(queryA: ParsedSqlQuery, queryB: ParsedSqlQuery): boolean {
  const aUsesOrders = hasTableMatching(queryA, /\borders?\b/i);
  const bUsesOrders = hasTableMatching(queryB, /\borders?\b/i);
  const aUsesPayments = hasTableMatching(queryA, /\bpayments?\b/i);
  const bUsesPayments = hasTableMatching(queryB, /\bpayments?\b/i);

  return (aUsesOrders && bUsesPayments) || (aUsesPayments && bUsesOrders);
}

function formatFilterList(filters: string[]): string {
  return filters.map((filter) => `"${filter}"`).join("; ");
}

function describeRemovedExclusion(filter: string): string | null {
  if (/status\s*!=\s*'deleted'/i.test(filter)) {
    return "deleted users";
  }

  if (/deleted_at\s+is\s+null/i.test(filter)) {
    return "users with deleted_at set";
  }

  if (/is_deleted\s*=\s*false/i.test(filter)) {
    return "deleted users";
  }

  if (/is_test\s*=\s*false/i.test(filter)) {
    return "test users";
  }

  if (/email\s+not\s+like\s+'%@company\.com'/i.test(filter)) {
    return "internal/company accounts";
  }

  return null;
}

function formatPotentiallyIncludedPopulation(excludedPopulation: string): string {
  if (excludedPopulation === "internal/company accounts") {
    return "employee/internal/test accounts";
  }

  return excludedPopulation;
}

function findRemovedExclusion(filters: string[]): {
  filter: string;
  excludedPopulation: string;
} | null {
  for (const filter of filters) {
    const excludedPopulation = describeRemovedExclusion(filter);
    if (excludedPopulation) {
      return { filter, excludedPopulation };
    }
  }

  return null;
}

interface SegmentFilter {
  field: string;
  value: string;
}

function parseSegmentFilter(filter: string): SegmentFilter | null {
  const match = filter.match(
    /^(?:[a-zA-Z_][a-zA-Z0-9_]*\.)?(country|region|market|locale|plan|tier|device|platform)\s*=\s*(?:'([^']+)'|"([^"]+)"|([a-zA-Z0-9_-]+))$/i,
  );
  if (!match || isMonetizationFilter(filter)) {
    return null;
  }

  return {
    field: match[1].toLowerCase(),
    value: match[2] || match[3] || match[4],
  };
}

function findSegmentChange(filtersA: string[], filtersB: string[]): {
  a: SegmentFilter;
  b: SegmentFilter;
} | null {
  for (const filterA of filtersA) {
    const segmentA = parseSegmentFilter(filterA);
    if (!segmentA) {
      continue;
    }

    const matchingSegmentB = filtersB
      .map((filterB) => parseSegmentFilter(filterB))
      .find((segmentB): segmentB is SegmentFilter =>
        Boolean(segmentB && segmentB.field === segmentA.field && segmentB.value !== segmentA.value),
      );

    if (matchingSegmentB) {
      return { a: segmentA, b: matchingSegmentB };
    }
  }

  return null;
}

function formatSegmentValue(segment: SegmentFilter): string {
  return segment.value.toUpperCase();
}

function describeSegmentPopulation(query: ParsedSqlQuery): string | null {
  const segment = query.filters.map((filter) => parseSegmentFilter(filter)).find(Boolean);
  if (!segment) {
    return null;
  }

  if (segment.field === "country") {
    return `${formatSegmentValue(segment)} users`;
  }

  return `${formatSegmentValue(segment)} ${segment.field} users`;
}

function describeExclusionPopulation(query: ParsedSqlQuery): string | null {
  const removedExclusion = findRemovedExclusion(query.filters);
  if (!removedExclusion) {
    return null;
  }

  if (removedExclusion.excludedPopulation === "deleted users") {
    return "users excluding deleted users";
  }

  return `users excluding ${removedExclusion.excludedPopulation}`;
}

function formatAggregation(query: ParsedSqlQuery): string {
  if (!query.aggregation) {
    return "no aggregation";
  }

  if (query.aggregation === "count" && getDistinctCountTarget(query)) {
    return `COUNT(DISTINCT ${query.aggregationDistinctTarget || "*"})`;
  }

  return `${query.aggregation.toUpperCase()}(${query.aggregationDistinctTarget || "*"})`;
}

function getDistinctCountTarget(query: ParsedSqlQuery): string | null {
  const distinctCountExpression = query.selectedExpressions.find((expression) =>
    /\bcount\s*\(\s*distinct\s+/i.test(expression),
  );

  return distinctCountExpression ? query.aggregationDistinctTarget : null;
}

function isDistinctUserVsRowCountChange(queryA: ParsedSqlQuery, queryB: ParsedSqlQuery): boolean {
  const aCountsUsers = queryA.aggregation === "count" && getDistinctCountTarget(queryA) === "user_id";
  const bCountsUsers = queryB.aggregation === "count" && getDistinctCountTarget(queryB) === "user_id";
  const aCountsRows = queryA.aggregation === "count" && queryA.aggregationDistinctTarget === "*";
  const bCountsRows = queryB.aggregation === "count" && queryB.aggregationDistinctTarget === "*";

  return (aCountsUsers && bCountsRows) || (aCountsRows && bCountsUsers);
}

function describeDistinctUserRowCountChange(
  queryA: ParsedSqlQuery,
  queryB: ParsedSqlQuery,
): string {
  const aDistinctTarget = getDistinctCountTarget(queryA);
  const bDistinctTarget = getDistinctCountTarget(queryB);

  if (aDistinctTarget && queryB.aggregationDistinctTarget === "*") {
    return `Query A counts distinct ${aDistinctTarget} values, while Query B counts event rows.`;
  }

  if (bDistinctTarget && queryA.aggregationDistinctTarget === "*") {
    return `Query A counts event rows, while Query B counts distinct ${bDistinctTarget} values.`;
  }

  return "One query counts distinct values, while the other counts event rows.";
}

function buildAggregationDifferenceDescription(
  queryA: ParsedSqlQuery,
  queryB: ParsedSqlQuery,
  aggregationsA: SqlAggregationSummary[],
  aggregationsB: SqlAggregationSummary[],
): string {
  const displayA = aggregationsA.map((item) => item.display);
  const displayB = aggregationsB.map((item) => item.display);
  const baseDescription =
    aggregationsA.length <= 1 && aggregationsB.length <= 1
      ? `Aggregation changed from ${displayA[0] ?? formatAggregation(queryA)} to ${displayB[0] ?? formatAggregation(queryB)}. Query A uses ${aggregationsA[0]?.functionName ?? queryA.aggregation ?? "no aggregation"} over ${aggregationsA[0]?.argument ?? queryA.aggregationDistinctTarget ?? "*"}, while Query B uses ${aggregationsB[0]?.functionName ?? queryB.aggregation ?? "no aggregation"} over ${aggregationsB[0]?.argument ?? queryB.aggregationDistinctTarget ?? "*"}.`
      : `Aggregation set changed. Query A computes ${displayA.join(", ") || "no aggregation"}, while Query B computes ${displayB.join(", ") || "no aggregation"}. All aggregate expressions are compared regardless of SELECT order.`;

  if (isDistinctUserVsRowCountChange(queryA, queryB)) {
    return `${baseDescription} ${describeDistinctUserRowCountChange(queryA, queryB)} This changes the metric from unique users to event rows; repeated events by the same user can make COUNT(*) larger than COUNT(DISTINCT user_id).`;
  }

  return baseDescription;
}

function getTableLabel(query: ParsedSqlQuery): string {
  if (query.tables.some((table) => /\bevents?\b/i.test(table))) {
    return "events";
  }

  if (query.tables.some((table) => /\busers?\b/i.test(table))) {
    return "users";
  }

  if (query.tables.length > 0) {
    return query.tables.join(", ");
  }

  return "records";
}

function describeFilterScope(query: ParsedSqlQuery): string {
  const eventFilter = query.filters.find((filter) => /\bevent\s*=\s*'[^']+'/i.test(filter));
  const eventName = eventFilter?.match(/'([^']+)'/)?.[1];
  if (eventName) {
    return `${eventName} events`;
  }

  if (query.filters.length > 0) {
    return `${getTableLabel(query)} matching ${formatFilterList(query.filters)}`;
  }

  return `all ${getTableLabel(query)}`;
}

function describeDistinctUserOrRowCount(
  query: ParsedSqlQuery,
  timeWindowLabel: string | null,
): string | null {
  const eventFilter = query.filters.find((filter) => /\bevent\s*=\s*'[^']+'/i.test(filter));
  const eventName = eventFilter?.match(/'([^']+)'/)?.[1];
  if (!eventName || query.aggregation !== "count") {
    return null;
  }

  if (query.aggregationDistinctTarget === "user_id") {
    return `Measures unique users with ${eventName} events.`;
  }

  if (query.aggregationDistinctTarget === "*") {
    const timePrefix = timeWindowLabel ? `${timeWindowLabel} ` : "";
    return `Measures ${timePrefix}${eventName} events / ${eventName} event rows.`;
  }

  return null;
}

function describeJoinPopulation(query: ParsedSqlQuery): string | null {
  if (query.tables.length < 2) {
    return null;
  }

  const baseTable = query.tables[0];
  const joinedTables = query.tables.slice(1);
  const firstJoinType = query.joinClauses[0]?.type;

  if (hasTableMatching(query, /\busers?\b/i) && hasTableMatching(query, /\borders?\b/i)) {
    if (firstJoinType === "left") {
      return "Measures all users with optional order matches / possible order data.";
    }

    if (firstJoinType === "inner") {
      return "Measures users joined with orders / users with matching order records.";
    }

    return "Measures users joined with orders / users with matching order records.";
  }

  return `Measures ${baseTable} joined with ${joinedTables.join(", ")}.`;
}

function getSingularEntityLabel(query: ParsedSqlQuery): string {
  const label = getTableLabel(query);
  if (label === "orders/transactions" || /^orders?\b/i.test(label)) {
    return "order";
  }

  if (/^payments?\b/i.test(label)) {
    return "payment";
  }

  if (/^users?\b/i.test(label)) {
    return "user";
  }

  if (/^events?\b/i.test(label)) {
    return "event";
  }

  return "record";
}

function describeQualifiedEntity(query: ParsedSqlQuery): string {
  const entity = getSingularEntityLabel(query);
  const eventFilter = query.filters.find((filter) => /\bevent\s*=\s*'[^']+'/i.test(filter));
  const eventName = eventFilter?.match(/'([^']+)'/)?.[1];
  if (eventName) {
    return `${eventName} ${entity}s`;
  }

  const monetizationFilter = query.filters.find(isMonetizationFilter);
  if (monetizationFilter) {
    return `paid ${entity}s`;
  }

  if (query.filters.length > 0) {
    return `${entity}s matching ${formatFilterList(query.filters)}`;
  }

  return `all ${entity}s`;
}

function formatTimeWindowLabel(timeHorizon: string | null): string | null {
  if (!timeHorizon) {
    return null;
  }

  const match = timeHorizon.match(/^(\d+)\s+([a-z]+)s?$/i);
  if (!match) {
    return timeHorizon;
  }

  return `${match[1]}-${match[2].toLowerCase().replace(/s$/, "")}`;
}

function describeAggregationMeasure(query: ParsedSqlQuery): string | null {
  const qualifiedEntity = describeQualifiedEntity(query);

  const isCommercialEntity = query.tables.some((table) => /orders?|payments?|transactions?/i.test(table));
  if (query.aggregation === "count" && isCommercialEntity) {
    return `Measures the count of ${qualifiedEntity}.`;
  }

  if (query.aggregation === "sum" && isRevenueField(query.aggregationDistinctTarget)) {
    return `Measures the total amount/revenue from ${qualifiedEntity}.`;
  }

  return null;
}

function hasSameConditionSet(queryA: ParsedSqlQuery, queryB: ParsedSqlQuery): boolean {
  const conditionsA = [...queryA.conditions].sort().join(" | ");
  const conditionsB = [...queryB.conditions].sort().join(" | ");
  return conditionsA === conditionsB;
}

function usesOnly(
  operators: ParsedSqlQuery["whereOperators"],
  operator: "and" | "or",
): boolean {
  return operators.length > 0 && operators.every((item) => item === operator);
}

function compareFilterBooleanLogic(
  queryA: ParsedSqlQuery,
  queryB: ParsedSqlQuery,
): DetectedDifference | null {
  const booleanA = getSqlStructure(queryA).root.booleanExpression;
  const booleanB = getSqlStructure(queryB).root.booleanExpression;
  if (booleanA && booleanB) {
    if (booleanA.canonical === booleanB.canonical) {
      return null;
    }

    if (booleanA.predicates.join("|") !== booleanB.predicates.join("|")) {
      return null;
    }

    if (booleanA.hasNegation !== booleanB.hasNegation) {
      return {
        category: "filter_logic_mismatch",
        description: "The WHERE boolean negation structure changed while the underlying predicates stayed the same. Adding or removing NOT can invert which records qualify for the metric.",
        impact: "high",
      };
    }

    const simpleAndOrTransition =
      (usesOnly(queryA.whereOperators, "and") && usesOnly(queryB.whereOperators, "or")) ||
      (usesOnly(queryA.whereOperators, "or") && usesOnly(queryB.whereOperators, "and"));
    if (!simpleAndOrTransition) {
      return {
        category: "filter_logic_mismatch",
        description: `The WHERE boolean operator structure changed through different AND/OR grouping while the predicates stayed the same (${formatFilterList(booleanA.predicates)}). Different parenthesis and precedence structure can change the measured population.`,
        impact: "high",
      };
    }
  }

  // Only judge boolean structure when the individual conditions are identical;
  // added or removed conditions are covered by the filter-scope detectors.
  if (!queryA.whereClause || !queryB.whereClause || !hasSameConditionSet(queryA, queryB)) {
    return null;
  }

  if (queryA.whereOperators.join("|") === queryB.whereOperators.join("|")) {
    return null;
  }

  const conditions = formatFilterList(queryA.conditions);

  if (usesOnly(queryA.whereOperators, "and") && usesOnly(queryB.whereOperators, "or")) {
    return {
      category: "filter_logic_mismatch",
      description: `The WHERE filter logic changed from AND to OR. The conditions are unchanged (${conditions}), but Query A requires all conditions to hold, while Query B qualifies records matching any single condition. The measured population becomes broader.`,
      impact: "high",
    };
  }

  if (usesOnly(queryA.whereOperators, "or") && usesOnly(queryB.whereOperators, "and")) {
    return {
      category: "filter_logic_mismatch",
      description: `The WHERE filter logic changed from OR to AND. The conditions are unchanged (${conditions}), but Query A qualifies records matching any single condition, while Query B requires all conditions to hold. The measured population becomes narrower.`,
      impact: "high",
    };
  }

  return {
    category: "filter_logic_mismatch",
    description: `The WHERE boolean operator structure changed while the conditions stayed the same (${conditions}). Combining the same conditions with a different AND/OR structure can broaden or narrow the measured population.`,
    impact: "medium",
  };
}

function compareBusinessLogic(
  queryA: ParsedSqlQuery,
  queryB: ParsedSqlQuery,
  profileA: QuerySemanticProfile,
  profileB: QuerySemanticProfile,
  sourceRoles?: SourceRoleComparison,
): DetectedDifference | null {
  if (
    sourceRoles?.safe &&
    sourceRoles.analysisA.graphSignature === sourceRoles.analysisB.graphSignature &&
    arraysEqual(
      [...queryA.filters].map(normalizePositionalSourceIdentity).sort(),
      [...queryB.filters].map(normalizePositionalSourceIdentity).sort(),
    ) &&
    arraysEqual(
      getSourceUsageSignatures(sourceRoles.analysisA, ["filter"]),
      getSourceUsageSignatures(sourceRoles.analysisB, ["filter"]),
    )
  ) {
    return null;
  }
  const ignorePatterns = [
    /paid|subscription|plan|mrr|arr/i,
    /last_active|event_date|created_at|current_date|current_timestamp|interval/i,
  ];
  const onlyInA = queryA.filters.filter(
    (value) => !queryB.filters.includes(value) && !ignorePatterns.some((pattern) => pattern.test(value)),
  );
  const onlyInB = queryB.filters.filter(
    (value) => !queryA.filters.includes(value) && !ignorePatterns.some((pattern) => pattern.test(value)),
  );

  if (onlyInA.length === 0 && onlyInB.length === 0) {
    return null;
  }

  const sameEntitySpace = profileA.entityLabel === profileB.entityLabel;
  const impact = sameEntitySpace ? "medium" : "high";
  const scopeA = describeFilterScope(queryA);
  const scopeB = describeFilterScope(queryB);
  const removedExclusion = findRemovedExclusion(onlyInA);
  const segmentChange = findSegmentChange(onlyInA, onlyInB);

  if (removedExclusion && onlyInB.length === 0) {
    return {
      category: "business_logic_mismatch",
      description: `Query B removes the exclusion filter from Query A (${formatFilterList([removedExclusion.filter])}). The measured population becomes broader and may now include ${formatPotentiallyIncludedPopulation(removedExclusion.excludedPopulation)}. Query A measures ${describeExclusionPopulation(queryA) || scopeA}, while Query B measures ${scopeB}.`,
      impact,
    };
  }

  if (segmentChange) {
    return {
      category: "business_logic_mismatch",
      description: `The segment filter changes on ${segmentChange.a.field}: Query A measures ${formatSegmentValue(segmentChange.a)}, while Query B measures ${formatSegmentValue(segmentChange.b)}. The metric shape is the same, but the queries compare different user cohorts/segments.`,
      impact: "medium",
    };
  }

  if (onlyInA.length > 0 && onlyInB.length === 0) {
    return {
      category: "business_logic_mismatch",
      description: `Query B removes filter logic from Query A (${formatFilterList(onlyInA)}). The measured population becomes broader: Query A measures ${scopeA}, while Query B measures ${scopeB}. This changes the business meaning of the metric, not just the SQL shape.`,
      impact,
    };
  }

  if (onlyInB.length > 0 && onlyInA.length === 0) {
    return {
      category: "business_logic_mismatch",
      description: `Query B adds filter logic that Query A does not have (${formatFilterList(onlyInB)}). The measured population becomes narrower: Query A measures ${scopeA}, while Query B measures ${scopeB}. This changes the business meaning of the metric, not just the SQL shape.`,
      impact,
    };
  }

  return {
    category: "business_logic_mismatch",
    description: `The inclusion logic is different. Query A keeps ${formatFilterList(onlyInA) || "no unique filters"}, while Query B keeps ${formatFilterList(onlyInB) || "no unique filters"}. This changes who qualifies for the metric.`,
    impact,
  };
}

function compareDescriptions(
  inputA: MetricDefinitionInput,
  inputB: MetricDefinitionInput,
): DetectedDifference | null {
  const descriptionA = normalizeText(inputA.description);
  const descriptionB = normalizeText(inputB.description);
  if (!descriptionA || !descriptionB || descriptionA === descriptionB) {
    return null;
  }

  const dimensionA = inferDimensionFromMetadata(inputA);
  const dimensionB = inferDimensionFromMetadata(inputB);
  const impact =
    dimensionA !== "unknown" && dimensionB !== "unknown" && dimensionA !== dimensionB
      ? "high"
      : "medium";

  return {
    category: "description_mismatch",
    description: `The metric descriptions do not align. Query A is described as "${inputA.description}", while Query B is described as "${inputB.description}".`,
    impact,
  };
}

function compareTeamContext(
  inputA: MetricDefinitionInput,
  inputB: MetricDefinitionInput,
): DetectedDifference | null {
  const teamA = normalizeText(inputA.team_context);
  const teamB = normalizeText(inputB.team_context);
  if (!teamA || !teamB || teamA === teamB) {
    return null;
  }

  return {
    category: "team_context_mismatch",
    description: `The metrics come from different team contexts: Query A is tagged for ${inputA.team_context}, while Query B is tagged for ${inputB.team_context}.`,
    impact: "medium",
  };
}

function compareIntendedUse(
  inputA: MetricDefinitionInput,
  inputB: MetricDefinitionInput,
): DetectedDifference | null {
  const useA = normalizeText(inputA.intended_use);
  const useB = normalizeText(inputB.intended_use);
  if (!useA || !useB || useA === useB) {
    return null;
  }

  return {
    category: "intended_use_mismatch",
    description: `The intended uses differ: Query A is meant for ${inputA.intended_use}, while Query B is meant for ${inputB.intended_use}.`,
    impact: "medium",
  };
}

function compareMetricIntent(
  profileA: QuerySemanticProfile,
  profileB: QuerySemanticProfile,
  differences: DetectedDifference[],
): DetectedDifference | null {
  if (profileA.businessMeaning === profileB.businessMeaning) {
    return null;
  }

  if (profileA.primaryDimension === profileB.primaryDimension) {
    return null;
  }

  const hasMonetizationMismatch = differences.some(
    (difference) => difference.category === "monetization_mismatch",
  );
  const monetizationVsPopulation =
    [profileA.primaryDimension, profileB.primaryDimension].includes("monetization") &&
    [profileA.primaryDimension, profileB.primaryDimension].includes("population");
  if (hasMonetizationMismatch && monetizationVsPopulation) {
    return null;
  }

  if (
    profileA.primaryDimension === profileB.primaryDimension &&
    differences.some((difference) => difference.category === "source_domain_mismatch")
  ) {
    return null;
  }

  if (
    differences.some(
      (difference) =>
        (difference.category === "business_logic_mismatch" &&
          /The JOIN can restrict the population/i.test(difference.description)) ||
        difference.category === "join_type_mismatch",
    )
  ) {
    return null;
  }

  if (
    differences.some(
      (difference) =>
        difference.category === "aggregation_mismatch" &&
        /unique users to event rows/i.test(difference.description),
    )
  ) {
    return null;
  }

  return {
    category: "metric_intent_mismatch",
    description: `The metrics point to different business concepts: Query A is ${profileA.primaryDimension}, while Query B is ${profileB.primaryDimension}.`,
    impact: "high",
  };
}

function deriveEvidenceSources(
  inputA: MetricDefinitionInput,
  inputB: MetricDefinitionInput,
  profileA: QuerySemanticProfile,
  profileB: QuerySemanticProfile,
  differences: DetectedDifference[],
): EvidenceSource[] {
  const categories = new Set(differences.map((difference) => difference.category));
  const metadataEvidence = new Set<EvidenceSource>();
  const metadataDimensionA = inferDimensionFromMetadata(inputA);
  const metadataDimensionB = inferDimensionFromMetadata(inputB);
  const hasMeaningfulSqlDifference =
    profileA.primaryDimension !== profileB.primaryDimension ||
    differences.some((difference) =>
      [
        "source_domain_mismatch",
        "activity_basis_mismatch",
        "monetization_mismatch",
        "time_reference_mismatch",
        "join_type_mismatch",
        "filter_logic_mismatch",
        "metric_intent_mismatch",
      ].includes(difference.category),
    );

  if (inputA.metric_name && inputB.metric_name) {
    metadataEvidence.add("metric_name");
  }

  if (
    inputA.description &&
    inputB.description &&
    (
      categories.has("description_mismatch") ||
      (hasMeaningfulSqlDifference &&
        metadataDimensionA !== "unknown" &&
        metadataDimensionB !== "unknown" &&
        metadataDimensionA !== metadataDimensionB)
    )
  ) {
    metadataEvidence.add("description");
  }

  if (
    inputA.team_context &&
    inputB.team_context &&
    (categories.has("team_context_mismatch") || hasMeaningfulSqlDifference)
  ) {
    metadataEvidence.add("team_context");
  }

  if (
    inputA.intended_use &&
    inputB.intended_use &&
    (categories.has("intended_use_mismatch") || hasMeaningfulSqlDifference)
  ) {
    metadataEvidence.add("intended_use");
  }

  if (metadataEvidence.size === 0) {
    return ["sql_only"];
  }

  return ["sql", ...metadataEvidence];
}

function inferConfidenceLevel(
  evidenceSources: EvidenceSource[],
  differences: DetectedDifference[],
): ConfidenceLevel {
  if (evidenceSources.includes("sql_only")) {
    return differences.length > 0 ? "medium" : "low";
  }

  const metadataCount = evidenceSources.filter((source) => source !== "sql").length;
  if (differences.length === 0) {
    return metadataCount >= 2 ? "medium" : "low";
  }

  if (metadataCount >= 2) {
    return "high";
  }

  return "medium";
}

function applyParserConfidenceCap(
  confidenceLevel: ConfidenceLevel,
  confidenceCap: ParserConfidenceCap | undefined,
): ConfidenceLevel {
  if (!confidenceCap || confidenceLevel === "low") {
    return confidenceLevel;
  }

  if (confidenceCap === "low") {
    return "low";
  }

  return confidenceLevel === "high" ? "medium" : confidenceLevel;
}

function getMostRestrictiveParserConfidenceCap(
  first: ParserConfidenceCap | undefined,
  second: ParserConfidenceCap | undefined,
): ParserConfidenceCap | undefined {
  if (first === "low" || second === "low") {
    return "low";
  }

  if (first === "medium" || second === "medium") {
    return "medium";
  }

  return undefined;
}

function ensureRiskCoversDetectedDifferences(
  riskLevel: RiskLevel,
  differences: DetectedDifference[],
): RiskLevel {
  if (differences.some((difference) => difference.impact === "high")) {
    return "high";
  }

  if (riskLevel === "low" && differences.some((difference) => difference.impact === "medium")) {
    return "medium";
  }

  return riskLevel;
}

function buildMetadataContextNote(
  inputA: MetricDefinitionInput,
  inputB: MetricDefinitionInput,
): string {
  const fields: Array<{
    label: string;
    a: string | undefined;
    b: string | undefined;
  }> = [
    { label: "metric names", a: inputA.metric_name, b: inputB.metric_name },
    { label: "descriptions", a: inputA.description, b: inputB.description },
    { label: "team context", a: inputA.team_context, b: inputB.team_context },
    { label: "intended use", a: inputA.intended_use, b: inputB.intended_use },
  ];

  const fullyAvailable = fields.filter((field) => field.a && field.b).map((field) => field.label);
  const partiallyAvailable = fields
    .filter((field) => (field.a && !field.b) || (!field.a && field.b))
    .map((field) => field.label);

  if (fullyAvailable.length === 0 && partiallyAvailable.length === 0) {
    return " No metadata context was provided, so this is based on SQL evidence only.";
  }

  if (partiallyAvailable.length > 0) {
    return ` Partial metadata was available. Fully compared: ${fullyAvailable.join(", ") || "none"}. Available on only one side: ${partiallyAvailable.join(", ")}.`;
  }

  return " Full metadata context was available for both inputs.";
}

function buildBusinessMeaningSummary(query: ParsedSqlQuery, profile: QuerySemanticProfile): string {
  const eventFilter = query.filters.find((filter) => /\bevent\s*=\s*'[^']+'/i.test(filter));
  const eventName = eventFilter?.match(/'([^']+)'/)?.[1];
  const reportingGrain = inferReportingGrain(query);
  const timeWindowLabel = formatTimeWindowLabel(profile.timeHorizon);
  const distinctUserOrRowCount = describeDistinctUserOrRowCount(query, timeWindowLabel);
  if (distinctUserOrRowCount) {
    if (reportingGrain && query.aggregationDistinctTarget === "*") {
      return `Measures ${reportingGrain} ${eventName} event counts.`;
    }

    return distinctUserOrRowCount;
  }

  if (eventName) {
    const timePrefix = timeWindowLabel ? `${timeWindowLabel} ` : "";
    const grainPrefix = reportingGrain ? `${reportingGrain} ` : "";
    return `Measures ${grainPrefix}${timePrefix}${eventName} events from ${query.tables.join(", ") || "the source dataset"}.`;
  }

  const joinPopulation = describeJoinPopulation(query);
  if (joinPopulation) {
    return joinPopulation;
  }

  if (!query.whereClause) {
    return `Measures ${describeFilterScope(query)} without a WHERE filter.`;
  }

  const aggregationMeasure = describeAggregationMeasure(query);
  if (aggregationMeasure) {
    return aggregationMeasure;
  }

  const segmentPopulation = describeSegmentPopulation(query);
  if (segmentPopulation) {
    return `Measures ${segmentPopulation}.`;
  }

  const exclusionPopulation = describeExclusionPopulation(query);
  if (exclusionPopulation) {
    return `Measures ${exclusionPopulation}.`;
  }

  return profile.businessMeaning;
}

function buildExplanation(
  similarity: number,
  inputA: MetricDefinitionInput,
  inputB: MetricDefinitionInput,
  profileA: QuerySemanticProfile,
  profileB: QuerySemanticProfile,
  differences: DetectedDifference[],
  confidenceLevel: ConfidenceLevel,
  evidenceSources: EvidenceSource[],
): string {
  const evidenceNote =
    evidenceSources.includes("sql_only")
      ? "This is a heuristic warning based on SQL structure alone, so confidence is more limited."
      : `Confidence is ${confidenceLevel} because the SQL signal is supported by ${evidenceSources
          .filter((source) => source !== "sql")
          .join(", ")} metadata.`;
  const metadataContextNote = buildMetadataContextNote(inputA, inputB);

  if (differences.length === 0) {
    return `These definitions are close enough to support the same business interpretation. They use similar logic, time framing, and metric intent. ${evidenceNote}${metadataContextNote}`;
  }

  const sameEntitySpace = profileA.entityLabel === profileB.entityLabel;
  const broadEntityText = sameEntitySpace
    ? `Both definitions operate in the same broad entity space (${profileA.entityLabel})`
    : `The definitions do not even operate over the same entity space (${profileA.entityLabel} vs ${profileB.entityLabel})`;
  const filterScopeDifference = differences.find(
    (difference) =>
      difference.category === "business_logic_mismatch" &&
      /measured population becomes (?:broader|narrower)/i.test(difference.description),
  );
  const removedExclusionDifference = differences.find(
    (difference) =>
      difference.category === "business_logic_mismatch" &&
      /removes the exclusion filter/i.test(difference.description),
  );
  const joinPopulationDifference = differences.find(
    (difference) =>
      difference.category === "business_logic_mismatch" &&
      /The JOIN can restrict the population/i.test(difference.description),
  );
  const joinTypeDifference = differences.find(
    (difference) => difference.category === "join_type_mismatch",
  );
  const segmentDifference = differences.find(
    (difference) =>
      difference.category === "business_logic_mismatch" &&
      /different user cohorts\/segments/i.test(difference.description),
  );
  const commerceSourceDifference = differences.find(
    (difference) =>
      difference.category === "source_domain_mismatch" &&
      /Orders and payments may not be interchangeable/i.test(difference.description),
  );
  const monetizationScopeDifference = differences.find(
    (difference) =>
      difference.category === "monetization_mismatch" &&
      /measured population becomes (?:broader|narrower)/i.test(difference.description),
  );
  const countRevenueAggregationDifference = differences.find(
    (difference) =>
      difference.category === "aggregation_mismatch" &&
      /COUNT\([^)]*\).*SUM\((?:amount|total|revenue|price)\)|SUM\((?:amount|total|revenue|price)\).*COUNT\([^)]*\)/i.test(
        difference.description,
      ),
  );
  const distinctUserRowCountDifference = differences.find(
    (difference) =>
      difference.category === "aggregation_mismatch" &&
      /unique users to event rows/i.test(difference.description),
  );
  const timeWindowDifference = differences.find(
    (difference) =>
      difference.category === "time_reference_mismatch" &&
      /different recency windows/i.test(difference.description),
  );
  const reportingGrainDifference = differences.find(
    (difference) => difference.category === "reporting_grain_mismatch",
  );

  if (removedExclusionDifference) {
    return `${broadEntityText}, but removing the exclusion filter broadens the population. ${removedExclusionDifference.description} ${evidenceNote}${metadataContextNote}`;
  }

  if (filterScopeDifference) {
    return `${broadEntityText}, but the filter scope changes the measured population. ${filterScopeDifference.description} ${evidenceNote}${metadataContextNote}`;
  }

  const filterLogicDifference = differences.find(
    (difference) => difference.category === "filter_logic_mismatch",
  );

  if (filterLogicDifference) {
    return `${broadEntityText}, but the boolean filter logic changes the measured population. ${filterLogicDifference.description} ${evidenceNote}${metadataContextNote}`;
  }

  if (joinPopulationDifference) {
    return `${broadEntityText}, but the JOIN changes the measured population. ${joinPopulationDifference.description} This means the metric may count joined rows or users with matching joined records rather than all base-table users. ${evidenceNote}${metadataContextNote}`;
  }

  if (joinTypeDifference) {
    return `${broadEntityText}, but the join type changes population inclusion. ${joinTypeDifference.description} ${evidenceNote}${metadataContextNote}`;
  }

  if (segmentDifference) {
    return `${broadEntityText}, but the segment filter changes the measured cohort. ${segmentDifference.description} This can make the counts diverge even though the table, aggregation, and filter field are aligned. ${evidenceNote}${metadataContextNote}`;
  }

  if (commerceSourceDifference) {
    return `${broadEntityText}, and the filter logic is similar, but the source of truth changes. ${commerceSourceDifference.description} ${evidenceNote}${metadataContextNote}`;
  }

  if (monetizationScopeDifference) {
    return `${broadEntityText}, but the monetization gate changes the measured population. ${monetizationScopeDifference.description} ${evidenceNote}${metadataContextNote}`;
  }

  if (countRevenueAggregationDifference) {
    return `${broadEntityText}, and the filters match, but the metric measure changes. ${countRevenueAggregationDifference.description} This is not just a qualification-rule difference: it changes the metric from order volume/count to monetary value/revenue. ${evidenceNote}${metadataContextNote}`;
  }

  if (distinctUserRowCountDifference) {
    return `${broadEntityText}, and the event filter matches, but the counted unit changes. ${distinctUserRowCountDifference.description} This means one query measures unique users while the other measures event-row volume. ${evidenceNote}${metadataContextNote}`;
  }

  if (timeWindowDifference) {
    return `${broadEntityText}, and the event concept is aligned, but the reporting window differs. ${timeWindowDifference.description} This changes which period the metric represents even though the underlying activity is the same. ${evidenceNote}${metadataContextNote}`;
  }

  if (reportingGrainDifference) {
    return `${broadEntityText}, and the activity concept is aligned, but the reporting grain differs. ${reportingGrainDifference.description} This changes the meaning of each trend point even though the underlying activity is the same. ${evidenceNote}${metadataContextNote}`;
  }

  if (profileA.primaryDimension !== profileB.primaryDimension) {
    return `${broadEntityText}, but they do not measure the same business concept. Query A measures ${profileA.primaryDimension === "engagement" ? "recent product engagement" : profileA.primaryDimension}, while Query B measures ${profileB.primaryDimension === "monetization" ? "monetized or paying activity" : profileB.primaryDimension}. They may look similar structurally, but they support different business decisions and should not be treated as interchangeable. ${evidenceNote}${metadataContextNote}`;
  }

  if (similarity < 45) {
    return `${broadEntityText}, but the operational definition is materially different. Differences in activity basis, qualification rules, or time reference mean the metrics can diverge even if teams use similar names. ${evidenceNote}${metadataContextNote}`;
  }

  return `${broadEntityText}, but there are still definition-level differences that should be documented before the metrics are compared in reporting. ${evidenceNote}${metadataContextNote}`;
}

function buildTimeWindowRecommendation(difference: DetectedDifference): string {
  const match = difference.description.match(/recency windows:\s+(.+?)\s+in Query A vs\s+(.+?)\s+in Query B/i);
  const queryAWindow = formatTimeWindowLabel(match?.[1] || null) || "the Query A";
  const queryBWindow = formatTimeWindowLabel(match?.[2] || null) || "the Query B";

  return `Confirm whether the time-window change is intentional. Do not compare ${queryAWindow} and ${queryBWindow} counts in the same KPI trendline without renaming or documenting the metric.`;
}

function buildRecommendation(
  similarity: number,
  profileA: QuerySemanticProfile,
  profileB: QuerySemanticProfile,
  differences: DetectedDifference[],
): string {
  const categories = new Set(differences.map((difference) => difference.category));
  const removedFilterDifference = differences.find(
    (difference) =>
      difference.category === "business_logic_mismatch" &&
      /Query B removes filter logic from Query A/i.test(difference.description),
  );

  const removedExclusionDifference = differences.find(
    (difference) =>
      difference.category === "business_logic_mismatch" &&
      /removes the exclusion filter/i.test(difference.description),
  );

  if (removedExclusionDifference) {
    if (/internal\/company accounts|employee\/internal\/test accounts|test users/i.test(removedExclusionDifference.description)) {
      return "Confirm whether including internal/test accounts is intentional. Do not compare external-user counts with all-user counts without documenting the population definition.";
    }

    return "Confirm whether including deleted users is intentional. Do not compare active/non-deleted user counts with all-user counts without documenting the population definition.";
  }

  if (removedFilterDifference) {
    return "Confirm whether removing the filter is intentional. Downstream dashboards expecting the narrower filtered activity may now include the broader population.";
  }

  const filterLogicDifference = differences.find(
    (difference) => difference.category === "filter_logic_mismatch",
  );

  if (filterLogicDifference) {
    if (/changed from AND to OR/i.test(filterLogicDifference.description)) {
      return "Confirm whether changing AND to OR is intentional. The measured population may have broadened: records matching any single condition now qualify for the metric.";
    }

    if (/changed from OR to AND/i.test(filterLogicDifference.description)) {
      return "Confirm whether changing OR to AND is intentional. The measured population may have narrowed: records must now match all conditions to qualify for the metric.";
    }

    return "Confirm whether the WHERE boolean logic change is intentional. The measured population may have broadened or narrowed even though the individual conditions are unchanged.";
  }

  const joinPopulationDifference = differences.find(
    (difference) =>
      difference.category === "business_logic_mismatch" &&
      /The JOIN can restrict the population/i.test(difference.description),
  );

  if (joinPopulationDifference) {
    return "Confirm whether the JOIN is intentional. Do not compare joined user-order counts with all-user counts without documenting whether the metric counts users, orders, or joined rows.";
  }

  const joinTypeDifference = differences.find(
    (difference) => difference.category === "join_type_mismatch",
  );

  if (joinTypeDifference) {
    return "Confirm whether the join-type change is intentional. Do not compare LEFT JOIN and INNER JOIN user-order counts without documenting whether users without orders should be included.";
  }

  const segmentDifference = differences.find(
    (difference) =>
      difference.category === "business_logic_mismatch" &&
      /different user cohorts\/segments/i.test(difference.description),
  );

  if (segmentDifference) {
    const match = segmentDifference.description.match(/Query A measures ([^,]+), while Query B measures ([^.]+)\./i);
    const segmentA = match?.[1] || "one segment";
    const segmentB = match?.[2] || "another segment";

    return `Confirm whether the segment change is intentional. Do not compare ${segmentA}-user and ${segmentB}-user counts as the same KPI without labeling or documenting the segment.`;
  }

  const removedMonetizationGate = differences.find(
    (difference) =>
      difference.category === "monetization_mismatch" &&
      /Query B removes the monetization gate from Query A/i.test(difference.description),
  );

  if (removedMonetizationGate) {
    return "Confirm whether this is an intentional metric-definition change. Do not compare paid-user counts with all-user counts in the same KPI trendline without renaming or documenting the metric.";
  }

  const commerceSourceDifference = differences.find(
    (difference) =>
      difference.category === "source_domain_mismatch" &&
      /Orders and payments may not be interchangeable/i.test(difference.description),
  );

  if (commerceSourceDifference) {
    return "Confirm which source of truth is intended. Do not compare order-based and payment-based counts as the same KPI without documenting the metric contract.";
  }

  const countRevenueAggregationDifference = differences.find(
    (difference) =>
      difference.category === "aggregation_mismatch" &&
      /COUNT\([^)]*\).*SUM\((?:amount|total|revenue|price)\)|SUM\((?:amount|total|revenue|price)\).*COUNT\([^)]*\)/i.test(
        difference.description,
      ),
  );

  if (countRevenueAggregationDifference) {
    return "Do not compare paid order count and paid order revenue as the same KPI. Rename or document these as separate metrics before using them in dashboards or trendlines.";
  }

  const distinctUserRowCountDifference = differences.find(
    (difference) =>
      difference.category === "aggregation_mismatch" &&
      /unique users to event rows/i.test(difference.description),
  );

  if (distinctUserRowCountDifference) {
    return "Do not compare unique-user login counts with login event-row counts as the same KPI. Confirm whether the metric is intended to count users or events.";
  }

  if (
    categories.has("monetization_mismatch") &&
    (categories.has("activity_basis_mismatch") ||
      categories.has("metric_intent_mismatch") ||
      categories.has("team_context_mismatch"))
  ) {
    return "Use separate metric names for engagement and monetized activity. Do not compare these results in the same KPI trendline without an explicit metric contract, and clarify whether the audience is product, finance, or executive reporting.";
  }

  const timeWindowDifference = differences.find(
    (difference) =>
      difference.category === "time_reference_mismatch" &&
      /different recency windows/i.test(difference.description),
  );

  if (timeWindowDifference) {
    return buildTimeWindowRecommendation(timeWindowDifference);
  }

  const reportingGrainDifference = differences.find(
    (difference) => difference.category === "reporting_grain_mismatch",
  );

  if (reportingGrainDifference) {
    return "Confirm whether the reporting-grain change is intentional. Do not compare daily and monthly login counts in the same trendline without documenting the grain.";
  }

  if (categories.has("time_reference_mismatch")) {
    return "Document which timestamp defines recency for this metric. Teams should align on whether the intended basis is event activity, account state, or another operational clock.";
  }

  if (categories.has("intended_use_mismatch")) {
    return "Clarify the intended audience and use case for each metric before combining them in shared reporting.";
  }

  if (similarity < 45 || profileA.primaryDimension !== profileB.primaryDimension) {
    return "Do not treat these metrics as interchangeable. Publish a short metric contract that names the source domain, qualification rules, and intended business use of each definition.";
  }

  if (differences.length > 0) {
    return "Keep the metrics separately documented and call out the qualification rules directly in dashboards or metric specs.";
  }

  return "No action required beyond normal review.";
}

function mapRiskToSeverity(riskLevel: RiskLevel): ImpactLayer["severity"] {
  if (riskLevel === "high") {
    return "HIGH";
  }

  if (riskLevel === "medium") {
    return "MEDIUM";
  }

  return "LOW";
}

function hasAggregationMismatch(differences: DetectedDifference[]): boolean {
  return differences.some((difference) => difference.category === "aggregation_mismatch");
}

function hasFilterRemoval(differences: DetectedDifference[]): boolean {
  return differences.some(
    (difference) =>
      /removes? (?:the )?(?:filter|exclusion filter|monetization gate|filter logic)/i.test(
        difference.description,
      ) || /filter removal/i.test(difference.description),
  );
}

function hasJoinChange(differences: DetectedDifference[]): boolean {
  return differences.some(
    (difference) =>
      difference.category === "join_type_mismatch" ||
      /JOIN/i.test(difference.description),
  );
}

function buildDecisionRisk(differences: DetectedDifference[]): string {
  const risks: string[] = [];

  if (hasAggregationMismatch(differences)) {
    risks.push("aggregation changes may change what is counted");
  }

  if (hasFilterRemoval(differences)) {
    risks.push("filter removal may alter the metric population");
  }

  if (differences.some((difference) => difference.category === "filter_logic_mismatch")) {
    risks.push("boolean filter logic changes may broaden or narrow the metric population");
  }

  if (hasJoinChange(differences)) {
    risks.push("join changes may include or exclude users and change row counts");
  }

  if (risks.length === 0 && differences.length > 0) {
    return "Definition differences may affect decisions if the metrics are treated as interchangeable.";
  }

  if (risks.length === 0) {
    return "No significant business impact detected.";
  }

  return `Decision risk: ${risks.join("; ")}.`;
}

function stripTrailingPeriod(text: string): string {
  return text.replace(/\.+$/, "");
}

function formatMeaningSummary(text: string): string {
  return stripTrailingPeriod(text).replace(/^Measures\s+/i, "");
}

export function buildImpactLayer(result: SemanticComparisonResult): ImpactLayer {
  return {
    severity: mapRiskToSeverity(result.risk_level),
    decisionRisk: buildDecisionRisk(result.detected_differences),
    affectedMeaning: `Query A: ${formatMeaningSummary(
      result.likely_business_meaning_a,
    )}; Query B: ${formatMeaningSummary(result.likely_business_meaning_b)}.`,
    recommendedAction: result.recommendation,
    evidence: result.detected_differences.map((difference) => difference.description),
  };
}

export function buildVerdict(
  result: SemanticComparisonResult,
  impact: ImpactLayer,
): string {
  if (impact.severity === "CRITICAL" || result.risk_level === "high") {
    return "HIGH RISK: This change alters the meaning of the metric.";
  }

  if (result.risk_level === "medium") {
    return "MEDIUM RISK: This change may affect how the metric is interpreted.";
  }

  if (result.detected_differences.length === 0) {
    return "LOW RISK: No meaningful semantic change detected.";
  }

  return "LOW RISK: This change is unlikely to alter the meaning of the metric.";
}

export interface SqlComparisonAnalysisOverrides {
  structureA?: SqlStructureSummary;
  structureB?: SqlStructureSummary;
  parserLimitations?: string[];
  confidenceCap?: ParserConfidenceCap;
}

export function compareMetricDefinitionsWithAnalysis(
  inputA: MetricDefinitionInput,
  inputB: MetricDefinitionInput,
  overrides: SqlComparisonAnalysisOverrides = {},
): SemanticComparisonResult {
  const normalizedInputA = normalizeMetricInput(inputA);
  const normalizedInputB = normalizeMetricInput(inputB);
  requireAnalyzableSqlInput(normalizedInputA, "A");
  requireAnalyzableSqlInput(normalizedInputB, "B");
  const parsedA = tokenizeSql(normalizedInputA.query, overrides.structureA);
  const parsedB = tokenizeSql(normalizedInputB.query, overrides.structureB);
  const sourceRoles = buildSourceRoleComparison(
    getSqlStructure(parsedA).syntax,
    getSqlStructure(parsedB).syntax,
  );
  const profileA = buildSemanticProfile(parsedA);
  const profileB = buildSemanticProfile(parsedB);
  const likelyBusinessMeaningA = buildBusinessMeaningSummary(parsedA, profileA);
  const likelyBusinessMeaningB = buildBusinessMeaningSummary(parsedB, profileB);

  const detectedDifferences: DetectedDifference[] = [];
  pushDifference(
    detectedDifferences,
    compareMetricNameAlignment(normalizedInputA, normalizedInputB, profileA, profileB),
  );
  pushDifference(detectedDifferences, compareSourceDomain(parsedA, parsedB, profileA, profileB));
  detectedDifferences.push(...compareSetOperations(parsedA, parsedB));
  detectedDifferences.push(
    ...compareWindowSpecifications(parsedA, parsedB, sourceRoles),
  );
  pushDifference(
    detectedDifferences,
    compareAggregation(parsedA, parsedB, sourceRoles),
  );
  detectedDifferences.push(...compareSourceRoleUsages(sourceRoles));
  pushDifference(
    detectedDifferences,
    compareCaseCollections(
      getSqlStructure(parsedA).root,
      getSqlStructure(parsedB).root,
      "",
      sourceRoles,
    ),
  );
  detectedDifferences.push(...compareNestedQueryScopes(parsedA, parsedB));
  pushDifference(detectedDifferences, compareJoinPopulation(parsedA, parsedB));
  pushDifference(detectedDifferences, compareJoinType(parsedA, parsedB));
  pushDifference(
    detectedDifferences,
    compareJoinPredicates(parsedA, parsedB, sourceRoles),
  );
  pushDifference(detectedDifferences, compareTimeReference(profileA, profileB));
  pushDifference(
    detectedDifferences,
    compareReportingGrain(parsedA, parsedB, sourceRoles),
  );
  pushDifference(detectedDifferences, compareActivityBasis(profileA, profileB));
  pushDifference(detectedDifferences, compareMonetization(profileA, profileB, parsedA, parsedB));
  pushDifference(detectedDifferences, compareFilterBooleanLogic(parsedA, parsedB));
  pushDifference(
    detectedDifferences,
    compareBusinessLogic(parsedA, parsedB, profileA, profileB, sourceRoles),
  );
  pushDifference(detectedDifferences, compareDescriptions(normalizedInputA, normalizedInputB));
  pushDifference(detectedDifferences, compareTeamContext(normalizedInputA, normalizedInputB));
  pushDifference(detectedDifferences, compareIntendedUse(normalizedInputA, normalizedInputB));
  pushDifference(detectedDifferences, compareMetricIntent(profileA, profileB, detectedDifferences));

  const semanticSimilarityScore = estimateBaseSimilarity(parsedA, parsedB);
  const riskLevel = ensureRiskCoversDetectedDifferences(
    inferRiskLevel(semanticSimilarityScore),
    detectedDifferences,
  );
  const evidenceSources = deriveEvidenceSources(
    normalizedInputA,
    normalizedInputB,
    profileA,
    profileB,
    detectedDifferences,
  );
  const parserAnalysis = analyzeParserLimitations(
    normalizedInputA.query,
    normalizedInputB.query,
  );
  const confidenceLevel = applyParserConfidenceCap(
    inferConfidenceLevel(evidenceSources, detectedDifferences),
    getMostRestrictiveParserConfidenceCap(
      parserAnalysis.confidenceCap,
      overrides.confidenceCap,
    ),
  );
  const parserLimitations = [
    ...new Set([
      ...parserAnalysis.notes,
      ...(overrides.parserLimitations ?? []),
    ]),
  ];

  const result: SemanticComparisonResult = {
    metric_name_a: getDisplayMetricName(normalizedInputA, parsedA),
    metric_name_b: getDisplayMetricName(normalizedInputB, parsedB),
    semantic_similarity_score: semanticSimilarityScore,
    detected_differences: detectedDifferences,
    likely_business_meaning_a: likelyBusinessMeaningA,
    likely_business_meaning_b: likelyBusinessMeaningB,
    risk_level: riskLevel,
    confidence_level: confidenceLevel,
    evidence_sources: evidenceSources,
    explanation: buildExplanation(
      semanticSimilarityScore,
      normalizedInputA,
      normalizedInputB,
      profileA,
      profileB,
      detectedDifferences,
      confidenceLevel,
      evidenceSources,
    ),
    recommendation: buildRecommendation(
      semanticSimilarityScore,
      profileA,
      profileB,
      detectedDifferences,
    ),
    ...(parserLimitations.length > 0 ? { parser_limitations: parserLimitations } : {}),
  };
  const impact = buildImpactLayer(result);

  return {
    ...result,
    verdict: buildVerdict(result, impact),
    impact,
  };
}

export function compareMetricDefinitions(
  inputA: MetricDefinitionInput,
  inputB: MetricDefinitionInput,
): SemanticComparisonResult {
  return compareMetricDefinitionsWithAnalysis(inputA, inputB);
}

export function compareSqlQueries(queryA: string, queryB: string): SemanticComparisonResult {
  return compareMetricDefinitions({ query: queryA }, { query: queryB });
}
