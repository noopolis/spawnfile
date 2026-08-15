import path from "node:path";
import os from "node:os";
import { chmod, mkdtemp } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BUILD_IMAGE_CACHE_VERSION,
  writeBuildImageCacheEntry
} from "../deployment/buildImageCacheStore.js";
import {
  fileExists,
  writeUtf8File,
  readUtf8File,
  removeDirectory
} from "../filesystem/index.js";

import {
  buildProject,
  createDefaultImageTag,
  createDockerBuildInvocation,
  type DockerBuildInvocation
} from "./buildProject.js";

vi.mock("./moltnetBinaries.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./moltnetBinaries.js")>();
  const { stageTrustedTestMoltnetRelease } = await import(
    "../../fixtures/support/trustedMoltnetRelease.js"
  );
  return {
    ...actual,
    stageMoltnetBinaries: (outputDirectory: string, options: Parameters<
      typeof actual.stageMoltnetBinaries
    >[1]) => stageTrustedTestMoltnetRelease(
      outputDirectory,
      options
    )
  };
});

const temporaryDirectories: string[] = [];
const examplesRoot = path.resolve(process.cwd(), "examples");
const fixturesRoot = path.resolve(process.cwd(), "fixtures");

beforeEach(async () => {
  const homeDirectory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-build-home-"));
  temporaryDirectories.push(homeDirectory);
  vi.stubEnv("SPAWNFILE_HOME", homeDirectory);
});

const createFakeDockerInfoCommand = async (architecture: string): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-fake-docker-"));
  temporaryDirectories.push(directory);
  const commandPath = path.join(directory, "docker");
  const safeArchitecture = JSON.stringify(architecture);
  await writeUtf8File(
    commandPath,
    `#!/usr/bin/env sh
printf '%s\\n' ${safeArchitecture}
`
  );
  await chmod(commandPath, 0o755);
  return commandPath;
};

const createFakeMoltnetCli = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-fake-moltnet-cli-"));
  temporaryDirectories.push(directory);
  const commandPath = path.join(directory, "moltnet");
  await writeUtf8File(
    commandPath,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const args = process.argv.slice(2);",
      "if (args[0] === 'version') {",
      "  process.stdout.write('0.0.0-test\\n');",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'skill' && args[1] === 'install') {",
      "  const flags = new Map();",
      "  for (let index = 2; index < args.length; index += 2) {",
      "    flags.set(args[index], args[index + 1]);",
      "  }",
      "  const runtime = flags.get('--runtime');",
      "  const workspace = flags.get('--workspace');",
      "  const content = '# name: moltnet\\nMoltnet is a transport, not an implicit reply channel.\\n';",
      "  const targets = runtime === 'codex'",
      "    ? [",
      "        path.join(workspace, '.agents', 'skills', 'moltnet', 'SKILL.md'),",
      "        path.join(workspace, '.codex', 'skills', 'moltnet', 'SKILL.md')",
      "      ]",
      "    : [path.join(workspace, 'skills', 'moltnet', 'SKILL.md')];",
      "  for (const target of targets) {",
      "    fs.mkdirSync(path.dirname(target), { recursive: true });",
      "    fs.writeFileSync(target, content);",
      "  }",
      "  process.stdout.write(`${targets.join(', ')}\\n`);",
      "  process.exit(0);",
      "}",
      "process.stderr.write(`unexpected args: ${args.join(' ')}\\n`);",
      "process.exit(1);"
    ].join("\n") + "\n"
  );
  await chmod(commandPath, 0o755);
  return commandPath;
};

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => removeDirectory(directory)));
});

