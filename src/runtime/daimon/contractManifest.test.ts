import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { removeDirectory } from "../../filesystem/index.js";
import {
  assertDaimonRuntimeHome,
  DAIMON_CONTRACT_MANIFEST_DIGEST_FILE,
  DAIMON_CONTRACT_MANIFEST_FILE,
  DAIMON_CONTRACT_MANIFEST_VERSION,
  DAIMON_GROK_ENGINE_BROKER,
  parseDaimonContractManifest,
  readVerifiedDaimonContractManifest
} from "./contractManifest.js";

const temporaryDirectories: string[] = [];
const canonical = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
};
const manifest = () => ({
  agySubscriptionRealm: {
    directoryMode: 0o700,
    durableMountPath: "/var/lib/spawnfile/daimon/agy-subscription-realm",
    fileMode: 0o600,
    maxUnlockBytes: 4_096,
    unlockMountPath: "/var/lib/spawnfile/daimon/agy-unlock-secret",
    unlockSourceSlot: "agy-unlock-secret"
  },
  grokSubscriptionRealm: {
    agentCredentialRelativePath: ".grok/auth.json",
    bootstrapMountPath: "/var/lib/spawnfile/daimon/grok-bootstrap-auth",
    bootstrapSourceSlot: "grok-auth",
    directoryMode: 0o700,
    durableMountPath: "/var/lib/spawnfile/daimon/grok-subscription-realm",
    fileMode: 0o600,
    maxCredentialBytes: 65_536
  },
  grokEngineBroker: DAIMON_GROK_ENGINE_BROKER,
  consumedConfigFields: [
    "version", "host.bindHost", "host.port", "host.controlTokenEnv", "agents[].id",
    "agents[].name", "agents[].instructions", "agents[].workspacePath",
    "agents[].runtimeHomePath", "agents[].engine.kind", "agents[].schedule.kind",
    "agents[].schedule.interval_ms", "agents[].schedule.cron", "agents[].schedule.timezone",
    "agents[].schedule.prompt", "agents[].mcp", "agents[].moltnet"
  ],
  engineCredentialMaterial: {
    codex: { destinationRelativePath: ".codex/auth.json", directoryMode: 0o700, fileMode: 0o600, sourceRelativePath: ".daimon-inbound/codex-auth", sourceSlot: "codex-auth" },
  },
  supportedEngineKinds: ["agy", "codex", "grok"],
  organizationRuntimeConfigV2Schema: {
    $id: "noopolis.daimon.organization-runtime.v2",
    properties: { agents: { items: { properties: { schedule: { oneOf: [{}, {}, {}] } } } } }
  },
  wakeAcceptanceTypes: ["manual", "message", "schedule", "external"],
  deliverySemantics: {
    activeDeliveryIdempotency: "unbounded-until-terminal", terminalReceiptHorizon: 2_048,
    recovery: "at-least-once-with-stable-wake-id", concurrentSameAgentTurns: false, externalEffectsExactlyOnce: false
  },
  version: DAIMON_CONTRACT_MANIFEST_VERSION
});

const writeManifest = async (source: string): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-daimon-contract-"));
  temporaryDirectories.push(directory);
  await writeFile(path.join(directory, DAIMON_CONTRACT_MANIFEST_FILE), source);
  await writeFile(
    path.join(directory, DAIMON_CONTRACT_MANIFEST_DIGEST_FILE),
    `sha256:${createHash("sha256").update(source).digest("hex")}\n`
  );
  return directory;
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(removeDirectory));
});

