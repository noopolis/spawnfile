import os from "node:os";
import path from "node:path";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  parsePreparedEvidenceHelperReceipt,
  type PrepareEvidenceHelperInput,
} from "../evidenceExportHelper/index.js";
import type { DockerTargetExecFile } from "../target/dockerTarget.js";

import {
  createCanonicalTargetConfigBytes,
  createTargetConfigDigest,
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
  readonly helperConfigId?: string;
  readonly helperImageDigest?: string;
  readonly os?: string;
}

const fakeDocker = (options: FakeDockerOptions = {}) => {
  const calls: string[][] = [];
  const commands: string[] = [];
  const execFile: DockerTargetExecFile = async (command, args) => {
    commands.push(command);
    calls.push([...args]);
    const dockerArgs = args[0] === "--context" ? args.slice(2) : args;
    if (dockerArgs[0] === "context" && dockerArgs[1] === "show") {
      return { stderr: "", stdout: "local-dev\n" };
    }
    if (dockerArgs[0] === "context" && dockerArgs[1] === "inspect") {
      return {
        stderr: "",
        stdout: `${JSON.stringify(options.endpoint ?? "unix:///tmp/docker.sock")}\n`,
      };
    }
    if (dockerArgs[0] === "info") {
      return {
        stderr: "",
        stdout: JSON.stringify({
          Architecture: options.architecture ?? "aarch64",
          OSType: options.os ?? "linux",
        }),
      };
    }
    if (dockerArgs[0] === "image" && dockerArgs[1] === "pull") {
      return { stderr: "", stdout: `${digest("f")}\n` };
    }
    if (dockerArgs[0] === "image" && dockerArgs[1] === "inspect") {
      if (dockerArgs[2]?.startsWith("spawnfile-local/evidence-export-helper@")) {
        return {
          stderr: "",
          stdout: JSON.stringify([{
            Architecture: "arm64",
            Config: {
              Cmd: [], Entrypoint: ["/bin/spawnfile-export-helper"],
              Env: ["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"],
              ExposedPorts: null, Healthcheck: null,
              Labels: { "spawnfile.target.evidence-export.helper-contract": "v1" },
              User: "65534:65534", Volumes: null,
            },
            Id: options.helperConfigId ?? digest("b"), Os: "linux",
            RepoDigests: [
              `spawnfile-local/evidence-export-helper@${options.helperImageDigest ?? digest("c")}`,
            ],
          }]),
        };
      }
      if (options.imageInspectFails === true) throw new Error("missing");
      const projection = {
        Architecture: options.imageArchitecture ?? options.architecture ?? "arm64",
        Id: options.imageId ?? digest("a"),
        Os: options.imageOs ?? "linux",
      };
      return { stderr: "", stdout: JSON.stringify(dockerArgs[4]?.startsWith("[")
        ? [projection] : projection) };
    }
    throw new Error(`unexpected Docker args: ${args.join(" ")}`);
  };
  return { calls, commands, execFile };
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

    const targetConfig = Object.freeze({
      context: "local-dev",
      dockerCommand: "docker",
      evidenceDestination,
      timeoutMs: 10_000,
      version: "spawnfile.target-default-config.v1" as const,
    });
    expect(resolution).toEqual({
      base_image: { config_digest: digest("a"), reference: STANDARD_WORLD_BASE_IMAGE },
      context_selection: "explicit",
      endpoint: { class: "local", transport: "unix" },
      platform: { architecture: "arm64", os: "linux" },
      target_config: targetConfig,
      target_config_digest: createTargetConfigDigest(targetConfig),
      version: "spawnfile.target-config-resolution.v1",
    });
    expect(createCanonicalTargetConfigBytes(resolution.target_config))
      .toBe(JSON.stringify(targetConfig));
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
      version: "spawnfile.target-config-prepared-plan.v1",
    }), { mode: 0o600 });
    const docker = fakeDocker();
    const resolution = await resolveTargetConfig({
      context: "local-dev",
      evidenceDestination,
      execFile: docker.execFile,
      preparedPlanPath: planPath,
    });
    expect(resolution.target_config.preparedArtifactMappings).toEqual([preparedMapping]);
    expect(resolution.target_config_digest).toBe(createTargetConfigDigest(resolution.target_config));

    await chmod(planPath, 0o644);
    await expect(resolveTargetConfig({
      context: "local-dev",
      evidenceDestination,
      execFile: docker.execFile,
      preparedPlanPath: planPath,
    })).rejects.toThrow(/private bounded regular file/u);
  });

  it("returns a correlated opaque helper receipt only for explicit local preparation", async () => {
    const evidenceDestination = await privateEvidenceDestination();
    const docker = fakeDocker();
    const receipt = parsePreparedEvidenceHelperReceipt({
      digest: digest("d"),
      handle: `opaque_${"e".repeat(64)}`,
      version: "spawnfile.target-evidence-export-helper.prepared.v1",
    });
    const prepareEvidenceExportHelper = vi.fn(async () => receipt);
    const resolution = await resolveTargetConfig({
      context: "local-dev",
      evidenceDestination,
      execFile: docker.execFile,
      prepareEvidenceHelper: true,
    }, { prepareEvidenceExportHelper });

    expect(prepareEvidenceExportHelper).toHaveBeenCalledWith(expect.objectContaining({
      baseImage: STANDARD_WORLD_BASE_IMAGE,
      context: "local-dev",
      timeoutMs: 10_000,
    }));
    expect(resolution.prepared_evidence_helper).toEqual(receipt);
    expect(resolution.target_config).toMatchObject({
      evidenceHelperBaseImage: STANDARD_WORLD_BASE_IMAGE,
      preparedEvidenceHelper: receipt,
    });
    expect(resolution.target_config_digest).toBe(createTargetConfigDigest(resolution.target_config));
    expect(Object.keys(resolution.prepared_evidence_helper ?? {})).toEqual([
      "digest", "handle", "version",
    ]);
  });

  it("uses the configured Docker-compatible executable for every helper call", async () => {
    const evidenceDestination = await privateEvidenceDestination();
    const docker = fakeDocker();
    const receipt = parsePreparedEvidenceHelperReceipt({
      digest: digest("d"),
      handle: `opaque_${"e".repeat(64)}`,
      version: "spawnfile.target-evidence-export-helper.prepared.v1",
    });
    const prepareEvidenceExportHelper = vi.fn(async (input: PrepareEvidenceHelperInput) => {
      await input.executor("docker", [
        "--context", "local-dev", "context", "inspect", "local-dev", "--format",
        "{{json .Endpoints.docker.Host}}",
      ], { timeout: 10_000 } as never);
      return receipt;
    });
    await expect(resolveTargetConfig({
      context: "local-dev",
      dockerCommand: "docker-compatible",
      evidenceDestination,
      execFile: docker.execFile,
      prepareEvidenceHelper: true,
    }, { prepareEvidenceExportHelper })).resolves.toMatchObject({
      prepared_evidence_helper: receipt,
    });
    expect(docker.commands).toEqual(docker.calls.map(() => "docker-compatible"));
    expect(docker.commands).not.toContain("docker");
  });

  it("refuses helper preparation without an explicit local target", async () => {
    const evidenceDestination = await privateEvidenceDestination();
    const docker = fakeDocker();
    const prepareEvidenceExportHelper = vi.fn();
    await expect(resolveTargetConfig({
      evidenceDestination,
      execFile: docker.execFile,
      prepareEvidenceHelper: true,
    }, { prepareEvidenceExportHelper })).rejects.toThrow(/explicitly selected local/u);
    expect(prepareEvidenceExportHelper).not.toHaveBeenCalled();
    expect(docker.calls).toHaveLength(2);
  });

  it("does not pull or prepare a helper on an explicitly remote target", async () => {
    const evidenceDestination = await privateEvidenceDestination();
    const docker = fakeDocker({ endpoint: "ssh://operator@example.test" });
    const prepareEvidenceExportHelper = vi.fn();
    await expect(resolveTargetConfig({
      allowRemotePull: true,
      context: "remote-prod",
      evidenceDestination,
      execFile: docker.execFile,
      prepareEvidenceHelper: true,
      pull: true,
    }, { prepareEvidenceExportHelper })).rejects.toThrow(/explicitly selected local/u);
    expect(prepareEvidenceExportHelper).not.toHaveBeenCalled();
    expect(docker.calls).toEqual([[
      "context", "inspect", "remote-prod", "--format", "{{json .Endpoints.docker.Host}}",
    ]]);
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
