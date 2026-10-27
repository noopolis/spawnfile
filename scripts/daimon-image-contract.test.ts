import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

type Material = {
  sourceSlot: string; sourceRelativePath: string; destinationRelativePath: string;
  directoryMode: number; fileMode: number;
};
const readJson = (file: string): unknown => JSON.parse(readFileSync(new URL(file, import.meta.url), "utf8"));
const vendored = readJson("../src/runtime/daimon/contract-manifest.json") as Record<string, unknown>;
const { engines: _engines, ...legacy } = vendored;
const v5 = { ...legacy, version: "noopolis.daimon.runtime-contract-manifest.v5" };
const mirror = readJson("../src/runtime/daimon/engine-descriptors.json") as {
  engines: Record<string, { id: string; auth: { staging: string; realm?: unknown }; credentialMaterial: Material | null }>;
};
const v6 = (portableCount: 1 | 2) => {
  const engines = structuredClone(mirror.engines);
  for (const engine of Object.values(engines)) if (engine.auth.staging === "portable-realm") engine.auth = { ...engine.auth, staging: "portable-file", realm: null };
  if (portableCount === 2) {
    const portable = Object.values(engines).find(e => e.auth.staging === "portable-file");
    assert.ok(portable?.credentialMaterial);
    engines["another-cli"] = { ...structuredClone(portable), id: "another-cli", credentialMaterial: {
      ...portable.credentialMaterial, destinationRelativePath: ".another/auth.json",
      sourceRelativePath: ".daimon-inbound/another-auth", sourceSlot: "another-auth"
    } };
  }
  return { ...structuredClone(vendored), version: "noopolis.daimon.runtime-contract-manifest.v6",
    engines, supportedEngineKinds: Object.keys(engines).sort(), engineCredentialMaterial: Object.fromEntries(
      Object.values(engines).filter(e => e.auth.staging === "portable-file").map(e => [e.id, structuredClone(e.credentialMaterial!)])) };
};
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : value && typeof value === "object" ? `{${Object.keys(value).sort().map(key => [key, (value as Record<string, unknown>)[key]] as const).map(
    ([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}` : JSON.stringify(value);

// Execute the actual image check, so its acceptance criteria cannot drift behind a test helper.
const checkImageContract = (value: unknown): number | null => {
  const dockerfile = readFileSync(new URL("../runtime-images/daimon/Dockerfile", import.meta.url), "utf8");
  const code = /node -e '([^']*const raw=fs.readFileSync[^']*)'/u.exec(dockerfile)?.[1];
  assert.ok(code, "missing Dockerfile manifest check");
  const root = mkdtempSync(path.join(os.tmpdir(), "daimon-image-contract-"));
  try {
    const file = path.join(root, "manifest.json");
    writeFileSync(file, `${canonical(value)}\n`);
    const result = spawnSync(process.execPath, ["-e", code, file], { encoding: "utf8" });
    assert.ifError(result.error);
    assert.equal(result.stderr, "", "image validator crashed instead of deciding acceptance");
    return result.status;
  } finally { rmSync(root, { force: true, recursive: true }); }
};

test("the image accepts the pinned v7 contract", () => {
  assert.equal(checkImageContract(vendored), 0);
});

test("the image retains v5 compatibility", () => {
  assert.equal(checkImageContract(v5), 0);
});

for (const count of [1, 2] as const) {
  test(`the image accepts v6 with ${count} portable-credential engine(s)`, () => {
    assert.equal(Object.keys(v6(count).engineCredentialMaterial).length, count);
    assert.equal(checkImageContract(v6(count)), 0);
  });
}

test("the image validates every portable descriptor's material in v6", () => {
  for (const id of Object.keys(v6(2).engineCredentialMaterial)) {
    const missing = v6(2); delete missing.engineCredentialMaterial[id];
    assert.equal(checkImageContract(missing), 1, `missing material for ${id}`);
    for (const field of ["sourceSlot", "sourceRelativePath", "destinationRelativePath", "directoryMode", "fileMode"] as const) {
      const mismatch = v6(2);
      Object.assign(mismatch.engineCredentialMaterial[id]!, { [field]: field.endsWith("Mode") ? 511 : "wrong" });
      assert.equal(checkImageContract(mismatch), 1, `mismatched ${id}.${field}`);
    }
  }
  const extra = v6(2); extra.engineCredentialMaterial.unused = { ...Object.values(extra.engineCredentialMaterial)[0]! };
  assert.equal(checkImageContract(extra), 1, "unowned material");
  for (const field of ["directoryMode", "fileMode"] as const) {
    const unsafe = v6(2);
    unsafe.engines["another-cli"]!.credentialMaterial![field] = 511;
    unsafe.engineCredentialMaterial["another-cli"]![field] = 511;
    assert.equal(checkImageContract(unsafe), 1, `unsafe matching ${field}`);
  }
});

for (const field of ["durableMountPath", "bootstrapMountPath", "bootstrapSourceSlot", "agentCredentialRelativePath", "directoryMode", "fileMode", "maxCredentialBytes"]) {
  test(`the image rejects an unsafe v7 Codex realm ${field}`, () => {
    const unsafe = structuredClone(vendored);
    (unsafe.codexSubscriptionRealm as Record<string, unknown>)[field] = field.endsWith("Mode") ? 511 : "wrong";
    assert.equal(checkImageContract(unsafe), 1);
  });
}

test("the image requires exactly one portable realm owner and its explicit v7 version", () => {
  const downgrade = { ...structuredClone(vendored), version: "noopolis.daimon.runtime-contract-manifest.v6" };
  assert.equal(checkImageContract(downgrade), 1);
  const missing = structuredClone(vendored) as { engines: Record<string, { auth: { staging: string } }> };
  missing.engines.codex!.auth.staging = "portable-file";
  assert.equal(checkImageContract(missing), 1);
});
