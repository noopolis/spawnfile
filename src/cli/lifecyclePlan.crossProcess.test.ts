import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { writeDeploymentRecord } from "../deployment/index.js";
import {
  canonicalLifecycleJson,
  lifecycleInvocationSchema,
} from "../deployment/lifecycleCompletionContracts.js";

const roots: string[] = [];

const child = (
  home: string,
  request: unknown,
): Promise<{ code: number | null; stderr: string; stdout: string }> =>
  new Promise((resolve, reject) => {
    const processChild = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/cli/index.ts",
        "lifecycle",
        "plan",
        "--request",
        "-",
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, SPAWNFILE_HOME: home },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stderr = "";
    let stdout = "";
    const timer = setTimeout(() => {
      processChild.kill("SIGKILL");
      reject(new Error("lifecycle plan child timed out"));
    }, 10_000);
    processChild.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    processChild.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    processChild.on("error", reject);
    processChild.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stderr, stdout });
    });
    processChild.stdin.end(JSON.stringify(request));
  });

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("lifecycle plan cross process", () => {
  // Deferred P3: add a simultaneous multi-process plan-vs-execute stress
  // matrix after the first composed match; atomic publication is covered in-process.
  it("emits the same canonical admitted invocation from separate processes", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "spawnfile-lifecycle-plan-child-"),
    );
    roots.push(root);
    const home = path.join(root, "home");
    const compiled = path.join(root, "compiled");
    await writeDeploymentRecord(compiled, {
      auth_profile: null,
      compile_fingerprint: "sf1:child",
      created_at: "2026-01-01T00:00:00.000Z",
      manager: "docker",
      name: "child",
      output_directory: compiled,
      run_id: "run-child",
      source: { kind: "project", root },
      target: { kind: "host", value: "local" },
      units: [
        {
          container_id: "container-child",
          container_name: "organization",
          contains: [{ id: "agent:one", kind: "agent" }],
          id: "organization",
          image_id: "sha256:child",
          image_tag: "child:latest",
          kind: "container",
          runtime_instances: ["agent-one"],
        },
      ],
      version: "spawnfile.deployment.v2",
    });
    const request = {
      compiled,
      deployment: "child",
      docker_command: null,
      export_to: null,
      force: true,
      lifecycle_invocation_id: "lci_child00000000000",
      operation: "down",
      path: root,
      reader_image: null,
      remove_volumes: false,
      timeout_ms: null,
      version: "spawnfile.lifecycle-plan-request.v1",
    };
    const first = await child(home, request);
    const second = await child(home, request);
    expect(first).toMatchObject({ code: 0, stderr: "" });
    expect(second).toEqual(first);
    const invocation = lifecycleInvocationSchema.parse(JSON.parse(first.stdout));
    expect(first.stdout).toBe(
      `${JSON.stringify(invocation, null, 2)}\n`,
    );
    expect(canonicalLifecycleJson(invocation)).toContain(
      '"version":"spawnfile.lifecycle-invocation.v1"',
    );
  }, 20_000);
});
