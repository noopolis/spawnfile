import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { expect, it } from "vitest";

import { createRootfsFiles, renderEntrypoint } from "../compiler/containerArtifactsRender.js";
import type { RuntimeTargetPlan } from "../compiler/containerArtifactsTypes.js";

const run = promisify(execFile);

const plan: RuntimeTargetPlan = {
  envFiles: [],
  id: "external-agent",
  instancePaths: { configPath: "/state/agent.json", workspacePath: "/workspace" },
  meta: {
    configFileName: "agent.json",
    instancePaths: { configPathTemplate: "/state/agent.json", workspacePathTemplate: "/workspace" },
    standaloneBaseImage: "debian:bookworm-slim",
    startCommand: ["/bin/agent", "<config-path>"],
    systemDeps: []
  },
  modelAuthMethods: {},
  modelSecretsRequired: [],
  runtimeName: "external-harness",
  runtimeRoot: "/opt/agent",
  targetFiles: [{ content: "{}\n", path: "agent.json" }]
};

it("uses the ordinary entrypoint and no native bootstrap for a runtime with no host integration", () => {
  expect(createRootfsFiles([plan])).toEqual([{ content: "{}\n", path: "container/rootfs/state/agent.json" }]);
  const entrypoint = renderEntrypoint([plan], []);
  expect(entrypoint).toContain("exec '/bin/agent' '/state/agent.json'");
  expect(entrypoint).not.toContain("--spawnfile-runtime-identity");
});

it("renders the OpenClaw token fallback only when OpenClaw is selected", () => {
  const openclaw = { ...plan, runtimeName: "openclaw" };
  for (const runtimeName of ["external-harness", "picoclaw", "daimon"]) {
    const other = { ...plan, runtimeName };
    expect(renderEntrypoint([other], [])).not.toContain("OPENCLAW_GATEWAY_TOKEN");
    expect(renderEntrypoint([openclaw, other], []).match(/export OPENCLAW_HOOKS_TOKEN/gu)).toHaveLength(1);
  }
});

it("starts a generated OpenClaw entrypoint with the derived or explicit hooks token", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "spawnfile-host-prelude-"));
  try {
    const configPath = path.join(root, "agent.json");
    const entrypoint = path.join(root, "entrypoint.sh");
    const openclaw: RuntimeTargetPlan = {
      ...plan,
      runtimeName: "openclaw",
      instancePaths: { configPath, workspacePath: root },
      meta: { ...plan.meta, startCommand: ["/bin/bash", "-c", 'printf %s "$OPENCLAW_HOOKS_TOKEN"'] }
    };
    await writeFile(configPath, "{}\n");
    await writeFile(entrypoint, renderEntrypoint([openclaw], ["OPENCLAW_GATEWAY_TOKEN", "OPENCLAW_HOOKS_TOKEN"]));

    for (const [supplied, expected] of [["", "hooks-synthetic"], ["explicit-test", "explicit-test"]]) {
      const { stdout } = await run("/bin/bash", [entrypoint], {
        env: { PATH: process.env.PATH, OPENCLAW_GATEWAY_TOKEN: "synthetic", OPENCLAW_HOOKS_TOKEN: supplied },
        timeout: 5_000
      });
      expect(stdout).toBe(expected);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
