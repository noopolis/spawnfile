import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../compiler/index.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../compiler/index.js")>(),
  compileProject: vi.fn(),
}));

import { compileProject, type BuildProjectResult, type CompileProjectResult, type UpProjectResult } from "../compiler/index.js";
import { writeUtf8File } from "../filesystem/index.js";
import type { CompileReport } from "../report/index.js";
import { REPORT_FILENAME } from "../shared/index.js";

import { runDaimonOrgE2E } from "./daimonOrg.js";
import { cleanup } from "./moltnetE2ESupport.js";
import { runOperationalSmokeE2E, type OperationalSmokeDependencies } from "./operationalSmoke.js";

const roots: string[] = [];
const makeRoot = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "spawnfile-e2e-recorded-memory-"));
  roots.push(root);
  return root;
};
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
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
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

  it.each([false, true])("local-rootfs cleanup preserves ledgers exactly when recording=%s", async (enabled) => {
    const root = await makeRoot();
    const ledger = path.join(root, "container", "rootfs", "memory", "events.jsonl");
    await mkdir(path.dirname(ledger), { recursive: true });
    await writeUtf8File(ledger, '{"seq":1}\n');
    vi.mocked(compileProject).mockResolvedValue({ outputDirectory: root, report: report(enabled), reportPath: "/fixture-report" } as CompileProjectResult);
    await expect(runDaimonOrgE2E({ outputDirectory: root, keepArtifacts: false }))
      .rejects.toThrow(enabled ? "--discard-recorded-memory" : "did not include a generated Daimon instance");
    if (enabled) await expect(readFile(ledger, "utf8")).resolves.toBe('{"seq":1}\n');
    else await expect(readFile(ledger, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses recording before local runtime setup even when artifacts would be kept", async () => {
    const root = await makeRoot();
    vi.mocked(compileProject).mockResolvedValue({ outputDirectory: root, report: report(), reportPath: "/fixture-report" } as CompileProjectResult);
    await expect(runDaimonOrgE2E({ outputDirectory: root, keepArtifacts: true }))
      .rejects.toThrow("Local-rootfs E2E recording requires --discard-recorded-memory");
  });

  it.each([false, true])("protects prior recorded output before compile unless discard=%s", async (discardRecordedMemory) => {
    const root = await makeRoot();
    const ledger = path.join(root, "events.jsonl");
    await writeUtf8File(ledger, '{"seq":1}\n');
    await writeUtf8File(path.join(root, REPORT_FILENAME), JSON.stringify(report()));
    vi.mocked(compileProject).mockResolvedValue({ outputDirectory: root, report: report(false), reportPath: "/fixture-report" } as CompileProjectResult);
    await expect(runDaimonOrgE2E({ outputDirectory: root, keepArtifacts: false, discardRecordedMemory }))
      .rejects.toThrow(discardRecordedMemory ? "did not include a generated Daimon instance" : "--discard-recorded-memory");
    if (discardRecordedMemory) {
      expect(compileProject).toHaveBeenCalledOnce();
      await expect(readFile(ledger, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } else {
      expect(compileProject).not.toHaveBeenCalled();
      await expect(readFile(ledger, "utf8")).resolves.toBe('{"seq":1}\n');
    }
  });
});
