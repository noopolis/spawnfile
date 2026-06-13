import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import type { ResolvedAuthProfile } from "../auth/index.js";
import { removeDirectory } from "../filesystem/index.js";

import { buildDistributionReport } from "./buildDistributionReport.js";
import { prepareImageRuntimeAuthMounts } from "./imageRuntimeAuth.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((dir) => removeDirectory(dir)));
});

const tempDir = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "spawnfile-img-auth-"));
  temporaryDirectories.push(dir);
  return dir;
};

const claudeImportDir = async (): Promise<string> => {
  const dir = await tempDir();
  const importDir = path.join(dir, ".claude");
  await mkdir(importDir, { recursive: true });
  await writeFile(
    path.join(importDir, ".credentials.json"),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: "claude-access",
        expiresAt: 1_800_000_000_000,
        refreshToken: "claude-refresh"
      }
    })
  );
  return importDir;
};

const report = () =>
  buildDistributionReport({
    envVariables: [],
    generatedAt: "2026-06-13T00:00:00.000Z",
    internalPorts: [],
    modelAuthMethods: { anthropic: "claude-code" },
    moltnetNetworks: [],
    organization: {
      agents: [{ id: "agent:assistant", name: "assistant", runtime: "openclaw", teams: [] }],
      project: "org",
      teams: []
    },
    persistentMounts: [],
    portMappings: [],
    publishedPorts: [],
    resources: [],
    runtimeInstances: [
      {
        config_path: "/var/lib/spawnfile/instances/openclaw/agent-assistant/home/.openclaw/openclaw.json",
        home_path: "/var/lib/spawnfile/instances/openclaw/agent-assistant/home",
        id: "agent-assistant",
        internal_port: null,
        model_auth_methods: { anthropic: "claude-code" },
        model_secrets_required: [],
        node_ids: ["agent:assistant"],
        published_port: null,
        runtime: "openclaw",
        workspace_path: "/w"
      }
    ]
  });

describe("prepareImageRuntimeAuthMounts", () => {
  it("mounts the credential profile and the import directory into the runtime home", async () => {
    const importDir = await claudeImportDir();
    const profile: ResolvedAuthProfile = {
      authHome: "/auth",
      env: {},
      imports: { "claude-code": { kind: "claude-code", path: importDir } },
      name: "me",
      profileDirectory: "/auth/me",
      profilePath: "/auth/me/profile.json",
      version: 1
    };
    const result = await prepareImageRuntimeAuthMounts({
      authProfile: profile,
      report: report(),
      tempRoot: await tempDir()
    });

    const home = "/var/lib/spawnfile/instances/openclaw/agent-assistant/home";
    expect(result.coveredModelSecrets.has("ANTHROPIC_API_KEY")).toBe(true);
    expect(result.mountArgs.some((arg) => arg.endsWith(`:${home}/.openclaw/agents/main/agent/auth-profiles.json`))).toBe(true);
    expect(result.mountArgs).toContain(`${importDir}:${home}/.claude`);
  });

  it("produces no mounts when the profile has no matching import", async () => {
    const profile: ResolvedAuthProfile = {
      authHome: "/auth",
      env: {},
      imports: {},
      name: "me",
      profileDirectory: "/auth/me",
      profilePath: "/auth/me/profile.json",
      version: 1
    };
    const result = await prepareImageRuntimeAuthMounts({
      authProfile: profile,
      report: report(),
      tempRoot: await tempDir()
    });
    expect(result.mountArgs).toHaveLength(0);
  });
});
