import { compareSqlQueries } from "../analyzer/differenceEngine.js";
import { getHighestSeverity, getResultSeverity } from "../ciGating.js";
import { composeCandidateDiscovery } from "../discoveryComposition.js";
import type { CandidateFile } from "../candidatePairing.js";
import type {
  CompareGitChangesOptions,
  GitAnalyzedFile,
  GitComparisonResult,
  GitComparisonSkippedFile,
} from "../gitComparison.js";
import type { GitContentLoadFailure } from "../gitDiscovery.js";
import {
  discoverGitChangedFilesWithRunner,
  loadGitPairContentWithRunner,
  type GitCommandRunner,
} from "./gitDiscoveryRuntime.js";

function mapPathFilteredSkips(
  candidates: CandidateFile[],
  skippedPaths: Array<{ path: string; reason: string }>,
): GitComparisonSkippedFile[] {
  const candidatesByPath = new Map<string, CandidateFile[]>();
  for (const candidate of candidates) {
    const queuedCandidates = candidatesByPath.get(candidate.path) ?? [];
    queuedCandidates.push(candidate);
    candidatesByPath.set(candidate.path, queuedCandidates);
  }

  return skippedPaths.map((item) => {
    const candidate = candidatesByPath.get(item.path)?.shift();
    return {
      stage: "path-filter",
      path: item.path,
      ...(candidate?.beforePath ? { beforePath: candidate.beforePath } : {}),
      ...(candidate?.afterPath ? { afterPath: candidate.afterPath } : {}),
      reason: item.reason,
    };
  });
}

function formatContentFailures(failures: GitContentLoadFailure[]): string {
  return failures
    .map(
      (failure) =>
        `${failure.side} content unavailable for ${failure.path} at ${failure.ref}: ${failure.reason}`,
    )
    .join("; ");
}

function formatAnalysisSkipReason(error: unknown): string {
  if (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "SEMANTIC_DELTA_UNANALYZABLE_SQL"
  ) {
    const input = error as { query?: unknown; reason?: unknown; message?: unknown };
    const query = input.query === "A" || input.query === "B" ? `Query ${input.query}` : "SQL input";
    const reason = typeof input.reason === "string" ? ` (${input.reason})` : "";
    return `analysis unavailable for ${query}${reason}: ${typeof input.message === "string" ? input.message : "Semantic Delta could not recognize enough supported query structure."}`;
  }

  return error instanceof Error ? error.message : String(error);
}

export function compareGitChangesWithRunner(
  options: CompareGitChangesOptions,
  runner: GitCommandRunner,
): GitComparisonResult {
  const discovery = discoverGitChangedFilesWithRunner(options, runner);
  const include = options.include?.length ? options.include : ["**/*.sql"];
  const composition = composeCandidateDiscovery({
    candidates: discovery.candidates,
    include,
    ignore: options.ignore,
  });
  const skipped: GitComparisonSkippedFile[] = [
    ...discovery.parserSkipped.map((item) => ({
      stage: "git-parse" as const,
      line: item.line,
      reason: item.reason,
    })),
    ...mapPathFilteredSkips(discovery.candidates, composition.pathFiltering.skipped),
    ...composition.pairing.skipped.map((item) => ({
      stage: "pairing" as const,
      ...item,
    })),
  ];
  const analyzed: GitAnalyzedFile[] = [];
  const warnings = [...discovery.warnings];

  for (const pair of composition.pairing.pairs) {
    const content = loadGitPairContentWithRunner(
      {
        repositoryPath: discovery.repositoryPath,
        baseRef: discovery.resolvedBaseRef,
        headRef: discovery.resolvedHeadRef,
        pair,
      },
      runner,
    );
    warnings.push(...content.warnings);

    if (
      content.failures.length > 0 ||
      content.beforeContent === undefined ||
      content.afterContent === undefined
    ) {
      skipped.push({
        stage: "content-load",
        path: pair.afterPath,
        beforePath: pair.beforePath,
        afterPath: pair.afterPath,
        reason:
          content.failures.length > 0
            ? formatContentFailures(content.failures)
            : "before or after content was unavailable without a detailed Git failure",
      });
      continue;
    }

    try {
      analyzed.push({
        path: pair.afterPath,
        displayPath: pair.displayPath,
        beforePath: pair.beforePath,
        afterPath: pair.afterPath,
        result: compareSqlQueries(content.beforeContent, content.afterContent),
      });
    } catch (error) {
      skipped.push({
        stage: "analysis",
        path: pair.afterPath,
        beforePath: pair.beforePath,
        afterPath: pair.afterPath,
        reason: formatAnalysisSkipReason(error),
      });
    }
  }

  const discoveredCount = discovery.files.length + discovery.parserSkipped.length;
  const accountedCount = analyzed.length + skipped.length;
  if (discoveredCount !== accountedCount) {
    throw new Error(
      `Internal Git comparison accounting error: discovered ${discoveredCount} rows but accounted for ${accountedCount}.`,
    );
  }

  const highestSeverity = analyzed.length > 0
    ? getHighestSeverity(analyzed.map((file) => getResultSeverity(file.result)))
    : null;

  return {
    repositoryPath: discovery.repositoryPath,
    baseRef: discovery.baseRef,
    headRef: discovery.headRef,
    resolvedBaseRef: discovery.resolvedBaseRef,
    resolvedHeadRef: discovery.resolvedHeadRef,
    analyzed,
    skipped,
    warnings,
    summary: {
      discoveredCount,
      analyzedCount: analyzed.length,
      skippedCount: skipped.length,
      highestSeverity,
    },
  };
}
