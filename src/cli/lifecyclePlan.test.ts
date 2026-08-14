import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  assertDeploymentLifecycleCorrelation,
  readDeploymentRecord,
  resolveDeploymentRecordPath,
  writeDeploymentRecord,
} from "../deployment/index.js";
import { canonicalLifecycleJson } from "../deployment/lifecycleCompletionContracts.js";

import { runCli } from "./runCli.js";

const priorHome = process.env.SPAWNFILE_HOME;
const project = path.resolve("examples/single-agent");
let home = "";
let compiled = "";
const invocationId = "lci_plan000000000000";

const output = () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stderr,
    stdout,
    streams: {
      stderr: (line: string) => stderr.push(line),
      stdout: (line: string) => stdout.push(line),
    },
  };
};

const stdin = (value: unknown) =>
  (async function* (): AsyncGenerator<string> {
    yield JSON.stringify(value);
  })();

const writeRecord = async (): Promise<void> => {
  compiled = path.join(home, "compiled");
  await writeDeploymentRecord(compiled, {
    auth_profile: null,
    compile_fingerprint: "sf1:plan",
    created_at: "2026-01-01T00:00:00.000Z",
    manager: "docker",
    name: "default",
    output_directory: compiled,
    run_id: "run-plan",
    source: { kind: "project", root: project },
    target: {
      endpoint_fingerprint: `sha256:${"a".repeat(32)}`,
      kind: "context",
      name: "gpu",
    },
    units: [
      {
        container_id: "container-plan",
        container_name: "organization",
        contains: [{ id: "agent:one", kind: "agent" }],
        id: "organization",
        image_id: "sha256:image",
        image_tag: "example:latest",
        kind: "container",
        runtime_instances: ["agent-one"],
      },
    ],
    version: "spawnfile.deployment.v2",
  });
};

const downRequest = () => ({
  compiled,
  deployment: "default",
  docker_command: null,
  export_to: null,
  force: true,
  lifecycle_invocation_id: invocationId,
  operation: "down",
  path: project,
  reader_image: null,
  remove_volumes: false,
  timeout_ms: null,
  version: "spawnfile.lifecycle-plan-request.v1",
});
const exportRequest = () => ({
  compiled,
  deployment: "default",
  docker_command: null,
  include_private: false,
  lifecycle_invocation_id: "lci_export0000000000",
  operation: "artifacts_export",
  out: path.join(home, "export"),
  path: project,
  reader_image: null,
  run_id: null,
  timeout_ms: null,
  version: "spawnfile.lifecycle-plan-request.v1",
});

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "spawnfile-lifecycle-plan-"));
  process.env.SPAWNFILE_HOME = home;
  await writeRecord();
});

afterEach(async () => {
  if (priorHome === undefined) delete process.env.SPAWNFILE_HOME;
  else process.env.SPAWNFILE_HOME = priorHome;
  await rm(home, { force: true, recursive: true });
});

