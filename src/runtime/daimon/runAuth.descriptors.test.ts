import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { removeDirectory } from "../../filesystem/index.js";
import * as engines from "./engines.js";
import { prepareDaimonRuntimeAuth } from "./runAuth.js";

const temporaryDirectories: string[] = [];
const codexCredential = () => JSON.stringify({ tokens: { access_token: "test-access", refresh_token: "test-refresh" } });
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
const callerUid = (): number => {
  const uid = process.getuid?.();
  if (typeof uid !== "number") throw new Error("this suite requires a POSIX uid");
  return uid;
};
const prepare = (outputDirectory: string, tempRoot: string, configPath: string) =>
  prepareDaimonRuntimeAuth({
    authProfile: null,
    containerCredentialUid: callerUid(),
    env: {},
    instance: { config_path: configPath, home_path: null, id: "daimon-organization", model_auth_methods: {}, model_secrets_required: [], runtime: "daimon" },
    outputDirectory,
    tempRoot
  });

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(temporaryDirectories.splice(0).map(removeDirectory));
});

describe("prepareDaimonRuntimeAuth descriptors", () => {
  it("resolves source slots, home overrides, ingress and credential format from descriptors", async () => {
    const outputDirectory = await createTempDirectory("spawnfile-daimon-output-");
    const tempRoot = await createTempDirectory("spawnfile-daimon-auth-");
    const credentialHome = await createTempDirectory("spawnfile-daimon-descriptor-home-");
    const source = path.join(credentialHome, "subscription.json");
    await writeFile(source, JSON.stringify({ subscription: { access: "token", refresh: "refresh" } }), { mode: 0o600 });
    const original = engines.getDaimonEngineDescriptor;
    const descriptor = original("codex")!;
    const auth = descriptor.auth;
    if (auth.staging !== "portable-file") throw new Error("expected portable descriptor");
    vi.spyOn(engines, "getDaimonEngineDescriptor").mockImplementation((engine) => engine === "codex" ? {
      ...descriptor,
      credentialMaterial: { ...descriptor.credentialMaterial!, sourceSlot: "custom-auth", sourceRelativePath: ".inbound/subscription" },
      homeEnvironment: "DESCRIPTOR_AUTH_HOME",
      auth: { ...auth, fileName: "subscription.json", format: {
        containerKey: "subscription", fallbackToRoot: false,
        accessTokenKeys: ["access"], refreshTokenKeys: ["refresh"]
      } }
    } : original(engine));
    vi.stubEnv("DESCRIPTOR_AUTH_HOME", credentialHome);
    vi.stubEnv("SPAWNFILE_DAIMON_SOURCE_CUSTOM_AUTH", source);
    const home = "/var/lib/spawnfile/instances/daimon/daimon-organization/runtime-homes/codex";
    const configPath = await writeConfig(outputDirectory, home);

    expect((await prepare(outputDirectory, tempRoot, configPath)).mountArgs)
      .toEqual(["-v", `${source}:${home}/.inbound/subscription:ro`]);
    vi.stubEnv("SPAWNFILE_DAIMON_SOURCE_CODEX_AUTH", source);
    await expect(prepare(outputDirectory, tempRoot, configPath)).rejects.toThrow(/not declared/u);
    delete process.env.SPAWNFILE_DAIMON_SOURCE_CODEX_AUTH;
    delete process.env.SPAWNFILE_DAIMON_SOURCE_CUSTOM_AUTH;
    expect((await prepare(outputDirectory, tempRoot, configPath)).mountArgs)
      .toEqual(["-v", `${source}:${home}/.inbound/subscription:ro`]);
    await writeFile(source, codexCredential(), { mode: 0o600 });
    await expect(prepare(outputDirectory, tempRoot, configPath)).rejects.toThrow(/refreshable subscription credential/u);
  });

  it("uses descriptor-defined realm staging rather than the engine id", async () => {
    const outputDirectory = await createTempDirectory("spawnfile-daimon-output-");
    const tempRoot = await createTempDirectory("spawnfile-daimon-auth-");
    const source = path.join(outputDirectory, "realm-unlock");
    await writeFile(source, "opaque-unlock", { mode: 0o600 });
    const original = engines.getDaimonEngineDescriptor;
    const descriptor = original("agy")!;
    vi.spyOn(engines, "getDaimonEngineDescriptor").mockImplementation((engine) => engine === "codex"
      ? { ...descriptor, id: engine } : original(engine));
    vi.stubEnv("SPAWNFILE_DAIMON_SOURCE_AGY_UNLOCK_SECRET", source);
    const configPath = await writeConfig(outputDirectory,
      "/var/lib/spawnfile/instances/daimon/daimon-organization/runtime-homes/codex");

    expect((await prepare(outputDirectory, tempRoot, configPath)).mountArgs)
      .toEqual(["-v", `${source}:/var/lib/spawnfile/daimon/agy-unlock-secret:ro`]);
  });

});
