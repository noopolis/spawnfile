import { chmod, lstat, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { removeDirectory } from "../../filesystem/index.js";
import { DAIMON_ORGANIZATION_UID } from "./runtimeIdentity.js";
import {
  assertDaimonCredentialContainerOwner,
  DAIMON_CREDENTIAL_CONTAINER_UID,
  isUnsafeDaimonSourceFile,
  prepareDaimonRuntimeAuth
} from "./runAuth.js";

const temporaryDirectories: string[] = [];
const originalCodexHome = process.env.CODEX_HOME;
const originalGrokHome = process.env.GROK_HOME;
const codexCredential = () => JSON.stringify({ tokens: { access_token: "test-access", refresh_token: "test-refresh" } });
const grokCredential = (accessLength = 32, refreshLength = 16) => JSON.stringify({ "https://auth.x.ai::test": { key: "a".repeat(accessLength), refresh_token: "r".repeat(refreshLength), expires_at: "2099-01-01T00:00:00.000Z" } });
const createTempDirectory = async (prefix: string): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
};
const writeConfig = async (outputDirectory: string, home: string): Promise<string> => {
  const configPath = "/var/lib/spawnfile/instances/daimon/daimon-organization/daimon/config.json";
  const hostPath = path.join(outputDirectory, "container", "rootfs", `.${configPath}`);
  await mkdir(path.dirname(hostPath), { recursive: true });
  await writeFile(hostPath, JSON.stringify({
    agents: [{ engine: { kind: "codex" }, id: "agent:codex", runtimeHomePath: home }],
    host: {},
    version: "noopolis.daimon.organization-runtime.v1"
  }));
  return configPath;
};
const writeConfigSource = async (
  outputDirectory: string,
  source: string,
  configPath = "/var/lib/spawnfile/instances/daimon/daimon-organization/daimon/config.json"
): Promise<string> => {
  const hostPath = path.join(outputDirectory, "container", "rootfs", `.${configPath}`);
  await mkdir(path.dirname(hostPath), { recursive: true });
  await writeFile(hostPath, source);
  return configPath;
};
const callerUid = (): number => {
  const uid = process.getuid?.();
  if (typeof uid !== "number") throw new Error("this suite requires a POSIX uid");
  return uid;
};
const prepare = (
  outputDirectory: string,
  tempRoot: string,
  configPath: string,
  containerCredentialUid: number = callerUid()
) =>
  prepareDaimonRuntimeAuth({
    authProfile: null,
    env: {},
    instance: { config_path: configPath, home_path: null, id: "daimon-organization", model_auth_methods: {}, model_secrets_required: [], runtime: "daimon" },
    outputDirectory,
    tempRoot
  }, containerCredentialUid);

afterEach(async () => {
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  if (originalGrokHome === undefined) delete process.env.GROK_HOME;
  else process.env.GROK_HOME = originalGrokHome;
  delete process.env.SPAWNFILE_DAIMON_SOURCE_CODEX_AUTH;
  delete process.env.SPAWNFILE_DAIMON_SOURCE_GROK_AUTH;
  delete process.env.SPAWNFILE_DAIMON_SOURCE_AGY_UNLOCK_SECRET;
  delete process.env.SPAWNFILE_DAIMON_SOURCE_UNKNOWN;
  await Promise.all(temporaryDirectories.splice(0).map(removeDirectory));
});

