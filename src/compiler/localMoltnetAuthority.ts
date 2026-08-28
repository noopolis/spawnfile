import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

import { ensureDirectory, fileExists } from "../filesystem/index.js";
import { SpawnfileError } from "../shared/index.js";
import type { MoltnetTargetArchitecture } from "./moltnetReleaseAuthority.js";

const execFile = promisify(execFileCallback);
const SHA256 = /^[a-f0-9]{64}$/u;

export interface LocalMoltnetReleaseIdentity {
  readonly architecture: MoltnetTargetArchitecture;
  readonly asset: string;
  readonly asset_sha256: `sha256:${string}`;
  readonly capabilities: readonly ["daimon-bridge", "pi-bridge"];
  readonly development: Readonly<{
    mode: "local-development";
    non_production: true;
    unsigned: true;
    unpublished: true;
  }>;
  readonly source_sha256: `sha256:${string}`;
  readonly source_inputs?: Readonly<{ dependencies_sha256: `sha256:${string}`; mode: "source-bundle"; source_sha256: `sha256:${string}`; toolchain: string }>;
  readonly version: "spawnfile.moltnet-release-identity.v1";
}

interface LocalMoltnetReleaseStamp {
  readonly arch: MoltnetTargetArchitecture;
  readonly asset: string;
  readonly capabilities: readonly ["daimon-bridge", "pi-bridge"];
  readonly development: LocalMoltnetReleaseIdentity["development"];
  readonly sha256: string;
  readonly source_sha256: `sha256:${string}`;
  readonly source_inputs?: LocalMoltnetReleaseIdentity["source_inputs"];
  readonly stamp_version: "spawnfile.local-moltnet-release-stamp.v1";
}

const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");

const assetName = (architecture: MoltnetTargetArchitecture): string =>
  `moltnet_linux_${architecture}.tar.gz`;

/** @internal Complete synthetic bridge contract used by local artifact verification. */
export const createLocalMoltnetBridgeProbeConfig = (
  kind: "daimon" | "pi",
  directory: string
): string => JSON.stringify({
  attachments: [{
    agent: { id: `${kind}-capability-probe`, name: `${kind} capability probe` },
    runtime: kind === "daimon"
      ? {
          control_url: "http://127.0.0.1:9",
          kind,
          receipt_store_path: path.join(directory, "daimon-receipts", "daimon-capability-probe.json"),
          token_env: "SPAWNFILE_DAIMON_CONTROL_TOKEN"
        }
      : { control_url: "http://127.0.0.1:9/agents/pi-capability-probe/wake", kind }
  }],
  moltnet: { base_url: "http://127.0.0.1:9", network_id: "capability-probe" },
  version: "moltnet.node.v1"
});

const assertBridgeCapability = async (
  binaryPath: string,
  directory: string,
  kind: "daimon" | "pi"
): Promise<void> => {
  const configPath = path.join(directory, `${kind}-bridge-probe.json`);
  const receiptDirectory = path.join(directory, "daimon-receipts");
  await ensureDirectory(receiptDirectory);
  await chmod(receiptDirectory, 0o700);
  await writeFile(configPath, createLocalMoltnetBridgeProbeConfig(kind, directory), { mode: 0o600 });
  try {
    await execFile(binaryPath, ["node", configPath], {
      env: { ...process.env, SPAWNFILE_DAIMON_CONTROL_TOKEN: "capability-probe" },
      timeout: 1_000
    });
    throw new SpawnfileError("compile_error", `Local Moltnet binary exited before proving its ${kind}-bridge capability`);
  } catch (error) {
    if (error instanceof SpawnfileError) throw error;
    const execution = error as { code?: unknown; killed?: unknown; signal?: unknown; stderr?: unknown; stdout?: unknown };
    const output = `${String(execution.stdout ?? "")}\n${String(execution.stderr ?? "")}`;
    if (/unsupported|only supported|required|invalid|unknown runtime/i.test(output)) {
      throw new SpawnfileError("compile_error", `Local Moltnet binary does not accept ${kind}-bridge configuration`);
    }
    if (execution.killed === true || execution.signal === "SIGTERM" || execution.code === "ETIMEDOUT") return;
    if (/connection refused|connect:|dial tcp|network is unreachable/i.test(output)) return;
    throw new SpawnfileError("compile_error", `Local Moltnet binary could not prove its ${kind}-bridge capability`);
  }
};