describe("lifecycle plan", () => {
  it("admits one exact no-effect down invocation and execution derives identical bytes", async () => {
    const planOutput = output();
    const effect = vi.fn(async () => ({
      deployment: "default",
      errors: [],
      retained_volumes: [],
      units_stopped: ["organization"],
      version: "spawnfile.down-receipt.v1" as const,
    }));
    const planCode = await runCli(["lifecycle", "plan", "--request", "-"], {
        handlers: { downDeployment: effect },
        stdin: stdin(downRequest()),
        streams: planOutput.streams,
      });
    expect(planCode, planOutput.stderr.join("\n")).toBe(0);
    expect(effect).not.toHaveBeenCalled();
    const planned = JSON.parse(planOutput.stdout.join("\n"));
    expect(planned).toEqual({
      correlation: {
        compile_fingerprint: "sf1:plan",
        compiled_output_directory: compiled,
        deployment: "default",
        deployment_instance_digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        run_id: "run-plan",
        target: JSON.stringify({
          endpoint_fingerprint: `sha256:${"a".repeat(32)}`,
          kind: "context",
          name: "gpu",
        }),
      },
      id: invocationId,
      operation: "down",
      request_policy: {
        docker_command: null,
        export_to: null,
        force: true,
        reader_image: null,
        remove_volumes: false,
        timeout_ms: null,
      },
      version: "spawnfile.lifecycle-invocation.v1",
    });

    const runOutput = output();
    expect(
      await runCli(
        [
          "down",
          project,
          "--deployment",
          "default",
          "--compiled",
          compiled,
          "--force",
          "--json",
          "--lifecycle-invocation",
          invocationId,
        ],
        runOutput.streams,
        { downDeployment: effect },
      ),
    ).toBe(0);
    expect(effect).toHaveBeenCalledTimes(1);
    const admission = JSON.parse(
      await readFile(
        path.join(home, "lifecycle-completions", `${invocationId}.admission`),
        "utf8",
      ),
    );
    expect(canonicalLifecycleJson(admission.invocation)).toBe(
      canonicalLifecycleJson(planned),
    );
  });

  it("refuses request or deployment drift before any effect", async () => {
    const first = output();
    const firstCode = await runCli(["lifecycle", "plan", "--request", "-"], {
        stdin: stdin(downRequest()),
        streams: first.streams,
      });
    expect(firstCode, first.stderr.join("\n")).toBe(0);

    const recordPath = resolveDeploymentRecordPath(compiled, "default");
    const record = await readDeploymentRecord(recordPath);
    await writeDeploymentRecord(compiled, {
      ...record,
      compile_fingerprint: "sf1:changed",
    });
    const providerEffect = vi.fn();
    const effect = vi.fn(async (options: {
      expectedLifecycleCorrelation?: Parameters<
        typeof assertDeploymentLifecycleCorrelation
      >[1];
    }) => {
      assertDeploymentLifecycleCorrelation(
        await readDeploymentRecord(recordPath),
        options.expectedLifecycleCorrelation,
      );
      providerEffect();
      throw new Error("unexpected");
    });
    const drifted = output();
    expect(
      await runCli(
        [
          "down",
          project,
          "--deployment",
          "default",
          "--compiled",
          compiled,
          "--force",
          "--json",
          "--lifecycle-invocation",
          invocationId,
        ],
        drifted.streams,
        { downDeployment: effect as never },
      ),
    ).toBe(1);
    expect(effect).toHaveBeenCalledTimes(1);
    expect(providerEffect).not.toHaveBeenCalled();
    expect(drifted.stderr.join("\n")).toContain(
      "Deployment changed after lifecycle admission",
    );

    const changedPolicy = output();
    expect(
      await runCli(
        ["lifecycle", "plan", "--request", "-"],
        {
          stdin: stdin({ ...downRequest(), force: false }),
          streams: changedPolicy.streams,
        },
      ),
    ).toBe(1);
    expect(changedPolicy.stderr.join("\n")).toContain("invocation id drift");
  });

  it("plans artifacts export from the same public selection and policy as execution", async () => {
    const plannedOutput = output();
    expect(
      await runCli(["lifecycle", "plan", "--request", "-"], {
        stdin: stdin(exportRequest()),
        streams: plannedOutput.streams,
      }),
    ).toBe(0);
    const planned = JSON.parse(plannedOutput.stdout.join("\n"));
    expect(planned).toMatchObject({
      correlation: {
        compile_fingerprint: "sf1:plan",
        compiled_output_directory: compiled,
        deployment: "default",
        deployment_selection: "default",
        run_id: "run-plan",
        run_id_selection: null,
      },
      id: exportRequest().lifecycle_invocation_id,
      operation: "artifacts_export",
      request_policy: {
        destination_directory: path.join(home, "export"),
        docker_command: null,
        include_private: false,
        reader_image: null,
        timeout_ms: null,
      },
      version: "spawnfile.lifecycle-invocation.v1",
    });

    const effect = vi.fn(async () => ({
      deploymentName: "default",
      failedFiles: [],
      index: {
        deployment: "default",
        exported_at: "2026-01-01T00:00:00.000Z",
        files: [],
        run_id: "run-plan",
        version: "spawnfile.export-index.v1" as const,
      },
      indexPath: path.join(home, "export", "spawnfile", "export-index.json"),
      missingOptionalFiles: [],
    }));
    const executed = output();
    expect(
      await runCli(
        [
          "artifacts",
          "export",
          project,
          "--out",
          path.join(home, "export"),
          "--deployment",
          "default",
          "--compiled",
          compiled,
          "--json",
          "--lifecycle-invocation",
          exportRequest().lifecycle_invocation_id,
        ],
        executed.streams,
        { exportRunArtifacts: effect as never },
      ),
    ).toBe(0);
    expect(effect).toHaveBeenCalledTimes(1);
    const admission = JSON.parse(
      await readFile(
        path.join(
          home,
          "lifecycle-completions",
          `${exportRequest().lifecycle_invocation_id}.admission`,
        ),
        "utf8",
      ),
    );
    expect(canonicalLifecycleJson(admission.invocation)).toBe(
      canonicalLifecycleJson(planned),
    );
  });

  it("rejects unknown request fields and documents the public command", async () => {
    const invalid = output();
    expect(
      await runCli(["lifecycle", "plan", "--request", "-"], {
        stdin: stdin({ ...downRequest(), private_config_id: "forbidden" }),
        streams: invalid.streams,
      }),
    ).toBe(2);
    expect(invalid.stderr).toEqual(["error: Invalid lifecycle plan request"]);
    const duplicate = output();
    const source = JSON.stringify(downRequest()).replace(
      '"force":true',
      '"force":false,"force":true',
    );
    expect(
      await runCli(["lifecycle", "plan", "--request", "-"], {
        stdin: (async function* () {
          yield source;
        })(),
        streams: duplicate.streams,
      }),
    ).toBe(2);
    expect(duplicate.stderr).toEqual([
      "error: Invalid lifecycle plan request",
    ]);

    const help = output();
    expect(
      await runCli(["lifecycle", "plan", "--help"], {
        stdin: stdin({}),
        streams: help.streams,
      }),
    ).toBe(0);
    expect(help.stdout.join("\n")).toContain(
      "spawnfile.lifecycle-plan-request.v1",
    );
  });
});
