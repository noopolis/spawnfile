import os from "node:os";
import path from "node:path";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import type { DockerTargetExecFile } from "../target/dockerTarget.js";

import {
  createTargetConfigResolutionBytes,
  resolveTargetConfig,
  STANDARD_WORLD_BASE_IMAGE,
} from "./targetConfigResolver.js";

const roots: string[] = [];
const digest = (character: string): string => `sha256:${character.repeat(64)}`;

const privateEvidenceDestination = async (): Promise<string> => {
  // The resolver requires the destination's parent to be a *physical* private
  // dir (realpath(parent) === parent), so resolve os.tmpdir()'s symlinks first
  // — on macOS it is /var → /private/var, which fails the check otherwise.
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "spawnfile-target-resolver-")));
  roots.push(root);
  return path.join(root, "world-evidence.tar");
};

interface FakeDockerOptions {
  readonly architecture?: string;
  readonly endpoint?: string;
  readonly imageArchitecture?: string;
  readonly imageId?: string;
  readonly imageInspectFails?: boolean;
  readonly imageOs?: string;
  readonly os?: string;
}

const fakeDocker = (options: FakeDockerOptions = {}) => {
  const calls: string[][] = [];
  const execFile: DockerTargetExecFile = async (_command, args) => {
    calls.push([...args]);
    if (args[0] === "context" && args[1] === "show") {
      return { stderr: "", stdout: "local-dev\n" };
    }
    if (args[0] === "context" && args[1] === "inspect") {
      return {
        stderr: "",
        stdout: `${JSON.stringify(options.endpoint ?? "unix:///tmp/docker.sock")}\n`,
      };
    }
    if (args[2] === "info") {
      return {
        stderr: "",
        stdout: JSON.stringify({
          Architecture: options.architecture ?? "aarch64",
          OSType: options.os ?? "linux",
        }),
      };
    }
    if (args[2] === "image" && args[3] === "pull") {
      return { stderr: "", stdout: `${digest("f")}\n` };
    }
    if (args[2] === "image" && args[3] === "inspect") {
      if (options.imageInspectFails === true) throw new Error("missing");
      return {
        stderr: "",
        stdout: JSON.stringify({
          Architecture: options.imageArchitecture ?? options.architecture ?? "arm64",
          Id: options.imageId ?? digest("a"),
          Os: options.imageOs ?? "linux",
        }),
      };
    }
    throw new Error(`unexpected Docker args: ${args.join(" ")}`);
  };
  return { calls, execFile };
};

