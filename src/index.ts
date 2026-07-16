export {
  buildImpactLayer,
  buildVerdict,
  compareMetricDefinitions,
  compareSqlQueries,
} from "./analyzer/differenceEngine.js";

export { formatPrComment } from "./output/formatPrComment.js";

export {
  formatGitComparisonPrComment,
  formatGitComparisonReport,
} from "./output/formatGitComparison.js";

export {
  gitDiffFilesToCandidates,
  parseGitDiffNameStatus,
} from "./gitDiffParser.js";

export {
  discoverGitChangedFiles,
  GitDiscoveryError,
  loadGitPairContent,
} from "./gitDiscovery.js";

export { compareGitChanges } from "./gitComparison.js";

export type {
  ConfidenceLevel,
  DetectedDifference,
  DifferenceCategory,
  EvidenceSource,
  ImpactLayer,
  MetricDefinitionInput,
  RiskLevel,
  SemanticComparisonResult,
} from "./types.js";

export type {
  GitDiffChangedFile,
  GitDiffFileStatus,
  GitDiffNameStatusParseResult,
  GitDiffParseSkippedLine,
} from "./gitDiffParser.js";

export type {
  GitContentLoadFailure,
  GitDiscoveryOptions,
  GitDiscoveryResult,
  GitPairContentResult,
  LoadGitPairContentOptions,
  VerifiedGitCommitHash,
} from "./gitDiscovery.js";

export type {
  CompareGitChangesOptions,
  GitAnalyzedFile,
  GitComparisonResult,
  GitComparisonSkippedFile,
  GitComparisonSkipStage,
  GitComparisonSummary,
} from "./gitComparison.js";
