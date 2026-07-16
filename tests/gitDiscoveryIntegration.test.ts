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
  discoverGitChangedFiles,
  loadGitPairContent,
} from "../src/gitDiscovery.js";
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
    const renamedContent = loadGitPairContent({
      repositoryPath,
      baseRef: discovery.resolvedBaseRef,
      headRef: discovery.resolvedHeadRef,
      pair: renamedPair,
    });
    assert.equal(renamedContent.failures.length, 0);
    assert.equal(renamedContent.beforeContent, "SELECT COUNT(*) FROM stable_source\n");
    assert.equal(renamedContent.afterContent, "SELECT COUNT(*) FROM stable_source\n");

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