describe("buildProject", () => {
  it("builds a single-agent project with a default image tag", async () => {
    const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-build-single-"));
    temporaryDirectories.push(outputDirectory);

    const invocations: DockerBuildInvocation[] = [];
    const imageInspector = vi.fn(async () => null);
    const result = await buildProject(path.join(examplesRoot, "single-agent"), {
      buildRunner: async (invocation) => {
        invocations.push(invocation);
      },
      imageInspector,
      outputDirectory
    });

    expect(result.imageTag).toBe("spawnfile-single-agent");
    expect(invocations).toEqual([
      {
        args: ["build", "-t", "spawnfile-single-agent", "."],
        command: "docker",
        cwd: outputDirectory,
        dockerContext: null,
        imageTag: "spawnfile-single-agent"
      }
    ]);
    expect(imageInspector).not.toHaveBeenCalled();
    expect(result.imageBuild).toEqual({
      buildMs: expect.any(Number),
      contextBytes: expect.any(Number),
      contextDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      contextDigestMs: expect.any(Number),
      contextFileCount: expect.any(Number),
      probeMs: expect.any(Number),
      skipped: false
    });
    expect(result.imageBuild!.contextBytes).toBeGreaterThan(0);
    expect(result.imageBuild!.contextFileCount).toBeGreaterThan(0);
    await expect(fileExists(path.join(outputDirectory, "Dockerfile"))).resolves.toBe(true);
    await expect(fileExists(path.join(outputDirectory, ".dockerignore"))).resolves.toBe(true);
    await expect(fileExists(path.join(outputDirectory, "runtime-sources"))).resolves.toBe(false);

    const dockerfile = await readUtf8File(path.join(outputDirectory, "Dockerfile"));
    expect(dockerfile).toContain(
      "COPY --from=noopolis/spawnfile-runtime-openclaw:2026.6.11 /opt/spawnfile/runtime-installs/openclaw /opt/spawnfile/runtime-installs/openclaw"
    );
    expect(dockerfile).not.toContain("runtime-sources");
  }, 30000);

  it("builds a multi-runtime team with artifact installs for all runtimes", async () => {
    const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-build-team-"));
    temporaryDirectories.push(outputDirectory);

    const buildRunner = vi.fn(async () => undefined);
    const result = await buildProject(path.join(fixturesRoot, "multi-runtime-team"), {
      buildRunner,
      outputDirectory
    });

    expect(result.imageTag).toBe("spawnfile-multi-runtime-team");
    expect(buildRunner).toHaveBeenCalledWith({
      args: ["build", "-t", "spawnfile-multi-runtime-team", "."],
      command: "docker",
      cwd: outputDirectory,
      dockerContext: null,
      imageTag: "spawnfile-multi-runtime-team"
    });

    const dockerfile = await readUtf8File(path.join(outputDirectory, "Dockerfile"));
    expect(dockerfile).toContain(
      "COPY --from=noopolis/spawnfile-runtime-openclaw:2026.6.11 /opt/spawnfile/runtime-installs/openclaw /opt/spawnfile/runtime-installs/openclaw"
    );
    expect(dockerfile).toContain(
      "COPY --from=noopolis/spawnfile-runtime-picoclaw:0.3.1 /opt/spawnfile/runtime-installs/picoclaw /opt/spawnfile/runtime-installs/picoclaw"
    );
    expect(dockerfile).toContain(
      "RUN mkdir -p /usr/local/bin && ln -sf /opt/spawnfile/runtime-installs/picoclaw/bin/picoclaw /usr/local/bin/picoclaw"
    );
    expect(dockerfile).not.toContain("go build -o /usr/local/bin/picoclaw");
    expect(dockerfile).not.toContain("pnpm install");
  }, 30000);

  it("uses an explicit image tag when provided", async () => {
    const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-build-tag-"));
    temporaryDirectories.push(outputDirectory);

    const buildRunner = vi.fn(async () => undefined);
    const result = await buildProject(path.join(examplesRoot, "single-agent"), {
      buildRunner,
      imageTag: "custom-image:dev",
      outputDirectory
    });

    expect(result.imageTag).toBe("custom-image:dev");
    expect(buildRunner).toHaveBeenCalledWith({
      args: ["build", "-t", "custom-image:dev", "."],
      command: "docker",
      cwd: outputDirectory,
      dockerContext: null,
      imageTag: "custom-image:dev"
    });
  }, 30000);

  it("always invokes an injected runner even when a fully matching cache entry exists", async () => {
    const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-build-skip-"));
    temporaryDirectories.push(outputDirectory);
    const buildRunner = vi.fn(async () => undefined);
    const inputPath = path.join(examplesRoot, "single-agent");
    const first = await buildProject(inputPath, {
      buildRunner,
      outputDirectory
    });
    await writeBuildImageCacheEntry({
      compileFingerprint: first.report.compile_fingerprint!,
      contextDigest: first.imageBuild!.contextDigest,
      dockerContext: null,
      imageId: "sha256:cached-image",
      imageTag: first.imageTag,
      projectRoot: first.report.root,
      version: BUILD_IMAGE_CACHE_VERSION,
      writtenAt: "2026-07-30T12:00:00.000Z"
    });
    const imageInspector = vi.fn(async () => ({
      id: "sha256:cached-image",
      labels: {
        "com.spawnfile.compile_fingerprint": first.report.compile_fingerprint!
      }
    }));

    const second = await buildProject(inputPath, {
      buildRunner,
      imageInspector,
      outputDirectory
    });

    expect(buildRunner).toHaveBeenCalledTimes(2);
    expect(imageInspector).not.toHaveBeenCalled();
    expect(second.imageBuild).toEqual({
      buildMs: expect.any(Number),
      contextBytes: first.imageBuild!.contextBytes,
      contextDigest: first.imageBuild!.contextDigest,
      contextDigestMs: expect.any(Number),
      contextFileCount: first.imageBuild!.contextFileCount,
      probeMs: 0,
      skipped: false
    });
  }, 30_000);

  it("derives the default image tag from a Spawnfile file path", async () => {
    const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-build-file-"));
    temporaryDirectories.push(outputDirectory);

    const buildRunner = vi.fn(async () => undefined);
    const result = await buildProject(path.join(examplesRoot, "single-agent", "Spawnfile"), {
      buildRunner,
      outputDirectory
    });

    expect(result.imageTag).toBe("spawnfile-single-agent");
    expect(buildRunner).toHaveBeenCalledWith({
      args: ["build", "-t", "spawnfile-single-agent", "."],
      command: "docker",
      cwd: outputDirectory,
      dockerContext: null,
      imageTag: "spawnfile-single-agent"
    });
  }, 30000);

  it("resolves Moltnet binary architecture from a docker context and stages matching assets", async () => {
    const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-build-context-arch-"));
    temporaryDirectories.push(outputDirectory);
    const previousReleaseDirectory = process.env.SPAWNFILE_MOLTNET_RELEASE_DIR;
    const dockerCommand = await createFakeDockerInfoCommand("arm64");
    const moltnetCli = await createFakeMoltnetCli();
    const buildRunner = vi.fn(async () => undefined);
    vi.stubEnv("SPAWNFILE_MOLTNET_CLI", moltnetCli);
    vi.stubEnv("SPAWNFILE_MOLTNET_TARGET_ARCH", "amd64");

    const result = await buildProject(path.join(examplesRoot, "moltnet-team-chat"), {
      buildRunner,
      dockerContext: "remote-pi",
      dockerCommand,
      outputDirectory
    });

    expect(result.imageTag).toBe("spawnfile-moltnet-team-chat");
    expect(buildRunner).toHaveBeenCalledWith({
      args: ["--context", "remote-pi", "build", "-t", result.imageTag, "."],
      command: dockerCommand,
      cwd: outputDirectory,
      dockerContext: "remote-pi",
      imageTag: result.imageTag
    });

    await expect(fileExists(path.join(outputDirectory, "moltnet-bin", "moltnet"))).resolves.toBe(true);
    expect(process.env.SPAWNFILE_MOLTNET_RELEASE_DIR).toBe(previousReleaseDirectory);
  }, 30000);
});

