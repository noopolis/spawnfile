import { describe, expect, it, vi } from "vitest";

const invocation = {
  correlation: { project_path: "/project" }, id: `lci_${"u".repeat(16)}`,
  operation: "up", request_policy: {}, version: "spawnfile.lifecycle-invocation.v1",
} as const;
const capability = {
  epoch: "00000000-0000-4000-8000-000000000000", role: "recovery",
} as const;
const imageId = `sha256:${"a".repeat(64)}`;
const containerId = "c".repeat(64);
const imageLabels = { "org.opencontainers.image.source": "example" } as const;
const requiredLabels = { "dev.spawnfile.deployment": "default" } as const;
const labelAuthority = {
  permitted_extra_labels: "image-config-labels",
  required: requiredLabels,
} as const;
const reservation = {
  container_name: "organization",
  docker_command: "docker",
  docker_context: "local",
  invocation,
  label_authority: labelAuthority,
  version: "spawnfile.lifecycle-up-reservation.v1",
} as const;
const start = {
  attempt: 0,
  container_id: containerId,
  container_name: "organization",
  image_id: imageId,
  invocation,
  label_authority: labelAuthority,
  version: "spawnfile.lifecycle-up-start.v1",
} as const;
const startState = { attempt: 0, start } as const;
const containerInspect = (labels: unknown = { ...imageLabels, ...requiredLabels }): string => [
  JSON.stringify(containerId), JSON.stringify("/organization"), JSON.stringify(imageId), JSON.stringify(labels),
].join("\n");
const imageInspect = (labels: unknown = imageLabels): string => [
  JSON.stringify(imageId), JSON.stringify(labels),
].join("\n");

interface LoadInput {
  activeStart?: typeof startState | null;
  containerInspect?: Error | string;
  imageInspect?: Error | string;
  record?: unknown;
  recordPresent?: boolean;
  recordStartError?: Error;
  reservation?: typeof reservation | null;
}

const load = async (input: LoadInput = {}) => {
  vi.resetModules();
  let activeStart = input.activeStart ?? null;
  const execFile = vi.fn((_: string, args: string[], __: unknown, callback: Function) => {
    const result = args.includes("container") && args.includes("inspect")
      ? input.containerInspect : args.includes("image") && args.includes("inspect")
        ? input.imageInspect : undefined;
    if (result instanceof Error) return callback(result, { stderr: "", stdout: "" });
    if (typeof result === "string") return callback(null, { stderr: "", stdout: result });
    if (args.includes("rm")) return callback(null, { stderr: "", stdout: "" });
    return callback(new Error("No such object"), { stderr: "", stdout: "" });
  });
  const recordLifecycleUpStart = vi.fn(async (_: unknown, value: Omit<typeof start, "attempt" | "invocation" | "version">) => {
    if (input.recordStartError) throw input.recordStartError;
    activeStart = { attempt: 0, start: { ...value, attempt: 0, invocation, version: start.version } } as typeof startState;
  });
  const recordLifecycleUpCleanup = vi.fn(async () => { activeStart = null; });
  vi.doMock("node:child_process", () => ({ execFile }));
  vi.doMock("node:fs/promises", () => ({
    lstat: vi.fn(async () => {
      if (input.record !== undefined || input.recordPresent) return {};
      throw Object.assign(new Error("missing record"), { code: "ENOENT" });
    }),
  }));
  vi.doMock("../deployment/index.js", () => ({
    createDeploymentInstanceDigest: vi.fn(),
    findLifecycleOutcomeEvidence: vi.fn().mockResolvedValue(null),
    findLifecycleUpReservation: vi.fn().mockResolvedValue(input.reservation === undefined ? reservation : input.reservation),
    findLifecycleUpStart: vi.fn().mockImplementation(async () => activeStart),
    readDeploymentRecord: input.record === undefined
      ? vi.fn().mockRejectedValue(new Error("record absent"))
      : vi.fn().mockResolvedValue(input.record),
    recordLifecycleUpCleanup,
    recordLifecycleUpStart,
    resolveDeploymentRecordPath: vi.fn(() => "/out/deployments/default.json"),
  }));
  vi.doMock("../filesystem/index.js", () => ({
    readUtf8File: vi.fn().mockResolvedValue(JSON.stringify({ compile_fingerprint: "fingerprint" })),
    resolveProjectOutputDirectory: vi.fn(() => "/out"),
  }));
  const module = await import("./upLifecycleRecovery.js");
  return { execFile, recordLifecycleUpCleanup, recordLifecycleUpStart, reconcile: module.reconcileUpLifecycle };
};