describe("Daimon contract manifest", () => {
  it("accepts canonical source-free contract bytes", async () => {
    const source = `${canonical(manifest())}\n`;
    await expect(readVerifiedDaimonContractManifest(await writeManifest(source))).resolves.toMatchObject({
      manifest: {
        agySubscriptionRealm: {
          durableMountPath: "/var/lib/spawnfile/daimon/agy-subscription-realm",
          unlockMountPath: "/var/lib/spawnfile/daimon/agy-unlock-secret"
        },
        grokSubscriptionRealm: {
          durableMountPath: "/var/lib/spawnfile/daimon/grok-subscription-realm",
          bootstrapMountPath: "/var/lib/spawnfile/daimon/grok-bootstrap-auth"
        },
        grokEngineBroker: {
          identities: { organizationUid: 2_000, brokerUid: 2_100, firstWorkerUid: 2_200 },
          providerProxy: { host: "127.0.0.1", port: 43_123 },
          mcpFacade: { host: "127.0.0.1", port: 43_124, path: "/mcp" }
        },
        supportedEngineKinds: ["agy", "codex", "grok"]
        , wakeAcceptanceTypes: ["manual", "message", "schedule", "external"]
      }
    });
  });

  it.each([
    "{\"supportedEngineKinds\":[\"agy\",\"codex\",\"grok\"]}\n",
    `${JSON.stringify(manifest(), null, 2)}\n`,
    `${canonical({ ...manifest(), engineCredentialMaterial: { ...manifest().engineCredentialMaterial, codex: { destinationRelativePath: ".codex/auth.json", directoryMode: 0o755, fileMode: 0o600, sourceRelativePath: ".daimon-inbound/codex-auth", sourceSlot: "codex-auth" } } })}\n`
  ])("rejects malformed, noncanonical, or unsafe bytes", async (source) => {
    await expect(readVerifiedDaimonContractManifest(await writeManifest(source))).rejects.toThrow(/manifest/u);
  });

  it("rejects later traversal escapes before any runtime-home join", () => {
    expect(assertDaimonRuntimeHome("/var/lib/spawnfile/instances/daimon/org/runtime-homes/a"))
      .toBe("/var/lib/spawnfile/instances/daimon/org/runtime-homes/a");
    for (const unsafe of [
      "/var/lib/spawnfile/instances/daimon/../other",
      "/var/lib/spawnfile/instances/daimon/org/runtime-homes/a/../../../../escape",
      "/tmp/daimon-home"
    ]) expect(() => assertDaimonRuntimeHome(unsafe)).toThrow(/escapes/u);
    expect(() => assertDaimonRuntimeHome("relative/runtime-home")).toThrow(/absolute POSIX/u);
  });

  it("rejects malformed credential and subscription-realm material at the consumed contract boundary", () => {
    for (const invalid of [null, [], "manifest"]) {
      expect(() => parseDaimonContractManifest(invalid)).toThrow(/manifest/u);
    }
    expect(() => parseDaimonContractManifest({
      ...manifest(),
      engineCredentialMaterial: { ...manifest().engineCredentialMaterial, extra: {} }
    })).toThrow(/credential material/u);
    expect(() => parseDaimonContractManifest({
      ...manifest(),
      agySubscriptionRealm: { ...manifest().agySubscriptionRealm, directoryMode: 0o755 }
    })).toThrow(/AGY subscription realm/u);
    expect(() => parseDaimonContractManifest({
      ...manifest(),
      grokSubscriptionRealm: { ...manifest().grokSubscriptionRealm, directoryMode: 0o755 }
    })).toThrow(/Grok subscription realm/u);
    expect(() => parseDaimonContractManifest({
      ...manifest(),
      grokEngineBroker: { ...DAIMON_GROK_ENGINE_BROKER, providerProxy: { host: "0.0.0.0", port: 43_123 } }
    })).toThrow(/Grok engine broker/u);
    expect(() => parseDaimonContractManifest({
      ...manifest(),
      grokEngineBroker: { ...DAIMON_GROK_ENGINE_BROKER, nativeAbiVersion: 1 }
    })).toThrow(/Grok engine broker/u);
  });

  it("rejects missing, malformed, noncanonical, and digest-mismatched packaged files", async () => {
    const missing = await mkdtemp(path.join(os.tmpdir(), "spawnfile-daimon-contract-missing-"));
    temporaryDirectories.push(missing);
    await expect(readVerifiedDaimonContractManifest(missing)).rejects.toThrow(/missing/u);

    await expect(readVerifiedDaimonContractManifest(await writeManifest("{not-json}\n")))
      .rejects.toThrow(/valid JSON/u);
    await expect(readVerifiedDaimonContractManifest(await writeManifest(`${canonical(manifest())}\r\n`)))
      .rejects.toThrow(/canonical UTF-8/u);

    const mismatched = await writeManifest(`${canonical(manifest())}\n`);
    await writeFile(path.join(mismatched, DAIMON_CONTRACT_MANIFEST_DIGEST_FILE), `sha256:${"0".repeat(64)}\n`);
    await expect(readVerifiedDaimonContractManifest(mismatched)).rejects.toThrow(/digest sidecar/u);
  });
});
