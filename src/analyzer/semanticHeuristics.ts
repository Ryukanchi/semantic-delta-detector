import {
  BusinessDimension,
  MetricDefinitionInput,
  ParsedSqlQuery,
  QuerySemanticProfile,
  RiskLevel,
} from "../types.js";

function containsAny(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some((keyword) => lower.includes(keyword));
}

function containsPattern(text: string, pattern: RegExp): boolean {
  return pattern.test(text.toLowerCase());
}

function findSignal(query: ParsedSqlQuery): string[] {
  return [
    ...query.tables,
    ...query.filters,
    ...query.timeWindows,
    ...query.selectedExpressions,
  ].map((value) => value.toLowerCase());
}

function getJoinedSignals(query: ParsedSqlQuery): string {
  return findSignal(query).join(" | ");
}

function inferDimensionFromText(text: string): BusinessDimension {
  const joined = text.toLowerCase();

  if (
    containsAny(joined, [
      "subscription_status = 'paid'",
      "subscription_status = 'active'",
      "subscription",
      "plan =",
      "paid",
      "is_paid",
      "mrr",
      "arr",
    ]) ||
    containsPattern(joined, /\brevenue\s*>\s*0\b/)
  ) {
    return "monetization";
  }

  if (
    containsAny(joined, ["events", "event = 'login'", "event =", "last_active", "session", "usage"]) ||
    containsPattern(joined, /\bactive\b/)
  ) {
    return "engagement";
  }

  if (containsAny(joined, ["signup", "registration", "created_at", "new user"])) {
    return "acquisition";
  }

  if (containsAny(joined, ["eligible", "eligibility", "completed", "verified", "approved"])) {
    return "eligibility";
  }

  if (containsAny(joined, ["order", "revenue", "amount", "gmv", "sales"])) {
    return "revenue";
  }

  if (containsAny(joined, ["users", "profiles", "accounts"])) {
    return "population";
  }

  return "unknown";
}

function detectPrimaryDimension(query: ParsedSqlQuery): QuerySemanticProfile["primaryDimension"] {
  return inferDimensionFromText(getJoinedSignals(query));
}

function detectSecondaryDimensions(
  query: ParsedSqlQuery,
  primaryDimension: QuerySemanticProfile["primaryDimension"],
): QuerySemanticProfile["secondaryDimensions"] {
  const joined = getJoinedSignals(query);
  const dimensions: QuerySemanticProfile["secondaryDimensions"] = [];

  if (
    primaryDimension !== "monetization" &&
    (containsAny(joined, ["subscription", "paid", "is_paid", "plan =", "mrr", "arr"]) ||
      containsPattern(joined, /\brevenue\s*>\s*0\b/))
  ) {
    dimensions.push("monetization");
  }

  if (
    primaryDimension !== "engagement" &&
    (containsAny(joined, ["events", "event =", "last_active", "session", "usage"]) ||
      containsPattern(joined, /\bactive\b/))
  ) {
    dimensions.push("engagement");
  }

  if (
    primaryDimension !== "eligibility" &&
    containsAny(joined, ["completed", "verified", "eligible", "approved"])
  ) {
    dimensions.push("eligibility");
  }

  return dimensions;
}

function detectEntityLabel(query: ParsedSqlQuery): string {
  const joined = getJoinedSignals(query);

  if (containsAny(joined, ["customer", "account_id"])) {
    return "customers/accounts";
  }

  if (containsAny(joined, ["user_id", "users", "last_active", "signup"])) {
    return "users";
  }

  if (containsAny(joined, ["order", "payment", "transaction"])) {
    return "orders/transactions";
  }

  return "records";
}

function detectSourceDomain(query: ParsedSqlQuery): string {
  const joined = getJoinedSignals(query);
  const tableText = query.tables.join(" ").toLowerCase();

  if (containsAny(`${joined} | ${tableText}`, ["events", "event =", "session", "activity"])) {
    return "product activity";
  }

  if (containsAny(`${joined} | ${tableText}`, ["subscription", "billing", "plan", "invoice", "paid"])) {
    return "billing/subscription";
  }

  if (containsAny(`${joined} | ${tableText}`, ["users", "profiles", "accounts"])) {
    return "user profile/state";
  }

  if (containsAny(`${joined} | ${tableText}`, ["orders", "payments", "revenue"])) {
    return "commercial transactions";
  }

  return "general dataset";
}

