import os from "node:os";
import path from "node:path";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  claimLifecycleInvocation,
  createDeploymentInstanceDigest,
  createOrganizationHandoff,
  readDeploymentRecord,
  recordLifecycleOutcomeEvidence,
  resolveDeploymentRecordPath,
  writeDeploymentRecord,
} from "../deployment/index.js";
import { buildUpReceipt as buildRealUpReceipt } from "../compiler/index.js";
import { canonicalLifecycleJson } from "../deployment/lifecycleCompletionContracts.js";
import { parseCanonicalSha256Digest } from "../deployment/organizationHandoffTypes.js";
import { parseOpaqueTargetHandle } from "../target/contracts.js";
import { runCli } from "./runCli.js";
import { createUpLifecycleInvocation } from "./upLifecycleInvocation.js";

const priorHome = process.env.SPAWNFILE_HOME;
const project = path.resolve("test/fixtures/single-agent");
let home = "";

const id = (letter: string): string => `lci_${letter.repeat(16)}`;
const streams = () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stderr,
    stdout,
    value: {
      stderr: (message: string) => stderr.push(message),
      stdout: (message: string) => stdout.push(message),
    },
  };
};
const downReceipt = {
  deployment: "default",
  errors: [],
  retained_volumes: [],
  units_stopped: ["default-container"],
  version: "spawnfile.down-receipt.v1" as const,
};
const exportResult = {
  deploymentName: "default",
  failedFiles: [],
  index: {
    deployment: "default",
    exported_at: "2026-01-01T00:00:00.000Z",
    files: [],
    run_id: "run-test",
    version: "spawnfile.export-index.v1" as const,
  },
  indexPath: "/tmp/export/spawnfile/export-index.json",
  missingOptionalFiles: [],
};
const upReceipt = {
  compiled_schedule: [],
  deployment: { container_ids: ["container-123"], name: "default" },
  fingerprint: "sf1:abc123",
  readiness: { moltnet_base_url: null, state: "running" as const },
  run_id: "run-abc123",
  version: "spawnfile.up-receipt.v1" as const,
};
const writeDownRecord = async (): Promise<string> => {
  const compiled = path.join(home, "compiled");
  await writeDeploymentRecord(compiled, {
    auth_profile: null,
    compile_fingerprint: "sf1:abc123",
    created_at: "2026-01-01T00:00:00.000Z",
    manager: "docker",
    name: "default",
    output_directory: compiled,
    run_id: "run-test",
    source: { kind: "project", root: project },
    target: {
      endpoint_fingerprint: `sha256:${"a".repeat(32)}`,
      kind: "context",
      name: "default",
    },
    units: [
      {
        container_id: "container-test",
        container_name: "spawnfile-test",
        contains: [{ id: "agent:test", kind: "agent" }],
        id: "default-container",
        image_id: "image-test",
        image_tag: "spawnfile-test:latest",
        kind: "container",
        runtime_instances: ["agent-test"],
      },
    ],
    version: "spawnfile.deployment.v2",
  });
  return compiled;
};

const expireLifecycleOwner = async (invocation: string): Promise<void> => {
  for (const suffix of ["admission", "heartbeat"]) {
    const file = path.join(
      home,
      "lifecycle-completions",
      `${invocation}.${suffix}`,
    );
    const text = await readFile(file, "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      },
    );
    if (text === null) continue;
    const value = JSON.parse(text) as {
      owner?: { lease_expires_at: number };
      lease_expires_at?: number;
    };
    if (value.owner) value.owner.lease_expires_at = 1;
    else value.lease_expires_at = 1;
    await writeFile(file, `${canonicalLifecycleJson(value)}\n`, { mode: 0o600 });
  }
};

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "spawnfile-lifecycle-cli-"));
  process.env.SPAWNFILE_HOME = home;
});

afterEach(async () => {
  if (priorHome === undefined) delete process.env.SPAWNFILE_HOME;
  else process.env.SPAWNFILE_HOME = priorHome;
  await rm(home, { force: true, recursive: true });
});