describe("prepareDaimonRuntimeAuth", () => {
  it("binds only one selected 0600 credential leaf without materializing it", async () => {
    const outputDirectory = await createTempDirectory("spawnfile-daimon-output-");
    const tempRoot = await createTempDirectory("spawnfile-daimon-auth-");
    const codexHome = await createTempDirectory("spawnfile-daimon-codex-");
    process.env.CODEX_HOME = codexHome;
    await writeFile(path.join(codexHome, "auth.json"), codexCredential());
    await chmod(path.join(codexHome, "auth.json"), 0o600);
    const home = "/var/lib/spawnfile/instances/daimon/daimon-organization/runtime-homes/codex";
    const configPath = await writeConfig(outputDirectory, home);
    const prepared = await prepare(outputDirectory, tempRoot, configPath);
    const mount = prepared.mountArgs[1]!;
    const source = path.join(codexHome, "auth.json");
    expect(mount).toBe(`${source}:${home}/.daimon-inbound/codex-auth:ro`);
    expect(prepared.launchIdentity).toBeUndefined();
    expect(prepared.mountArgs.join("\n")).not.toContain(tempRoot);
    expect((await lstat(path.join(outputDirectory, "container", "rootfs", `.${home}`, ".daimon-inbound"))).mode & 0o777)
      .toBe(0o700);
  });

  it("accepts the declared native Codex refresh credential variants", async () => {
    for (const nativeCredential of [
      { accessToken: "test-access", refreshToken: "test-refresh" },
      { token: "test-access", refreshToken: "test-refresh" }
    ]) {
      const outputDirectory = await createTempDirectory("spawnfile-daimon-output-");
      const tempRoot = await createTempDirectory("spawnfile-daimon-auth-");
      const codexHome = await createTempDirectory("spawnfile-daimon-codex-");
      process.env.CODEX_HOME = codexHome;
      await writeFile(path.join(codexHome, "auth.json"), JSON.stringify(nativeCredential), { mode: 0o600 });
      await chmod(path.join(codexHome, "auth.json"), 0o600);
      const configPath = await writeConfig(
        outputDirectory,
        "/var/lib/spawnfile/instances/daimon/daimon-organization/runtime-homes/codex"
      );
      await expect(prepare(outputDirectory, tempRoot, configPath)).resolves.toMatchObject({
        mountArgs: ["-v", expect.stringContaining("/.daimon-inbound/codex-auth:ro")]
      });
    }
  });

  it("rejects an insecure caller-provided credential source", async () => {
    const outputDirectory = await createTempDirectory("spawnfile-daimon-output-");
    const tempRoot = await createTempDirectory("spawnfile-daimon-auth-");
    const codexHome = await createTempDirectory("spawnfile-daimon-codex-");
    process.env.CODEX_HOME = codexHome;
    await writeFile(path.join(codexHome, "auth.json"), "token\n");
    const configPath = await writeConfig(
      outputDirectory,
      "/var/lib/spawnfile/instances/daimon/daimon-organization/runtime-homes/codex"
    );
    await expect(prepareDaimonRuntimeAuth({
      authProfile: null,
      env: {},
      instance: { config_path: configPath, home_path: null, id: "daimon-organization", model_auth_methods: {}, model_secrets_required: [], runtime: "daimon" },
      outputDirectory,
      tempRoot
    })).rejects.toThrow(/0600/u);
  });

  it("binds portable leaves plus one independent AGY realm unlock source", async () => {
    const outputDirectory = await createTempDirectory("spawnfile-daimon-output-");
    const tempRoot = await createTempDirectory("spawnfile-daimon-auth-");
    const credentials = await Promise.all(["codex", "grok"].map(async (engine) => {
      const home = await createTempDirectory(`spawnfile-daimon-${engine}-`);
      const file = "auth.json";
      await writeFile(path.join(home, file), engine === "grok" ? grokCredential() : codexCredential());
      await chmod(path.join(home, file), 0o600);
      return { engine, file, home };
    }));
    process.env.SPAWNFILE_DAIMON_SOURCE_CODEX_AUTH = path.join(
      credentials[0]!.home,
      credentials[0]!.file
    );
    process.env.SPAWNFILE_DAIMON_SOURCE_GROK_AUTH = path.join(
      credentials[1]!.home,
      credentials[1]!.file
    );
    const unlock = path.join(outputDirectory, "agy-unlock");
    await writeFile(unlock, "opaque-unlock");
    await chmod(unlock, 0o600);
    process.env.SPAWNFILE_DAIMON_SOURCE_AGY_UNLOCK_SECRET = unlock;
    const configPath = "/var/lib/spawnfile/instances/daimon/daimon-organization/daimon/config.json";
    const hostPath = path.join(outputDirectory, "container", "rootfs", `.${configPath}`);
    await mkdir(path.dirname(hostPath), { recursive: true });
    await writeFile(hostPath, JSON.stringify({
      agents: [...credentials.map((credential) => ({
        engine: { kind: credential.engine },
        id: `agent:${credential.engine}`,
        runtimeHomePath: `/var/lib/spawnfile/instances/daimon/daimon-organization/runtime-homes/${credential.engine}`,
        schedule: { kind: "every", interval_ms: 60_000, prompt: "scheduled work" }
      })), {
        engine: { kind: "grok" },
        id: "agent:grok-two",
        runtimeHomePath: "/var/lib/spawnfile/instances/daimon/daimon-organization/runtime-homes/grok-two",
        schedule: { kind: "disabled" }
      }, {
        engine: { kind: "agy" },
        id: "agent:agy",
        runtimeHomePath: "/var/lib/spawnfile/instances/daimon/daimon-organization/runtime-homes/agy",
        schedule: { kind: "disabled" }
      }],
      host: {}, version: "noopolis.daimon.organization-runtime.v2"
    }));

    const prepared = await prepare(outputDirectory, tempRoot, configPath);

    expect(prepared.mountArgs).toEqual([
      "-v",
      `${path.join(credentials[0]!.home, credentials[0]!.file)}:/var/lib/spawnfile/instances/daimon/daimon-organization/runtime-homes/codex/.daimon-inbound/codex-auth:ro`,
      "-v",
      `${path.join(credentials[1]!.home, credentials[1]!.file)}:/var/lib/spawnfile/daimon/grok-bootstrap-auth:ro`,
      "-v",
      `${unlock}:/var/lib/spawnfile/daimon/agy-unlock-secret:ro`
    ]);
    expect(prepared.launchIdentity).toBeUndefined();
    expect(prepared.mountArgs.join("\n")).not.toContain("antigravity-oauth-token");
  });

  it("fails closed when an AGY organization has no unlock source", async () => {
    const outputDirectory = await createTempDirectory("spawnfile-daimon-output-");
    const tempRoot = await createTempDirectory("spawnfile-daimon-auth-");
    const configPath = "/var/lib/spawnfile/instances/daimon/daimon-organization/daimon/config.json";
    const hostPath = path.join(outputDirectory, "container", "rootfs", `.${configPath}`);
    await mkdir(path.dirname(hostPath), { recursive: true });
    await writeFile(hostPath, JSON.stringify({
      agents: [{
        engine: { kind: "agy" },
        id: "agent:agy",
        runtimeHomePath: "/var/lib/spawnfile/instances/daimon/daimon-organization/runtime-homes/agy"
      }],
      host: {},
      version: "noopolis.daimon.organization-runtime.v1"
    }));

    await expect(prepareDaimonRuntimeAuth({
      authProfile: null,
      env: {},
      instance: { config_path: configPath, home_path: null, id: "daimon-organization", model_auth_methods: {}, model_secrets_required: [], runtime: "daimon" },
      outputDirectory,
      tempRoot
    })).rejects.toThrow(/AGY realm unlock/u);
  });

  it("fails before staging a later runtime-home traversal", async () => {
    const outputDirectory = await createTempDirectory("spawnfile-daimon-output-");
    const tempRoot = await createTempDirectory("spawnfile-daimon-auth-");
    const configPath = await writeConfig(
      outputDirectory,
      "/var/lib/spawnfile/instances/daimon/daimon-organization/runtime-homes/a/../../../../escape"
    );
    await expect(prepareDaimonRuntimeAuth({
      authProfile: null,
      env: {},
      instance: { config_path: configPath, home_path: null, id: "daimon-organization", model_auth_methods: {}, model_secrets_required: [], runtime: "daimon" },
      outputDirectory,
      tempRoot
    })).rejects.toThrow(/escapes/u);
  });

  it("accepts an auth-free organization and resolves Grok from its native home", async () => {
    const outputDirectory = await createTempDirectory("spawnfile-daimon-output-");
    const tempRoot = await createTempDirectory("spawnfile-daimon-auth-");
    const emptyConfig = await writeConfigSource(outputDirectory, JSON.stringify({
      agents: [], host: {}, version: "noopolis.daimon.organization-runtime.v1"
    }));
    await expect(prepare(outputDirectory, tempRoot, emptyConfig)).resolves.toEqual({
      coveredModelSecrets: [], mountArgs: []
    });

    const grokHome = await createTempDirectory("spawnfile-daimon-grok-home-");
    process.env.GROK_HOME = grokHome;
    await writeFile(path.join(grokHome, "auth.json"), grokCredential());
    await chmod(path.join(grokHome, "auth.json"), 0o600);
    const grokConfig = await writeConfigSource(outputDirectory, JSON.stringify({
      agents: [{
        engine: { kind: "grok" }, id: "agent:grok",
        runtimeHomePath: "/var/lib/spawnfile/instances/daimon/daimon-organization/runtime-homes/grok"
      }],
      host: {}, version: "noopolis.daimon.organization-runtime.v1"
    }));
    await expect(prepare(outputDirectory, tempRoot, grokConfig)).resolves.toMatchObject({
      mountArgs: ["-v", expect.stringContaining(":/var/lib/spawnfile/daimon/grok-bootstrap-auth:ro")]
    });
  });

  it("rejects an empty Grok placeholder before Docker launch without reflecting credential bytes", async () => {
    const outputDirectory = await createTempDirectory("spawnfile-daimon-output-");
    const tempRoot = await createTempDirectory("spawnfile-daimon-auth-");
    const grokHome = await createTempDirectory("spawnfile-daimon-grok-home-");
    process.env.GROK_HOME = grokHome;
    await writeFile(path.join(grokHome, "auth.json"), "{}", { mode: 0o600 });
    await chmod(path.join(grokHome, "auth.json"), 0o600);
    const configPath = await writeConfigSource(outputDirectory, JSON.stringify({
      agents: [{ engine: { kind: "grok" }, id: "agent:grok", runtimeHomePath: "/var/lib/spawnfile/instances/daimon/daimon-organization/runtime-homes/grok" }],
      host: {}, version: "noopolis.daimon.organization-runtime.v1"
    }));
    await expect(prepare(outputDirectory, tempRoot, configPath)).rejects.toThrow(/refreshable subscription credential/u);
  });

  it("matches the broker credential token-length boundary", async () => {
    const outputDirectory = await createTempDirectory("spawnfile-daimon-output-");
    const tempRoot = await createTempDirectory("spawnfile-daimon-auth-");
    const grokHome = await createTempDirectory("spawnfile-daimon-grok-home-");
    process.env.GROK_HOME = grokHome;
    const configPath = await writeConfigSource(outputDirectory, JSON.stringify({
      agents: [{ engine: { kind: "grok" }, id: "agent:grok", runtimeHomePath: "/var/lib/spawnfile/instances/daimon/daimon-organization/runtime-homes/grok" }],
      host: {}, version: "noopolis.daimon.organization-runtime.v1"
    }));
    for (const [access, refresh, accepted] of [[31, 16, false], [32, 15, false], [32, 16, true]] as const) {
      await writeFile(path.join(grokHome, "auth.json"), grokCredential(access, refresh), { mode: 0o600 });
      const result = prepare(outputDirectory, tempRoot, configPath);
      if (accepted) await expect(result).resolves.toBeDefined();
      else await expect(result).rejects.toThrow(/refreshable subscription credential/u);
    }
  });

  it("redacts rejected Grok credential contents", async () => {
    const outputDirectory = await createTempDirectory("spawnfile-daimon-output-");
    const tempRoot = await createTempDirectory("spawnfile-daimon-auth-");
    const grokHome = await createTempDirectory("spawnfile-daimon-grok-home-");
    process.env.GROK_HOME = grokHome;
    await writeFile(path.join(grokHome, "auth.json"), "secret-grok-canary", { mode: 0o600 });
    await chmod(path.join(grokHome, "auth.json"), 0o600);
    const configPath = await writeConfigSource(outputDirectory, JSON.stringify({
      agents: [{ engine: { kind: "grok" }, id: "agent:grok", runtimeHomePath: "/var/lib/spawnfile/instances/daimon/daimon-organization/runtime-homes/grok" }],
      host: {}, version: "noopolis.daimon.organization-runtime.v1"
    }));
    try {
      await prepare(outputDirectory, tempRoot, configPath);
      expect.fail("expected invalid credential rejection");
    } catch (error) {
      expect((error as Error).message).toMatch(/refreshable subscription credential/u);
      expect((error as Error).message).not.toContain("secret-grok-canary");
    }
  });

  it("rejects undeclared source slots and unsafe generated config shapes before mounting", async () => {
    const outputDirectory = await createTempDirectory("spawnfile-daimon-output-");
    const tempRoot = await createTempDirectory("spawnfile-daimon-auth-");
    process.env.SPAWNFILE_DAIMON_SOURCE_UNKNOWN = "/private/source";
    await expect(prepare(outputDirectory, tempRoot, "/missing.json"))
      .rejects.toThrow(/not declared/u);
    delete process.env.SPAWNFILE_DAIMON_SOURCE_UNKNOWN;

    await expect(prepare(outputDirectory, tempRoot, "relative.json"))
      .rejects.toThrow(/non-absolute/u);
    await expect(prepare(outputDirectory, tempRoot, "/"))
      .rejects.toThrow(/outside its ephemeral support root/u);
    await expect(prepare(outputDirectory, tempRoot, "/missing.json"))
      .rejects.toThrow(/could not read/u);

    const home = "/var/lib/spawnfile/instances/daimon/daimon-organization/runtime-homes/agent";
    const invalidSources = [
      ["not-json", /not JSON/u],
      ["null", /invalid shape/u],
      [JSON.stringify({ agents: {}, version: "noopolis.daimon.organization-runtime.v1" }), /supported v1\/v2/u],
      [JSON.stringify({ agents: [null], version: "noopolis.daimon.organization-runtime.v1" }), /invalid agent$/u],
      [JSON.stringify({ agents: [{ engine: null, id: "agent", runtimeHomePath: home }], version: "noopolis.daimon.organization-runtime.v1" }), /invalid agent credential target/u],
      [JSON.stringify({ agents: [{ engine: { kind: "codex" }, id: "", runtimeHomePath: home }], version: "noopolis.daimon.organization-runtime.v1" }), /invalid agent credential target/u],
      [JSON.stringify({ agents: [
        { engine: { kind: "codex" }, id: "a", runtimeHomePath: home },
        { engine: { kind: "grok" }, id: "b", runtimeHomePath: home }
      ], version: "noopolis.daimon.organization-runtime.v1" }), /overlapping runtime homes/u]
    ] as const;
    for (const [source, message] of invalidSources) {
      const configPath = await writeConfigSource(outputDirectory, source);
      await expect(prepare(outputDirectory, tempRoot, configPath)).rejects.toThrow(message);
    }
  });

  it("fails closed when a selected native credential leaf is missing", async () => {
    const outputDirectory = await createTempDirectory("spawnfile-daimon-output-");
    const tempRoot = await createTempDirectory("spawnfile-daimon-auth-");
    process.env.CODEX_HOME = await createTempDirectory("spawnfile-daimon-empty-codex-");
    const configPath = await writeConfig(
      outputDirectory,
      "/var/lib/spawnfile/instances/daimon/daimon-organization/runtime-homes/codex"
    );
    await expect(prepare(outputDirectory, tempRoot, configPath)).rejects.toThrow(/missing the selected codex/u);
  });
});

