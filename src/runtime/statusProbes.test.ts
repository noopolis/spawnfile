import { describe, expect, it, vi } from "vitest";

import type { DeploymentRecord, DockerUnitInspection } from "../deployment/index.js";
import type { ContainerRuntimeInstanceReport } from "../report/index.js";
import type { RuntimeProbeGateway, RuntimeStatusProbeContext } from "./types.js";
import { createRuntimeHttpProbe, createRuntimePathProbe } from "./statusProbes.js";

const deployment = {} as DeploymentRecord;
const unit = {} as DeploymentRecord["units"][number];
const inspection = {} as DockerUnitInspection;

const instance = (
  overrides: Partial<ContainerRuntimeInstanceReport> = {}
): ContainerRuntimeInstanceReport => ({
  config_path: "/config.json",
  home_path: "/home",
  id: "agent-runtime",
  internal_port: 1234,
  model_auth_methods: {},
  model_secrets_required: [],
  runtime: "test-runtime",
  workspace_path: "/workspace",
  ...overrides
});

const context = (
  manager: Partial<RuntimeProbeGateway>,
  runtimeInstance = instance()
): RuntimeStatusProbeContext => ({
  deployment,
  instance: runtimeInstance,
  manager: {
    exec: vi.fn(async () => ({ stderr: "", stdout: "" })),
    httpGet: vi.fn(async () => ({ body: "ok", ok: true })),
    inspectUnit: vi.fn(async () => inspection),
    ...manager
  },
  timeoutMs: 10,
  unit
});

describe("runtime status probe helpers", () => {
  it("reports path probe success, missing report paths, and exec failures", async () => {
    const probe = createRuntimePathProbe({
      id: "workspace",
      key: "runtime.workspace",
      label: "Workspace",
      pathFor: (entry) => entry.workspace_path,
      testFlag: "-d"
    });
    const failingExec = vi.fn(async () => {
      throw new Error("missing");
    });

    await expect(probe.run(context({}))).resolves.toEqual([
      { key: "runtime.workspace", message: "Workspace exists at /workspace", severity: "ok" }
    ]);
    await expect(probe.run(context({}, instance({ workspace_path: undefined })))).resolves.toEqual([
      {
        key: "runtime.workspace",
        message: "Workspace path is not present in the compile report",
        severity: "unknown"
      }
    ]);
    await expect(probe.run(context({ exec: failingExec }))).resolves.toEqual([
      {
        key: "runtime.workspace",
        message: "Workspace missing at /workspace: missing",
        severity: "error"
      }
    ]);
  });

  it("reports HTTP probe success, missing ports, and failed requests", async () => {
    const probe = createRuntimeHttpProbe({
      id: "health",
      key: "runtime.health",
      label: "Health",
      path: "/health",
      portFor: (entry) => entry.internal_port
    });

    await expect(probe.run(context({}))).resolves.toEqual([
      { key: "runtime.health", message: "Health responded on /health", severity: "ok" }
    ]);
    await expect(probe.run(context({}, instance({ internal_port: null })))).resolves.toEqual([
      {
        key: "runtime.health",
        message: "Health port is not present in the compile report",
        severity: "unknown"
      }
    ]);
    await expect(probe.run(context({
      httpGet: vi.fn(async () => ({ body: "", ok: false }))
    }))).resolves.toEqual([
      {
        key: "runtime.health",
        message: "Health failed on /health: request failed",
        severity: "error"
      }
    ]);
  });
});
