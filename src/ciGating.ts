import { SemanticComparisonResult } from "./types.js";

export type SeverityThreshold = "low" | "medium" | "high" | "critical";

export type SupportedFailOnThreshold = "low" | "medium" | "high";

const severityOrder: Record<SeverityThreshold, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

const supportedFailOnThresholds: SupportedFailOnThreshold[] = [
  "low",
  "medium",
  "high",
];

export function parseFailOnThreshold(value: string): SeverityThreshold {
  const normalizedValue = value.toLowerCase();

  if (
    supportedFailOnThresholds.includes(
      normalizedValue as SupportedFailOnThreshold,
    )
  ) {
    return normalizedValue as SupportedFailOnThreshold;
  }

  throw new Error(
    `Invalid --fail-on value "${value}". Supported values: ${supportedFailOnThresholds.join(", ")}.`,
  );
}

export function getResultSeverity(result: SemanticComparisonResult): SeverityThreshold {
  if (result.impact?.severity) {
    const normalized = result.impact.severity.toLowerCase() as SeverityThreshold;
    if (normalized in severityOrder) {
      return normalized;
    }
  }

  return result.risk_level;
}

export function shouldFailForRisk(
  resultRisk: SeverityThreshold,
  threshold: SeverityThreshold,
): boolean {
  return severityOrder[resultRisk] >= severityOrder[threshold];
}

export function getHighestSeverity(
  severities: SeverityThreshold[],
): SeverityThreshold {
  let highest: SeverityThreshold = "low";

  for (const severity of severities) {
    if (shouldFailForRisk(severity, highest)) {
      highest = severity;
    }
  }

  return highest;
}