describe("buildProject helpers", () => {
  it("creates default image tags from the project root directory", () => {
    expect(createDefaultImageTag("/tmp/Single Agent")).toBe("spawnfile-single-agent");
    expect(createDefaultImageTag("/tmp/???")).toBe("spawnfile-project");
  });

  it("creates docker build invocations for the compile output directory", () => {
    expect(createDockerBuildInvocation("/tmp/dist", "spawnfile-agent")).toEqual({
      args: ["build", "-t", "spawnfile-agent", "."],
      command: "docker",
      cwd: "/tmp/dist",
      dockerContext: null,
      imageTag: "spawnfile-agent"
    });

    expect(createDockerBuildInvocation("/tmp/dist", "spawnfile-agent", "podman")).toEqual({
      args: ["build", "-t", "spawnfile-agent", "."],
      command: "podman",
      cwd: "/tmp/dist",
      dockerContext: null,
      imageTag: "spawnfile-agent"
    });

    expect(createDockerBuildInvocation("/tmp/dist", "spawnfile-agent", {
      dockerContext: "gpu-host"
    })).toEqual({
      args: ["--context", "gpu-host", "build", "-t", "spawnfile-agent", "."],
      command: "docker",
      cwd: "/tmp/dist",
      dockerContext: "gpu-host",
      imageTag: "spawnfile-agent"
    });
  });
});
