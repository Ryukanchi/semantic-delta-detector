import { ImpactLayer, SemanticComparisonResult } from "../types.js";

function getSeverity(result: SemanticComparisonResult): ImpactLayer["severity"] {
  if (result.impact?.severity) {
    return result.impact.severity;
  }

  if (result.risk_level === "high") {
    return "HIGH";
  }

  if (result.risk_level === "medium") {
    return "MEDIUM";
  }

  return "LOW";
}

function getSeverityEmoji(severity: ImpactLayer["severity"]): string {
  const emojis: Record<ImpactLayer["severity"], string> = {
    LOW: "🟢",
    MEDIUM: "🟡",
    HIGH: "🔴",
    CRITICAL: "⚠️",
  };

  return emojis[severity];
}

function getVerdictBody(result: SemanticComparisonResult): string {
  const verdict = result.verdict || "No significant semantic risk detected.";
  return verdict.replace(/^(LOW|MEDIUM|HIGH|CRITICAL)\s+RISK:\s*/i, "");
}

function cleanImpactText(text: string): string {
  return text.replace(/^(Decision risk|Decision Risk|Risk):\s*/i, "");
}

function getEvidencePriority(description: string, result: SemanticComparisonResult): number {
  const recommendation = result.impact?.recommendedAction || result.recommendation;
  const decisionRisk = result.impact?.decisionRisk || "";

  if (
    /filter|population/i.test(recommendation) &&
    /removes? (?:the )?(?:filter|exclusion filter|filter logic)|adds? filter logic/i.test(
      description,
    )
  ) {
    return 0;
  }

  if (/aggregation|counted|what is counted/i.test(recommendation) && /Aggregation changed/i.test(description)) {
    return 0;
  }

  if (/join|include|exclude/i.test(recommendation) && /JOIN|join type/i.test(description)) {
    return 0;
  }

  if (/source of truth|source domain/i.test(recommendation) && /source domain|source tables/i.test(description)) {
    return 0;
  }

  if (/monetization|paid|subscription/i.test(recommendation) && /monetization|paid|subscription/i.test(description)) {
    return 1;
  }

  if (
    /filter|population/i.test(decisionRisk) &&
    /removes? (?:the )?(?:filter|exclusion filter|filter logic)|adds? filter logic/i.test(
      description,
    )
  ) {
    return 1;
  }

  if (/aggregation|counted|what is counted/i.test(decisionRisk) && /Aggregation changed/i.test(description)) {
    return 1;
  }

  if (/join|include|exclude/i.test(decisionRisk) && /JOIN|join type/i.test(description)) {
    return 1;
  }

  return 2;
}

function getEvidence(result: SemanticComparisonResult): string[] {
  const evidence =
    result.detected_differences.length > 0
      ? result.detected_differences
          .map((difference, index) => ({ description: difference.description, index }))
          .sort((left, right) => {
            const priorityDelta =
              getEvidencePriority(left.description, result) -
              getEvidencePriority(right.description, result);

            return priorityDelta === 0 ? left.index - right.index : priorityDelta;
          })
          .map((item) => item.description)
      : result.impact?.evidence || [];

  return evidence.slice(0, 2).map((item) => {
    const firstSentence = item.match(/^.*?[.!?](?:\s|$)/)?.[0]?.trim() || item;
    return firstSentence.length > 180 ? `${firstSentence.slice(0, 177)}...` : firstSentence;
  });
}

export function formatPrComment(result: SemanticComparisonResult): string {
  const severity = getSeverity(result);
  const evidence = getEvidence(result);
  const evidenceLines =
    evidence.length > 0
      ? evidence.map((item) => `- ${item}`)
      : ["- No significant semantic differences detected."];

  return [
    `${getSeverityEmoji(severity)} ${severity} RISK`,
    getVerdictBody(result),
    "",
    `Impact: ${cleanImpactText(
      result.impact?.decisionRisk || "No significant business impact detected.",
    )}`,
    "Evidence:",
    ...evidenceLines,
    `Recommendation: ${result.impact?.recommendedAction || result.recommendation}`,
  ].join("\n");
}
