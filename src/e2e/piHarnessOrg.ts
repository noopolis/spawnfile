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

const execFile = promisify(execFileCallback);

export interface PiHarnessOrgE2EOptions {
  codexAuthPath?: string;
  fixtureDirectory?: string;
  keepArtifacts?: boolean;
  nodeCommand?: string;
  npmCommand?: string;
  outputDirectory?: string;
}

export interface PiHarnessOrgE2EResult {
  mapperNotePath: string;
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

const fixturesRoot = path.resolve(process.cwd(), "fixtures", "e2e", "pi-harness-org");

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
  const codex = JSON.parse(await readUtf8File(codexAuthPath)) as CodexAuthFile;
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
          `Pi E2E workspace resource path already exists and is not a symlink: ${linkPath}`
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
        `Pi E2E expected generated note was not created: ${notePath}`
      );
    }
  }

  if ((await realpath(mapperShared)) !== (await realpath(reviewerShared))) {
    throw new SpawnfileError(
      "runtime_error",
      "Pi E2E expected mapper and reviewer shared-lab links to share one backing directory"
    );
  }

  return { mapperNotePath, reviewerNotePath };
};

export const runPiHarnessOrgE2E = async (
  options: PiHarnessOrgE2EOptions = {}
): Promise<PiHarnessOrgE2EResult> => {
  const outputDirectory =
    options.outputDirectory ?? await mkdtemp(path.join(os.tmpdir(), "spawnfile-pi-harness-org-"));
  const keepArtifacts = options.keepArtifacts ?? Boolean(options.outputDirectory);

  try {
    const compileResult = await compileProject(options.fixtureDirectory ?? fixturesRoot, {
      outputDirectory
    });
    const container = compileResult.report.container;
    const instance = container?.runtime_instances.find((candidate) => candidate.runtime === "pi");
    if (!container || !instance || !instance.home_path || !instance.workspace_path) {
      throw new SpawnfileError("runtime_error", "Pi E2E compile output did not include a Pi runtime instance");
    }

    const rootfs = path.join(outputDirectory, "container", "rootfs");
    const runtimeRoot = toRootfsPath(rootfs, "/opt/spawnfile/runtime-installs/pi");
    await prepareRootfsResources(rootfs, container.workspace_resources);
    await writePiAuth(
      rootfs,
      instance.home_path,
      options.codexAuthPath ?? path.join(os.homedir(), ".codex", "auth.json")
    );
    await execFile(options.npmCommand ?? "npm", [
      "install",
      "--omit=dev",
      "--no-fund",
      "--no-audit"
    ], {
      cwd: runtimeRoot
    });
    await execFile(options.nodeCommand ?? "node", [
      path.join(runtimeRoot, "app.mjs"),
      toRootfsPath(rootfs, instance.config_path)
    ], {
      env: {
        ...process.env,
        SPAWNFILE_PI_RUN_ONCE: "1"
      }
    });

    const notes = await assertSharedNotes(rootfs, instance.workspace_path);

    return {
      ...notes,
      outputDirectory
    };
  } finally {
    if (!keepArtifacts) {
      await removeDirectory(outputDirectory);
    }
  }
};
