import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

type JsonObject = Record<string, unknown>;

const parseObject = async (filePath: string): Promise<JsonObject> => {
  const value = JSON.parse(await readFile(filePath, "utf8")) as unknown;
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as JsonObject;
};

test("explicit-test MCP lowering binds compiled identity and declared server tools", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "spawnfile-test-mcp-"));
  try {
    const declaration = path.join(root, "declaration.json");
    const report = path.join(root, "report.json");
    const out = path.join(root, "out");
    await writeFile(declaration, JSON.stringify({
      servers: [{
        agent_id: "agent:alpha",
        args: ["/fixture/server.mjs"],
        command: "/usr/local/bin/node",
        env_names: [],
        id: "fixture",
        tools: ["checkpoint"],
      }],
      version: "spawnfile.explicit-test-mcp-declaration.v1",
    }));
    await writeFile(report, JSON.stringify({
      compile_fingerprint: "sf1:0123456789ab",
      container: { runtime_instances: [{ node_ids: ["agent:alpha"], runtime: "daimon" }] },
    }));
    execFileSync(process.execPath, [
      "--experimental-strip-types",
      "scripts/compile-explicit-test-mcp.ts",
      "--declaration",
      declaration,
      "--report",
      report,
      "--out",
      out,
    ]);
    const artifact = await parseObject(path.join(out, "explicit-test-mcp.json"));
    const receipt = await parseObject(path.join(out, "explicit-test-mcp-receipt.json"));
    assert.equal(artifact.compile_fingerprint, "sf1:0123456789ab");
    assert.deepEqual(receipt.servers, [{ agent_id: "agent:alpha", id: "fixture", tools: ["checkpoint"] }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
