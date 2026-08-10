import assert from "node:assert/strict";
import test from "node:test";
import { composeCandidateDiscovery } from "../src/discoveryComposition.js";
import {
  GitDiffNulParseError,
  gitDiffFilesToCandidates,
  parseGitDiffNameStatus,
  parseGitDiffNameStatusZ,
} from "../src/gitDiffParser.js";

function nameStatusZ(records: ReadonlyArray<readonly string[]>): Buffer {
  const fields = records.flat();
  return fields.length === 0
    ? Buffer.alloc(0)
    : Buffer.from(`${fields.join("\0")}\0`, "utf8");
}

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

test("parses NUL-delimited ordinary and special paths without splitting them", () => {
  const paths = [
    "models/ordinary.sql",
    "models/ユニコード.sql",
    "models/space name.sql",
    "models/tab\tname.sql",
    "models/line\nname.sql",
    'models/quote"name.sql',
    "models/backslash\\name.sql",
    "models/深い directory/metric.sql",
  ];
  const result = parseGitDiffNameStatusZ(
    nameStatusZ(paths.map((path) => ["M", path])),
  );

  assert.deepEqual(
    result.files.map((file) => file.path),
    paths,
  );
  assert.ok(result.files.every((file) => file.status === "modified"));
  assert.deepEqual(result.skipped, []);
});

test("parses NUL-delimited added, deleted, and unknown statuses conservatively", () => {
  const result = parseGitDiffNameStatusZ(
    nameStatusZ([
      ["A", "models/added.sql"],
      ["D", "models/deleted.sql"],
      ["T", "models/type-changed.sql"],
    ]),
  );

  assert.deepEqual(
    result.files.map((file) => [file.status, file.path, file.rawStatus]),
    [
      ["added", "models/added.sql", "A"],
      ["deleted", "models/deleted.sql", "D"],
      ["unknown", "models/type-changed.sql", "T"],
    ],
  );
  assert.deepEqual(result.skipped, []);
});

test("preserves exact NUL-delimited rename and copy paths", () => {
  const renamedBefore = 'models/old\t"\\名.sql';
  const renamedAfter = 'models/new\n"\\名.sql';
  const copiedBefore = "models/source ユニコード.sql";
  const copiedAfter = "models/copy\tname.sql";
  const result = parseGitDiffNameStatusZ(
    nameStatusZ([
      ["R087", renamedBefore, renamedAfter],
      ["C100", copiedBefore, copiedAfter],
    ]),
  );

  assert.deepEqual(result.files, [
    {
      status: "renamed",
      path: renamedAfter,
      beforePath: renamedBefore,
      afterPath: renamedAfter,
      rawStatus: "R087",
    },
    {
      status: "unknown",
      path: copiedAfter,
      beforePath: copiedBefore,
      afterPath: copiedAfter,
      rawStatus: "C100",
    },
  ]);
  assert.deepEqual(gitDiffFilesToCandidates(result.files)[1], {
    path: copiedAfter,
    status: "unknown",
    beforePath: copiedBefore,
    afterPath: copiedAfter,
    hasBefore: false,
    hasAfter: false,
  });
});

test("preserves NUL-delimited duplicate records and ordering", () => {
  const result = parseGitDiffNameStatusZ(
    nameStatusZ([
      ["M", "models/second.sql"],
      ["M", "models/duplicate.sql"],
      ["M", "models/first.sql"],
      ["M", "models/duplicate.sql"],
    ]),
  );

  assert.deepEqual(
    result.files.map((file) => file.path),
    [
      "models/second.sql",
      "models/duplicate.sql",
      "models/first.sql",
      "models/duplicate.sql",
    ],
  );
});

test("keeps explicit empty NUL fields observable and preserves later records", () => {
  const result = parseGitDiffNameStatusZ(
    nameStatusZ([
      ["M", "models/valid.sql"],
      ["R100", "models/old.sql", ""],
      ["M", "models/after-empty.sql"],
    ]),
  );

  assert.deepEqual(
    result.files.map((file) => file.path),
    ["models/valid.sql", "models/after-empty.sql"],
  );
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /path field 2 is empty/i);
});

test("keeps an explicit empty copy field from consuming the next status", () => {
  const result = parseGitDiffNameStatusZ(
    nameStatusZ([
      ["C100", "models/source.sql", ""],
      ["A", "models/after-empty.sql"],
    ]),
  );

  assert.deepEqual(result.files, [
    {
      status: "added",
      path: "models/after-empty.sql",
      rawStatus: "A",
    },
  ]);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /path field 2 is empty/i);
});

test("fails closed on missing terminal NUL and truncated EOF", () => {
  assert.throws(
    () => parseGitDiffNameStatusZ(Buffer.from("M\0models/unterminated.sql", "utf8")),
    (error: unknown) =>
      error instanceof GitDiffNulParseError &&
      /without a terminal NUL/i.test(error.message) &&
      /no records were accepted/i.test(error.message),
  );

  assert.throws(
    () =>
      parseGitDiffNameStatusZ(
        Buffer.from("M\0models/valid.sql\0R100\0models/old.sql\0", "utf8"),
      ),
    (error: unknown) =>
      error instanceof GitDiffNulParseError &&
      /no safe complete record framing/i.test(error.message) &&
      /no records were accepted/i.test(error.message),
  );
});

