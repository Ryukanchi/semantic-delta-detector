import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  compareGitChanges,
  discoverGitChangedFiles,
  GitDiscoveryError,
  loadGitPairContent,
  type GitPairContentResult,
  type VerifiedGitCommitHash,
} from "../src/index.js";
import { composeCandidateDiscovery } from "../src/discoveryComposition.js";

function runGit(repositoryPath: string, args: string[]): string {
  const result = spawnSync("git", ["-C", repositoryPath, ...args], {
    encoding: "utf8",
    shell: false,
  });

  assert.equal(
    result.status,
    0,
    `Git command failed (${args.join(" ")}): ${result.stderr || result.error?.message}`,
  );
  return result.stdout.trim();
}

function writeRepositoryFile(repositoryPath: string, path: string, contents: string): void {
  const fullPath = join(repositoryPath, path);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, contents, "utf8");
}

test("discovers and reads real modified, added, deleted, and renamed Git files", () => {
  const gitVersion = spawnSync("git", ["--version"], { encoding: "utf8", shell: false });
  assert.equal(
    gitVersion.status,
    0,
    `Git is required for this integration test: ${gitVersion.stderr || gitVersion.error?.message}`,
  );

  const repositoryPath = mkdtempSync(join(tmpdir(), "semantic-delta-git-discovery-"));

  try {
    runGit(repositoryPath, ["init"]);
    runGit(repositoryPath, ["config", "user.name", "Semantic Delta Test"]);
    runGit(repositoryPath, ["config", "user.email", "semantic-delta@example.test"]);

    writeRepositoryFile(
      repositoryPath,
      "models/revenue.sql",
      "SELECT COUNT(*) FROM orders WHERE status = 'paid'\n",
    );
    writeRepositoryFile(
      repositoryPath,
      "models/deleted.sql",
      "SELECT COUNT(*) FROM deleted_source\n",
    );
    writeRepositoryFile(
      repositoryPath,
      "models/old_name.sql",
      "SELECT COUNT(*) FROM stable_source\n",
    );
    writeRepositoryFile(repositoryPath, "docs/ignored.sql", "SELECT 1\n");
    runGit(repositoryPath, ["add", "--", "."]);
    runGit(repositoryPath, ["commit", "-m", "initial"]);
    const baseRef = runGit(repositoryPath, ["rev-parse", "HEAD"]);
    const treeObject = runGit(repositoryPath, ["rev-parse", `${baseRef}^{tree}`]);
    const blobObject = runGit(repositoryPath, [
      "rev-parse",
      `${baseRef}:models/revenue.sql`,
    ]);
    runGit(repositoryPath, ["tag", "-a", "fixture-tag", "-m", "fixture tag", baseRef]);
    const tagObject = runGit(repositoryPath, ["rev-parse", "fixture-tag^{tag}"]);

    writeRepositoryFile(
      repositoryPath,
      "models/revenue.sql",
      "SELECT SUM(amount) FROM orders WHERE status = 'paid'\n",
    );
    writeRepositoryFile(repositoryPath, "models/new.sql", "SELECT COUNT(*) FROM users\n");
    unlinkSync(join(repositoryPath, "models/deleted.sql"));
    renameSync(
      join(repositoryPath, "models/old_name.sql"),
      join(repositoryPath, "models/renamed.sql"),
    );
    writeRepositoryFile(repositoryPath, "docs/ignored.sql", "SELECT 2\n");
    runGit(repositoryPath, ["add", "--", "."]);
    runGit(repositoryPath, ["commit", "-m", "change metrics"]);

    const discovery = discoverGitChangedFiles({
      repositoryPath,
      baseRef,
      headRef: "HEAD",
    });

    assert.deepEqual(
      discovery.files.map((file) => [file.status, file.path]),
      [
        ["modified", "docs/ignored.sql"],
        ["deleted", "models/deleted.sql"],
        ["added", "models/new.sql"],
        ["renamed", "models/renamed.sql"],
        ["modified", "models/revenue.sql"],
      ],
    );
    const composition = composeCandidateDiscovery({
      candidates: discovery.candidates,
      include: ["models/**"],
      ignore: ["docs/**"],
    });
    assert.deepEqual(
      composition.pathFiltering.skipped.map((item) => item.path),
      ["docs/ignored.sql"],
    );
    assert.deepEqual(
      composition.pairing.pairs.map((pair) => pair.displayPath),
      [
        "models/old_name.sql -> models/renamed.sql",
        "models/revenue.sql",
      ],
    );
    assert.deepEqual(
      composition.pairing.skipped.map((item) => item.path),
      ["models/deleted.sql", "models/new.sql"],
    );

    const renamedPair = composition.pairing.pairs[0];
    const renamedContent = loadGitPairContent(
      {
        repositoryPath,
        baseRef: discovery.resolvedBaseRef,
        headRef: discovery.resolvedHeadRef,
        pair: renamedPair,
      },
    );
    assert.equal(renamedContent.failures.length, 0);
    assert.equal(renamedContent.beforeContent, "SELECT COUNT(*) FROM stable_source\n");
    assert.equal(renamedContent.afterContent, "SELECT COUNT(*) FROM stable_source\n");

    for (const invalidObject of [
      { name: "tree", hash: treeObject },
      { name: "blob", hash: blobObject },
      { name: "tag", hash: tagObject },
    ]) {
      let invalidResult: GitPairContentResult | undefined;
      assert.throws(
        () => {
          invalidResult = loadGitPairContent(
            {
              repositoryPath,
              baseRef: invalidObject.hash as VerifiedGitCommitHash,
              headRef: discovery.resolvedHeadRef,
              pair: renamedPair,
            },
          );
        },
        (error: unknown) =>
          error instanceof GitDiscoveryError &&
          error.message.includes(`Git reported "${invalidObject.name}"`),
      );
      assert.equal(invalidResult, undefined);
    }

    let nonexistentResult: GitPairContentResult | undefined;
    assert.throws(
      () => {
        nonexistentResult = loadGitPairContent(
          {
            repositoryPath,
            baseRef: "0".repeat(40) as VerifiedGitCommitHash,
            headRef: discovery.resolvedHeadRef,
            pair: renamedPair,
          },
        );
      },
      (error: unknown) =>
        error instanceof GitDiscoveryError &&
        /Could not verify base commit hash/.test(error.message),
    );
    assert.equal(nonexistentResult, undefined);

    const modifiedPair = composition.pairing.pairs[1];
    const modifiedContent = loadGitPairContent({
      repositoryPath,
      baseRef: discovery.resolvedBaseRef,
      headRef: discovery.resolvedHeadRef,
      pair: modifiedPair,
    });
    assert.equal(modifiedContent.failures.length, 0);
    assert.match(modifiedContent.beforeContent ?? "", /COUNT\(\*\)/);
    assert.match(modifiedContent.afterContent ?? "", /SUM\(amount\)/);
  } finally {
    rmSync(repositoryPath, { recursive: true, force: true });
  }
});

