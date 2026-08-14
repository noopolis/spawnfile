import { execFile as execFileCallback } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { lstat, mkdtemp, realpath, symlink } from "node:fs/promises";
import { promisify } from "node:util";

import { compileProject } from "../compiler/index.js";
import {
  ensureDirectory,
  fileExists,
  readUtf8File,
  removeDirectory,
  writeUtf8File
} from "../filesystem/index.js";
import { SpawnfileError } from "../shared/index.js";
import { ensureNoopolisRunId } from "../runtime/index.js";
import { findDaimonRuntimeInstance, resolveDaimonRuntimeRoot } from "./daimonRuntimeInstanceLookup.js";
import {
  applyRuntimePackageOverrides,
  type RuntimePackageOverrides
} from "./runtimePackageOverrides.js";

const execFile = promisify(execFileCallback);

export interface DaimonOrgE2EOptions {
  codexAuthPath?: string;
  fixtureDirectory?: string;
  keepArtifacts?: boolean;
  nodeCommand?: string;
  npmCommand?: string;
  outputDirectory?: string;
  runtimePackageOverrides?: RuntimePackageOverrides;
}

export interface DaimonOrgE2EResult {
  mapperNotePath: string;
  memoryEventCount: number;
  memoryEventsPath: string;
  memoryRecallCount: number;
  outputDirectory: string;
  reviewerNotePath: string;
}

interface CodexAuthFile {
  tokens?: {
    access_token?: string;
    account_id?: string;
    refresh_token?: string;
  };
}

const fixturesRoot = path.resolve(process.cwd(), "test", "fixtures", "e2e", "daimon-org");

const toRootfsPath = (rootfs: string, containerPath: string): string =>
  path.join(rootfs, containerPath.replace(/^\/+/u, ""));

const decodeJwtExpiry = (accessToken: string): number => {
  const payload = accessToken.split(".")[1];
  if (!payload) {
    return Date.now() + 30 * 60 * 1000;
  }

  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      exp?: unknown;
    };
    return typeof decoded.exp === "number"
      ? decoded.exp * 1000
      : Date.now() + 30 * 60 * 1000;
  } catch {
    return Date.now() + 30 * 60 * 1000;
  }
};

const writePiAuth = async (
  rootfs: string,
  homePath: string,
  codexAuthPath: string
): Promise<void> => {
  const codexAuthContent = await readUtf8File(codexAuthPath);
  const codex = JSON.parse(codexAuthContent) as CodexAuthFile;
  const access = codex.tokens?.access_token;
  const refresh = codex.tokens?.refresh_token;
  const accountId = codex.tokens?.account_id;

  if (!access || !refresh || !accountId) {
    throw new SpawnfileError(
      "validation_error",
      `Codex auth file is missing access_token, refresh_token, or account_id: ${codexAuthPath}`
    );
  }

  const authPath = path.join(toRootfsPath(rootfs, homePath), ".pi", "agent", "auth.json");
  await ensureDirectory(path.dirname(authPath));
  await writeUtf8File(
    authPath,
    `${JSON.stringify(
      {
        "openai-codex": {
          access,
          accountId,
          expires: decodeJwtExpiry(access),
          refresh,
          type: "oauth"
        }
      },
      null,
      2
    )}\n`
  );

  const codexCliAuthPath = path.join(toRootfsPath(rootfs, homePath), ".codex", "auth.json");
  await ensureDirectory(path.dirname(codexCliAuthPath));
  await writeUtf8File(codexCliAuthPath, codexAuthContent);
};