const preparedMapping = Object.freeze({
  archive_digest: digest("1"),
  artifact_manifest_digest: digest("2"),
  base_image_config_digest: digest("3"),
  build_policy_digest: digest("4"),
  bundle_digest: digest("5"),
  entrypoint: "bin/world-service",
  launcher_digest: digest("6"),
  network_alias: "world-service",
  platform: Object.freeze({ architecture: "arm64" as const, os: "linux" as const }),
  platform_digest: digest("7"),
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("target config resolver", () => {
  it("resolves an explicit local context read-only with the standard base image", async () => {
    const evidenceDestination = await privateEvidenceDestination();
    const docker = fakeDocker();
    const resolution = await resolveTargetConfig({
      context: "local-dev",
      evidenceDestination,
      execFile: docker.execFile,
    });

    expect(resolution).toEqual({
      base_image: { config_digest: digest("a"), reference: STANDARD_WORLD_BASE_IMAGE },
      context_selection: "explicit",
      endpoint: { class: "local", transport: "unix" },
      platform: { architecture: "arm64", os: "linux" },
      target_config: {
        context: "local-dev",
        dockerCommand: "docker",
        evidenceDestination,
        timeoutMs: 10_000,
        version: "spawnfile.target-default-config.v1",
      },
      version: "spawnfile.target-config-resolution.v1",
    });
    expect(JSON.parse(createTargetConfigResolutionBytes(resolution))).toEqual(resolution);
    expect(docker.calls).toHaveLength(3);
    expect(docker.calls.some((args) => args.includes("pull"))).toBe(false);
  });

  it("auto-selects only the reachable current local context", async () => {
    const evidenceDestination = await privateEvidenceDestination();
    const docker = fakeDocker();
    const resolution = await resolveTargetConfig({ evidenceDestination, execFile: docker.execFile });

    expect(resolution.context_selection).toBe("auto-local");
    expect(resolution.target_config.context).toBe("local-dev");
    expect(docker.calls[0]).toEqual(["context", "show"]);

    const remote = fakeDocker({ endpoint: "ssh://operator@example.test" });
    await expect(resolveTargetConfig({
      evidenceDestination,
      execFile: remote.execFile,
    })).rejects.toThrow(/Current Docker context is remote/u);
    expect(remote.calls).toHaveLength(2);
  });

  it("reports an explicitly selected remote context but gates remote pulls", async () => {
    const evidenceDestination = await privateEvidenceDestination();
    const readOnly = fakeDocker({
      architecture: "x86_64",
      endpoint: "ssh://operator@example.test",
      imageArchitecture: "amd64",
    });
    await expect(resolveTargetConfig({
      baseImage: "registry.example/world:1.0.0",
      context: "remote-prod",
      evidenceDestination,
      execFile: readOnly.execFile,
    })).resolves.toMatchObject({
      context_selection: "explicit",
      endpoint: { class: "remote", transport: "ssh" },
      platform: { architecture: "amd64", os: "linux" },
    });

    const blocked = fakeDocker({ endpoint: "tcp://example.test:2376" });
    await expect(resolveTargetConfig({
      context: "remote-prod",
      evidenceDestination,
      execFile: blocked.execFile,
      pull: true,
    })).rejects.toThrow(/requires --allow-remote-pull/u);
    expect(blocked.calls).toHaveLength(1);

    const allowed = fakeDocker({ endpoint: "https://example.test:2376" });
    await expect(resolveTargetConfig({
      allowRemotePull: true,
      context: "remote-prod",
      evidenceDestination,
      execFile: allowed.execFile,
      pull: true,
    })).resolves.toMatchObject({ endpoint: { class: "remote", transport: "https" } });
    expect(allowed.calls.some((args) => args[2] === "image" && args[3] === "pull")).toBe(true);
  });

  it("fails closed for an absent image unless pull was explicitly requested", async () => {
    const evidenceDestination = await privateEvidenceDestination();
    const docker = fakeDocker({ imageInspectFails: true });
    await expect(resolveTargetConfig({
      context: "local-dev",
      evidenceDestination,
      execFile: docker.execFile,
    })).rejects.toThrow(/rerun with --pull/u);
    expect(docker.calls.some((args) => args.includes("pull"))).toBe(false);
  });

  it("loads one strict private prepared mapping into the emitted target config", async () => {
    const evidenceDestination = await privateEvidenceDestination();
    const planPath = path.join(path.dirname(evidenceDestination), "target-plan.json");
    await writeFile(planPath, JSON.stringify({
      evidence_destination: evidenceDestination,
      prepared_artifact_mapping: preparedMapping,
    }), { mode: 0o600 });
    const docker = fakeDocker();
    const resolution = await resolveTargetConfig({
      context: "local-dev",
      evidenceDestination,
      execFile: docker.execFile,
      preparedPlanPath: planPath,
    });
    expect(resolution.target_config.preparedArtifactMappings).toEqual([preparedMapping]);

    await chmod(planPath, 0o644);
    await expect(resolveTargetConfig({
      context: "local-dev",
      evidenceDestination,
      execFile: docker.execFile,
      preparedPlanPath: planPath,
    })).rejects.toThrow(/private bounded regular file/u);
  });

  it("rejects invalid inputs and platform or image identity drift", async () => {
    const evidenceDestination = await privateEvidenceDestination();
    const unused = fakeDocker();
    await expect(resolveTargetConfig({
      baseImage: digest("a"),
      context: "local-dev",
      evidenceDestination,
      execFile: unused.execFile,
    })).rejects.toThrow(/portable image reference/u);
    expect(unused.calls).toEqual([]);

    await expect(resolveTargetConfig({
      context: "local-dev",
      evidenceDestination,
      execFile: fakeDocker({ imageArchitecture: "amd64" }).execFile,
    })).rejects.toThrow(/does not match/u);
    await expect(resolveTargetConfig({
      context: "local-dev",
      evidenceDestination,
      execFile: fakeDocker({ imageId: "sha256:short" }).execFile,
    })).rejects.toThrow(/config ID is invalid/u);
    await expect(resolveTargetConfig({
      context: "local-dev",
      evidenceDestination,
      execFile: fakeDocker({ os: "windows" }).execFile,
    })).rejects.toThrow(/operating system is unsupported/u);
  });
});