const safeSourceFacts = (overrides: Partial<Parameters<typeof isUnsafeDaimonSourceFile>[0]> = {}) => ({
  isFile: true,
  isSymbolicLink: false,
  mode: 0o100600,
  nlink: 1,
  size: 64,
  uid: 1_234,
  ...overrides
});

describe("isUnsafeDaimonSourceFile", () => {
  it("accepts one bounded 0600 regular file owned by a non-root caller", () => {
    expect(isUnsafeDaimonSourceFile(safeSourceFacts(), 1_234, 64 * 1024)).toBe(false);
  });

  it("refuses a credential the calling process does not own", () => {
    // The gap this whole change is about: a host file owned by somebody else is
    // material the deploying process cannot vouch for, and the container would
    // read it under a third identity again.
    expect(isUnsafeDaimonSourceFile(safeSourceFacts({ uid: 2_000 }), 1_234, 64 * 1024)).toBe(true);
    expect(isUnsafeDaimonSourceFile(safeSourceFacts({ uid: 0 }), 1_234, 64 * 1024)).toBe(true);
  });

  it("refuses a root caller even when it owns the credential", () => {
    expect(isUnsafeDaimonSourceFile(safeSourceFacts({ uid: 0 }), 0, 64 * 1024)).toBe(true);
    expect(isUnsafeDaimonSourceFile(safeSourceFacts({ uid: -1 }), -1, 64 * 1024)).toBe(true);
    expect(isUnsafeDaimonSourceFile(safeSourceFacts(), undefined, 64 * 1024)).toBe(true);
  });

  it("refuses links, non-files, permissive modes, hard links, and unbounded sizes", () => {
    for (const overrides of [
      { isFile: false },
      { isSymbolicLink: true },
      { mode: 0o100644 },
      { mode: 0o100640 },
      { nlink: 2 },
      { size: 0 },
      { size: 64 * 1024 + 1 }
    ]) {
      expect(isUnsafeDaimonSourceFile(safeSourceFacts(overrides), 1_234, 64 * 1024)).toBe(true);
    }
  });
});

