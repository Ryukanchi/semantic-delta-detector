import assert from "node:assert/strict";
import test from "node:test";
import { composeCandidateDiscovery } from "../src/discoveryComposition.js";
import {
  gitDiffFilesToCandidates,
  parseGitDiffNameStatus,
} from "../src/gitDiffParser.js";

test("parses a modified file", () => {
  const result = parseGitDiffNameStatus("M\tmodels/revenue.sql");

  assert.deepEqual(result, {
    files: [
      {
        status: "modified",
        path: "models/revenue.sql",
        rawStatus: "M",
      },
    ],
    skipped: [],
  });
});

test("parses an added file", () => {
  const result = parseGitDiffNameStatus("A\tmodels/new_metric.sql");

  assert.equal(result.files[0].status, "added");
  assert.equal(result.files[0].path, "models/new_metric.sql");
});

test("parses a deleted file", () => {
  const result = parseGitDiffNameStatus("D\tmodels/old_metric.sql");

  assert.equal(result.files[0].status, "deleted");
  assert.equal(result.files[0].path, "models/old_metric.sql");
});

test("parses an R100 rename with before and after paths", () => {
  const result = parseGitDiffNameStatus(
    "R100\tmodels/old_name.sql\tmodels/new_name.sql",
  );

  assert.deepEqual(result.files[0], {
    status: "renamed",
    path: "models/new_name.sql",
    beforePath: "models/old_name.sql",
    afterPath: "models/new_name.sql",
    rawStatus: "R100",
  });
});

test("preserves input order", () => {
  const result = parseGitDiffNameStatus(
    [
      "D\tmodels/third.sql",
      "M\tmodels/first.sql",
      "A\tmodels/second.sql",
    ].join("\n"),
  );

  assert.deepEqual(
    result.files.map((file) => file.path),
    ["models/third.sql", "models/first.sql", "models/second.sql"],
  );
});

test("ignores empty lines and trims carriage-return line endings", () => {
  const result = parseGitDiffNameStatus(
    "\r\nM\tmodels/revenue.sql\r\n\r\nA\tmodels/new.sql\r\n",
  );

  assert.deepEqual(
    result.files.map((file) => file.path),
    ["models/revenue.sql", "models/new.sql"],
  );
  assert.deepEqual(result.skipped, []);
});

test("skips malformed lines with transparent reasons", () => {
  const result = parseGitDiffNameStatus(
    ["not-tab-separated", "\tmodels/no-status.sql", "R100\tmodels/old.sql"].join("\n"),
  );

  assert.equal(result.files.length, 0);
  assert.equal(result.skipped.length, 3);
  assert.match(result.skipped[0].reason, /tab-separated/i);
  assert.match(result.skipped[1].reason, /status/i);
  assert.match(result.skipped[2].reason, /before and after paths/i);
});

test("keeps unknown statuses visible", () => {
  const result = parseGitDiffNameStatus("T\tmodels/type_changed.sql");

  assert.deepEqual(result.files[0], {
    status: "unknown",
    path: "models/type_changed.sql",
    rawStatus: "T",
  });
  assert.deepEqual(result.skipped, []);
});

test("skips unknown status rows with ambiguous extra paths", () => {
  const result = parseGitDiffNameStatus(
    "C100\tmodels/source.sql\tmodels/copied.sql",
  );

  assert.deepEqual(result.files, []);
  assert.match(result.skipped[0].reason, /exactly one path/i);
});

test("maps parsed files to conservative CandidateFile metadata", () => {
  const parsed = parseGitDiffNameStatus(
    [
      "M\tmodels/revenue.sql",
      "A\tmodels/new_metric.sql",
      "D\tmodels/old_metric.sql",
      "R100\tmodels/old.sql\tmodels/renamed.sql",
      "T\tmodels/type_changed.sql",
    ].join("\n"),
  );

  assert.deepEqual(gitDiffFilesToCandidates(parsed.files), [
    {
      path: "models/revenue.sql",
      status: "modified",
      hasBefore: true,
      hasAfter: true,
    },
    {
      path: "models/new_metric.sql",
      status: "added",
      hasBefore: false,
      hasAfter: true,
    },
    {
      path: "models/old_metric.sql",
      status: "deleted",
      hasBefore: true,
      hasAfter: false,
    },
    {
      path: "models/renamed.sql",
      status: "renamed",
      beforePath: "models/old.sql",
      afterPath: "models/renamed.sql",
      hasBefore: true,
      hasAfter: true,
    },
    {
      path: "models/type_changed.sql",
      status: "unknown",
      hasBefore: false,
      hasAfter: false,
    },
  ]);
});

test("maps an incomplete rename to unknown metadata", () => {
  const candidates = gitDiffFilesToCandidates([
    {
      status: "renamed",
      path: "models/new.sql",
      afterPath: "models/new.sql",
      rawStatus: "R100",
    },
  ]);

  assert.deepEqual(candidates, [
    {
      path: "models/new.sql",
      status: "unknown",
      hasBefore: false,
      hasAfter: false,
    },
  ]);
});

test("feeds parsed git rows through discovery composition", () => {
  const parsed = parseGitDiffNameStatus(
    [
      "M\tmodels/revenue.sql",
      "A\tmodels/new_metric.sql",
      "D\tmodels/old_metric.sql",
      "R100\tmodels/old.sql\tmodels/renamed.sql",
    ].join("\n"),
  );
  const result = composeCandidateDiscovery({
    candidates: gitDiffFilesToCandidates(parsed.files),
    include: ["models/**"],
    ignore: [],
  });

  assert.equal(result.pathFiltering.included.length, 4);
  assert.deepEqual(result.pathFiltering.skipped, []);
  assert.deepEqual(result.pairing.pairs, [
    {
      beforePath: "models/revenue.sql",
      afterPath: "models/revenue.sql",
      displayPath: "models/revenue.sql",
    },
    {
      beforePath: "models/old.sql",
      afterPath: "models/renamed.sql",
      displayPath: "models/old.sql -> models/renamed.sql",
    },
  ]);
  assert.deepEqual(
    result.pairing.skipped.map((candidate) => candidate.path),
    ["models/new_metric.sql", "models/old_metric.sql"],
  );
  assert.match(result.pairing.skipped[0].reason, /no before version/i);
  assert.match(result.pairing.skipped[1].reason, /no after version/i);
});

test("does not deduplicate repeated paths", () => {
  const result = parseGitDiffNameStatus(
    "M\tmodels/revenue.sql\nM\tmodels/revenue.sql",
  );

  assert.equal(result.files.length, 2);
  assert.equal(result.files[0].path, result.files[1].path);
});

test("preserves Windows-style paths without normalizing them", () => {
  const result = parseGitDiffNameStatus("M\tmodels\\finance\\revenue.sql");

  assert.equal(result.files[0].path, "models\\finance\\revenue.sql");
});
