import assert from "node:assert/strict";
import test from "node:test";

import { createLocalDaimonCapabilityReceipt } from "./build-local-daimon-runtime.mjs";

test("local Daimon receipt binds all three engine identities and manifest digest", () => {
  const previous = { AGY_CLI_SHA256: process.env.AGY_CLI_SHA256, CODEX_CLI_SHA256: process.env.CODEX_CLI_SHA256, GROK_CLI_SHA256: process.env.GROK_CLI_SHA256 };
  process.env.AGY_CLI_SHA256 = "a".repeat(64);
  process.env.CODEX_CLI_SHA256 = "b".repeat(64);
  process.env.GROK_CLI_SHA256 = "c".repeat(64);
  const receipt = createLocalDaimonCapabilityReceipt({ architecture: "amd64", manifestSha256: `sha256:${"d".repeat(64)}`, packageSha256: `sha256:${"e".repeat(64)}`, sourceSha256: `sha256:${"f".repeat(64)}` });
  assert.deepEqual(Object.keys(receipt.engines).sort(), ["agy", "codex", "grok"]);
  assert.equal(receipt.daimon.package_sha256, `sha256:${"e".repeat(64)}`);
  assert.equal(receipt.provenance.mode, "local-development");
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

test("local Daimon receipt rejects a missing engine digest", () => {
  const previous = process.env.AGY_CLI_SHA256;
  delete process.env.AGY_CLI_SHA256;
  assert.throws(() => createLocalDaimonCapabilityReceipt({
    architecture: "amd64", manifestSha256: `sha256:${"d".repeat(64)}`,
    packageSha256: `sha256:${"e".repeat(64)}`, sourceSha256: `sha256:${"f".repeat(64)}`
  }), /AGY_CLI_SHA256/u);
  if (previous === undefined) delete process.env.AGY_CLI_SHA256;
  else process.env.AGY_CLI_SHA256 = previous;
});
