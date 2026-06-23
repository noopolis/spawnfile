import path from "node:path";
import os from "node:os";
import { chmod, mkdtemp } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fileExists,
  writeUtf8File,
  readUtf8File,
  ensureDirectory,
  removeDirectory
} from "../filesystem/index.js";

import {
  buildProject,
  createDefaultImageTag,
  createDockerBuildInvocation,
  type DockerBuildInvocation
} from "./buildProject.js";

const execFile = promisify(execFileCallback);
const temporaryDirectories: string[] = [];
const fixturesRoot = path.resolve(process.cwd(), "fixtures");

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

const createFakeMoltnetReleaseDirectory = async (
  architecture = "amd64"
): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-moltnet-release-"));
  const payloadDirectory = path.join(directory, "payload");
  temporaryDirectories.push(directory);

  await ensureDirectory(payloadDirectory);
  await writeUtf8File(path.join(payloadDirectory, "moltnet"), "#!/usr/bin/env sh\necho moltnet\n");
  await chmod(path.join(payloadDirectory, "moltnet"), 0o755);
  const assetName = `moltnet_linux_${architecture}.tar.gz`;
  await execFile("tar", ["-C", payloadDirectory, "-czf", path.join(directory, assetName), "."]);

  return directory;
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
    const result = await buildProject(path.join(fixturesRoot, "single-agent"), {
      buildRunner: async (invocation) => {
        invocations.push(invocation);
      },
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
    await expect(fileExists(path.join(outputDirectory, "Dockerfile"))).resolves.toBe(true);
    await expect(fileExists(path.join(outputDirectory, "runtime-sources"))).resolves.toBe(false);

    const dockerfile = await readUtf8File(path.join(outputDirectory, "Dockerfile"));
    expect(dockerfile).toContain(
      "COPY --from=noopolis/spawnfile-runtime-openclaw:2026.6.8 /opt/spawnfile/runtime-installs/openclaw /opt/spawnfile/runtime-installs/openclaw"
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
      "COPY --from=noopolis/spawnfile-runtime-openclaw:2026.6.8 /opt/spawnfile/runtime-installs/openclaw /opt/spawnfile/runtime-installs/openclaw"
    );
    expect(dockerfile).toContain(
      "COPY --from=noopolis/spawnfile-runtime-picoclaw:0.2.9 /opt/spawnfile/runtime-installs/picoclaw /opt/spawnfile/runtime-installs/picoclaw"
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
    const result = await buildProject(path.join(fixturesRoot, "single-agent"), {
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

  it("derives the default image tag from a Spawnfile file path", async () => {
    const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-build-file-"));
    temporaryDirectories.push(outputDirectory);

    const buildRunner = vi.fn(async () => undefined);
    const result = await buildProject(path.join(fixturesRoot, "single-agent", "Spawnfile"), {
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
    const releaseDirectory = await createFakeMoltnetReleaseDirectory("arm64");
    const dockerCommand = await createFakeDockerInfoCommand("arm64");
    const moltnetCli = await createFakeMoltnetCli();
    const buildRunner = vi.fn(async () => undefined);
    vi.stubEnv("SPAWNFILE_MOLTNET_CLI", moltnetCli);
    vi.stubEnv("SPAWNFILE_MOLTNET_RELEASE_DIR", releaseDirectory);
    vi.stubEnv("SPAWNFILE_MOLTNET_TARGET_ARCH", "amd64");

    const result = await buildProject(path.join(fixturesRoot, "e2e", "moltnet-team-chat"), {
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
      dockerContext: "gpu-4090"
    })).toEqual({
      args: ["--context", "gpu-4090", "build", "-t", "spawnfile-agent", "."],
      command: "docker",
      cwd: "/tmp/dist",
      dockerContext: "gpu-4090",
      imageTag: "spawnfile-agent"
    });
  });
});
