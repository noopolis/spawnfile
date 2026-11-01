import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../compiler/index.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../compiler/index.js")>(),
  compileProject: vi.fn(),
}));

import { compileProject, type BuildProjectResult, type UpProjectResult } from "../compiler/index.js";
import type { CompileReport } from "../report/index.js";

import { cleanup } from "./moltnetE2ESupport.js";
import { runOperationalSmokeE2E, type OperationalSmokeDependencies } from "./operationalSmoke.js";

const report = (enabled = true): CompileReport => ({
  container: {
    dockerfile: "Dockerfile", entrypoint: "entrypoint", env_example: ".env.example", model_secrets_required: [],
    persistent_mounts: [{ id: "memory-recall", mount_path: "/memory", reason: "memory", volume_name: "recorded-memory" }],
    ports: [], runtime_homes: [], runtime_instances: [], runtime_secrets_required: [], runtimes_installed: [], secrets_required: [],
  },
  diagnostics: [], nodes: [], root: "/fixture", spawnfile_version: "0.1",
  ...(enabled ? { recording: { keep_ms: 1, memory_mount_ids: ["memory-recall"] } } : {}),
});
const buildResult = (enabled = true): BuildProjectResult => ({
  imageTag: "fixture:latest", outputDirectory: "/fixture-output", report: report(enabled), reportPath: "/fixture-report",
}) as BuildProjectResult;

afterEach(async () => {
  vi.mocked(compileProject).mockReset();
});

describe("E2E recorded memory retention", () => {
  it("refuses generic Moltnet cleanup before any Docker deletion", async () => {
    const runCommand = vi.fn(async () => "");
    await expect(cleanup({ buildResult: buildResult(), dockerCommand: "docker", keepImages: false, runCommand }))
      .rejects.toThrow("automatic E2E cleanup cannot discard recorded memory");
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("preserves generic cleanup behavior when recording is off", async () => {
    const runCommand = vi.fn(async () => "");
    await cleanup({ buildResult: buildResult(false), dockerCommand: "docker", keepImages: false, runCommand });
    expect(runCommand).toHaveBeenCalledWith("docker", ["volume", "rm", "-f", "recorded-memory"]);
  });

  it("refuses operational smoke cleanup before container, image, or volume deletion", async () => {
    const runDockerCommand = vi.fn(async (_dockerCommand: string, _args: string[]) => { throw new Error("stop before runtime checks"); });
    const removeDirectory = vi.fn(async () => undefined);
    const runCli = vi.fn(async (_argv: string[], _streams: unknown,
      handlers?: { upProject?: typeof import("../compiler/index.js").upProject }) => {
      await handlers?.upProject?.("/fixture", {});
      return 0;
    }) as unknown as NonNullable<OperationalSmokeDependencies["runCli"]>;
    await expect(runOperationalSmokeE2E({ logger: { info: () => undefined }, pollIntervalMs: 1, timeoutMs: 1 }, {
      removeDirectory, runCli, runDockerCommand, sleep: async () => undefined,
      upProject: async () => ({ ...buildResult(), containerName: "recorded-container" }) as UpProjectResult,
    })).rejects.toThrow("automatic E2E cleanup cannot discard recorded memory");
    expect(runDockerCommand.mock.calls.some(([, args]) => args.includes("rm"))).toBe(false);
    expect(removeDirectory).not.toHaveBeenCalled();
  });
});
