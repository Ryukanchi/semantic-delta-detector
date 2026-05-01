import test from "node:test";
import assert from "node:assert/strict";
import { composeCandidateDiscovery } from "../src/discoveryComposition.js";

test("discovery composition pairs one modified SQL file", () => {
  assert.deepEqual(
    composeCandidateDiscovery({
      paths: ["models/revenue.sql"],
      candidates: [
        {
          path: "models/revenue.sql",
          status: "modified",
          hasBefore: true,
          hasAfter: true,
        },
      ],
      include: ["**/*.sql"],
    }),
    {
      pathFiltering: {
        included: [
          {
            path: "models/revenue.sql",
            reason: "included by include pattern: **/*.sql",
          },
        ],
        skipped: [],
      },
      pairing: {
        pairs: [
          {
            beforePath: "models/revenue.sql",
            afterPath: "models/revenue.sql",
            displayPath: "models/revenue.sql",
          },
        ],
        skipped: [],
      },
    },
  );
});

test("discovery composition skips ignored paths before pairing", () => {
  assert.deepEqual(
    composeCandidateDiscovery({
      paths: ["docs/example.sql"],
      candidates: [
        {
          path: "docs/example.sql",
          status: "modified",
          hasBefore: true,
          hasAfter: true,
        },
      ],
      ignore: ["docs/**"],
    }),
    {
      pathFiltering: {
        included: [],
        skipped: [
          {
            path: "docs/example.sql",
            reason: "excluded by ignore pattern: docs/**",
          },
        ],
      },
      pairing: {
        pairs: [],
        skipped: [],
      },
    },
  );
});

test("discovery composition excludes non-matching include candidates", () => {
  assert.deepEqual(
    composeCandidateDiscovery({
      paths: ["docs/revenue.sql"],
      candidates: [
        {
          path: "docs/revenue.sql",
          status: "modified",
          hasBefore: true,
          hasAfter: true,
        },
      ],
      include: ["models/**"],
    }),
    {
      pathFiltering: {
        included: [],
        skipped: [
          {
            path: "docs/revenue.sql",
            reason: "excluded because no include pattern matched",
          },
        ],
      },
      pairing: {
        pairs: [],
        skipped: [],
      },
    },
  );
});

test("discovery composition lets pairing skip added files after path inclusion", () => {
  assert.deepEqual(
    composeCandidateDiscovery({
      paths: ["models/new_metric.sql"],
      candidates: [
        {
          path: "models/new_metric.sql",
          status: "added",
          hasBefore: false,
          hasAfter: true,
        },
      ],
      include: ["models/**"],
    }),
    {
      pathFiltering: {
        included: [
          {
            path: "models/new_metric.sql",
            reason: "included by include pattern: models/**",
          },
        ],
        skipped: [],
      },
      pairing: {
        pairs: [],
        skipped: [
          {
            path: "models/new_metric.sql",
            reason: "skipped because no before version exists",
          },
        ],
      },
    },
  );
});

test("discovery composition preserves ordering through filtering and pairing", () => {
  const result = composeCandidateDiscovery({
    paths: ["models/a.sql", "docs/skip.sql", "models/new.sql", "models/b.sql"],
    candidates: [
      {
        path: "models/a.sql",
        status: "modified",
        hasBefore: true,
        hasAfter: true,
      },
      {
        path: "docs/skip.sql",
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
    ],
    include: ["models/**"],
  });

  assert.deepEqual(
    result.pathFiltering.included.map((item) => item.path),
    ["models/a.sql", "models/new.sql", "models/b.sql"],
  );
  assert.deepEqual(
    result.pathFiltering.skipped.map((item) => item.path),
    ["docs/skip.sql"],
  );
  assert.deepEqual(
    result.pairing.pairs.map((item) => item.displayPath),
    ["models/a.sql", "models/b.sql"],
  );
  assert.deepEqual(
    result.pairing.skipped.map((item) => item.path),
    ["models/new.sql"],
  );
});

test("discovery composition preserves skipped path reasons", () => {
  const result = composeCandidateDiscovery({
    paths: ["docs/example.sql"],
    candidates: [],
    ignore: ["docs/**"],
  });

  assert.deepEqual(result.pathFiltering.skipped, [
    {
      path: "docs/example.sql",
      reason: "excluded by ignore pattern: docs/**",
    },
  ]);
});

test("discovery composition preserves skipped pairing reasons", () => {
  const result = composeCandidateDiscovery({
    paths: ["models/revenue.sql"],
    candidates: [
      {
        path: "models/revenue.sql",
        status: "modified",
        hasBefore: true,
        hasAfter: false,
      },
    ],
  });

  assert.deepEqual(result.pairing.skipped, [
    {
      path: "models/revenue.sql",
      reason: "skipped because no after version exists",
    },
  ]);
});