describe("assertDaimonCredentialContainerOwner", () => {
  it("pins the required uid to the uid the compiled container drops to", () => {
    expect(DAIMON_CREDENTIAL_CONTAINER_UID).toBe(DAIMON_ORGANIZATION_UID);
    expect(DAIMON_CREDENTIAL_CONTAINER_UID).toBe(2_000);
  });

  it("accepts a credential owned by the container uid", () => {
    expect(() => assertDaimonCredentialContainerOwner(DAIMON_CREDENTIAL_CONTAINER_UID, "codex"))
      .not.toThrow();
  });

  it("names both the required and the observed uid when they disagree", () => {
    expect(() => assertDaimonCredentialContainerOwner(2_001, "codex"))
      .toThrow(/owned by uid 2001 but the Daimon container reads it as uid 2000/u);
  });
});

describe("prepareDaimonRuntimeAuth container credential ownership", () => {
  const codexOrganization = async () => {
    const outputDirectory = await createTempDirectory("spawnfile-daimon-output-");
    const tempRoot = await createTempDirectory("spawnfile-daimon-auth-");
    const codexHome = await createTempDirectory("spawnfile-daimon-codex-");
    process.env.CODEX_HOME = codexHome;
    const source = path.join(codexHome, "auth.json");
    await writeFile(source, codexCredential());
    await chmod(source, 0o600);
    const configPath = await writeConfig(
      outputDirectory,
      "/var/lib/spawnfile/instances/daimon/daimon-organization/runtime-homes/codex"
    );
    return { configPath, outputDirectory, source, tempRoot };
  };

  it("refuses a credential the container cannot own, naming the required and observed uid", async () => {
    // No injected uid: this is the real deploy default, so the refusal is the
    // one an operator on a uid-2001 account actually hits.
    const organization = await codexOrganization();
    const observed = callerUid();
    expect(observed).not.toBe(DAIMON_CREDENTIAL_CONTAINER_UID);
    await expect(prepareDaimonRuntimeAuth({
      authProfile: null,
      env: {},
      instance: { config_path: organization.configPath, home_path: null, id: "daimon-organization", model_auth_methods: {}, model_secrets_required: [], runtime: "daimon" },
      outputDirectory: organization.outputDirectory,
      tempRoot: organization.tempRoot
    })).rejects.toThrow(
      new RegExp(`owned by uid ${observed} but the Daimon container reads it as uid 2000`, "u")
    );
  });

  it("binds a correctly owned credential unchanged and never copies it", async () => {
    const organization = await codexOrganization();
    const before = await lstat(organization.source);
    const prepared = await prepare(
      organization.outputDirectory, organization.tempRoot, organization.configPath
    );
    expect(prepared.mountArgs).toEqual([
      "-v",
      `${organization.source}:/var/lib/spawnfile/instances/daimon/daimon-organization/runtime-homes/codex/.daimon-inbound/codex-auth:ro`
    ]);
    const after = await lstat(organization.source);
    expect([after.ino, after.uid, after.mode & 0o777, after.nlink])
      .toEqual([before.ino, before.uid, 0o600, 1]);
  });

  it("still refuses a root deploy before any mount is built", async () => {
    const organization = await codexOrganization();
    const posix = process as unknown as { getuid: () => number };
    const spy = vi.spyOn(posix, "getuid").mockReturnValue(0);
    try {
      await expect(prepareDaimonRuntimeAuth({
        authProfile: null,
        env: {},
        instance: { config_path: organization.configPath, home_path: null, id: "daimon-organization", model_auth_methods: {}, model_secrets_required: [], runtime: "daimon" },
        outputDirectory: organization.outputDirectory,
        tempRoot: organization.tempRoot
      }, 0)).rejects.toThrow(/caller-owned 0600 regular file/u);
    } finally {
      spy.mockRestore();
    }
  });

  it("refuses an AGY unlock secret the container cannot own", async () => {
    const outputDirectory = await createTempDirectory("spawnfile-daimon-output-");
    const tempRoot = await createTempDirectory("spawnfile-daimon-auth-");
    const unlock = path.join(outputDirectory, "agy-unlock");
    await writeFile(unlock, "opaque-unlock");
    await chmod(unlock, 0o600);
    process.env.SPAWNFILE_DAIMON_SOURCE_AGY_UNLOCK_SECRET = unlock;
    const configPath = await writeConfigSource(outputDirectory, JSON.stringify({
      agents: [{
        engine: { kind: "agy" },
        id: "agent:agy",
        runtimeHomePath: "/var/lib/spawnfile/instances/daimon/daimon-organization/runtime-homes/agy"
      }],
      host: {},
      version: "noopolis.daimon.organization-runtime.v1"
    }));
    await expect(prepareDaimonRuntimeAuth({
      authProfile: null,
      env: {},
      instance: { config_path: configPath, home_path: null, id: "daimon-organization", model_auth_methods: {}, model_secrets_required: [], runtime: "daimon" },
      outputDirectory,
      tempRoot
    })).rejects.toThrow(
      new RegExp(`AGY realm unlock artifact is owned by uid ${callerUid()} but the Daimon container reads it as uid 2000`, "u")
    );
  });
});
