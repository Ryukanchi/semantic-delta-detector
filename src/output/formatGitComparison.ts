import { getResultSeverity, type SeverityThreshold } from "../ciGating.js";
import type {
  GitAnalyzedFile,
  GitComparisonResult,
  GitComparisonSkippedFile,
} from "../gitComparison.js";

function formatSeverity(severity: SeverityThreshold): string {
  return severity.toUpperCase();
}

function severityEmoji(severity: SeverityThreshold): string {
  if (severity === "critical") {
    return "⚠️";
  }

  if (severity === "high") {
    return "🔴";
  }

  if (severity === "medium") {
    return "🟡";
  }

  return "🟢";
}

function getEvidence(file: GitAnalyzedFile): string[] {
  if (file.result.detected_differences.length === 0) {
    return ["No meaningful semantic differences detected."];
  }

  return file.result.detected_differences
    .slice(0, 2)
    .map((difference) => difference.description);
}

function formatFinding(file: GitAnalyzedFile): string[] {
  const severity = getResultSeverity(file.result);
  const lines = [
    `### ${file.displayPath} — ${formatSeverity(severity)}`,
    "",
    file.result.verdict ?? "Semantic comparison completed.",
    "",
    `- Similarity: ${file.result.semantic_similarity_score}/100`,
    `- Confidence: ${file.result.confidence_level}`,
    "- Evidence:",
    ...getEvidence(file).map((evidence) => `  - ${evidence}`),
    `- Recommendation: ${file.result.recommendation}`,
  ];

  if (file.result.parser_limitations?.length) {
    lines.push(
      "- Analysis limits:",
      ...file.result.parser_limitations.map((note) => `  - ${note}`),
    );
  }

  return lines;
}

function getSkippedLabel(item: GitComparisonSkippedFile): string {
  if (item.path) {
    if (item.beforePath && item.afterPath && item.beforePath !== item.afterPath) {
      return `${item.beforePath} -> ${item.afterPath}`;
    }

    return item.path;
  }

  return item.line ? `raw line: ${item.line}` : "unknown changed-file row";
}

export function formatGitComparisonReport(result: GitComparisonResult): string {
  const lines = [
    "# Semantic Delta Git Comparison",
    "",
    "## Summary",
    "",
    `- Highest risk: ${formatSeverity(result.summary.highestSeverity)}`,
    `- Changed files discovered: ${result.summary.discoveredCount}`,
    `- Files analyzed: ${result.summary.analyzedCount}`,
    `- Files skipped: ${result.summary.skippedCount}`,
    "",
    "## Findings",
    "",
  ];

  if (result.analyzed.length === 0) {
    lines.push("No comparable files were analyzed. No semantic gate was applied.");
  } else {
    result.analyzed.forEach((file, index) => {
      if (index > 0) {
        lines.push("");
      }
      lines.push(...formatFinding(file));
    });
  }

  lines.push("", "## Skipped Files", "");
  if (result.skipped.length === 0) {
    lines.push("No files were skipped.");
  } else {
    lines.push(
      ...result.skipped.map(
        (item) => `- [${item.stage}] ${getSkippedLabel(item)} — ${item.reason}`,
      ),
    );
  }

  if (result.warnings.length > 0) {
    lines.push(
      "",
      "## Git Warnings",
      "",
      ...result.warnings.map((warning) => `- ${warning}`),
    );
  }

  lines.push(
    "",
    "## Refs",
    "",
    `- Repository: ${result.repositoryPath}`,
    `- Base: ${result.baseRef}`,
    `- Head: ${result.headRef}`,
  );

  return lines.join("\n");
}

function orderFindingsBySeverity(files: GitAnalyzedFile[]): GitAnalyzedFile[] {
  const order: SeverityThreshold[] = ["critical", "high", "medium", "low"];
  return order.flatMap((severity) =>
    files.filter((file) => getResultSeverity(file.result) === severity),
  );
}

function conciseVerdict(file: GitAnalyzedFile): string {
  return (file.result.verdict ?? "Semantic comparison completed.").replace(
    /^(LOW|MEDIUM|HIGH|CRITICAL)\s+RISK:\s*/i,
    "",
  );
}

function formatSkippedSummary(result: GitComparisonResult): string {
  const stages: GitComparisonSkippedFile["stage"][] = [
    "git-parse",
    "path-filter",
    "pairing",
    "content-load",
  ];
  return stages
    .map((stage) => ({
      stage,
      count: result.skipped.filter((item) => item.stage === stage).length,
    }))
    .filter((item) => item.count > 0)
    .map((item) => `${item.stage}: ${item.count}`)
    .join(", ");
}

export function formatGitComparisonPrComment(result: GitComparisonResult): string {
  const severity = result.summary.highestSeverity;
  const orderedFindings = orderFindingsBySeverity(result.analyzed);
  const shownFindings = orderedFindings.slice(0, 5);
  const shownSkipped = result.skipped.slice(0, 5);
  const lines = [
    `${severityEmoji(severity)} ${formatSeverity(severity)} RISK — ${result.summary.analyzedCount} analyzed, ${result.summary.skippedCount} skipped`,
    result.analyzed.length === 0
      ? result.summary.discoveredCount === 0
        ? "No changed files were discovered between these refs."
        : "No comparable files were analyzed. Skipped changes are listed below."
      : severity === "low"
        ? "No meaningful semantic change was detected in the analyzed files."
        : "At least one analyzed SQL file may change metric meaning.",
    "",
    "Findings:",
  ];

  if (shownFindings.length === 0) {
    lines.push("- None analyzed.");
  } else {
    lines.push(
      ...shownFindings.map((file) => {
        const fileSeverity = getResultSeverity(file.result);
        return `- ${severityEmoji(fileSeverity)} ${file.displayPath} — ${formatSeverity(fileSeverity)}: ${conciseVerdict(file)}`;
      }),
    );
    if (orderedFindings.length > shownFindings.length) {
      lines.push(`- …and ${orderedFindings.length - shownFindings.length} more analyzed file(s).`);
    }
  }

  lines.push("", `Skipped: ${result.summary.skippedCount}`);
  if (shownSkipped.length > 0) {
    lines.push(`Stages: ${formatSkippedSummary(result)}`);
    lines.push(
      ...shownSkipped.map(
        (item) => `- [${item.stage}] ${getSkippedLabel(item)} — ${item.reason}`,
      ),
    );
    if (result.skipped.length > shownSkipped.length) {
      lines.push(`- …and ${result.skipped.length - shownSkipped.length} more skipped row(s).`);
    }
  }

  lines.push("", `Refs: ${result.baseRef} → ${result.headRef}`);
  if (result.warnings.length > 0) {
    lines.push(`Git warnings: ${result.warnings.length} (see JSON or full report for details).`);
  }

  return lines.join("\n");
}