test(
  "round-trips special Git paths through discovery, filtering, pairing, and content loading",
  {
    skip:
      process.platform === "win32"
        ? "Windows does not support every filename character in this POSIX path matrix"
        : false,
  },
  () => {
    const gitVersion = spawnSync("git", ["--version"], {
      encoding: "utf8",
      shell: false,
    });
    assert.equal(
      gitVersion.status,
      0,
      `Git is required for this integration test: ${gitVersion.stderr || gitVersion.error?.message}`,
    );

    const repositoryPath = mkdtempSync(join(tmpdir(), "semantic-delta-special-paths-"));
    const modifiedPaths = [
      "models/ordinary.sql",
      "models/ユニコード.sql",
      "models/space name.sql",
      "models/tab\tname.sql",
      "models/line\nname.sql",
      'models/quote"name.sql',
      "models/backslash\\name.sql",
      "models/深い directory/metric.sql",
    ];
    const renamedBefore = 'models/old\t"\\名.sql';
    const renamedAfter = 'models/new\n"\\名.sql';

    try {
      runGit(repositoryPath, ["init"]);
      runGit(repositoryPath, ["config", "user.name", "Semantic Delta Test"]);
      runGit(repositoryPath, ["config", "user.email", "semantic-delta@example.test"]);

      for (const [index, path] of modifiedPaths.entries()) {
        writeRepositoryFile(
          repositoryPath,
          path,
          `SELECT COUNT(*) FROM source_${index}\n`,
        );
      }
      writeRepositoryFile(
        repositoryPath,
        renamedBefore,
        "SELECT COUNT(DISTINCT rename_id) FROM rename_source WHERE status = 'stable'\n",
      );
      runGit(repositoryPath, ["add", "--", "."]);
      runGit(repositoryPath, ["commit", "-m", "add special paths"]);
      const baseRef = runGit(repositoryPath, ["rev-parse", "HEAD"]);

      for (const [index, path] of modifiedPaths.entries()) {
        writeRepositoryFile(
          repositoryPath,
          path,
          `SELECT COUNT(*) FROM source_${index} WHERE active = true\n`,
        );
      }
      renameSync(join(repositoryPath, renamedBefore), join(repositoryPath, renamedAfter));
      runGit(repositoryPath, ["add", "--", "."]);
      runGit(repositoryPath, ["commit", "-m", "change special paths"]);

      runGit(repositoryPath, ["config", "core.quotePath", "true"]);
      const quotedDiscovery = discoverGitChangedFiles({
        repositoryPath,
        baseRef,
        headRef: "HEAD",
      });
      runGit(repositoryPath, ["config", "core.quotePath", "false"]);
      const unquotedDiscovery = discoverGitChangedFiles({
        repositoryPath,
        baseRef,
        headRef: "HEAD",
      });

      assert.deepEqual(unquotedDiscovery.files, quotedDiscovery.files);
      assert.deepEqual(unquotedDiscovery.parserSkipped, []);
      assert.equal(unquotedDiscovery.files.length, modifiedPaths.length + 1);
      for (const path of modifiedPaths) {
        const file = unquotedDiscovery.files.find((candidate) => candidate.path === path);
        assert.ok(file, `Missing exact discovered path ${JSON.stringify(path)}`);
        assert.equal(file.status, "modified");
      }
      assert.deepEqual(
        unquotedDiscovery.files.find((file) => file.status === "renamed"),
        {
          status: "renamed",
          path: renamedAfter,
          beforePath: renamedBefore,
          afterPath: renamedAfter,
          rawStatus: "R100",
        },
      );

      const comparison = compareGitChanges({
        repositoryPath,
        baseRef,
        headRef: "HEAD",
      });
      assert.equal(comparison.summary.discoveredCount, modifiedPaths.length + 1);
      assert.equal(comparison.summary.analyzedCount, modifiedPaths.length + 1);
      assert.equal(comparison.summary.skippedCount, 0);
      assert.equal(
        comparison.summary.discoveredCount,
        comparison.analyzed.length + comparison.skipped.length,
      );
      assert.ok(
        comparison.analyzed.some(
          (file) =>
            file.beforePath === renamedBefore &&
            file.afterPath === renamedAfter &&
            file.displayPath === `${renamedBefore} -> ${renamedAfter}`,
        ),
      );
      for (const path of modifiedPaths) {
        assert.ok(
          comparison.analyzed.some(
            (file) => file.beforePath === path && file.afterPath === path,
          ),
          `Special path did not reach content loading: ${JSON.stringify(path)}`,
        );
      }
    } finally {
      rmSync(repositoryPath, { recursive: true, force: true });
    }
  },
);
