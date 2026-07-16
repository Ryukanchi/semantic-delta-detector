import { compareSqlQueries } from "./analyzer/differenceEngine.js";
import type { SeverityThreshold } from "./ciGating.js";
import { getHighestSeverity, getResultSeverity } from "./ciGating.js";
import { composeCandidateDiscovery } from "./discoveryComposition.js";
import {
  discoverGitChangedFiles,
  loadGitPairContent,
  runGitCommand,
  type GitCommandRunner,
  type GitDiscoveryOptions,
} from "./gitDiscovery.js";
import type { SemanticComparisonResult } from "./types.js";

export type GitComparisonSkipStage =
  | "git-parse"
  | "path-filter"
  | "pairing"
  | "content-load";

export interface GitComparisonSkippedFile {
  stage: GitComparisonSkipStage;
  path?: string;
  beforePath?: string;
  afterPath?: string;
  line?: string;
  reason: string;
}

export interface GitAnalyzedFile {
  path: string;
  displayPath: string;
  beforePath: string;
  afterPath: string;
  result: SemanticComparisonResult;
}

export interface GitComparisonSummary {
  discoveredCount: number;
  analyzedCount: number;
  skippedCount: number;
  highestSeverity: SeverityThreshold;
}

export interface GitComparisonResult {
  repositoryPath: string;
  baseRef: string;
  headRef: string;
  resolvedBaseRef: string;
  resolvedHeadRef: string;
  analyzed: GitAnalyzedFile[];
  skipped: GitComparisonSkippedFile[];
  warnings: string[];
  summary: GitComparisonSummary;
}

export interface CompareGitChangesOptions extends GitDiscoveryOptions {
  include?: string[];
  ignore?: string[];
}

function formatContentFailures(
  failures: ReturnType<typeof loadGitPairContent>["failures"],
): string {
  return failures
    .map(
      (failure) =>
        `${failure.side} content unavailable for ${failure.path} at ${failure.ref}: ${failure.reason}`,
    )
    .join("; ");
}

export function compareGitChanges(
  options: CompareGitChangesOptions,
  runner: GitCommandRunner = runGitCommand,
): GitComparisonResult {
  const discovery = discoverGitChangedFiles(options, runner);
  const composition = composeCandidateDiscovery({
    candidates: discovery.candidates,
    include: options.include,
    ignore: options.ignore,
  });
  const skipped: GitComparisonSkippedFile[] = [
    ...discovery.parserSkipped.map((item) => ({
      stage: "git-parse" as const,
      line: item.line,
      reason: item.reason,
    })),
    ...composition.pathFiltering.skipped.map((item) => ({
      stage: "path-filter" as const,
      path: item.path,
      reason: item.reason,
    })),
    ...composition.pairing.skipped.map((item) => ({
      stage: "pairing" as const,
      path: item.path,
      reason: item.reason,
    })),
  ];
  const analyzed: GitAnalyzedFile[] = [];
  const warnings = [...discovery.warnings];

  for (const pair of composition.pairing.pairs) {
    const content = loadGitPairContent(
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

    analyzed.push({
      path: pair.afterPath,
      displayPath: pair.displayPath,
      beforePath: pair.beforePath,
      afterPath: pair.afterPath,
      result: compareSqlQueries(content.beforeContent, content.afterContent),
    });
  }

  const discoveredCount = discovery.files.length + discovery.parserSkipped.length;
  const accountedCount = analyzed.length + skipped.length;
  if (discoveredCount !== accountedCount) {
    throw new Error(
      `Internal Git comparison accounting error: discovered ${discoveredCount} rows but accounted for ${accountedCount}.`,
    );
  }

  const highestSeverity = getHighestSeverity(
    analyzed.map((file) => getResultSeverity(file.result)),
  );

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
