import type { SeverityThreshold } from "./ciGating.js";
import type { GitDiscoveryOptions, VerifiedGitCommitHash } from "./gitDiscovery.js";
import { compareGitChangesWithRunner } from "./internal/gitComparisonRuntime.js";
import { runGitCommand } from "./internal/gitDiscoveryRuntime.js";
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
  resolvedBaseRef: VerifiedGitCommitHash;
  resolvedHeadRef: VerifiedGitCommitHash;
  analyzed: GitAnalyzedFile[];
  skipped: GitComparisonSkippedFile[];
  warnings: string[];
  summary: GitComparisonSummary;
}

export interface CompareGitChangesOptions extends GitDiscoveryOptions {
  include?: string[];
  ignore?: string[];
}

export function compareGitChanges(
  options: CompareGitChangesOptions,
): GitComparisonResult {
  return compareGitChangesWithRunner(options, runGitCommand);
}
