import { Buffer } from "node:buffer";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../cli/runCli.js";
import {
  provisionCredentials,
  type ProvisionedCredentials
} from "./credentialProvisioning.js";
import { initializeTargetSecretSourceLifecycle } from "./targetSecretSourceLifecycle.js";
import { createCanonicalTargetSecretSourceJson } from "./targetSecretSourceRecordCommon.js";

const GENERATED_SENTINELS = [
  "f1e2d3c4b5a697887766554433221100",
  "0f1e2d3c4b5a6978877665544332211a"
] as const;
const DERIVED_SENTINEL = "DERIVED_SENTINEL_PROVISIONING";
const SENTINELS = [...GENERATED_SENTINELS, DERIVED_SENTINEL];
const PRIVATE_HANDLE_KEYS = ["source_version_handle", "sourceVersionHandle"];
const cleanup: string[] = [];
const originalHome = process.env.SPAWNFILE_HOME;

afterEach(async () => {
  if (originalHome === undefined) delete process.env.SPAWNFILE_HOME;
  else process.env.SPAWNFILE_HOME = originalHome;
  await Promise.all(cleanup.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

const walk = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(async (entry) => {
    const candidate = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(candidate) : [candidate];
  }))).flat();
};
const assertNoSecretSentinels = (
  text: string,
  sentinels: readonly string[] = SENTINELS
): void => {
  for (const sentinel of sentinels) expect(text).not.toContain(sentinel);
};
const assertNoPrivateHandleKeys = (text: string): void => {
  for (const key of PRIVATE_HANDLE_KEYS) expect(text).not.toContain(key);
};
const assertPublicBytes = (text: string): void => {
  assertNoSecretSentinels(text);
  assertNoPrivateHandleKeys(text);
};
const canonicalJsonText = (raw: unknown): string => {
  const bytes = createCanonicalTargetSecretSourceJson(raw);
  try { return new TextDecoder().decode(bytes); } finally { bytes.fill(0); }
};
const requestGraph = (codexSource: string) => ({
  credentials: [
    { bytes: 16, env: "ALPHA_ACCESS_TOKEN", kind: "generated-token", name: "alpha-access-token" },
    { bytes: 16, env: "BETA_ACCESS_TOKEN", kind: "generated-token", name: "beta-access-token" },
    {
      content: { endpoint: "https://service.test", marker: DERIVED_SENTINEL },
      env: "SERVICE_CONFIG",
      kind: "derived-config",
      name: "service-config"
    }
  ],
  descriptor_digest: `sha256:${"a".repeat(64)}`,
  model_engine_auth: { from: codexSource, kind: "codex", profile: "launch" },
  run_id: "run-1",
  scope: "world",
  selected_target: {
    fingerprint: `sha256:${"b".repeat(32)}`,
    handle: `opaque_${"c".repeat(16)}`,
    version: "spawnfile.target-resource.selected-target.v1"
  },
  version: "spawnfile.auth.credential-provisioning.request.v1",
  world_bindings: {
    json_url: "https://world.test/v1/world",
    mcp_url: "https://world.test/mcp",
    members: [
      { id: "alpha", principal_id: "agent:alpha", token_credential_name: "alpha-access-token" },
      { id: "beta", principal_id: "agent:beta", token_credential_name: "beta-access-token" }
    ],
    world_instance_id: "world-1"
  }
});
const resolvedGraph = {
  grants: [
    { capability_manifest: { operations: ["observe"], rate: 1 }, member_id: "alpha", principal_id: "agent:alpha" },
    { capability_manifest: { operations: ["act"], rate: 2 }, member_id: "beta", principal_id: "agent:beta" }
  ],
  run_id: "run-1",
  version: "spawnfile.auth.resolved-world-grants.v1",
  world_instance_id: "world-1"
};
const entropy = () => {
  let index = 0;
  return (bytes: number): Uint8Array => {
    const value = Buffer.from(GENERATED_SENTINELS[index]!, "hex");
    index += 1;
    expect(value.length).toBe(bytes);
    return value;
  };
};
type Fixture = Readonly<{
  codexSource: string;
  directory: string;
  envFile: string;
  home: string;
  requestFile: string;
  resolvedFile: string;
  worldFile: string;
}>;
const fixture = async (label: string): Promise<Fixture> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), `spawnfile-provision-${label}-`));
  cleanup.push(directory);
  const home = path.join(directory, "home");
  const codexSource = path.join(directory, "codex-source");
  await mkdir(home, { mode: 0o700 });
  await mkdir(codexSource, { mode: 0o700 });
  await writeFile(path.join(codexSource, "auth.json"), '{"account":"opaque-test-account"}', { mode: 0o600 });
  const requestFile = path.join(directory, "request.json");
  await writeFile(requestFile, JSON.stringify(requestGraph(codexSource)), { mode: 0o600 });
  const resolvedFile = path.join(directory, "resolved.json");
  await writeFile(resolvedFile, JSON.stringify(resolvedGraph), { mode: 0o600 });
  return {
    codexSource,
    directory,
    envFile: path.join(directory, "credentials.env"),
    home,
    requestFile,
    resolvedFile,
    worldFile: path.join(directory, "world-bindings.json")
  };
};
const streams = () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stderr,
    stdout,
    value: {
      stderr: (message: string) => stderr.push(message),
      stdout: (message: string) => stdout.push(message)
    }
  };
};
const versionValues = async (home: string): Promise<string[]> => {
  const root = path.join(home, "auth", "target-secrets", "versions");
  return Promise.all((await walk(root)).map(async (file) => {
    const record = JSON.parse(await readFile(file, "utf8")) as { secret: string };
    return Buffer.from(record.secret, "base64").toString("utf8");
  }));
};
const assertPublishedRecordSchemas = async (home: string): Promise<void> => {
  const root = path.join(home, "auth", "target-secrets");
  const aliasFiles = await walk(path.join(root, "aliases"));
  const grantFiles = await walk(path.join(root, "grants"));
  expect(aliasFiles.length).toBeGreaterThan(0);
  expect(grantFiles.length).toBeGreaterThan(0);
  for (const file of aliasFiles) {
    const record = JSON.parse(await readFile(file, "utf8")) as unknown;
    expect(Object.keys(record as object).sort()).toEqual([
      "publication_handle", "source_handle", "source_version_handle", "version"
    ]);
  }
  for (const file of grantFiles) {
    const record = JSON.parse(await readFile(file, "utf8")) as unknown;
    expect(Object.keys(record as object).sort()).toEqual([
      "descriptor_digest", "name", "publication_handle", "run_id", "scope",
      "selected_target", "source_handle", "source_version_handle", "version"
    ]);
  }
};
const sweep = async (
  state: Fixture,
  publicTexts: readonly string[],
  envExpected: boolean
): Promise<void> => {
  for (const text of publicTexts) assertPublicBytes(text);
  const authRoot = path.join(state.home, "auth");
  const authFiles = await walk(authRoot);
  expect(authFiles.length).toBeGreaterThan(envExpected ? 9 : 6);
  for (const file of authFiles) {
    const relative = path.relative(path.join(state.home, "auth", "target-secrets"), file);
    if (relative.startsWith(`versions${path.sep}`)) continue;
    const text = await readFile(file, "utf8");
    assertNoSecretSentinels(text);
  }
  const visited = await walk(state.directory);
  expect(visited.length).toBeGreaterThan(envExpected ? 14 : 9);
  for (const file of visited) {
    const relativeAuth = path.relative(authRoot, file);
    const insideAuth = relativeAuth !== ".."
      && !relativeAuth.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relativeAuth);
    if (insideAuth) continue;
    const text = await readFile(file, "utf8");
    assertNoPrivateHandleKeys(text);
    if (file === state.envFile) continue;
    if (file === state.requestFile) {
      // derived-config.content is DECLARATIVE, non-secret configuration that the caller
      // authored into the request by design — it is stored as a target secret for uniform
      // handling, but it is not minted material and its presence in the caller's own
      // request file is not a leak.
      assertNoSecretSentinels(text, GENERATED_SENTINELS);
      continue;
    }
    assertNoSecretSentinels(text);
  }
};

