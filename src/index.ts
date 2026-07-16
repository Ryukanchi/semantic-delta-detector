export {
  buildImpactLayer,
  buildVerdict,
  compareMetricDefinitions,
  compareSqlQueries,
} from "./analyzer/differenceEngine.js";

export { formatPrComment } from "./output/formatPrComment.js";

export {
  gitDiffFilesToCandidates,
  parseGitDiffNameStatus,
} from "./gitDiffParser.js";

export {
  discoverGitChangedFiles,
  GitDiscoveryError,
  loadGitPairContent,
} from "./gitDiscovery.js";

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
  GitCommandResult,
  GitCommandRunner,
  GitContentLoadFailure,
  GitDiscoveryOptions,
  GitDiscoveryResult,
  GitPairContentResult,
  LoadGitPairContentOptions,
} from "./gitDiscovery.js";
