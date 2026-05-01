import test from "node:test";
import assert from "node:assert/strict";
import { createCandidatePairs } from "../src/candidatePairing.js";

test("candidate pairing creates a pair for modified files with before and after content", () => {
  assert.deepEqual(
    createCandidatePairs([
      {
        path: "models/revenue.sql",
        status: "modified",
        beforePath: "base/models/revenue.sql",
        afterPath: "head/models/revenue.sql",
        hasBefore: true,
        hasAfter: true,
      },
    ]),
    {
      pairs: [
        {
          beforePath: "base/models/revenue.sql",
          afterPath: "head/models/revenue.sql",
          displayPath: "models/revenue.sql",
        },
      ],
      skipped: [],
    },
  );
});

test("candidate pairing defaults modified before and after paths to the candidate path", () => {
  assert.deepEqual(
    createCandidatePairs([
      {
        path: "models/revenue.sql",
        status: "modified",
        hasBefore: true,
        hasAfter: true,
      },
    ]),
    {
      pairs: [
        {
          beforePath: "models/revenue.sql",
          afterPath: "models/revenue.sql",
          displayPath: "models/revenue.sql",
        },
      ],
      skipped: [],
    },
  );
});

test("candidate pairing skips added files with a no-before reason", () => {
  assert.deepEqual(
    createCandidatePairs([
      {
        path: "models/new_metric.sql",
        status: "added",
        hasBefore: false,
        hasAfter: true,
      },
    ]),
    {
      pairs: [],
      skipped: [
        {
          path: "models/new_metric.sql",
          reason: "skipped because no before version exists",
        },
      ],
    },
  );
});

test("candidate pairing skips deleted files with a no-after reason", () => {
  assert.deepEqual(
    createCandidatePairs([
      {
        path: "models/old_metric.sql",
        status: "deleted",
        hasBefore: true,
        hasAfter: false,
      },
    ]),
    {
      pairs: [],
      skipped: [
        {
          path: "models/old_metric.sql",
          reason: "skipped because no after version exists",
        },
      ],
    },
  );
});

test("candidate pairing skips modified files missing before content", () => {
  assert.deepEqual(
    createCandidatePairs([
      {
        path: "models/revenue.sql",
        status: "modified",
        hasBefore: false,
        hasAfter: true,
      },
    ]),
    {
      pairs: [],
      skipped: [
        {
          path: "models/revenue.sql",
          reason: "skipped because no before version exists",
        },
      ],
    },
  );
});

test("candidate pairing skips modified files missing after content", () => {
  assert.deepEqual(
    createCandidatePairs([
      {
        path: "models/revenue.sql",
        status: "modified",
        hasBefore: true,
        hasAfter: false,
      },
    ]),
    {
      pairs: [],
      skipped: [
        {
          path: "models/revenue.sql",
          reason: "skipped because no after version exists",
        },
      ],
    },
  );
});

test("candidate pairing creates a pair for renamed files with explicit before and after paths", () => {
  assert.deepEqual(
    createCandidatePairs([
      {
        path: "models/new_revenue.sql",
        status: "renamed",
        beforePath: "models/old_revenue.sql",
        afterPath: "models/new_revenue.sql",
        hasBefore: true,
        hasAfter: true,
      },
    ]),
    {
      pairs: [
        {
          beforePath: "models/old_revenue.sql",
          afterPath: "models/new_revenue.sql",
          displayPath: "models/old_revenue.sql -> models/new_revenue.sql",
        },
      ],
      skipped: [],
    },
  );
});

test("candidate pairing skips renamed files with incomplete path info", () => {
  assert.deepEqual(
    createCandidatePairs([
      {
        path: "models/new_revenue.sql",
        status: "renamed",
        beforePath: "models/old_revenue.sql",
        hasBefore: true,
        hasAfter: true,
      },
    ]),
    {
      pairs: [],
      skipped: [
        {
          path: "models/new_revenue.sql",
          reason: "skipped renamed file because before/after paths are incomplete",
        },
      ],
    },
  );
});

test("candidate pairing skips unknown statuses", () => {
  assert.deepEqual(
    createCandidatePairs([
      {
        path: "models/revenue.sql",
        status: "unknown",
        hasBefore: true,
        hasAfter: true,
      },
    ]),
    {
      pairs: [],
      skipped: [
        {
          path: "models/revenue.sql",
          reason: "skipped because candidate status is unknown",
        },
      ],
    },
  );
});

test("candidate pairing preserves input order within pairs and skipped groups", () => {
  const result = createCandidatePairs([
    {
      path: "models/a.sql",
      status: "modified",
      hasBefore: true,
      hasAfter: true,
    },
    {
      path: "models/new.sql",
      status: "added",
      hasBefore: false,
      hasAfter: true,
    },
    {
      path: "models/b.sql",
      status: "modified",
      hasBefore: true,
      hasAfter: true,
    },
    {
      path: "models/deleted.sql",
      status: "deleted",
      hasBefore: true,
      hasAfter: false,
    },
  ]);

  assert.deepEqual(
    result.pairs.map((pair) => pair.displayPath),
    ["models/a.sql", "models/b.sql"],
  );
  assert.deepEqual(
    result.skipped.map((candidate) => candidate.path),
    ["models/new.sql", "models/deleted.sql"],
  );
});
