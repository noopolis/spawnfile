import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { runCli } from "../cli/runCli.js";
import { consumeImageUp } from "../distribution/index.js";
import { removeDirectory } from "../filesystem/index.js";
import { SpawnfileError } from "../shared/index.js";

const DEFAULT_FIXTURE_DIRECTORY = fileURLToPath(
  new URL("../../fixtures/distribution-org", import.meta.url)
);

export interface DistributionRoundtripLogger {
  info(message: string): void;
}

export interface RunDistributionRoundtripOptions {
  dockerCommand?: string;
  fixtureDirectory?: string;
  keepArtifacts?: boolean;
  logger?: DistributionRoundtripLogger;
  registryPort?: number;
}

export interface RunDistributionRoundtripResult {
  deploymentName: string;
  imageRef: string;
}

const runDocker = async (
  dockerCommand: string,
  args: string[],
  options: { allowFailure?: boolean } = {}
): Promise<string> =>
  new Promise<string>((resolve, reject) => {
    const child = spawn(dockerCommand, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: string[] = [];
    const stderr: string[] = [];
    child.stdout.on("data", (chunk: Buffer | string) => stdout.push(String(chunk)));
    child.stderr.on("data", (chunk: Buffer | string) => stderr.push(String(chunk)));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0 || options.allowFailure) {
        resolve(stdout.join(""));
        return;
      }
      reject(
        new SpawnfileError("runtime_error", `docker ${args[0]} failed (${code}): ${stderr.join("").trim()}`)
      );
    });
  });

const expectThrows = async (
  label: string,
  action: () => Promise<unknown>,
  matcher: RegExp
): Promise<void> => {
  let threw: unknown;
  try {
    await action();
  } catch (error) {
    threw = error;
  }
  if (!threw) {
    throw new SpawnfileError("runtime_error", `Expected ${label} to fail but it succeeded`);
  }
  const message = threw instanceof Error ? threw.message : String(threw);
  if (!matcher.test(message)) {
    throw new SpawnfileError("runtime_error", `${label} failed with unexpected message: ${message}`);
  }
};

