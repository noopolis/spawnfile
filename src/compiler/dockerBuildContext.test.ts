import { appendFile, chmod, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ensureDirectory,
  readUtf8File,
  removeDirectory,
  writeUtf8File
} from "../filesystem/index.js";

import { compileProject } from "./compileProject.js";
import {
  createDockerBuildContextDigest,
  createDockerIgnoreContent,
  DOCKER_BUILD_CONTEXT_IGNORE_PATTERNS,
  listDockerBuildContextFiles,
  matchesDockerBuildIgnorePattern
} from "./dockerBuildContext.js";

const fixturesRoot = path.resolve(process.cwd(), "test", "fixtures");
const temporaryDirectories: string[] = [];
const previousRunId = process.env.NOOPOLIS_RUN_ID;

const createOutputDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-context-"));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  if (previousRunId === undefined) {
    delete process.env.NOOPOLIS_RUN_ID;
  } else {
    process.env.NOOPOLIS_RUN_ID = previousRunId;
  }
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => removeDirectory(directory))
  );
});

describe("Docker build context", () => {
  it("emits only the frozen, measured ignore patterns", () => {
    expect(DOCKER_BUILD_CONTEXT_IGNORE_PATTERNS).toEqual([
      "runtimes/",
      "spawnfile-report.json",
      "deployments/"
    ]);
    expect(Object.isFrozen(DOCKER_BUILD_CONTEXT_IGNORE_PATTERNS)).toBe(true);
    expect(createDockerIgnoreContent()).toBe(
      "runtimes/\nspawnfile-report.json\ndeployments/\n"
    );
  });

  it("lists surviving files with relative paths, byte sizes, and permission modes", async () => {
    const directory = await createOutputDirectory();
    await ensureDirectory(path.join(directory, "nested"));
    await ensureDirectory(path.join(directory, "runtimes"));
    await writeUtf8File(path.join(directory, "b.txt"), "bbb");
    await chmod(path.join(directory, "b.txt"), 0o644);
    await writeUtf8File(path.join(directory, "nested", "a.txt"), "a");
    await chmod(path.join(directory, "nested", "a.txt"), 0o600);
    await writeUtf8File(path.join(directory, "runtimes", "ignored.txt"), "ignored");
    await writeUtf8File(path.join(directory, "spawnfile-report.json"), "{}");

    expect(await listDockerBuildContextFiles(directory)).toEqual([
      { mode: 0o644, path: "b.txt", size: 3 },
      { mode: 0o600, path: "nested/a.txt", size: 1 }
    ]);
    expect(matchesDockerBuildIgnorePattern("deployments/x.json", "deployments/")).toBe(true);
    expect(matchesDockerBuildIgnorePattern("other/deployments/x.json", "deployments/")).toBe(false);
  });

  it("keeps a stable digest across compile timestamps when the run id is unchanged", async () => {
    const outputDirectory = await createOutputDirectory();
    process.env.NOOPOLIS_RUN_ID = "run-context-stable";
    const first = await compileProject(path.join(fixturesRoot, "single-agent"), {
      outputDirectory
    });
    const firstDigest = await createDockerBuildContextDigest(outputDirectory);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await compileProject(path.join(fixturesRoot, "single-agent"), {
      outputDirectory
    });
    const secondDigest = await createDockerBuildContextDigest(outputDirectory);

    expect(first.report.generated_at).not.toBe(second.report.generated_at);
    expect(firstDigest).toBe(secondDigest);
  }, 30_000);

  it("changes the digest when a fresh run id changes the copied entrypoint", async () => {
    const outputDirectory = await createOutputDirectory();
    process.env.NOOPOLIS_RUN_ID = "run-aaaa";
    await compileProject(path.join(fixturesRoot, "single-agent"), { outputDirectory });
    const firstDigest = await createDockerBuildContextDigest(outputDirectory);

    process.env.NOOPOLIS_RUN_ID = "run-bbbb";
    await compileProject(path.join(fixturesRoot, "single-agent"), { outputDirectory });
    const secondDigest = await createDockerBuildContextDigest(outputDirectory);

    // F6 guard: a fresh causal run id is image content and must force a rebuild.
    expect(secondDigest).not.toBe(firstDigest);
    expect(await readUtf8File(path.join(outputDirectory, "entrypoint.sh"))).toContain(
      "run-bbbb"
    );
  }, 30_000);

  it("changes the digest when an agent workspace byte changes", async () => {
    const outputDirectory = await createOutputDirectory();
    process.env.NOOPOLIS_RUN_ID = "run-workspace";
    await compileProject(path.join(fixturesRoot, "single-agent"), { outputDirectory });
    const firstDigest = await createDockerBuildContextDigest(outputDirectory);
    const workspaceFile = (await listDockerBuildContextFiles(outputDirectory))
      .find((file) => file.path.includes("/workspace/"));

    expect(workspaceFile).toBeDefined();
    await appendFile(path.join(outputDirectory, workspaceFile!.path), "x");
    expect(await createDockerBuildContextDigest(outputDirectory)).not.toBe(firstDigest);
  }, 30_000);

  it("ignores additions under the duplicated runtimes tree", async () => {
    const outputDirectory = await createOutputDirectory();
    process.env.NOOPOLIS_RUN_ID = "run-runtimes";
    await compileProject(path.join(fixturesRoot, "single-agent"), { outputDirectory });
    const firstDigest = await createDockerBuildContextDigest(outputDirectory);

    await ensureDirectory(path.join(outputDirectory, "runtimes", "extra"));
    await writeUtf8File(path.join(outputDirectory, "runtimes", "extra", "ignored.txt"), "x");
    expect(await createDockerBuildContextDigest(outputDirectory)).toBe(firstDigest);
  }, 30_000);
});
