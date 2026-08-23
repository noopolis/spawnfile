import { chmod, lstat, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { removeDirectory } from "../../filesystem/index.js";
import { prepareDaimonRuntimeAuth } from "./runAuth.js";

const temporaryDirectories: string[] = [];
const originalCodexHome = process.env.CODEX_HOME;
const originalGrokHome = process.env.GROK_HOME;
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
const prepare = (outputDirectory: string, tempRoot: string, configPath: string) =>
  prepareDaimonRuntimeAuth({
    authProfile: null,
    env: {},
    instance: { config_path: configPath, home_path: null, id: "daimon-organization", model_auth_methods: {}, model_secrets_required: [], runtime: "daimon" },
    outputDirectory,
    tempRoot
  });

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
    await writeFile(path.join(codexHome, "auth.json"), "{\"token\":\"redacted\"}\n");
    await chmod(path.join(codexHome, "auth.json"), 0o600);
    const home = "/var/lib/spawnfile/instances/daimon/daimon-organization/runtime-homes/codex";
    const configPath = await writeConfig(outputDirectory, home);
    const prepared = await prepareDaimonRuntimeAuth({
      authProfile: null,
      env: {},
      instance: { config_path: configPath, home_path: null, id: "daimon-organization", model_auth_methods: {}, model_secrets_required: [], runtime: "daimon" },
      outputDirectory,
      tempRoot
    });
    const mount = prepared.mountArgs[1]!;
    const source = path.join(codexHome, "auth.json");
    expect(mount).toBe(`${source}:${home}/.daimon-inbound/codex-auth:ro`);
    expect(prepared.launchIdentity).toEqual({ kind: "daimon", uid: process.getuid?.() });
    expect(prepared.mountArgs.join("\n")).not.toContain(tempRoot);
    expect((await lstat(path.join(outputDirectory, "container", "rootfs", `.${home}`, ".daimon-inbound"))).mode & 0o777)
      .toBe(0o700);
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
      await writeFile(path.join(home, file), `${engine}-token\n`);
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
        runtimeHomePath: `/var/lib/spawnfile/instances/daimon/daimon-organization/runtime-homes/${credential.engine}`
      })), {
        engine: { kind: "agy" },
        id: "agent:agy",
        runtimeHomePath: "/var/lib/spawnfile/instances/daimon/daimon-organization/runtime-homes/agy"
      }],
      host: {}, version: "noopolis.daimon.organization-runtime.v1"
    }));

    const prepared = await prepareDaimonRuntimeAuth({
      authProfile: null, env: {},
      instance: { config_path: configPath, home_path: null, id: "daimon-organization", model_auth_methods: {}, model_secrets_required: [], runtime: "daimon" },
      outputDirectory, tempRoot
    });

    expect(prepared.mountArgs).toEqual([...credentials].sort((left, right) =>
      left.engine.localeCompare(right.engine)
    ).flatMap((credential) => [
      "-v",
      `${path.join(credential.home, credential.file)}:/var/lib/spawnfile/instances/daimon/daimon-organization/runtime-homes/${credential.engine}/.daimon-inbound/${credential.engine}-auth:ro`
    ]).concat(["-v", `${unlock}:/var/lib/spawnfile/daimon/agy-unlock-secret:ro`]));
    expect(prepared.launchIdentity).toEqual({ kind: "daimon", uid: process.getuid?.() });
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
    await writeFile(path.join(grokHome, "auth.json"), "grok-auth\n");
    await chmod(path.join(grokHome, "auth.json"), 0o600);
    const grokConfig = await writeConfigSource(outputDirectory, JSON.stringify({
      agents: [{
        engine: { kind: "grok" }, id: "agent:grok",
        runtimeHomePath: "/var/lib/spawnfile/instances/daimon/daimon-organization/runtime-homes/grok"
      }],
      host: {}, version: "noopolis.daimon.organization-runtime.v1"
    }));
    await expect(prepare(outputDirectory, tempRoot, grokConfig)).resolves.toMatchObject({
      launchIdentity: { kind: "daimon", uid: process.getuid?.() },
      mountArgs: ["-v", expect.stringContaining(".daimon-inbound/grok-auth:ro")]
    });
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
      [JSON.stringify({ agents: {}, version: "noopolis.daimon.organization-runtime.v1" }), /not v1/u],
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