export const runDistributionRoundtripE2E = async (
  options: RunDistributionRoundtripOptions = {}
): Promise<RunDistributionRoundtripResult> => {
  const logger = options.logger ?? { info: (message: string) => console.log(message) };
  const dockerCommand = options.dockerCommand ?? "docker";
  const fixtureDirectory = options.fixtureDirectory ?? DEFAULT_FIXTURE_DIRECTORY;
  const registryPort = options.registryPort ?? 5577;
  const runId = Date.now().toString(36);
  const registryName = `spawnfile-e2e-registry-${runId}`;
  const repo = `localhost:${registryPort}/spawnfile-e2e/distribution-org`;
  const imageRef = `${repo}:1.0.0`;
  const deploymentName = "e2e-roundtrip";
  const containerName = `spawnfile-${deploymentName}`;

  const workRoot = await mkdtemp(path.join(os.tmpdir(), "spawnfile-roundtrip-"));
  const projectDirectory = path.join(workRoot, "project");
  const outputDirectory = path.join(projectDirectory, ".spawn");
  const homeDirectory = path.join(workRoot, "home");
  const previousHome = process.env.SPAWNFILE_HOME;
  process.env.SPAWNFILE_HOME = homeDirectory;

  const cleanup = async (): Promise<void> => {
    await runDocker(dockerCommand, ["rm", "-f", containerName], { allowFailure: true });
    await runDocker(dockerCommand, ["rm", "-f", registryName], { allowFailure: true });
    await runDocker(dockerCommand, ["rmi", "-f", imageRef], { allowFailure: true });
    await runDocker(dockerCommand, ["volume", "rm", "-f", `spawnfile_${deploymentName}_moltnet-store`], {
      allowFailure: true
    });
    if (previousHome === undefined) {
      delete process.env.SPAWNFILE_HOME;
    } else {
      process.env.SPAWNFILE_HOME = previousHome;
    }
    if (!options.keepArtifacts) {
      await removeDirectory(workRoot).catch(() => undefined);
    }
  };

  try {
    logger.info("starting local registry");
    await runDocker(dockerCommand, ["rm", "-f", registryName], { allowFailure: true });
    await runDocker(dockerCommand, [
      "run",
      "-d",
      "--name",
      registryName,
      "-p",
      `${registryPort}:5000`,
      "registry:2"
    ]);

    logger.info("compiling and building the creator image");
    await cp(fixtureDirectory, projectDirectory, { recursive: true });
    const compileExit = await runCli(["compile", projectDirectory, "--out", outputDirectory]);
    if (compileExit !== 0) {
      throw new SpawnfileError("compile_error", `compile exited ${compileExit}`);
    }
    await runDocker(dockerCommand, ["build", "-t", imageRef, outputDirectory]);
    await runDocker(dockerCommand, ["push", imageRef]);

    logger.info("preflight failure leg: missing required secret starts no container");
    await expectThrows(
      "preflight with missing secret",
      () =>
        consumeImageUp(imageRef, {
          authValues: { ANTHROPIC_API_KEY: "sk-test" },
          deploymentName,
          dockerCommand,
          pull: true
        }),
      /DIST_REQUIRED_TOKEN/
    );
    const afterFailure = await runDocker(
      dockerCommand,
      ["ps", "-a", "--filter", `name=${containerName}`, "--format", "{{.Names}}"],
      { allowFailure: true }
    );
    if (afterFailure.trim().length > 0) {
      throw new SpawnfileError("runtime_error", "container exists after a failed preflight");
    }

    logger.info("deploying sourceless from the registry");
    const consumed = await consumeImageUp(imageRef, {
      authProfileName: "e2e",
      authValues: { ANTHROPIC_API_KEY: "sk-test", DIST_REQUIRED_TOKEN: "required-value" },
      deploymentName,
      dockerCommand,
      pull: true
    });
    if (consumed.deploymentName !== deploymentName) {
      throw new SpawnfileError("runtime_error", "unexpected deployment name");
    }

    logger.info("verifying the home-store record and cached report");
    const recordRaw = await readFile(
      path.join(homeDirectory, "deployments", deploymentName, "record.json"),
      "utf8"
    );
    const record = JSON.parse(recordRaw) as {
      source: { kind: string; ref: string };
      units: Array<{ contains: Array<{ kind: string }> }>;
      version: string;
    };
    if (record.version !== "spawnfile.deployment.v2" || record.source.kind !== "image") {
      throw new SpawnfileError("runtime_error", "home record is not a v2 image record");
    }
    const hasNetwork = record.units[0]?.contains.some((entry) => entry.kind === "network");
    if (!hasNetwork) {
      throw new SpawnfileError("runtime_error", "record unit is missing the declared network");
    }
    const cachedReport = await readFile(
      path.join(homeDirectory, "deployments", deploymentName, "spawnfile-report.json"),
      "utf8"
    );
    if (!cachedReport.includes("spawnfile.distribution-report.v1")) {
      throw new SpawnfileError("runtime_error", "cached report missing or wrong version");
    }

    logger.info("verifying the derived volume name is deployment-scoped");
    const volumes = await runDocker(dockerCommand, ["volume", "ls", "--format", "{{.Name}}"]);
    if (!volumes.includes(`spawnfile_${deploymentName}_`)) {
      throw new SpawnfileError("runtime_error", "deployment-scoped volume was not created");
    }

    logger.info("static image status renders the interface");
    const statusLines: string[] = [];
    const statusExit = await runCli(["status", imageRef], {
      stderr: (message) => statusLines.push(message),
      stdout: (message) => statusLines.push(message)
    });
    const statusText = statusLines.join("\n");
    if (statusExit !== 0 || !statusText.includes("DIST_REQUIRED_TOKEN")) {
      throw new SpawnfileError("runtime_error", `static image status did not render interface: ${statusText}`);
    }
    if (statusText.includes("OPENCLAW_GATEWAY_TOKEN")) {
      throw new SpawnfileError("runtime_error", "static status demanded a generated secret");
    }

    logger.info("distribution roundtrip E2E passed");
    return { deploymentName, imageRef };
  } finally {
    await cleanup();
  }
};
