export type CandidateFileStatus = "modified" | "added" | "deleted" | "renamed" | "unknown";

export interface CandidateFile {
  path: string;
  status: CandidateFileStatus;
  beforePath?: string;
  afterPath?: string;
  hasBefore: boolean;
  hasAfter: boolean;
}

export interface CandidatePair {
  beforePath: string;
  afterPath: string;
  displayPath: string;
}

export interface SkippedCandidate {
  path: string;
  reason: string;
}

export interface CandidatePairingResult {
  pairs: CandidatePair[];
  skipped: SkippedCandidate[];
}

function skipCandidate(candidate: CandidateFile, reason: string): SkippedCandidate {
  return {
    path: candidate.path,
    reason,
  };
}

function createModifiedPair(candidate: CandidateFile): CandidatePair {
  return {
    beforePath: candidate.beforePath ?? candidate.path,
    afterPath: candidate.afterPath ?? candidate.path,
    displayPath: candidate.path,
  };
}

function createRenamedPair(candidate: CandidateFile): CandidatePair {
  return {
    beforePath: candidate.beforePath ?? candidate.path,
    afterPath: candidate.afterPath ?? candidate.path,
    displayPath: `${candidate.beforePath} -> ${candidate.afterPath}`,
  };
}

export function createCandidatePairs(candidates: CandidateFile[]): CandidatePairingResult {
  const result: CandidatePairingResult = {
    pairs: [],
    skipped: [],
  };

  for (const candidate of candidates) {
    if (candidate.status === "added") {
      result.skipped.push(skipCandidate(candidate, "skipped because no before version exists"));
      continue;
    }

    if (candidate.status === "deleted") {
      result.skipped.push(skipCandidate(candidate, "skipped because no after version exists"));
      continue;
    }

    if (candidate.status === "unknown") {
      result.skipped.push(skipCandidate(candidate, "skipped because candidate status is unknown"));
      continue;
    }

    if (!candidate.hasBefore) {
      result.skipped.push(skipCandidate(candidate, "skipped because no before version exists"));
      continue;
    }

    if (!candidate.hasAfter) {
      result.skipped.push(skipCandidate(candidate, "skipped because no after version exists"));
      continue;
    }

    if (candidate.status === "renamed") {
      if (!candidate.beforePath || !candidate.afterPath) {
        result.skipped.push(
          skipCandidate(candidate, "skipped renamed file because before/after paths are incomplete"),
        );
        continue;
      }

      result.pairs.push(createRenamedPair(candidate));
      continue;
    }

    result.pairs.push(createModifiedPair(candidate));
  }

  return result;
}