describe("credential provisioning hostile leak sweep", () => {
  it("keeps all values in version leaves and the exclusive env file", async () => {
    const state = await fixture("success");
    process.env.SPAWNFILE_HOME = state.home;
    const output = streams();
    let provisioned: ProvisionedCredentials | undefined;
    const caught: string[] = [];
    let exitCode = -1;
    try {
      exitCode = await runCli([
        "auth", "provision", state.requestFile,
        "--env-file", state.envFile,
        "--world-bindings", state.worldFile,
        "--resolved-grants", state.resolvedFile
      ], {
        handlers: {
          provisionCredentials: async (request) => {
            provisioned = await provisionCredentials(request, { entropy: entropy() });
            return provisioned;
          }
        },
        streams: output.value
      });
    } catch (error) {
      caught.push(error instanceof Error ? error.message : String(error));
    }
    expect(exitCode).toBe(0);
    expect(output.stderr).toEqual([]);
    expect(output.stdout).toHaveLength(1);
    const receiptBytes = output.stdout[0]!;
    const worldBytes = await readFile(state.worldFile, "utf8");
    const requestBytes = await readFile(state.requestFile, "utf8");
    expect(requestBytes).toContain(DERIVED_SENTINEL);
    const captured = provisioned;
    expect(captured).toBeDefined();
    if (captured === undefined) throw new Error("expected provisioned credentials");
    expect(captured.materials.size).toBe(0);
    const provisionedReceiptBytes = canonicalJsonText(captured.receipt);
    const provisionedWithoutMaterialsBytes = canonicalJsonText(
      Object.fromEntries(Object.entries(captured).filter(([key]) => key !== "materials"))
    );
    await sweep(state, [receiptBytes, output.stdout.join("\n"), output.stderr.join("\n"),
      caught.join("\n"), worldBytes, provisionedReceiptBytes, provisionedWithoutMaterialsBytes], true);
    expect(Object.keys(captured.receipt).sort()).toEqual([
      "credentials", "phases", "run_id", "scope", "version"
    ]);
    for (const credential of captured.receipt.credentials) {
      expect(Object.keys(credential).sort()).toEqual([
        "env", "name", "scope", "source_handle"
      ]);
    }
    expect((await stat(state.envFile)).mode & 0o777).toBe(0o600);
    const env = await readFile(state.envFile, "utf8");
    for (const sentinel of SENTINELS) expect(env).toContain(sentinel);
    for (const key of PRIVATE_HANDLE_KEYS) expect(env).not.toContain(key);
    await assertPublishedRecordSchemas(state.home);
    expect((await versionValues(state.home)).sort()).toEqual([
      GENERATED_SENTINELS[0],
      GENERATED_SENTINELS[1],
      `{"endpoint":"https://service.test","marker":"${DERIVED_SENTINEL}"}`
    ].sort());
  }, 30_000);

  it("zeroes materials and passes the full sweep after a mid-grant failure", async () => {
    const state = await fixture("failure");
    process.env.SPAWNFILE_HOME = state.home;
    const output = streams();
    const caught: string[] = [];
    const authoredMaterials: Uint8Array[] = [];
    let exitCode = -1;
    try {
      const lifecycle = await initializeTargetSecretSourceLifecycle();
      let grants = 0;
      exitCode = await runCli([
        "auth", "provision", state.requestFile,
        "--env-file", state.envFile,
        "--world-bindings", state.worldFile,
        "--resolved-grants", state.resolvedFile
      ], {
        handlers: {
          provisionCredentials: (request) => provisionCredentials(request, {
            entropy: entropy(),
            lifecycle: {
              author: async (material) => {
                authoredMaterials.push(material);
                return lifecycle.author(material);
              },
              grant: async (grant) => {
                grants += 1;
                if (grants === 2) throw new Error(DERIVED_SENTINEL);
                return lifecycle.grant(grant);
              }
            }
          })
        },
        streams: output.value
      });
    } catch (error) {
      caught.push(error instanceof Error ? error.message : String(error));
    }
    expect(exitCode).toBe(1);
    expect(output.stdout).toEqual([]);
    expect(output.stderr).toEqual(["error: invalid target secret source record"]);
    expect(authoredMaterials).toHaveLength(3);
    expect(authoredMaterials.every((material) => material.every((byte) => byte === 0))).toBe(true);
    await expect(stat(state.envFile)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(state.worldFile)).rejects.toMatchObject({ code: "ENOENT" });
    const receiptBytes = output.stdout[0] ?? "";
    const worldBytes = "";
    await sweep(state, [receiptBytes, output.stdout.join("\n"), output.stderr.join("\n"),
      caught.join("\n"), worldBytes], false);
    expect((await versionValues(state.home)).sort()).toEqual([
      GENERATED_SENTINELS[0],
      GENERATED_SENTINELS[1],
      `{"endpoint":"https://service.test","marker":"${DERIVED_SENTINEL}"}`
    ].sort());
  }, 30_000);
});