function detectTimeField(query: ParsedSqlQuery): string | null {
  const conditionsText = query.conditions.join(" | ");
  const match = conditionsText.match(
    /\b([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:>=|>|<=|<|=)\s*(?:current_date|current_timestamp)/i,
  );

  return match ? match[1].toLowerCase() : null;
}

function detectTimeHorizon(query: ParsedSqlQuery): string | null {
  const conditionsText = query.conditions.join(" | ");
  const intervalMatch = conditionsText.match(/interval\s+'(\d+\s+\w+)'/i);
  if (intervalMatch) {
    return intervalMatch[1].toLowerCase();
  }

  const relativeMatch = conditionsText.match(/\b(\d+)\s+(day|days|month|months|year|years)\b/i);
  if (relativeMatch) {
    return `${relativeMatch[1]} ${relativeMatch[2].toLowerCase()}`;
  }

  return null;
}

function describeTimeField(timeField: string | null): string {
  if (!timeField) {
    return "recent activity";
  }

  if (timeField === "last_active") {
    return "recent account activity";
  }

  if (timeField === "event_date") {
    return "recent product events";
  }

  if (timeField === "created_at") {
    return "recent creation date";
  }

  return timeField.replace(/_/g, " ");
}

function buildBusinessMeaning(profile: Omit<QuerySemanticProfile, "businessMeaning">): string {
  if (profile.primaryDimension === "monetization" && profile.secondaryDimensions.includes("engagement")) {
    return `Measures ${profile.entityLabel} with ${describeTimeField(profile.timeField)} who also meet a monetization condition.`;
  }

  if (profile.primaryDimension === "monetization") {
    return `Measures ${profile.entityLabel} who meet a paid, subscribed, or monetized definition.`;
  }

  if (profile.primaryDimension === "engagement") {
    return `Measures ${profile.entityLabel} based on recent product activity or usage behavior.`;
  }

  if (profile.primaryDimension === "acquisition") {
    return `Measures newly created ${profile.entityLabel} entering the product or funnel.`;
  }

  if (profile.primaryDimension === "population") {
    return `Measures the overall ${profile.entityLabel} population.`;
  }

  if (profile.primaryDimension === "eligibility") {
    return `Measures ${profile.entityLabel} who satisfy an operational or eligibility gate.`;
  }

  if (profile.primaryDimension === "revenue") {
    return "Measures commercial performance or transaction value.";
  }

  return "Represents a derived metric over the filtered dataset.";
}

export function buildSemanticProfile(query: ParsedSqlQuery): QuerySemanticProfile {
  const primaryDimension = detectPrimaryDimension(query);
  const secondaryDimensions = detectSecondaryDimensions(query, primaryDimension);
  const entityLabel = detectEntityLabel(query);
  const sourceDomain = detectSourceDomain(query);
  const timeField = detectTimeField(query);
  const timeHorizon = detectTimeHorizon(query);

  const profileBase = {
    primaryDimension,
    secondaryDimensions,
    entityLabel,
    sourceDomain,
    timeField,
    timeHorizon,
  };

  return {
    ...profileBase,
    businessMeaning: buildBusinessMeaning(profileBase),
  };
}

export function inferBusinessMeaning(query: ParsedSqlQuery): string {
  return buildSemanticProfile(query).businessMeaning;
}

export function inferDimensionFromMetadata(input: MetricDefinitionInput): BusinessDimension {
  const joined = [
    input.metric_name,
    input.description,
    input.team_context,
    input.intended_use,
  ]
    .filter(Boolean)
    .join(" | ");

  if (!joined) {
    return "unknown";
  }

  return inferDimensionFromText(joined);
}

export function normalizeText(input: string | undefined): string | null {
  if (!input) {
    return null;
  }

  const normalized = input.trim().toLowerCase().replace(/\s+/g, " ");
  return normalized.length > 0 ? normalized : null;
}

export function estimateBaseSimilarity(queryA: ParsedSqlQuery, queryB: ParsedSqlQuery): number {
  const profileA = buildSemanticProfile(queryA);
  const profileB = buildSemanticProfile(queryB);
  let score = 100;

  if (queryA.aggregation !== queryB.aggregation) {
    score -= 25;
  }

  if (queryA.aggregationDistinctTarget !== queryB.aggregationDistinctTarget) {
    score -= 10;
  }

  const sameTable = queryA.tables.some((table) => queryB.tables.includes(table));
  if (!sameTable) {
    score -= profileA.sourceDomain === profileB.sourceDomain ? 10 : 20;
  }

  const sharedFilters = queryA.filters.filter((filter) => queryB.filters.includes(filter)).length;
  const maxFilters = Math.max(queryA.filters.length, queryB.filters.length);
  if (maxFilters > 0) {
    score -= Math.round(((maxFilters - sharedFilters) / maxFilters) * 12);
  }

  if (profileA.timeHorizon !== profileB.timeHorizon) {
    score -= 10;
  } else if (profileA.timeField !== profileB.timeField) {
    score -= 8;
  }

  if (profileA.primaryDimension !== profileB.primaryDimension) {
    score -= 25;
  } else if (profileA.businessMeaning !== profileB.businessMeaning) {
    score -= 10;
  }

  if (profileA.secondaryDimensions.join("|") !== profileB.secondaryDimensions.join("|")) {
    score -= 10;
  }

  return Math.max(0, Math.min(100, score));
}

export function inferRiskLevel(similarityScore: number): RiskLevel {
  if (similarityScore >= 75) {
    return "low";
  }

  if (similarityScore >= 45) {
    return "medium";
  }

  return "high";
}
