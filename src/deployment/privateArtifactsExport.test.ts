import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { CompileReport } from "../report/index.js";

import { exportPrivateRuntimeArtifacts } from "./privateArtifactsExport.js";

const report: CompileReport = {
  container: {
    dockerfile: "container/Dockerfile",
    entrypoint: "container/entrypoint",
    env_example: "container/.env.example",
    model_secrets_required: [],
    ports: [],
    runtime_homes: [],
    runtime_instances: [{
      config_path: "/spawn/instances/team/config/pi-app.json",
      home_path: "/spawn/instances/team/home",
      id: "team",
      model_auth_methods: {},
      model_secrets_required: [],
      node_ids: ["agent:blue", "agent:red", "team:root"],
      runtime: "daimon",
    }],
    runtime_secrets_required: [],
    runtimes_installed: [],
    secrets_required: [],
  },
  diagnostics: [],
  nodes: [],
  root: "/project",
  spawnfile_version: "0.1",
};

describe("exportPrivateRuntimeArtifacts", () => {
  it("copies only explicit private Pi roots and indexes exact regular bytes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "spawnfile-private-export-"));
    try {
      const execFile = async (_file: string, args: string[]) => {
        const source = args.at(-2)!;
        const destination = args.at(-1)!;
        const team = source.includes("/blue/") ? "blue" : "red";
        const turn = path.join(destination, "turns", `turn-${team}`);
        await mkdir(turn, { recursive: true });
        await writeFile(path.join(turn, "manifest.json"), `{"agent":"${team}"}\n`);
        await writeFile(path.join(destination, ".sentinel"), "");
        return { stderr: "", stdout: "" };
      };
      const result = await exportPrivateRuntimeArtifacts({
        containerRef: "organization",
        destinationDirectory: root,
        dockerCommand: "docker",
        execFile,
        report,
        target: {
          endpoint_fingerprint: "sha256:0123456789abcdef0123456789abcdef",
          kind: "context",
          name: "gpu-host",
        },
        timeoutMs: 1_000,
      });

      expect(result.missing).toEqual([]);
      expect(result.files.map(({ path: file }) => file).sort()).toEqual([
        "private/daimon/blue/private-training/pi/raw/.sentinel",
        "private/daimon/blue/private-training/pi/raw/turns/turn-blue/manifest.json",
        "private/daimon/red/private-training/pi/raw/.sentinel",
        "private/daimon/red/private-training/pi/raw/turns/turn-red/manifest.json",
      ]);
      expect(result.files.filter(({ bytes }) => bytes === 0)).toHaveLength(2);
      expect(result.files.every(({ source }) =>
        source.kind === "container"
        && source.ref.startsWith("organization:/spawn/instances/team/runtime/agents/"),
      )).toBe(true);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("reports every missing opted-in private root without partial output", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "spawnfile-private-missing-"));
    try {
      const result = await exportPrivateRuntimeArtifacts({
        containerRef: "organization",
        destinationDirectory: root,
        dockerCommand: "docker",
        execFile: async () => {
          throw new Error("missing");
        },
        report,
        target: {
          endpoint_fingerprint: "sha256:0123456789abcdef0123456789abcdef",
          kind: "context",
          name: "gpu-host",
        },
        timeoutMs: 1_000,
      });
      expect(result.files).toEqual([]);
      expect(result.missing).toEqual([
        "private/daimon/blue/private-training/pi/raw",
        "private/daimon/red/private-training/pi/raw",
      ]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