const rewriteConfigMemoryPathsForHostE2E = async (
  configPath: string,
  rootfs: string
): Promise<string> => {
  const config = JSON.parse(await readUtf8File(configPath)) as {
    agents?: Array<{ memory?: { runtime_home_path?: string } }>;
  };
  let memoryEventsPath = "";
  for (const agent of config.agents ?? []) {
    const memory = agent.memory;
    if (!memory?.runtime_home_path?.startsWith("/")) {
      continue;
    }
    const containerMemoryPath = memory.runtime_home_path;
    memory.runtime_home_path = toRootfsPath(rootfs, containerMemoryPath);
    memoryEventsPath ||= path.join(memory.runtime_home_path, "memory", "events.jsonl");
  }
  await writeUtf8File(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return memoryEventsPath;
};

const readJsonl = async <T>(filePath: string): Promise<T[]> => {
  const content = await readUtf8File(filePath);
  return content.split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
};

const prepareRootfsResources = async (
  rootfs: string,
  resources: NonNullable<Awaited<ReturnType<typeof compileProject>>["report"]["container"]>["workspace_resources"]
): Promise<void> => {
  for (const resource of resources ?? []) {
    const backingPath = toRootfsPath(rootfs, resource.backing_path);
    const linkPath = toRootfsPath(rootfs, resource.link_path);
    await ensureDirectory(backingPath);
    await ensureDirectory(path.dirname(linkPath));
    if (await fileExists(linkPath)) {
      const stats = await lstat(linkPath);
      if (!stats.isSymbolicLink()) {
        throw new SpawnfileError(
          "runtime_error",
          `Daimon E2E workspace resource path already exists and is not a symlink: ${linkPath}`
        );
      }
      continue;
    }
    await symlink(backingPath, linkPath, "dir");
  }
};

const assertSharedNotes = async (
  rootfs: string,
  workspacePath: string
): Promise<{ mapperNotePath: string; reviewerNotePath: string }> => {
  const workspace = toRootfsPath(rootfs, workspacePath);
  const mapperShared = path.join(workspace, "agents", "mapper", "shared-lab");
  const reviewerShared = path.join(workspace, "agents", "reviewer", "shared-lab");
  const mapperNotePath = path.join(mapperShared, "mapper-note.md");
  const reviewerNotePath = path.join(reviewerShared, "reviewer-note.md");

  for (const notePath of [mapperNotePath, reviewerNotePath]) {
    if (!(await fileExists(notePath))) {
      throw new SpawnfileError(
        "runtime_error",
        `Daimon E2E expected generated note was not created: ${notePath}`
      );
    }
  }

  if ((await realpath(mapperShared)) !== (await realpath(reviewerShared))) {
    throw new SpawnfileError(
      "runtime_error",
      "Daimon E2E expected mapper and reviewer shared-lab links to share one backing directory"
    );
  }

  return { mapperNotePath, reviewerNotePath };
};

/**
 * INTERIM live-model regression check (Slice B), kept intentionally: two
 * real Codex agents actually writing to a shared workspace path (and
 * recording/recalling real Mneme memory) is unfakeable live-model behavior
 * — no fake-engine unit test can stand in for it. This stays in `src/e2e`
 * as-is pending the compose-and-observe pipeline (Spawnfile org + Simfile
 * world, composed and run, observed read-only from `simfile`); see
 * `src/e2e/AGENTS.md`'s Slice A redundancy note for what WAS already
 * redundant here and got deleted (turn causal stamping / trace shape / the
 * turn-trace<->activity-event JOIN / memory-in-prompt / B70 recall-mode) —
 * this file's shared-workspace-write and cross-restart memory persistence
 * proof is not on that list.
 */
export const runDaimonOrgE2E = async (
  options: DaimonOrgE2EOptions = {}
): Promise<DaimonOrgE2EResult> => {
  const outputDirectory =
    options.outputDirectory ?? await mkdtemp(path.join(os.tmpdir(), "spawnfile-daimon-org-"));
  const keepArtifacts = options.keepArtifacts ?? Boolean(options.outputDirectory);

  try {
    const compileResult = await compileProject(options.fixtureDirectory ?? fixturesRoot, {
      outputDirectory
    });
    const container = compileResult.report.container;
    const instance = findDaimonRuntimeInstance(container?.runtime_instances);
    if (!container || !instance || !instance.home_path || !instance.workspace_path) {
      throw new SpawnfileError("runtime_error", "Daimon E2E compile output did not include a generated Daimon instance");
    }

    const rootfs = path.join(outputDirectory, "container", "rootfs");
    const runtimeRoot = await resolveDaimonRuntimeRoot(rootfs);
    const configPath = toRootfsPath(rootfs, instance.config_path);
    await prepareRootfsResources(rootfs, container.workspace_resources);
    await writePiAuth(
      rootfs,
      instance.home_path,
      options.codexAuthPath ?? path.join(os.homedir(), ".codex", "auth.json")
    );
    await applyRuntimePackageOverrides(
      path.join(runtimeRoot, "package.json"),
      options.runtimePackageOverrides
    );
    const memoryEventsPath = await rewriteConfigMemoryPathsForHostE2E(configPath, rootfs);
    await execFile(options.npmCommand ?? "npm", [
      "install",
      "--omit=dev",
      "--no-fund",
      "--no-audit"
    ], {
      cwd: runtimeRoot
    });
    const appArgs = [path.join(runtimeRoot, "app.mjs"), configPath];
    // This harness runs the generated app.mjs directly instead of through
    // spawnfile run/up, so it must stamp NOOPOLIS_RUN_ID itself (like
    // src/e2e/officeSim.ts did) — daimon's resolveRunId throws on a blank
    // value and both runs share one id for a single causal run.
    const appEnv: NodeJS.ProcessEnv = {
      ...process.env,
      SPAWNFILE_PI_RUN_ONCE: "1"
    };
    ensureNoopolisRunId(appEnv);
    await execFile(options.nodeCommand ?? "node", appArgs, { env: appEnv });
    await execFile(options.nodeCommand ?? "node", appArgs, { env: appEnv });

    const notes = await assertSharedNotes(rootfs, instance.workspace_path);
    const memoryEvents = memoryEventsPath ? await readJsonl<{ type?: string }>(memoryEventsPath) : [];
    const memoryRecallCount = memoryEvents.filter((event) => event.type === "memory.recalled").length;
    if (memoryEvents.length === 0 || memoryRecallCount === 0) {
      throw new SpawnfileError(
        "runtime_error",
        "Daimon E2E expected generated app to persist and recall Mneme memories across two runs"
      );
    }

    return {
      ...notes,
      memoryEventCount: memoryEvents.length,
      memoryEventsPath,
      memoryRecallCount,
      outputDirectory
    };
  } finally {
    if (!keepArtifacts) {
      await removeDirectory(outputDirectory);
    }
  }
};