describe("machine lifecycle CLI", () => {
  it("claims export before its effect and replays identical bytes", async () => {
    const compiled = await writeDownRecord();
    const effect = vi.fn(async () => exportResult);
    const first = streams();
    const second = streams();
    const argv = [
      "artifacts",
      "export",
      project,
      "--out",
      "/tmp/export",
      "--deployment",
      "default",
      "--compiled",
      compiled,
      "--json",
      "--lifecycle-invocation",
      id("a"),
    ];
    await expect(
      runCli(argv, first.value, { exportRunArtifacts: effect as never }),
    ).resolves.toBe(0);
    const secondCode = await runCli(argv, second.value, {
      exportRunArtifacts: effect as never,
    });
    expect(secondCode, second.stderr.join("\n")).toBe(0);
    expect(effect).toHaveBeenCalledTimes(1);
    expect(second.stdout).toEqual(first.stdout);
  });

  it("replays down after the deployment record has been removed", async () => {
    const compiled = await writeDownRecord();
    let recordPresent = true;
    const effect = vi.fn(async () => {
      if (!recordPresent) throw new Error("deployment record is gone");
      recordPresent = false;
      await rm(resolveDeploymentRecordPath(compiled, "default"));
      return downReceipt;
    });
    const argv = [
      "down",
      project,
      "--deployment",
      "default",
      "--compiled",
      compiled,
      "--json",
      "--lifecycle-invocation",
      id("b"),
    ];
    const first = streams();
    const second = streams();
    await expect(
      runCli(argv, first.value, { downDeployment: effect as never }),
    ).resolves.toBe(0);
    expect(recordPresent).toBe(false);
    await expect(
      runCli(argv, second.value, { downDeployment: effect as never }),
    ).resolves.toBe(0);
    expect(effect).toHaveBeenCalledTimes(1);
    expect(second.stdout).toEqual(first.stdout);
  });

  it("completes down when retained volumes match the request policy", async () => {
    const compiled = await writeDownRecord();
    const retained = {
      ...downReceipt,
      retained_volumes: ["spawnfile-project-memory-abc123"],
    };
    const effect = vi.fn(async () => retained);
    const argv = [
      "down",
      project,
      "--deployment",
      "default",
      "--compiled",
      compiled,
      "--json",
      "--lifecycle-invocation",
      id("m"),
    ];
    const first = streams();
    const second = streams();
    await expect(
      runCli(argv, first.value, { downDeployment: effect as never }),
    ).resolves.toBe(0);
    await expect(
      runCli(argv, second.value, { downDeployment: effect as never }),
    ).resolves.toBe(0);
    expect(effect).toHaveBeenCalledTimes(1);
    expect(JSON.parse(first.stdout[0]!)).toEqual(retained);
    expect(second.stdout).toEqual(first.stdout);
  });

  it("leaves a crashed owner pending and never runs a second effect", async () => {
    const compiled = await writeDownRecord();
    const effect = vi.fn(async () => {
      throw new Error("crash after admission");
    });
    const argv = [
      "down",
      project,
      "--deployment",
      "default",
      "--compiled",
      compiled,
      "--json",
      "--lifecycle-invocation",
      id("c"),
    ];
    const first = streams();
    const second = streams();
    await expect(
      runCli(argv, first.value, { downDeployment: effect as never }),
    ).resolves.toBe(1);
    await expect(
      runCli(argv, second.value, { downDeployment: effect as never }),
    ).resolves.toBe(1);
    expect(effect).toHaveBeenCalledTimes(1);
    expect(second.stderr.join("\n")).toContain("in-flight owner");
  });

  it("recovers an export after its initial owner lease expires", async () => {
    const invocation = id("i");
    const compiled = await writeDownRecord();
    const effect = vi
      .fn()
      .mockRejectedValueOnce(new Error("dead export owner"))
      .mockResolvedValueOnce(exportResult);
    const argv = [
      "artifacts",
      "export",
      project,
      "--out",
      "/tmp/export",
      "--deployment",
      "default",
      "--compiled",
      compiled,
      "--json",
      "--lifecycle-invocation",
      invocation,
    ];
    await expect(
      runCli(argv, streams().value, { exportRunArtifacts: effect as never }),
    ).resolves.toBe(1);
    await expireLifecycleOwner(invocation);
    await expect(
      runCli(argv, streams().value, { exportRunArtifacts: effect as never }),
    ).resolves.toBe(0);
    expect(effect).toHaveBeenCalledTimes(2);
  });

  it("recovers down against the exact deployment after owner death", async () => {
    const invocation = id("j");
    const compiled = await writeDownRecord();
    const effect = vi
      .fn()
      .mockRejectedValueOnce(new Error("dead down owner"))
      .mockResolvedValueOnce(downReceipt);
    const argv = [
      "down",
      project,
      "--deployment",
      "default",
      "--compiled",
      compiled,
      "--force",
      "--json",
      "--lifecycle-invocation",
      invocation,
    ];
    await expect(
      runCli(argv, streams().value, { downDeployment: effect as never }),
    ).resolves.toBe(1);
    await expireLifecycleOwner(invocation);
    await expect(
      runCli(argv, streams().value, { downDeployment: effect as never }),
    ).resolves.toBe(0);
    expect(effect).toHaveBeenCalledTimes(2);
  });

  it("keeps a partial down nonterminal and retries it after the owner lease expires", async () => {
    const invocation = id("l");
    const compiled = await writeDownRecord();
    const effect = vi.fn()
      .mockResolvedValueOnce({
        ...downReceipt,
        errors: ["unable to remove container"],
        units_stopped: [],
      })
      .mockResolvedValueOnce(downReceipt);
    const argv = [
      "down",
      project,
      "--deployment",
      "default",
      "--compiled",
      compiled,
      "--force",
      "--json",
      "--lifecycle-invocation",
      invocation,
    ];
    const first = streams();
    await expect(runCli(argv, first.value, {
      downDeployment: effect as never,
    })).resolves.toBe(1);
    expect(first.stderr.join("\n")).toContain("remains retryable");
    await expireLifecycleOwner(invocation);
    const second = streams();
    await expect(runCli(argv, second.value, {
      downDeployment: effect as never,
    })).resolves.toBe(0);
    expect(effect).toHaveBeenCalledTimes(2);
    expect(JSON.parse(second.stdout[0]!)).toEqual(downReceipt);
  });

  it("does not resume export after an identity-only same-name redeploy", async () => {
    const invocation = id("k");
    const compiled = await writeDownRecord();
    const effect = vi.fn(async () => {
      throw new Error("dead export owner");
    });
    const argv = [
      "artifacts",
      "export",
      project,
      "--out",
      "/tmp/export",
      "--deployment",
      "default",
      "--compiled",
      compiled,
      "--json",
      "--lifecycle-invocation",
      invocation,
    ];
    await runCli(argv, streams().value, {
      exportRunArtifacts: effect as never,
    });
    await expireLifecycleOwner(invocation);
    const record = JSON.parse(
      await readFile(resolveDeploymentRecordPath(compiled, "default"), "utf8"),
    );
    await writeDeploymentRecord(compiled, {
      ...record,
      units: record.units.map(
        (unit: Record<string, unknown>, index: number) =>
          index === 0
            ? {
                ...unit,
                container_id: "replacement-container",
                image_id: "replacement-image",
              }
            : unit,
      ),
    });
    const retry = streams();
    await expect(
      runCli(argv, retry.value, { exportRunArtifacts: effect as never }),
    ).resolves.toBe(1);
    expect(effect).toHaveBeenCalledTimes(1);
    expect(retry.stderr.join("\n")).toContain("ambiguous");
  });

  it("rejects invocation drift before another owner effect", async () => {
    const compiled = await writeDownRecord();
    const effect = vi.fn(async () => downReceipt);
    const base = [
      "down",
      project,
      "--deployment",
      "default",
      "--compiled",
      compiled,
      "--json",
      "--lifecycle-invocation",
      id("d"),
    ];
    await runCli(base, streams().value, { downDeployment: effect as never });
    const drift = streams();
    await expect(
      runCli([...base, "--volumes"], drift.value, {
        downDeployment: effect as never,
      }),
    ).resolves.toBe(1);
    expect(effect).toHaveBeenCalledTimes(1);
    expect(drift.stderr.join("\n")).toContain("invocation id drift");
  });

  it("fails malformed outcome completion closed and remains pending", async () => {
    const compiled = await writeDownRecord();
    const malformed = {
      ...downReceipt,
      version: "not-a-receipt",
    };
    const effect = vi.fn(async () => malformed);
    const argv = [
      "down",
      project,
      "--deployment",
      "default",
      "--compiled",
      compiled,
      "--json",
      "--lifecycle-invocation",
      id("e"),
    ];
    await expect(
      runCli(argv, streams().value, { downDeployment: effect as never }),
    ).resolves.toBe(1);
    const retry = streams();
    await expect(
      runCli(argv, retry.value, { downDeployment: effect as never }),
    ).resolves.toBe(1);
    expect(effect).toHaveBeenCalledTimes(1);
    expect(retry.stderr.join("\n")).toContain("in-flight owner");
  });

  it("stores digests rather than secret-bearing up bindings", async () => {
    const secret = "PRIVATE_NETWORK_HANDLE";
    const selectedReceipt = path.join(home, "selected-target.json");
    await writeFile(selectedReceipt, "{}");
    const upProject = vi.fn(async () => ({
      report: { compile_fingerprint: "sf1:abc123" },
    }));
    const result = streams();
    await expect(
      runCli(
        [
          "up",
          project,
          "--json",
          "--lifecycle-invocation",
          id("f"),
          "--detach",
          "--deployment",
          "default",
          "--auth-profile",
          "private-profile",
          "--env-file",
          "/tmp/private.env",
          "--organization-handoff-run-id",
          "run-abc123",
          "--descriptor-digest",
          `sha256:${"b".repeat(64)}`,
          "--selected-target-receipt",
          selectedReceipt,
          "--network-attachment-handle",
          secret,
          "--selected-target-receipt-digest",
          `sha256:${"a".repeat(64)}`,
          "--world-bindings",
          "/tmp/private-bindings.json",
        ],
        result.value,
        {
          buildUpReceipt: vi.fn(async () => upReceipt) as never,
          upProject: upProject as never,
        },
      ),
    ).resolves.toBe(0);
    const admission = await readFile(
      path.join(home, "lifecycle-completions", `${id("f")}.admission`),
      "utf8",
    );
    expect(admission).not.toContain(secret);
    expect(admission).not.toContain("private-profile");
    expect(admission).not.toContain("private.env");
    expect(admission).not.toContain("private-bindings");
    expect(admission).toContain("network_attachment_handle_digest");
  });

  it("reconstructs up after post-deployment owner death without a second up", async () => {
    const invocation = id("h");
    const projectCopy = path.join(home, "project");
    await cp(project, projectCopy, { recursive: true });
    const compiled = path.join(home, "up-compiled");
    const networkHandle = `opaque_${"e".repeat(16)}`;
    const selectedDigest = `sha256:${"a".repeat(64)}`;
    const handoff = createOrganizationHandoff("run-abc123", {
      bindingDigest: parseCanonicalSha256Digest(`sha256:${"b".repeat(64)}`),
      networkAttachmentHandle: parseOpaqueTargetHandle(networkHandle),
      selectedTargetReceiptDigest:
        parseCanonicalSha256Digest(selectedDigest),
    });
    const recordPath = await writeDeploymentRecord(compiled, {
        auth_profile: null,
        compile_fingerprint: "sf1:abc123",
        created_at: "2026-01-01T00:00:00.000Z",
        manager: "docker",
        name: "default",
        organization_handoff: handoff,
        organization_handoff_handle: parseOpaqueTargetHandle(
          `opaque_${"f".repeat(16)}`,
        ),
        output_directory: compiled,
        run_id: "run-abc123",
        source: { kind: "project", root: projectCopy },
        target: {
          endpoint_fingerprint: `sha256:${"a".repeat(32)}`,
          kind: "context",
          name: "default",
        },
        units: [
          {
            container_id: "container-123",
            container_name: "spawnfile-test",
            contains: [{ id: "agent:test", kind: "agent" }],
            id: "default-container",
            image_id: "image-test",
            image_tag: "spawnfile-test:latest",
            kind: "container",
            runtime_instances: ["agent-test"],
          },
        ],
        version: "spawnfile.deployment.v2",
      });
    const report = {
      compile_fingerprint: "sf1:abc123",
      diagnostics: [],
      nodes: [],
      root: projectCopy,
      spawnfile_version: "0.1" as const,
    };
    await writeFile(
      path.join(compiled, "spawnfile-report.json"),
      JSON.stringify(report),
    );
    const initialResult = {
      authProfileName: null,
      containerName: "spawnfile-test",
      deploymentRecordPath: recordPath,
      imageTag: "spawnfile-test:latest",
      organizationReadinessEvidence: undefined as never,
      outputDirectory: compiled,
      report,
      reportPath: path.join(compiled, "spawnfile-report.json"),
      supportDirectory: null,
    };
    const exact = createUpLifecycleInvocation(projectCopy, {
      deployment: "default",
      descriptorDigest: `sha256:${"c".repeat(64)}`,
      detach: true,
      lifecycleInvocation: invocation,
      networkAttachmentHandle: networkHandle,
      organizationHandoffRunId: "run-abc123",
      out: compiled,
      selectedTargetReceiptDigest: selectedDigest,
      worldBindings: "/tmp/world-bindings.json",
    });
    const claim = await claimLifecycleInvocation(exact);
    if (claim.status !== "owner") throw new Error("expected initial owner");
    const originalReceipt = await buildRealUpReceipt(projectCopy, initialResult);
    await recordLifecycleOutcomeEvidence(
      exact,
      JSON.stringify(originalReceipt, null, 2),
      claim.capability,
      createDeploymentInstanceDigest(
        await readDeploymentRecord(recordPath),
      ),
    );
    await expireLifecycleOwner(invocation);
    await writeFile(
      path.join(projectCopy, "Spawnfile"),
      `${await readFile(path.join(projectCopy, "Spawnfile"), "utf8")}\nschedule:\n  kind: cron\n  cron: \"0 5 * * *\"\n`,
    );
    const upProject = vi.fn();
    const buildUpReceipt = vi.fn(buildRealUpReceipt);
    const argv = [
      "up",
      projectCopy,
      "--out",
      compiled,
      "--json",
      "--lifecycle-invocation",
      invocation,
      "--detach",
      "--deployment",
      "default",
      "--organization-handoff-run-id",
      "run-abc123",
      "--descriptor-digest",
      `sha256:${"c".repeat(64)}`,
      "--selected-target-receipt",
      "/tmp/selected-target.json",
      "--network-attachment-handle",
      networkHandle,
      "--selected-target-receipt-digest",
      selectedDigest,
      "--world-bindings",
      "/tmp/world-bindings.json",
    ];
    const recovered = streams();
    const recoveryCode = await runCli(argv, recovered.value, {
        buildUpReceipt: buildUpReceipt as never,
        upProject: upProject as never,
      });
    expect(recoveryCode, recovered.stderr.join("\n")).toBe(0);
    expect(upProject).not.toHaveBeenCalled();
    expect(buildUpReceipt).not.toHaveBeenCalled();
    expect(recovered.stdout).toEqual([
      JSON.stringify(originalReceipt, null, 2),
    ]);
  });

  it("lookup is read-only and returns the strict versioned machine state", async () => {
    const result = streams();
    await expect(
      runCli(["lifecycle", "lookup", id("g")], result.value),
    ).resolves.toBe(0);
    expect(JSON.parse(result.stdout[0]!)).toEqual({
      invocation_id: id("g"),
      status: "not_applied",
      version: "spawnfile.lifecycle-lookup.v1",
    });
  });
});
