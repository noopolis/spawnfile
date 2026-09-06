import os from "node:os";
import path from "node:path";
import { chmod, lstat, mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";

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

const codexImportDir = async (): Promise<string> => {
  const dir = await tempDir();
  const importDir = path.join(dir, ".codex");
  await mkdir(importDir, { recursive: true });
  await writeFile(
    path.join(importDir, "auth.json"),
    JSON.stringify({
      tokens: {
        access_token: "codex-access",
        account_id: "acct",
        refresh_token: "codex-refresh"
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

const codexReport = () =>
  buildDistributionReport({
    envVariables: [],
    generatedAt: "2026-06-13T00:00:00.000Z",
    internalPorts: [],
    modelAuthMethods: { openai: "codex" },
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
        model_auth_methods: { openai: "codex" },
        model_secrets_required: [],
        node_ids: ["agent:assistant"],
        published_port: null,
        runtime: "openclaw",
        workspace_path: "/w"
      }
    ]
  });

const daimonReport = () => buildDistributionReport({
  envVariables: [], generatedAt: "2026-08-26T00:00:00.000Z", internalPorts: [],
  modelAuthMethods: {}, moltnetNetworks: [],
  organization: { agents: [
    { id: "agent:coder", name: "coder", runtime: "daimon", teams: [] },
    { id: "agent:reviewer", name: "reviewer", runtime: "daimon", teams: [] }
  ], project: "org", teams: [] },
  persistentMounts: [], portMappings: [], publishedPorts: [], resources: [],
  runtimeInstances: [{
    config_path: "/var/lib/spawnfile/instances/daimon/daimon-organization/daimon/daimon-organization-runtime.json",
    engine_by_node_id: { "agent:coder": "codex", "agent:reviewer": "grok" },
    home_path: null, id: "daimon-organization", internal_port: null,
    model_auth_methods: {}, model_secrets_required: [],
    node_ids: ["agent:coder", "agent:reviewer"], published_port: null,
    runtime: "daimon", workspace_path: "/var/lib/spawnfile/instances/daimon/daimon-organization/workspace"
  }]
});

const callerUid = (): number => {
  const uid = process.getuid?.();
  if (typeof uid !== "number") throw new Error("this suite requires a POSIX uid");
  return uid;
};

const directDaimonSources = async () => {
  const root = await tempDir(), codex = path.join(root, "codex.json"), grok = path.join(root, "grok.json");
  await writeFile(codex, JSON.stringify({ tokens: { access_token: "fake-access", refresh_token: "fake-refresh" } }), { mode: 0o600 });
  await writeFile(grok, JSON.stringify({ "https://auth.x.ai::fixture": { key: "a".repeat(32), refresh_token: "r".repeat(16), expires_at: "2099-01-01T00:00:00.000Z" } }), { mode: 0o600 });
  return { codex, grok, environment: { SPAWNFILE_DAIMON_SOURCE_CODEX_AUTH: codex, SPAWNFILE_DAIMON_SOURCE_GROK_AUTH: grok } };
};

describe("prepareImageRuntimeAuthMounts", () => {
  it("mounts direct Daimon provider sources from an embedded engine map without an auth profile", async () => {
    const sources = await directDaimonSources();
    const result = await prepareImageRuntimeAuthMounts({
      authProfile: null, daimonContainerCredentialUid: callerUid(),
      report: daimonReport(), sourceEnvironment: sources.environment,
      tempRoot: await tempDir()
    });
    expect(result.mountArgs).toContain(`${sources.codex}:/var/lib/spawnfile/instances/daimon/daimon-organization/runtime-homes/coder/.daimon-inbound/codex-auth:ro`);
    expect(result.mountArgs).toContain(`${sources.grok}:/var/lib/spawnfile/daimon/grok-bootstrap-auth:ro`);
  });

  it("fails closed on missing, permissive, or linked direct Daimon sources", async () => {
    const sources = await directDaimonSources();
    const uid = callerUid();
    await expect(prepareImageRuntimeAuthMounts({
      authProfile: null, daimonContainerCredentialUid: uid, report: daimonReport(),
      sourceEnvironment: { ...sources.environment, SPAWNFILE_DAIMON_SOURCE_GROK_AUTH: path.join(await tempDir(), "missing") },
      tempRoot: await tempDir()
    })).rejects.toThrow(/missing the selected grok artifact/u);
    await chmod(sources.grok, 0o644);
    await expect(prepareImageRuntimeAuthMounts({ authProfile: null, daimonContainerCredentialUid: uid, report: daimonReport(), sourceEnvironment: sources.environment, tempRoot: await tempDir() })).rejects.toThrow(/caller-owned 0600 regular file/u);
    await chmod(sources.grok, 0o600);
    const linked = path.join(await tempDir(), "linked.json"); await symlink(sources.grok, linked);
    await expect(prepareImageRuntimeAuthMounts({ authProfile: null, daimonContainerCredentialUid: uid, report: daimonReport(), sourceEnvironment: { ...sources.environment, SPAWNFILE_DAIMON_SOURCE_GROK_AUTH: linked }, tempRoot: await tempDir() })).rejects.toThrow(/caller-owned 0600 regular file/u);
  });

  it("refuses a Daimon image credential the container cannot own, naming both uids", async () => {
    // No daimonContainerCredentialUid override: the real deploy default, which
    // is what an operator whose account is not uid 2000 actually hits.
    const sources = await directDaimonSources();
    const observed = callerUid();
    expect(observed).not.toBe(2_000);
    await expect(prepareImageRuntimeAuthMounts({
      authProfile: null, report: daimonReport(), sourceEnvironment: sources.environment,
      tempRoot: await tempDir()
    })).rejects.toThrow(
      new RegExp(`codex artifact is owned by uid ${observed} but the Daimon container reads it as uid 2000`, "u")
    );
  });

  it("bind-mounts a correctly owned Daimon credential without copying it", async () => {
    const sources = await directDaimonSources();
    const before = await lstat(sources.codex);
    const result = await prepareImageRuntimeAuthMounts({
      authProfile: null, daimonContainerCredentialUid: callerUid(),
      report: daimonReport(), sourceEnvironment: sources.environment,
      tempRoot: await tempDir()
    });
    expect(result.mountArgs).toContain(`${sources.codex}:/var/lib/spawnfile/instances/daimon/daimon-organization/runtime-homes/coder/.daimon-inbound/codex-auth:ro`);
    const after = await lstat(sources.codex);
    expect([after.ino, after.uid, after.mode & 0o777, after.nlink])
      .toEqual([before.ino, before.uid, 0o600, 1]);
  });

  it("does not prepare unrelated runtimes when no auth profile is selected", async () => {
    const result = await prepareImageRuntimeAuthMounts({ authProfile: null, report: report(), tempRoot: await tempDir() });
    expect(result.mountArgs).toEqual([]);
  });

  it("rejects a Daimon engine map that is incomplete or invalid for Daimon", async () => {
    const sources = await directDaimonSources(), incomplete = daimonReport();
    incomplete.runtime_instances[0]!.engine_by_node_id = { "agent:coder": "codex" };
    await expect(prepareImageRuntimeAuthMounts({ authProfile: null, report: incomplete, sourceEnvironment: sources.environment, tempRoot: await tempDir() })).rejects.toThrow(/does not match its declared agents/u);
    const invalid = daimonReport(); invalid.runtime_instances[0]!.engine_by_node_id!["agent:reviewer"] = "scripted";
    await expect(prepareImageRuntimeAuthMounts({ authProfile: null, report: invalid, sourceEnvironment: sources.environment, tempRoot: await tempDir() })).rejects.toThrow(/unsupported engine/u);
  });

  it("rejects redirected Daimon paths and cross-engine slug collisions", async () => {
    const sources = await directDaimonSources();
    for (const field of ["config_path", "workspace_path"] as const) {
      const redirected = daimonReport(); redirected.runtime_instances[0]![field] = `/tmp/${field}`;
      await expect(prepareImageRuntimeAuthMounts({ authProfile: null, report: redirected, sourceEnvironment: sources.environment, tempRoot: await tempDir() })).rejects.toThrow(/paths are not canonical/u);
    }
    const collision = daimonReport();
    collision.runtime_instances[0]!.node_ids = ["agent:review er", "agent:review-er"];
    collision.runtime_instances[0]!.engine_by_node_id = { "agent:review er": "codex", "agent:review-er": "grok" };
    await expect(prepareImageRuntimeAuthMounts({ authProfile: null, report: collision, sourceEnvironment: sources.environment, tempRoot: await tempDir() })).rejects.toThrow(/unsafe agent id/u);
  });

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

  it("mounts imported Codex auth into runtime homes", async () => {
    const importDir = await codexImportDir();
    const profile: ResolvedAuthProfile = {
      authHome: "/auth",
      env: {},
      imports: { codex: { kind: "codex", path: importDir } },
      name: "me",
      profileDirectory: "/auth/me",
      profilePath: "/auth/me/profile.json",
      version: 1
    };
    const result = await prepareImageRuntimeAuthMounts({
      authProfile: profile,
      report: codexReport(),
      tempRoot: await tempDir()
    });

    const home = "/var/lib/spawnfile/instances/openclaw/agent-assistant/home";
    expect(result.coveredModelSecrets.has("OPENAI_API_KEY")).toBe(true);
    expect(result.mountArgs).toContain(`${importDir}:${home}/.codex`);
  });

  it("throws when an imported auth path does not exist", async () => {
    const profile: ResolvedAuthProfile = {
      authHome: "/auth",
      env: {},
      imports: { "claude-code": { kind: "claude-code", path: "/no/such/import/dir" } },
      name: "me",
      profileDirectory: "/auth/me",
      profilePath: "/auth/me/profile.json",
      version: 1
    };
    await expect(
      prepareImageRuntimeAuthMounts({
        authProfile: profile,
        report: report(),
        tempRoot: await tempDir()
      })
    ).rejects.toThrow(/Imported auth path for claude-code does not exist/);
  });

  it("throws when the imported directory exists but holds no usable credential", async () => {
    // A registered import whose credential file is absent/expired would otherwise
    // mount cleanly and produce a container that cannot authenticate.
    const emptyImport = await tempDir();
    const profile: ResolvedAuthProfile = {
      authHome: "/auth",
      env: {},
      imports: { "claude-code": { kind: "claude-code", path: emptyImport } },
      name: "me",
      profileDirectory: "/auth/me",
      profilePath: "/auth/me/profile.json",
      version: 1
    };
    await expect(
      prepareImageRuntimeAuthMounts({
        authProfile: profile,
        report: report(),
        tempRoot: await tempDir()
      })
    ).rejects.toThrow(/no usable credential/);
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
