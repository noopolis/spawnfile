import { spawn } from "node:child_process";
import { stat, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runCli } from "../cli/runCli.js";
import {
  parseDownReceipt,
  parseExportIndex,
  parseUpReceipt,
  type DownReceipt,
  type ExportIndex,
  type UpReceipt
} from "../deployment/index.js";
import { ensureDirectory, removeDirectory } from "../filesystem/index.js";
import { isSpawnfileError, SpawnfileError } from "../shared/index.js";
import {
  createMoltnetHttpClient,
  poll,
  waitForAgents,
  waitForRoom,
  type MoltnetRoomTarget,
  type PollOptions
} from "./moltnetE2ESupport.js";

const runDockerCommand = async (dockerCommand: string, args: string[]): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(dockerCommand, args, { stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${dockerCommand} ${args.join(" ")} failed`))));
  });
};

/**
 * Spawnfile's own lifecycle smoke (Slice B, Piece 5 step 5) — the safety net that keeps
 * spawnfile's e2e coverage off zero once the office-sim monolith (`officeSim.ts`,
 * `autonomousOfficeSim*`) is deleted in step 6. It proves the documented
 * up -> artifacts-export -> down receipt contract end to end against a minimal SCRIPTED
 * fixture (`fixtures/lifecycle-smoke`, no auth): `spawnfile up --json` ->
 * up-receipt fields -> moltnet `/healthz` -> `spawnfile artifacts export --json` ->
 * export-index lists non-empty `raw/{moltnet,mneme,daimon}` files -> `spawnfile down
 * --json` -> a clean receipt. ZERO transcript/turn/behavior assertions (Decision 20 —
 * that lives in `ecosystem/simfile` now): the one seeded mention below is plumbing to
 * guarantee the exported artifacts are genuinely non-empty, not a reported assertion.
 */

const DEFAULT_FIXTURE_DIRECTORY = fileURLToPath(
  new URL("../../fixtures/lifecycle-smoke", import.meta.url)
);
const NETWORK_ID = "smoke_lab";
const ROOM_ID = "smoke-room";
const AGENT_ID = "watcher";
const RAW_AUTHORITIES = ["moltnet", "mneme", "daimon"] as const;

export interface LifecycleSmokeLogger {
  info(message: string): void;
}

export interface RunLifecycleSmokeE2EOptions {
  containerName?: string;
  deploymentName?: string;
  dockerCommand?: string;
  fixtureDirectory?: string;
  imageTag?: string;
  keepArtifacts?: boolean;
  keepImages?: boolean;
  logger?: LifecycleSmokeLogger;
  outputDirectory?: string;
  pollIntervalMs?: number;
  runDirectory?: string;
  timeoutMs?: number;
}

export interface RunLifecycleSmokeE2EResult {
  containerName: string;
  downReceipt: DownReceipt;
  exportIndex: ExportIndex;
  runDirectory: string;
  upReceipt: UpReceipt;
}

const loggerFor = (logger?: LifecycleSmokeLogger): LifecycleSmokeLogger =>
  logger ?? { info: (message) => console.log(message) };

/** Runs one `spawnfile ... --json` command in-process via `runCli` (never a subprocess —
 * per src/e2e/AGENTS.md's "reuse compiler and auth APIs" rule) and parses its single
 * JSON stdout write. */
const runCliJson = async <T>(args: string[], parse: (raw: unknown) => T): Promise<T> => {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const exitCode = await runCli(args, {
    stderr: (message) => stderrChunks.push(message),
    stdout: (message) => stdoutChunks.push(message)
  });
  if (exitCode !== 0) {
    throw new SpawnfileError(
      "runtime_error",
      `spawnfile ${args.join(" ")} exited with code ${exitCode}: ${stderrChunks.join("\n")}`
    );
  }
  return parse(JSON.parse(stdoutChunks.join("\n")));
};

interface ExportCommandJson {
  deployment: string;
  failed_files: string[];
  index: unknown;
  index_path: string;
  missing_optional_files: string[];
}

const assertUpReceipt = (receipt: UpReceipt): void => {
  if (!receipt.fingerprint) {
    throw new SpawnfileError("runtime_error", "up-receipt had no fingerprint");
  }
  if (!receipt.run_id) {
    throw new SpawnfileError("runtime_error", "up-receipt had no run_id");
  }
  if (receipt.compiled_schedule.length === 0) {
    throw new SpawnfileError("runtime_error", "up-receipt had an empty compiled_schedule");
  }
  if (!receipt.readiness.moltnet_base_url) {
    throw new SpawnfileError("runtime_error", "up-receipt had no moltnet_base_url");
  }
  if (!receipt.engines || receipt.engines.length === 0) {
    throw new SpawnfileError("runtime_error", "up-receipt had no engines disclosure");
  }
};

/** Asserts the export-index lists a non-empty file for every raw authority, and that the
 * file genuinely exists on disk with matching size — not just that the index claims so. */
const assertExportedArtifacts = async (
  runDirectory: string,
  exportJson: ExportCommandJson
): Promise<ExportIndex> => {
  if (exportJson.failed_files.length > 0) {
    throw new SpawnfileError(
      "runtime_error",
      `artifacts export reported failed files: ${exportJson.failed_files.join(", ")}`
    );
  }
  const index = parseExportIndex(exportJson.index);
  for (const authority of RAW_AUTHORITIES) {
    const prefix = `raw/${authority}/`;
    const entry = index.files.find((file) => file.path.startsWith(prefix) && file.bytes > 0);
    if (!entry) {
      throw new SpawnfileError(
        "runtime_error",
        `export-index has no non-empty file under ${prefix} (files: ${index.files.map((file) => file.path).join(", ") || "none"})`
      );
    }
    const onDisk = await stat(path.join(runDirectory, entry.path));
    if (onDisk.size !== entry.bytes || onDisk.size === 0) {
      throw new SpawnfileError(
        "runtime_error",
        `exported file ${entry.path} on disk (${onDisk.size} bytes) does not match index (${entry.bytes} bytes)`
      );
    }
  }
  return index;
};

const assertDownReceipt = (receipt: DownReceipt, deploymentName: string): void => {
  if (receipt.deployment !== deploymentName) {
    throw new SpawnfileError("runtime_error", `down-receipt named deployment "${receipt.deployment}", expected "${deploymentName}"`);
  }
  if (receipt.units_stopped.length === 0) {
    throw new SpawnfileError("runtime_error", "down-receipt stopped no units");
  }
  if (receipt.errors.length > 0) {
    throw new SpawnfileError("runtime_error", `down-receipt reported errors: ${receipt.errors.join(", ")}`);
  }
};

/** Seeds exactly ONE mention (the only write this smoke performs — everything else is a
 * read) and waits, read-only, for the watcher's one reply to appear. This is a
 * precondition for non-empty artifacts, never a reported turn/behavior assertion. */
const driveOneRealTurn = async (
  baseUrl: string,
  pollOptions: PollOptions
): Promise<void> => {
  const client = createMoltnetHttpClient();
  const target: MoltnetRoomTarget = {
    baseUrl,
    expectedMembers: [AGENT_ID],
    networkId: NETWORK_ID,
    roomId: ROOM_ID
  };

  await poll("Moltnet health", pollOptions, async () => ((await client.health(baseUrl)) ? true : null));
  await waitForRoom(client, target, pollOptions);
  await waitForAgents(client, target, pollOptions);

  const baseline = await client.listRoomMessages(baseUrl, ROOM_ID, 50);
  const baselineIds = new Set(baseline.map((message) => message.id));

  await client.sendRoomMessage({
    baseUrl,
    from: { id: "operator", name: "Lifecycle Smoke", type: "human" },
    mentions: [AGENT_ID],
    roomId: ROOM_ID,
    text: `@${AGENT_ID} lifecycle smoke ping`
  });

  await poll(`${AGENT_ID} reply`, pollOptions, async () => {
    const messages = await client.listRoomMessages(baseUrl, ROOM_ID, 50);
    return messages.find((message) => message.from.id === AGENT_ID && !baselineIds.has(message.id)) ?? null;
  });
};

export const runLifecycleSmokeE2E = async (
  options: RunLifecycleSmokeE2EOptions = {}
): Promise<RunLifecycleSmokeE2EResult> => {
  const logger = loggerFor(options.logger);
  const fixtureDirectory = options.fixtureDirectory ?? DEFAULT_FIXTURE_DIRECTORY;
  const dockerCommand = options.dockerCommand ?? "docker";
  const containerName = options.containerName ?? "spawnfile-e2e-lifecycle-smoke";
  const deploymentName = options.deploymentName ?? "spawnfile-e2e-lifecycle-smoke";
  const imageTag = options.imageTag ?? `spawnfile-e2e-lifecycle-smoke-${Date.now()}`;
  const root = await mkdtemp(path.join(os.tmpdir(), "spawnfile-e2e-lifecycle-smoke-"));
  const outputDirectory = options.outputDirectory ?? path.join(root, "dist");
  const runDirectory = options.runDirectory ?? path.join(root, "run");
  await ensureDirectory(runDirectory);
  const pollOptions: PollOptions = {
    intervalMs: options.pollIntervalMs ?? 2_000,
    sleep: (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
    timeoutMs: options.timeoutMs ?? 120_000
  };

  const dockerCommandArgs = dockerCommand === "docker" ? [] : ["--docker-command", dockerCommand];
  let upReceipt: UpReceipt | undefined;

  try {
    logger.info("lifecycle-smoke: spawnfile up --json");
    upReceipt = await runCliJson(
      [
        "up", fixtureDirectory,
        "--json",
        "--detach",
        "--name", containerName,
        "--deployment", deploymentName,
        "--out", outputDirectory,
        "--tag", imageTag,
        ...dockerCommandArgs
      ],
      parseUpReceipt
    );
    assertUpReceipt(upReceipt);

    logger.info("lifecycle-smoke: waiting for moltnet + driving one real turn");
    await driveOneRealTurn(upReceipt.readiness.moltnet_base_url as string, pollOptions);

    logger.info("lifecycle-smoke: spawnfile artifacts export --json");
    const exportJson = await runCliJson(
      [
        "artifacts", "export", fixtureDirectory,
        "--out", runDirectory,
        "--deployment", deploymentName,
        "--compiled", outputDirectory,
        "--json",
        ...dockerCommandArgs
      ],
      (raw) => raw as ExportCommandJson
    );
    const exportIndex = await assertExportedArtifacts(runDirectory, exportJson);

    logger.info("lifecycle-smoke: spawnfile down --json");
    const downReceipt = await runCliJson(
      [
        "down", fixtureDirectory,
        "--deployment", deploymentName,
        "--compiled", outputDirectory,
        "--volumes",
        "--json",
        ...dockerCommandArgs
      ],
      parseDownReceipt
    );
    assertDownReceipt(downReceipt, deploymentName);

    return { containerName, downReceipt, exportIndex, runDirectory, upReceipt };
  } catch (error) {
    // Best-effort teardown so a failed smoke never leaks a live container/volumes.
    await runCliJson(
      [
        "down", fixtureDirectory,
        "--deployment", deploymentName,
        "--compiled", outputDirectory,
        "--volumes",
        "--force",
        "--json",
        ...dockerCommandArgs
      ],
      (raw) => raw
    ).catch(() => undefined);
    const message = error instanceof Error ? error.message : String(error);
    throw new SpawnfileError(isSpawnfileError(error) ? error.code : "runtime_error", message);
  } finally {
    if (!options.keepImages) {
      await runDockerCommand(dockerCommand, ["image", "rm", "-f", imageTag]).catch(() => undefined);
    }
    if (!options.keepArtifacts) {
      await removeDirectory(root);
    }
  }
};
