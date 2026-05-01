import {
  CandidateFile,
  CandidatePairingResult,
  createCandidatePairs,
} from "./candidatePairing.js";
import {
  CandidatePathFilterResult,
  filterCandidatePaths,
} from "./pathFilter.js";

export interface ComposeCandidateDiscoveryInput {
  paths: string[];
  candidates: CandidateFile[];
  include?: string[];
  ignore?: string[];
}

export interface CandidateDiscoveryCompositionResult {
  pathFiltering: CandidatePathFilterResult;
  pairing: CandidatePairingResult;
}

export function composeCandidateDiscovery(
  input: ComposeCandidateDiscoveryInput,
): CandidateDiscoveryCompositionResult {
  const pathFiltering = filterCandidatePaths(input.paths, {
    include: input.include,
    ignore: input.ignore,
  });
  const includedPaths = new Set(pathFiltering.included.map((item) => item.path));
  const includedCandidates = input.candidates.filter((candidate) =>
    includedPaths.has(candidate.path),
  );

  return {
    pathFiltering,
    pairing: createCandidatePairs(includedCandidates),
  };
}
