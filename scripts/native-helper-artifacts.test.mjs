import assert from "node:assert/strict";
import { chmod, cp, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { verifyNativeHelperArtifacts } from "./native-helper-artifacts.mjs";

test("native helper closure rejects missing and wrong-architecture artifacts", async () => {
  await verifyNativeHelperArtifacts(path.resolve("src/deployment/native/artifacts"));
  const empty = await mkdtemp(path.join(os.tmpdir(), "spawnfile-native-empty-"));
  await assert.rejects(verifyNativeHelperArtifacts(empty), /Missing Linux x64/u);
  const built = path.resolve("dist/deployment/native"); const wrong = await mkdtemp(path.join(os.tmpdir(), "spawnfile-native-wrong-"));
  await cp(built, wrong, { recursive: true }); await writeFile(path.join(wrong, "rename-noreplace-x64"), "not-elf"); await chmod(path.join(wrong, "rename-noreplace-x64"), 0o755);
  await assert.rejects(verifyNativeHelperArtifacts(wrong), /Wrong-architecture/u);
});