const recoverableLaterRecords = [
  {
    name: "modified",
    fields: ["M", "models/good.sql"],
    expected: {
      status: "modified",
      path: "models/good.sql",
      rawStatus: "M",
    },
  },
  {
    name: "added",
    fields: ["A", "models/good.sql"],
    expected: {
      status: "added",
      path: "models/good.sql",
      rawStatus: "A",
    },
  },
  {
    name: "deleted",
    fields: ["D", "models/good.sql"],
    expected: {
      status: "deleted",
      path: "models/good.sql",
      rawStatus: "D",
    },
  },
  {
    name: "unknown",
    fields: ["T", "models/good.sql"],
    expected: {
      status: "unknown",
      path: "models/good.sql",
      rawStatus: "T",
    },
  },
  {
    name: "rename",
    fields: ["R100", "models/later-old.sql", "models/later-new.sql"],
    expected: {
      status: "renamed",
      path: "models/later-new.sql",
      beforePath: "models/later-old.sql",
      afterPath: "models/later-new.sql",
      rawStatus: "R100",
    },
  },
] as const;

for (const malformedStatus of ["R100", "C100"] as const) {
  for (const laterRecord of recoverableLaterRecords) {
    test(`recovers the later ${laterRecord.name} record after truncated ${malformedStatus}`, () => {
      const result = parseGitDiffNameStatusZ(
        nameStatusZ([
          [malformedStatus, "models/incomplete.sql"],
          laterRecord.fields,
        ]),
      );

      assert.deepEqual(result.files, [laterRecord.expected]);
      assert.equal(result.skipped.length, 1);
      assert.match(result.skipped[0].reason, /entry is truncated/i);
      assert.match(result.skipped[0].reason, /only 1 could be assigned/i);
      assert.equal(
        result.skipped[0].line,
        `${JSON.stringify(malformedStatus)} NUL "models/incomplete.sql"`,
      );
    });
  }
}

test("fails closed instead of choosing between ambiguous complete framings", () => {
  assert.throws(
    () =>
      parseGitDiffNameStatusZ(
        nameStatusZ([
          ["R100", "models/old.sql", "M"],
          ["A", "R100"],
          ["D", "models/path.sql"],
        ]),
      ),
    (error: unknown) =>
      error instanceof GitDiffNulParseError &&
      /ambiguous record boundaries/i.test(error.message) &&
      /no records were accepted/i.test(error.message),
  );
});

test("fails closed on invalid or empty status fields", () => {
  const invalidStatus = Buffer.concat([
    Buffer.from([0xff, 0]),
    Buffer.from("models/bad.sql\0M\0models/good.sql\0", "utf8"),
  ]);
  assert.throws(
    () => parseGitDiffNameStatusZ(invalidStatus),
    (error: unknown) =>
      error instanceof GitDiffNulParseError &&
      /no safe complete record framing/i.test(error.message),
  );
  assert.throws(
    () =>
      parseGitDiffNameStatusZ(
        Buffer.from("\0models/bad.sql\0M\0models/good.sql\0", "utf8"),
      ),
    (error: unknown) =>
      error instanceof GitDiffNulParseError &&
      /no safe complete record framing/i.test(error.message),
  );
});

test("skips invalid UTF-8 rename and copy fields while preserving the next record", () => {
  for (const malformedStatus of ["R100", "C100"] as const) {
    const result = parseGitDiffNameStatusZ(
      Buffer.concat([
        Buffer.from(`${malformedStatus}\0models/old.sql\0`, "utf8"),
        Buffer.from([0xc3, 0x28, 0]),
        nameStatusZ([["M", "models/after-invalid.sql"]]),
      ]),
    );

    assert.deepEqual(result.files, [
      {
        status: "modified",
        path: "models/after-invalid.sql",
        rawStatus: "M",
      },
    ]);
    assert.equal(result.skipped.length, 1);
    assert.match(result.skipped[0].reason, /path field 2 is not valid UTF-8/i);
    assert.match(result.skipped[0].line, /0xc328/);
  }
});

test("skips invalid UTF-8 paths without manufacturing replacement text", () => {
  const invalidPath = Buffer.from([0xc3, 0x28]);
  const result = parseGitDiffNameStatusZ(
    Buffer.concat([
      Buffer.from("M\0", "utf8"),
      invalidPath,
      Buffer.from([0]),
      nameStatusZ([["M", "models/after-invalid.sql"]]),
    ]),
  );

  assert.deepEqual(result.files.map((file) => file.path), ["models/after-invalid.sql"]);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /not valid UTF-8/i);
  assert.match(result.skipped[0].line, /0xc328/);
  assert.doesNotMatch(result.skipped[0].line, /�/);
});

test("keeps the public legacy text parser behavior unchanged", () => {
  const result = parseGitDiffNameStatus(
    'M\t"models/quoted\\303\\274.sql"\nC100\tmodels/source.sql\tmodels/copy.sql',
  );

  assert.equal(result.files[0].path, '"models/quoted\\303\\274.sql"');
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /exactly one path/i);
});