const reconcile = (run: Awaited<ReturnType<typeof load>>) => run.reconcile(
  "/project", { context: "local", deployment: "default" }, invocation, capability,
);

describe("up lifecycle recovery", () => {
  it("retries after a fsynced reservation finds no exact container before Docker takes effect", async () => {
    const run = await load();
    await expect(reconcile(run)).resolves.toMatchObject({
      recovery: { kind: "no_docker_mutation" }, status: "provably_not_applied",
    });
    expect(run.recordLifecycleUpStart).not.toHaveBeenCalled();
  });

  it("does not call a reservation-less recovery provably not applied", async () => {
    const run = await load({ reservation: null });
    await expect(reconcile(run)).resolves.toEqual({ status: "resume_safe" });
    expect(run.execFile).not.toHaveBeenCalled();
  });

  it("adopts an exact orphan after Docker started but before its durable start record", async () => {
    const run = await load({ containerInspect: containerInspect(), imageInspect: imageInspect() });
    await expect(reconcile(run)).resolves.toMatchObject({
      recovery: {
        containerId,
        containerName: "organization",
        deploymentLabels: requiredLabels,
        imageId,
        kind: "detached_container",
      },
      status: "resume_safe",
    });
    expect(run.recordLifecycleUpStart).toHaveBeenCalledWith(invocation, {
      container_id: containerId,
      container_name: "organization",
      image_id: imageId,
      label_authority: labelAuthority,
    }, capability);
    expect(run.execFile.mock.calls.map((call) => call[1])).toEqual([
      ["--context", "local", "container", "inspect", "--format",
        "{{json .Id}}\n{{json .Name}}\n{{json .Image}}\n{{json .Config.Labels}}", "organization"],
      ["--context", "local", "image", "inspect", "--format", "{{json .Id}}\n{{json .Config.Labels}}", imageId],
    ]);
    expect(run.recordLifecycleUpCleanup).not.toHaveBeenCalled();
  });

  it("remains ambiguous if inspect fails before the start record can be published", async () => {
    const run = await load({ containerInspect: new Error("transport reset") });
    await expect(reconcile(run)).resolves.toEqual({
      reason: "up_reserved_container_reconciliation_failed", status: "ambiguous",
    });
    expect(run.recordLifecycleUpStart).not.toHaveBeenCalled();
    expect(run.execFile.mock.calls.some((call) => call[1].includes("rm"))).toBe(false);
  });

  it("leaves an exact orphan untouched if durable start-record publication fails", async () => {
    const run = await load({
      containerInspect: containerInspect(), imageInspect: imageInspect(), recordStartError: new Error("record failed"),
    });
    await expect(reconcile(run)).resolves.toEqual({
      reason: "up_reserved_container_reconciliation_failed", status: "ambiguous",
    });
    expect(run.recordLifecycleUpStart).toHaveBeenCalledTimes(1);
    expect(run.execFile.mock.calls.some((call) => call[1].includes("rm"))).toBe(false);
  });

  it("resumes a durably published start only after matching image and label authority", async () => {
    const run = await load({ activeStart: startState, containerInspect: containerInspect(), imageInspect: imageInspect() });
    await expect(reconcile(run)).resolves.toMatchObject({
      recovery: { containerId, containerName: "organization", imageId, kind: "detached_container" },
      status: "resume_safe",
    });
    expect(run.execFile.mock.calls.map((call) => call[1])).toEqual([
      ["--context", "local", "container", "inspect", "--format",
        "{{json .Id}}\n{{json .Name}}\n{{json .Image}}\n{{json .Config.Labels}}", containerId],
      ["--context", "local", "image", "inspect", "--format", "{{json .Id}}\n{{json .Config.Labels}}", imageId],
    ]);
    expect(run.recordLifecycleUpCleanup).not.toHaveBeenCalled();
  });

  it("does not replace a recorded start that has disappeared", async () => {
    const run = await load({
      activeStart: startState,
      containerInspect: new Error("No such container"),
    });
    await expect(reconcile(run)).resolves.toEqual({
      reason: "up_started_container_missing", status: "ambiguous",
    });
    expect(run.execFile.mock.calls.some((call) => call[1].includes("rm"))).toBe(false);
    expect(run.recordLifecycleUpCleanup).not.toHaveBeenCalled();
  });

  it("refuses removal when the recorded image authority drifts", async () => {
    const run = await load({
      activeStart: startState,
      containerInspect: containerInspect({ ...imageLabels, ...requiredLabels }),
      imageInspect: [JSON.stringify(`sha256:${"b".repeat(64)}`), JSON.stringify(imageLabels)].join("\n"),
    });
    await expect(reconcile(run)).resolves.toEqual({ reason: "up_started_container_drifted", status: "ambiguous" });
    expect(run.execFile.mock.calls.some((call) => call[1].includes("rm"))).toBe(false);
  });

  it("keeps the container recorded when image re-verification cannot prove its authority", async () => {
    const run = await load({
      activeStart: startState,
      containerInspect: containerInspect(),
      imageInspect: new Error("No such object"),
    });
    await expect(reconcile(run)).resolves.toEqual({
      reason: "up_started_container_reconciliation_failed", status: "ambiguous",
    });
    expect(run.execFile.mock.calls.some((call) => call[1].includes("rm"))).toBe(false);
    expect(run.recordLifecycleUpCleanup).not.toHaveBeenCalled();
  });

  it("refuses removal for unknown provider labels beyond explicit image-config labels", async () => {
    const run = await load({
      activeStart: startState,
      containerInspect: containerInspect({ ...imageLabels, ...requiredLabels, "provider.extra": "not-authorized" }),
      imageInspect: imageInspect(),
    });
    await expect(reconcile(run)).resolves.toEqual({ reason: "up_started_container_drifted", status: "ambiguous" });
    expect(run.execFile.mock.calls.some((call) => call[1].includes("rm"))).toBe(false);
  });

  it("replays an exact recorded deployment when receipt evidence was lost", async () => {
    const record = {
      auth_profile: null,
      compile_fingerprint: "fingerprint",
      name: "default",
      organization_handoff: {},
      organization_handoff_handle: {},
      output_directory: "/out",
      source: { kind: "project", root: "/project" },
      target: { kind: "context", name: "local" },
      units: [{ container_name: "organization" }],
    };
    const run = await load({ activeStart: startState, record });
    await expect(reconcile(run)).resolves.toMatchObject({
      recovery: { kind: "deployment_record" }, status: "resume_safe",
    });
    expect(run.execFile).not.toHaveBeenCalled();
    expect(run.recordLifecycleUpCleanup).not.toHaveBeenCalled();
  });

  it("does not clean an active start when a present deployment record is unreadable", async () => {
    const run = await load({ activeStart: startState, recordPresent: true });
    await expect(reconcile(run)).resolves.toEqual({
      reason: "up_durable_evidence_absent_or_invalid", status: "ambiguous",
    });
    expect(run.execFile).not.toHaveBeenCalled();
    expect(run.recordLifecycleUpCleanup).not.toHaveBeenCalled();
  });
});
