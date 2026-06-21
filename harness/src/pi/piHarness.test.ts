import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PiHarnessAdapter } from "./piHarness.js";

const tempRoots: string[] = [];

const tempDir = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "noopolis-daimon-pi-"));
  tempRoots.push(directory);
  return directory;
};

test.afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test("starts a local endpoint model without an explicit modelsPath", async () => {
  const root = await tempDir();
  const adapter = new PiHarnessAdapter({
    authPath: path.join(root, "auth.json"),
    model: {
      auth: { method: "none" },
      endpoint: {
        baseUrl: "http://127.0.0.1:11434/v1",
        compatibility: "openai"
      },
      name: "llama3.2",
      provider: "local"
    }
  });

  const workspacePath = path.join(root, "workspace");
  const handle = await adapter.startAgent({
    id: "localist",
    instructions: "Use the local model when asked to work.",
    name: "Localist",
    runtimeHomePath: path.join(root, "runtime"),
    workspacePath
  });

  assert.equal(handle.status().state, "idle");
  assert.ok((await stat(workspacePath)).isDirectory());
  await handle.stop();
});
