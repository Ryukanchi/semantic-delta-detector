import { SemanticComparisonResult } from "./types.js";

export type SeverityThreshold = "low" | "medium" | "high" | "critical";

const severityOrder: Record<SeverityThreshold, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

const supportedThresholds = Object.keys(severityOrder) as SeverityThreshold[];

export function parseFailOnThreshold(value: string): SeverityThreshold {
  const normalizedValue = value.toLowerCase();

  if (supportedThresholds.includes(normalizedValue as SeverityThreshold)) {
    return normalizedValue as SeverityThreshold;
  }

  throw new Error(
    `Invalid --fail-on value "${value}". Supported values: ${supportedThresholds.join(", ")}.`,
  );
}

export function getResultSeverity(result: SemanticComparisonResult): SeverityThreshold {
  if (result.impact?.severity) {
    return parseFailOnThreshold(result.impact.severity);
  }

  return result.risk_level;
}

export function shouldFailForRisk(
  resultRisk: SeverityThreshold,
  threshold: SeverityThreshold,
): boolean {
  return severityOrder[resultRisk] >= severityOrder[threshold];
}