/** @internal Strict parser shared with provenance regression tests. */
export const parseLocalReleaseStamp = (
  raw: string,
  architecture: MoltnetTargetArchitecture
): LocalMoltnetReleaseStamp => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SpawnfileError("compile_error", "Local Moltnet release stamp is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SpawnfileError("compile_error", "Local Moltnet release stamp has an invalid shape");
  }
  const value = parsed as Record<string, unknown>;
  const development = value.development as Record<string, unknown> | undefined;
  const sourceInputs = value.source_inputs as Record<string, unknown> | undefined;
  if (!exactKeys(value, ["arch", "asset", "capabilities", "development", "sha256", "source_sha256", "stamp_version", ...(sourceInputs ? ["source_inputs"] : [])])
    || value.stamp_version !== "spawnfile.local-moltnet-release-stamp.v1"
    || value.arch !== architecture
    || value.asset !== assetName(architecture)
    || !Array.isArray(value.capabilities)
    || value.capabilities.join("\0") !== "daimon-bridge\0pi-bridge"
    || !development
    || !exactKeys(development, ["mode", "non_production", "unsigned", "unpublished"])
    || development.mode !== "local-development"
    || development.non_production !== true
    || development.unsigned !== true
    || development.unpublished !== true
    || typeof value.sha256 !== "string"
    || !SHA256.test(value.sha256)
    || typeof value.source_sha256 !== "string"
    || !/^sha256:[a-f0-9]{64}$/u.test(value.source_sha256)
    || (sourceInputs && (!exactKeys(sourceInputs, ["dependencies_sha256", "mode", "source_sha256", "toolchain"]) || sourceInputs.mode !== "source-bundle" || !/^sha256:[a-f0-9]{64}$/u.test(String(sourceInputs.dependencies_sha256)) || sourceInputs.source_sha256 !== value.source_sha256 || sourceInputs.toolchain !== "golang:1.24-bookworm@sha256:1a6d4452c65dea36aac2e2d606b01b4a029ec90cc1ae53890540ce6173ea77ac"))) {
    throw new SpawnfileError("compile_error", "Local Moltnet release stamp must be a complete development-only dual-bridge identity");
  }
  return value as unknown as LocalMoltnetReleaseStamp;
};

const verifyBuiltMoltnetArchive = async (
  releaseAssetPath: string,
  architecture: MoltnetTargetArchitecture,
  hostArchitecture: MoltnetTargetArchitecture
): Promise<void> => {
  const temporaryDirectory = path.join(path.dirname(releaseAssetPath), `.spawnfile-moltnet-verify-${process.pid}-${Date.now()}`);
  try {
    await ensureDirectory(temporaryDirectory);
    await execFile("tar", ["-C", temporaryDirectory, "-xzf", releaseAssetPath]);
    const binaryPath = path.join(temporaryDirectory, "moltnet");
    if (!(await fileExists(binaryPath))) {
      throw new SpawnfileError("compile_error", "Local Moltnet archive does not contain its moltnet binary");
    }
    await chmod(binaryPath, 0o755);
    if (architecture === hostArchitecture) {
      const { stdout } = await execFile(binaryPath, ["version"]); if (!stdout.trim()) throw new SpawnfileError("compile_error", "Local Moltnet binary did not produce a bounded version identity");
      await assertBridgeCapability(binaryPath, temporaryDirectory, "pi"); await assertBridgeCapability(binaryPath, temporaryDirectory, "daimon");
    } else {
      for (const kind of ["pi", "daimon"] as const) {
        const configPath = path.join(temporaryDirectory, `${kind}-docker-probe.json`); await writeFile(configPath, createLocalMoltnetBridgeProbeConfig(kind, "/receipts"));
        const { stdout: rawId } = await execFile("docker", ["create", "--platform", `linux/${architecture}`, "--env", "SPAWNFILE_DAIMON_CONTROL_TOKEN=probe", "node:24-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df", "timeout", "2", "/moltnet", "node", "/config.json"]); const id = rawId.trim();
        try { await execFile("docker", ["cp", binaryPath, `${id}:/moltnet`]); await execFile("docker", ["cp", configPath, `${id}:/config.json`]); try { await execFile("docker", ["start", "--attach", id]); } catch (error) { const result = error as { code?: unknown; stdout?: unknown; stderr?: unknown }; const output = `${String(result.stdout ?? "")}\n${String(result.stderr ?? "")}`; if (result.code !== 124 && !/connection refused|connect:|dial tcp|network is unreachable/iu.test(output)) throw new SpawnfileError("compile_error", `Local Moltnet cross-host ${kind} capability probe failed`); } }
        finally { await execFile("docker", ["rm", "--force", id]); }
      }
    }
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
};

export const readLocalMoltnetReleaseIdentity = async (
  releaseDirectory: string,
  architecture: MoltnetTargetArchitecture,
  hostArchitecture: MoltnetTargetArchitecture
): Promise<LocalMoltnetReleaseIdentity> => {
  const asset = assetName(architecture);
  const assetPath = path.join(releaseDirectory, asset);
  const stampPath = path.join(releaseDirectory, `local_moltnet_release_stamp_${architecture}.json`);
  if (!(await fileExists(assetPath)) || !(await fileExists(stampPath))) {
    throw new SpawnfileError("compile_error", "Local Moltnet release requires its exact archive and development identity stamp");
  }
  const stamp = parseLocalReleaseStamp(await readFile(stampPath, "utf8"), architecture);
  const sha256 = createHash("sha256").update(await readFile(assetPath)).digest("hex");
  if (stamp.sha256 !== sha256) {
    throw new SpawnfileError("compile_error", "Local Moltnet development stamp does not match its archive bytes");
  }
  await verifyBuiltMoltnetArchive(assetPath, architecture, hostArchitecture);
  return Object.freeze({
    architecture,
    asset,
    asset_sha256: `sha256:${sha256}`,
    capabilities: Object.freeze(["daimon-bridge", "pi-bridge"] as const),
    development: Object.freeze({ mode: "local-development", non_production: true, unsigned: true, unpublished: true }),
    source_sha256: stamp.source_sha256,
    ...(stamp.source_inputs ? { source_inputs: Object.freeze(stamp.source_inputs) } : {}),
    version: "spawnfile.moltnet-release-identity.v1"
  });
};
