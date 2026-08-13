import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { mkdtemp, writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import { fileExists, removeDirectory } from "../filesystem/index.js";
import { SpawnfileError } from "../shared/index.js";
import type { OrganizationReadinessEvidence } from "../compiler/organizationReadyEvidence.js";

import { runCli } from "./runCli.js";

const temporaryDirectories: string[] = [];
const fixturesRoot = path.resolve(process.cwd(), "test", "fixtures");
const packageVersion = (
  JSON.parse(readFileSync("package.json", "utf8")) as { version: string }
).version;
const genericOrganizationReadinessEvidence: OrganizationReadinessEvidence = {
  compileFingerprint: "sf1:000000000000",
  compileVersion: "0.1",
  hasExternalMoltnet: false,
  networks: [],
  organizationMembers: [],
  projectLabel: "generic",
  version: "spawnfile.organization-ready-evidence.v1",
  worldBindings: null,
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => removeDirectory(directory)),
  );
});

describe("runCli", () => {
  it("requires literal target config stdin and bounds config failures before effects", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "spawnfile-target-cli-"),
    );
    temporaryDirectories.push(directory);
    const requestFile = path.join(directory, "request.json");
    await writeFile(
      requestFile,
      JSON.stringify({
        idempotency_key: "idem_aaaaaaaaaaaaaaaa",
        operation: "select_target",
        target_reference: "gpu-4090",
        version: "spawnfile.target-resource.request.v1",
      }),
    );
    const missingConfig: string[] = [];
    await expect(
      runCli(["target", "select_target", requestFile], {
        stderr: (message) => missingConfig.push(message),
        stdout: () => undefined,
      }),
    ).resolves.toBe(2);
    expect(missingConfig).toEqual(["error: Invalid target command"]);

    const pathStderr: string[] = [];
    await expect(
      runCli(
        [
          "target",
          "--config",
          path.join(directory, "config.json"),
          "select_target",
          requestFile,
        ],
        {
          stderr: (message) => pathStderr.push(message),
          stdout: () => undefined,
        },
      ),
    ).resolves.toBe(2);
    expect(pathStderr).toEqual(["error: Invalid target configuration"]);

    const stdout: string[] = [];
    const stdinStderr: string[] = [];
    let stdinReads = 0;
    await expect(
      runCli(["target", "--config", "-", "select_target", requestFile], {
        stdin: (async function* () {
          stdinReads += 1;
          yield '{"unexpected":"private-value"}';
        })(),
        streams: {
          stderr: (message) => stdinStderr.push(message),
          stdout: (message) => stdout.push(message),
        },
      }),
    ).resolves.toBe(2);
    expect(stdinReads).toBe(1);
    expect(stdout).toEqual([]);
    expect(stdinStderr).toEqual(["error: Invalid target configuration"]);
    expect(stdinStderr.join("\n")).not.toContain("private-value");

    let consumedBeforeRequest = false;
    const invalidRequest = path.join(directory, "invalid-request.json");
    await writeFile(invalidRequest, "{");
    await expect(
      runCli(["target", "--config", "-", "select_target", invalidRequest], {
        stdin: (async function* () {
          consumedBeforeRequest = true;
          yield "{}";
        })(),
        streams: { stderr: () => undefined, stdout: () => undefined },
      }),
    ).resolves.toBe(2);
    expect(consumedBeforeRequest).toBe(false);

    consumedBeforeRequest = false;
    await expect(
      runCli(
        [
          "target",
          "--config",
          "-",
          "select_target",
          path.relative(process.cwd(), requestFile),
        ],
        {
          stdin: (async function* () {
            consumedBeforeRequest = true;
            yield "{}";
          })(),
          streams: { stderr: () => undefined, stdout: () => undefined },
        },
      ),
    ).resolves.toBe(2);
    expect(consumedBeforeRequest).toBe(false);
  });

  it("normalizes hostile target usage errors without changing other command diagnostics", async () => {
    const privateSentinel = `PRIVATE_${"s".repeat(100_000)}`;
    const cases = [
      ["target", "--config", "-", privateSentinel],
      [
        "target",
        "--config",
        "-",
        "select_target",
        `/tmp/${privateSentinel}.json`,
        `--${privateSentinel}`,
      ],
      ["target", "--config", "-", "select_target"],
    ];
    for (const argv of cases) {
      const stdout: string[] = [];
      const stderr: string[] = [];
      let stdinReads = 0;
      const exitCode = await runCli(argv, {
        stdin: (async function* () {
          stdinReads += 1;
          yield "{}";
        })(),
        streams: {
          stderr: (message) => stderr.push(message),
          stdout: (message) => stdout.push(message),
        },
      });
      expect(exitCode).toBe(2);
      expect(stdinReads).toBe(0);
      expect(stdout).toEqual([]);
      expect(stderr).toEqual(["error: Invalid target command"]);
      expect(Buffer.byteLength(stderr[0]!, "utf8")).toBe(29);
      expect(stderr.join("\n")).not.toContain("PRIVATE_");
    }

    const nonTargetStderr: string[] = [];
    await expect(
      runCli(["unknown-outside-target"], {
        stderr: (message) => nonTargetStderr.push(message),
        stdout: () => undefined,
      }),
    ).resolves.toBe(2);
    expect(nonTargetStderr.join("\n")).toContain("unknown-outside-target");
  });

  it("prints the package version", async () => {
    const stdout: string[] = [];
    const exitCode = await runCli(["--version"], {
      stderr: () => undefined,
      stdout: (message) => stdout.push(message),
    });

    expect(exitCode).toBe(0);
    expect(stdout).toEqual([packageVersion]);
  });

  it("lists runtime adapters", async () => {
    const stdout: string[] = [];
    const exitCode = await runCli(["runtimes"], {
      stderr: () => undefined,
      stdout: (message) => stdout.push(message),
    });

    expect(exitCode).toBe(0);
    expect(stdout).toContain("openclaw");
  });

  it("validates a project", async () => {
    const stdout: string[] = [];
    const buildCompilePlan = vi.fn(async () => ({
      edges: [],
      nodes: [],
      root: "/tmp/project",
      runtimes: {},
    }));

    const exitCode = await runCli(
      ["validate", path.join(fixturesRoot, "single-agent")],
      {
        stderr: () => undefined,
        stdout: (message) => stdout.push(message),
      },
      { buildCompilePlan },
    );

    expect(buildCompilePlan).toHaveBeenCalledWith(
      path.join(fixturesRoot, "single-agent"),
    );
    expect(stdout).toEqual([
      "validation succeeded",
      "root: /tmp/project\nnodes: 0\nruntimes: none",
    ]);
    expect(exitCode).toBe(0);
  });

  it("compiles a project", async () => {
    const outputDirectory = await mkdtemp(
      path.join(os.tmpdir(), "spawnfile-cli-"),
    );
    temporaryDirectories.push(outputDirectory);
    const compileProject = vi.fn(async () => ({
      organizationReadinessEvidence: genericOrganizationReadinessEvidence,
      outputDirectory: "/tmp/spawnfile-compile-out",
      report: {
        diagnostics: [],
        nodes: [],
        root: path.join(fixturesRoot, "single-agent"),
        spawnfile_version: "0.1" as const,
      },
      reportPath: "/tmp/spawnfile-compile-out/spawnfile-report.json",
    }));

    const stdout: string[] = [];
    const exitCode = await runCli(
      [
        "compile",
        path.join(fixturesRoot, "single-agent"),
        "--out",
        outputDirectory,
        "--world-bindings",
        "/tmp/world-bindings.json",
      ],
      {
        stderr: () => undefined,
        stdout: (message) => stdout.push(message),
      },
      { compileProject },
    );

    expect(exitCode).toBe(0);
    expect(compileProject).toHaveBeenCalledWith(
      path.join(fixturesRoot, "single-agent"),
      {
        outputDirectory,
        worldBindingsPath: "/tmp/world-bindings.json",
      },
    );
    expect(stdout[0]).toContain("compiled to");
  }, 30000);

  it("builds a project", async () => {
    const stdout: string[] = [];
    const buildProject = vi.fn(async () => ({
      imageTag: "spawnfile-single-agent",
      organizationReadinessEvidence: genericOrganizationReadinessEvidence,
      outputDirectory: "/tmp/spawnfile-build-out",
      report: {
        diagnostics: [],
        nodes: [],
        root: path.join(fixturesRoot, "single-agent"),
        spawnfile_version: "0.1" as const,
      },
      reportPath: "/tmp/spawnfile-build-out/spawnfile-report.json",
    }));

    const exitCode = await runCli(
      [
        "build",
        path.join(fixturesRoot, "single-agent"),
        "--out",
        "/tmp/spawnfile-build-out",
      ],
      {
        stderr: () => undefined,
        stdout: (message) => stdout.push(message),
      },
      { buildProject },
    );

    expect(exitCode).toBe(0);
    expect(buildProject).toHaveBeenCalledWith(
      path.join(fixturesRoot, "single-agent"),
      {
        dockerContext: undefined,
        dockerCommand: undefined,
        imageTag: undefined,
        outputDirectory: "/tmp/spawnfile-build-out",
      },
    );
    expect(stdout).toEqual([
      "built image spawnfile-single-agent",
      "compiled to /tmp/spawnfile-build-out",
      "report: /tmp/spawnfile-build-out/spawnfile-report.json",
    ]);
  });

  it("runs up for a project in detached mode", async () => {
    const stdout: string[] = [];
    const upProject = vi.fn(async () => ({
      authProfileName: "dev",
      containerName: "spawnfile-single-agent",
      imageTag: "spawnfile-single-agent",
      organizationReadinessEvidence: genericOrganizationReadinessEvidence,
      outputDirectory: "/tmp/spawnfile-up-out",
      report: {
        container: {
          dockerfile: "Dockerfile",
          entrypoint: "entrypoint.sh",
          env_example: ".env.example",
          model_secrets_required: ["ANTHROPIC_API_KEY"],
          ports: [18789],
          runtime_instances: [
            {
              config_path:
                "/var/lib/spawnfile/instances/openclaw/agent-assistant/home/.openclaw/openclaw.json",
              home_path:
                "/var/lib/spawnfile/instances/openclaw/agent-assistant/home",
              id: "agent-assistant",
              model_auth_methods: {
                anthropic: "api_key" as const,
              },
              model_secrets_required: ["ANTHROPIC_API_KEY"],
              runtime: "openclaw",
            },
          ],
          runtime_homes: [
            "/var/lib/spawnfile/instances/openclaw/agent-assistant/home",
          ],
          runtime_secrets_required: ["OPENCLAW_GATEWAY_TOKEN"],
          runtimes_installed: ["openclaw"],
          secrets_required: ["ANTHROPIC_API_KEY", "OPENCLAW_GATEWAY_TOKEN"],
        },
        diagnostics: [],
        nodes: [],
        root: path.join(fixturesRoot, "single-agent"),
        spawnfile_version: "0.1" as const,
      },
      reportPath: "/tmp/spawnfile-up-out/spawnfile-report.json",
      supportDirectory: "/tmp/spawnfile-run-support",
    }));

    const exitCode = await runCli(
      [
        "up",
        path.join(fixturesRoot, "single-agent"),
        "--auth-profile",
        "dev",
        "--env-file",
        "/tmp/dev.env",
        "--deployment",
        "prod-eu",
        "--context",
        "hetzner",
        "--detach",
        "--out",
        "/tmp/spawnfile-up-out",
      ],
      {
        stderr: () => undefined,
        stdout: (message) => stdout.push(message),
      },
      { upProject },
    );

    expect(exitCode).toBe(0);
    expect(upProject).toHaveBeenCalledWith(
      path.join(fixturesRoot, "single-agent"),
      {
        authProfile: "dev",
        containerName: undefined,
        deploymentName: "prod-eu",
        detach: true,
        dockerCommand: undefined,
        dockerContext: "hetzner",
        envFilePath: "/tmp/dev.env",
        imageTag: undefined,
        outputDirectory: "/tmp/spawnfile-up-out",
      },
    );
    expect(stdout).toEqual([
      "built image spawnfile-single-agent",
      "compiled to /tmp/spawnfile-up-out",
      "report: /tmp/spawnfile-up-out/spawnfile-report.json",
      "running container spawnfile-single-agent",
      "image: spawnfile-single-agent",
    ]);
  });

  it("keeps organization handoff CLI inputs complete, project-only, and opaque", async () => {
    const project = path.join(fixturesRoot, "single-agent");
    const handle = "opaque_0123456789abcdef";
    const bindings = "/tmp/world-bindings.json";
    const receiptDirectory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-selected-target-"));
    temporaryDirectories.push(receiptDirectory);
    const selectedTargetReceipt = {
      fingerprint: `sha256:${"f".repeat(32)}`,
      handle: "opaque_fedcba9876543210",
      version: "spawnfile.target-resource.selected-target.v1",
    };
    const selectedTargetReceiptBytes = JSON.stringify(selectedTargetReceipt);
    const selectedTargetReceiptFile = path.join(receiptDirectory, "selected-target.json");
    await writeFile(selectedTargetReceiptFile, selectedTargetReceiptBytes);
    const selected = `sha256:${createHash("sha256").update(selectedTargetReceiptBytes).digest("hex")}`;
    const descriptor = `sha256:${"d".repeat(64)}`;
    const runId = "run-one";
    const partials = [
      ["--world-bindings", bindings],
      ["--selected-target-receipt-digest", selected],
      ["--network-attachment-handle", handle],
      [
        "--world-bindings",
        bindings,
        "--selected-target-receipt-digest",
        selected,
      ],
      ["--world-bindings", bindings, "--network-attachment-handle", handle],
      [
        "--selected-target-receipt-digest",
        selected,
        "--network-attachment-handle",
        handle,
      ],
    ];
    for (const flags of partials) {
      const upProject = vi.fn();
      const stderr: string[] = [];
      const exitCode = await runCli(
        ["up", project, ...flags],
        {
          stderr: (message) => stderr.push(message),
          stdout: () => undefined,
        },
        { upProject: upProject as never },
      );
      expect(exitCode).toBe(2);
      expect(upProject).not.toHaveBeenCalled();
      expect(stderr.join("\n")).not.toContain(handle);
    }

    const upProject = vi.fn(async () => ({
      imageTag: "football:latest",
      outputDirectory: "/tmp/out",
      report: {
        diagnostics: [],
        nodes: [],
        root: project,
        spawnfile_version: "0.1",
      },
      reportPath: "/tmp/out/report.json",
      supportDirectory: null,
    }));
    await expect(
      runCli(
        [
          "up",
          project,
          "--detach",
          "--organization-handoff-run-id",
          runId,
          "--descriptor-digest",
          descriptor,
          "--selected-target-receipt",
          selectedTargetReceiptFile,
          "--world-bindings",
          bindings,
          "--selected-target-receipt-digest",
          selected,
          "--network-attachment-handle",
          handle,
        ],
        { stderr: () => undefined, stdout: () => undefined },
        { upProject: upProject as never },
      ),
    ).resolves.toBe(0);
    expect(upProject).toHaveBeenCalledWith(
      project,
      expect.objectContaining({
        worldBindingsPath: bindings,
        descriptorDigest: descriptor,
        organizationHandoffRunId: runId,
        selectedTargetReceipt: selectedTargetReceiptFile,
        selectedTargetReceiptDigest: selected,
        networkAttachmentHandle: handle,
      }),
    );

    for (const flags of [
      ["--selected-target-receipt-digest", selected],
      ["--network-attachment-handle", handle],
      [
        "--world-bindings",
        bindings,
        "--selected-target-receipt-digest",
        selected,
        "--network-attachment-handle",
        handle,
      ],
    ]) {
      const consumeImageUp = vi.fn();
      const stderr: string[] = [];
      const exitCode = await runCli(
        ["up", "you/org:1.0.0", ...flags],
        {
          stderr: (message) => stderr.push(message),
          stdout: () => undefined,
        },
        { consumeImageUp: consumeImageUp as never },
      );
      expect(exitCode).toBe(2);
      expect(consumeImageUp).not.toHaveBeenCalled();
      expect(stderr.join("\n")).not.toContain(handle);
    }
  });

  it("rejects overlong receipt paths and oversized receipt files before project execution", async () => {
    const receiptDirectory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-receipt-limits-"));
    temporaryDirectories.push(receiptDirectory);
    const oversizedReceipt = path.join(receiptDirectory, "oversized.json");
    await writeFile(oversizedReceipt, "x".repeat(65_537));
    const upProject = vi.fn();
    for (const receiptPath of ["x".repeat(4097), oversizedReceipt]) {
      const stderr: string[] = [];
      const exitCode = await runCli(
        [
          "up",
          path.join(fixturesRoot, "single-agent"),
          "--json",
          "--detach",
          "--organization-handoff-run-id",
          "run-one",
          "--descriptor-digest",
          `sha256:${"d".repeat(64)}`,
          "--selected-target-receipt",
          receiptPath,
          "--world-bindings",
          "/tmp/world-bindings.json",
          "--selected-target-receipt-digest",
          `sha256:${"e".repeat(64)}`,
          "--network-attachment-handle",
          "opaque_0123456789abcdef"
        ],
        { stderr: (message) => stderr.push(message), stdout: () => undefined },
        { upProject: upProject as never }
      );

      expect(exitCode).toBe(2);
      expect(stderr.join("\n")).toContain("Invalid selected target receipt");
    }
    expect(upProject).not.toHaveBeenCalled();
  });

  it("starts a dev deployment under the dev output directory", async () => {
    const stdout: string[] = [];
    const devUpProject = vi.fn(async () => ({
      authProfileName: "dev",
      containerName: "spawnfile-pi-dev",
      deploymentRecordPath: "/tmp/org/.spawn-dev/deployments/dev.json",
      imageTag: "spawnfile-pi-dev",
      organizationReadinessEvidence: genericOrganizationReadinessEvidence,
      outputDirectory: "/tmp/org/.spawn-dev",
      report: {
        diagnostics: [],
        nodes: [],
        root: path.join(fixturesRoot, "e2e", "daimon-org"),
        spawnfile_version: "0.1" as const,
      },
      reportPath: "/tmp/org/.spawn-dev/spawnfile-report.json",
      supportDirectory: "/tmp/spawnfile-run-support",
    }));

    const exitCode = await runCli(
      [
        "dev",
        "up",
        path.join(fixturesRoot, "e2e", "daimon-org"),
        "--auth-profile",
        "dev",
        "--deployment",
        "dev",
        "--context",
        "gpu-4090",
        "--out",
        "/tmp/org/.spawn-dev",
      ],
      {
        stderr: () => undefined,
        stdout: (message) => stdout.push(message),
      },
      { devUpProject },
    );

    expect(exitCode).toBe(0);
    expect(devUpProject).toHaveBeenCalledWith(
      path.join(fixturesRoot, "e2e", "daimon-org"),
      {
        authProfile: "dev",
        containerName: undefined,
        deploymentName: "dev",
        dockerCommand: undefined,
        dockerContext: "gpu-4090",
        envFilePath: undefined,
        imageTag: undefined,
        outputDirectory: "/tmp/org/.spawn-dev",
      },
    );
    expect(stdout).toEqual([
      "dev deployment: spawnfile-pi-dev",
      "image: spawnfile-pi-dev",
      "compiled to /tmp/org/.spawn-dev",
      "record: /tmp/org/.spawn-dev/deployments/dev.json",
    ]);
  });

  it("hot-applies one agent into a dev deployment", async () => {
    const stdout: string[] = [];
    const devApplyProject = vi.fn(async () => ({
      agentId: "agent:observer",
      bridgeStarted: true,
      containerName: "spawnfile-pi-dev",
      deploymentName: "dev",
      existingAgent: false,
      outputDirectory: "/tmp/org/.spawn-dev",
    }));

    const exitCode = await runCli(
      [
        "dev",
        "apply",
        path.join(fixturesRoot, "e2e", "daimon-org"),
        "--agent",
        "observer",
        "--deployment",
        "dev",
        "--out",
        "/tmp/org/.spawn-dev",
      ],
      {
        stderr: () => undefined,
        stdout: (message) => stdout.push(message),
      },
      { devApplyProject },
    );

    expect(exitCode).toBe(0);
    expect(devApplyProject).toHaveBeenCalledWith(
      path.join(fixturesRoot, "e2e", "daimon-org"),
      {
        agent: "observer",
        deploymentName: "dev",
        dockerCommand: undefined,
        outputDirectory: "/tmp/org/.spawn-dev",
      },
    );
    expect(stdout).toEqual([
      "applied agent agent:observer",
      "container: spawnfile-pi-dev",
      "bridge: started",
    ]);
  });

  it("restarts one agent in a dev deployment", async () => {
    const stdout: string[] = [];
    const devRestartProject = vi.fn(async () => ({
      agentId: "agent:mapper",
      bridgeStarted: false,
      containerName: "spawnfile-pi-dev",
      deploymentName: "dev",
      existingAgent: true,
      outputDirectory: "/tmp/org/.spawn-dev",
    }));

    const exitCode = await runCli(
      [
        "dev",
        "restart",
        "/tmp/org",
        "--agent",
        "mapper",
        "--deployment",
        "dev",
      ],
      {
        stderr: () => undefined,
        stdout: (message) => stdout.push(message),
      },
      { devRestartProject },
    );

    expect(exitCode).toBe(0);
    expect(devRestartProject).toHaveBeenCalledWith("/tmp/org", {
      agent: "mapper",
      deploymentName: "dev",
      dockerCommand: undefined,
      outputDirectory: undefined,
    });
    expect(stdout).toEqual([
      "restarted agent agent:mapper",
      "container: spawnfile-pi-dev",
      "bridge: unchanged",
    ]);
  });

  it("prints dev activity as JSON lines", async () => {
    const stdout: string[] = [];
    const devActivityProject = vi.fn(async () => ({
      containerName: "spawnfile-pi-dev",
      deploymentName: "dev",
      events: [
        {
          agent_id: "agent:mapper",
          sequence: 7,
          type: "agent.turn.started",
          version: "spawnfile.activity.v1",
        },
      ],
      outputDirectory: "/tmp/org/.spawn-dev",
    }));

    const exitCode = await runCli(
      [
        "dev",
        "activity",
        "/tmp/org",
        "--agent",
        "mapper",
        "--deployment",
        "dev",
        "--tail",
        "5",
      ],
      {
        stderr: () => undefined,
        stdout: (message) => stdout.push(message),
      },
      { devActivityProject },
    );

    expect(exitCode).toBe(0);
    expect(devActivityProject).toHaveBeenCalledWith("/tmp/org", {
      agent: "mapper",
      deploymentName: "dev",
      dockerCommand: undefined,
      outputDirectory: undefined,
      tail: 5,
    });
    expect(stdout).toEqual([
      JSON.stringify({
        agent_id: "agent:mapper",
        sequence: 7,
        type: "agent.turn.started",
        version: "spawnfile.activity.v1",
      }),
    ]);
  });

  it("rejects invalid dev activity tail values", async () => {
    const stderr: string[] = [];
    const devActivityProject = vi.fn();

    const exitCode = await runCli(
      ["dev", "activity", "/tmp/org", "--tail", "5abc"],
      {
        stderr: (message) => stderr.push(message),
        stdout: () => undefined,
      },
      { devActivityProject },
    );

    expect(exitCode).toBe(2);
    expect(devActivityProject).not.toHaveBeenCalled();
    expect(stderr.join("\n")).toContain("must be a positive integer");
  });

  it("stops a dev deployment", async () => {
    const stdout: string[] = [];
    const devStopProject = vi.fn(async () => ({
      containerName: "spawnfile-pi-dev",
      deploymentName: "dev",
      outputDirectory: "/tmp/org/.spawn-dev",
    }));

    const exitCode = await runCli(
      ["dev", "stop", "/tmp/org", "--deployment", "dev"],
      {
        stderr: () => undefined,
        stdout: (message) => stdout.push(message),
      },
      { devStopProject },
    );

    expect(exitCode).toBe(0);
    expect(devStopProject).toHaveBeenCalledWith("/tmp/org", {
      deploymentName: "dev",
      dockerCommand: undefined,
      outputDirectory: undefined,
    });
    expect(stdout).toEqual([
      "stopped dev deployment dev",
      "container: spawnfile-pi-dev",
    ]);
  });

  it("runs a project in detached mode", async () => {
    const stdout: string[] = [];
    const runProject = vi.fn(async () => ({
      authProfileName: "dev",
      containerName: "spawnfile-single-agent",
      imageTag: "spawnfile-single-agent",
      organizationReadinessEvidence: genericOrganizationReadinessEvidence,
      outputDirectory: "/tmp/spawnfile-run-out",
      report: {
        container: {
          dockerfile: "Dockerfile",
          entrypoint: "entrypoint.sh",
          env_example: ".env.example",
          model_secrets_required: ["ANTHROPIC_API_KEY"],
          ports: [18789],
          runtime_instances: [
            {
              config_path:
                "/var/lib/spawnfile/instances/openclaw/agent-assistant/home/.openclaw/openclaw.json",
              home_path:
                "/var/lib/spawnfile/instances/openclaw/agent-assistant/home",
              id: "agent-assistant",
              model_auth_methods: {
                anthropic: "api_key" as const,
              },
              model_secrets_required: ["ANTHROPIC_API_KEY"],
              runtime: "openclaw",
            },
          ],
          runtime_homes: [
            "/var/lib/spawnfile/instances/openclaw/agent-assistant/home",
          ],
          runtime_secrets_required: ["OPENCLAW_GATEWAY_TOKEN"],
          runtimes_installed: ["openclaw"],
          secrets_required: ["ANTHROPIC_API_KEY", "OPENCLAW_GATEWAY_TOKEN"],
        },
        diagnostics: [],
        nodes: [],
        root: path.join(fixturesRoot, "single-agent"),
        spawnfile_version: "0.1" as const,
      },
      reportPath: "/tmp/spawnfile-run-out/spawnfile-report.json",
    }));

    const exitCode = await runCli(
      [
        "run",
        path.join(fixturesRoot, "single-agent"),
        "--auth-profile",
        "dev",
        "--env-file",
        "/tmp/dev.env",
        "--deployment",
        "prod-eu",
        "--context",
        "hetzner",
        "--detach",
        "--out",
        "/tmp/spawnfile-run-out",
      ],
      {
        stderr: () => undefined,
        stdout: (message) => stdout.push(message),
      },
      { runProject },
    );

    expect(exitCode).toBe(0);
    expect(runProject).toHaveBeenCalledWith(
      path.join(fixturesRoot, "single-agent"),
      {
        authProfile: "dev",
        containerName: undefined,
        deploymentName: "prod-eu",
        detach: true,
        dockerCommand: undefined,
        dockerContext: "hetzner",
        envFilePath: "/tmp/dev.env",
        imageTag: undefined,
        outputDirectory: "/tmp/spawnfile-run-out",
      },
    );
    expect(stdout).toEqual([
      "running container spawnfile-single-agent",
      "image: spawnfile-single-agent",
    ]);
  });

  it("sets a primary model through the CLI", async () => {
    const stdout: string[] = [];
    const setProjectPrimaryModel = vi.fn(async () => ({
      updatedFiles: ["/tmp/project/Spawnfile"],
    }));

    const exitCode = await runCli(
      [
        "model",
        "set",
        "custom",
        "foo-large",
        "/tmp/project",
        "--auth",
        "api_key",
        "--key",
        "CUSTOM_API_KEY",
        "--compat",
        "anthropic",
        "--base-url",
        "https://llm.example.com/v1",
        "--recursive",
      ],
      {
        stderr: () => undefined,
        stdout: (message) => stdout.push(message),
      },
      { setProjectPrimaryModel },
    );

    expect(exitCode).toBe(0);
    expect(setProjectPrimaryModel).toHaveBeenCalledWith({
      authKey: "CUSTOM_API_KEY",
      authMethod: "api_key",
      endpointBaseUrl: "https://llm.example.com/v1",
      endpointCompatibility: "anthropic",
      name: "foo-large",
      path: "/tmp/project",
      provider: "custom",
      recursive: true,
    });
    expect(stdout).toEqual(["updated /tmp/project/Spawnfile"]);
  });

  it("adds a fallback model through the CLI", async () => {
    const stdout: string[] = [];
    const addProjectModelFallback = vi.fn(async () => ({
      updatedFiles: ["/tmp/project/Spawnfile"],
    }));

    const exitCode = await runCli(
      [
        "model",
        "add-fallback",
        "anthropic",
        "claude-opus-4-6",
        "/tmp/project",
        "--auth",
        "claude-code",
      ],
      {
        stderr: () => undefined,
        stdout: (message) => stdout.push(message),
      },
      { addProjectModelFallback },
    );

    expect(exitCode).toBe(0);
    expect(addProjectModelFallback).toHaveBeenCalledWith({
      authKey: undefined,
      authMethod: "claude-code",
      endpointBaseUrl: undefined,
      endpointCompatibility: undefined,
      name: "claude-opus-4-6",
      path: "/tmp/project",
      provider: "anthropic",
      recursive: undefined,
    });
    expect(stdout).toEqual(["updated /tmp/project/Spawnfile"]);
  });

  it("clears fallback models through the CLI", async () => {
    const stdout: string[] = [];
    const clearProjectModelFallbacks = vi.fn(async () => ({
      updatedFiles: ["/tmp/project/Spawnfile"],
    }));

    const exitCode = await runCli(
      ["model", "clear-fallbacks", "/tmp/project", "--recursive"],
      {
        stderr: () => undefined,
        stdout: (message) => stdout.push(message),
      },
      { clearProjectModelFallbacks },
    );

    expect(exitCode).toBe(0);
    expect(clearProjectModelFallbacks).toHaveBeenCalledWith({
      path: "/tmp/project",
      recursive: true,
    });
    expect(stdout).toEqual(["updated /tmp/project/Spawnfile"]);
  });

  it("sets a runtime through the CLI", async () => {
    const stdout: string[] = [];
    const setProjectRuntime = vi.fn(async () => ({
      updatedFiles: ["/tmp/project/Spawnfile"],
    }));

    const exitCode = await runCli(
      ["runtime", "set", "picoclaw", "/tmp/project", "--recursive"],
      {
        stderr: () => undefined,
        stdout: (message) => stdout.push(message),
      },
      { setProjectRuntime },
    );

    expect(exitCode).toBe(0);
    expect(setProjectRuntime).toHaveBeenCalledWith({
      path: "/tmp/project",
      recursive: true,
      runtime: "picoclaw",
    });
    expect(stdout).toEqual(["updated /tmp/project/Spawnfile"]);
  });

  it("adds a surface through the CLI", async () => {
    const stdout: string[] = [];
    const addProjectSurface = vi.fn(async () => ({
      updatedFiles: ["/tmp/project/Spawnfile"],
    }));

    const exitCode = await runCli(
      [
        "surface",
        "add",
        "slack",
        "/tmp/project",
        "--bot-token-secret",
        "SLACK_BOT_TOKEN",
        "--app-token-secret",
        "SLACK_APP_TOKEN",
        "--recursive",
      ],
      {
        stderr: () => undefined,
        stdout: (message) => stdout.push(message),
      },
      { addProjectSurface },
    );

    expect(exitCode).toBe(0);
    expect(addProjectSurface).toHaveBeenCalledWith({
      appTokenSecret: "SLACK_APP_TOKEN",
      botTokenSecret: "SLACK_BOT_TOKEN",
      path: "/tmp/project",
      recursive: true,
      surface: "slack",
    });
    expect(stdout).toEqual(["updated /tmp/project/Spawnfile"]);
  });

  it("sets surface access through the CLI", async () => {
    const stdout: string[] = [];
    const setProjectSurfaceAccess = vi.fn(async () => ({
      updatedFiles: ["/tmp/project/Spawnfile"],
    }));

    const exitCode = await runCli(
      [
        "surface",
        "set-access",
        "discord",
        "/tmp/project",
        "--mode",
        "allowlist",
        "--user",
        "U1",
        "--user",
        "U2",
        "--guild",
        "G1",
        "--channel",
        "C1",
      ],
      {
        stderr: () => undefined,
        stdout: (message) => stdout.push(message),
      },
      { setProjectSurfaceAccess },
    );

    expect(exitCode).toBe(0);
    expect(setProjectSurfaceAccess).toHaveBeenCalledWith({
      channels: ["C1"],
      chats: [],
      groups: [],
      guilds: ["G1"],
      mode: "allowlist",
      path: "/tmp/project",
      recursive: undefined,
      surface: "discord",
      users: ["U1", "U2"],
    });
    expect(stdout).toEqual(["updated /tmp/project/Spawnfile"]);
  });

  it("rejects removed http surface access through the CLI", async () => {
    const stderr: string[] = [];
    const setProjectSurfaceAccess = vi.fn(async () => ({
      updatedFiles: ["/tmp/project/Spawnfile"],
    }));

    const exitCode = await runCli(
      ["surface", "set-access", "http", "/tmp/project", "--mode", "open"],
      {
        stderr: (message) => stderr.push(message),
        stdout: () => undefined,
      },
      { setProjectSurfaceAccess },
    );

    expect(exitCode).toBe(2);
    expect(setProjectSurfaceAccess).not.toHaveBeenCalled();
    expect(stderr[0]).toMatch(/unsupported portable surface http/i);
  });

  it("imports env auth into a profile", async () => {
    const stdout: string[] = [];
    const importEnvFile = vi.fn(async () => ({
      authHome: "/tmp/.spawnfile/auth",
      env: {
        ANTHROPIC_API_KEY: "ant-key",
        OPENAI_API_KEY: "openai-key",
      },
      imports: {},
      name: "dev",
      profileDirectory: "/tmp/.spawnfile/auth/profiles/dev",
      profilePath: "/tmp/.spawnfile/auth/profiles/dev/profile.json",
      version: 1 as const,
    }));

    const exitCode = await runCli(
      ["auth", "import", "env", "/tmp/dev.env", "--profile", "dev"],
      {
        stderr: () => undefined,
        stdout: (message) => stdout.push(message),
      },
      { importEnvFile },
    );

    expect(exitCode).toBe(0);
    expect(importEnvFile).toHaveBeenCalledWith("dev", "/tmp/dev.env");
    expect(stdout).toEqual([
      "profile: dev",
      "env: ANTHROPIC_API_KEY, OPENAI_API_KEY",
      "imports: none",
    ]);
  });

  it("imports Codex auth into a profile", async () => {
    const stdout: string[] = [];
    const importCodexAuth = vi.fn(async () => ({
      authHome: "/tmp/.spawnfile/auth",
      env: {},
      imports: {
        codex: {
          kind: "codex" as const,
          path: "/tmp/.spawnfile/auth/profiles/dev/imports/codex",
        },
      },
      name: "dev",
      profileDirectory: "/tmp/.spawnfile/auth/profiles/dev",
      profilePath: "/tmp/.spawnfile/auth/profiles/dev/profile.json",
      version: 1 as const,
    }));

    const exitCode = await runCli(
      ["auth", "import", "codex", "--profile", "dev", "--from", "/tmp/.codex"],
      {
        stderr: () => undefined,
        stdout: (message) => stdout.push(message),
      },
      { importCodexAuth },
    );

    expect(exitCode).toBe(0);
    expect(importCodexAuth).toHaveBeenCalledWith("dev", "/tmp/.codex");
    expect(stdout).toEqual(["profile: dev", "env: none", "imports: codex"]);
  });

  it("imports Claude Code auth into a profile", async () => {
    const stdout: string[] = [];
    const importClaudeCodeAuth = vi.fn(async () => ({
      authHome: "/tmp/.spawnfile/auth",
      env: {},
      imports: {
        "claude-code": {
          kind: "claude-code" as const,
          path: "/tmp/.spawnfile/auth/profiles/dev/imports/claude-code",
        },
      },
      name: "dev",
      profileDirectory: "/tmp/.spawnfile/auth/profiles/dev",
      profilePath: "/tmp/.spawnfile/auth/profiles/dev/profile.json",
      version: 1 as const,
    }));

    const exitCode = await runCli(
      [
        "auth",
        "import",
        "claude-code",
        "--profile",
        "dev",
        "--from",
        "/tmp/.claude",
      ],
      {
        stderr: () => undefined,
        stdout: (message) => stdout.push(message),
      },
      { importClaudeCodeAuth },
    );

    expect(exitCode).toBe(0);
    expect(importClaudeCodeAuth).toHaveBeenCalledWith("dev", "/tmp/.claude");
    expect(stdout).toEqual([
      "profile: dev",
      "env: none",
      "imports: claude-code",
    ]);
  });

  it("shows an auth profile summary", async () => {
    const stdout: string[] = [];
    const requireAuthProfile = vi.fn(async () => ({
      authHome: "/tmp/.spawnfile/auth",
      env: {
        ANTHROPIC_API_KEY: "ant-key",
      },
      imports: {
        codex: {
          kind: "codex" as const,
          path: "/tmp/.spawnfile/auth/profiles/dev/imports/codex",
        },
      },
      name: "dev",
      profileDirectory: "/tmp/.spawnfile/auth/profiles/dev",
      profilePath: "/tmp/.spawnfile/auth/profiles/dev/profile.json",
      version: 1 as const,
    }));

    const exitCode = await runCli(
      ["auth", "show", "--profile", "dev"],
      {
        stderr: () => undefined,
        stdout: (message) => stdout.push(message),
      },
      { requireAuthProfile },
    );

    expect(exitCode).toBe(0);
    expect(stdout).toEqual([
      "profile: dev",
      "env: ANTHROPIC_API_KEY",
      "imports: codex",
    ]);
  });

  it("syncs project auth from declared manifest methods", async () => {
    const stdout: string[] = [];
    const syncProjectAuth = vi.fn(async () => ({
      authHome: "/tmp/.spawnfile/auth",
      env: {
        OPENAI_API_KEY: "openai-key",
      },
      imports: {
        codex: {
          kind: "codex" as const,
          path: "/tmp/.spawnfile/auth/profiles/dev/imports/codex",
        },
      },
      name: "dev",
      profileDirectory: "/tmp/.spawnfile/auth/profiles/dev",
      profilePath: "/tmp/.spawnfile/auth/profiles/dev/profile.json",
      version: 1 as const,
    }));

    const exitCode = await runCli(
      [
        "auth",
        "sync",
        path.join(fixturesRoot, "single-agent"),
        "--profile",
        "dev",
        "--env-file",
        "/tmp/dev.env",
      ],
      {
        stderr: () => undefined,
        stdout: (message) => stdout.push(message),
      },
      { syncProjectAuth },
    );

    expect(exitCode).toBe(0);
    expect(syncProjectAuth).toHaveBeenCalledWith(
      path.join(fixturesRoot, "single-agent"),
      {
        claudeCodeDirectory: undefined,
        codexDirectory: undefined,
        envFilePath: "/tmp/dev.env",
        profileName: "dev",
      },
    );
    expect(stdout).toEqual([
      "profile: dev",
      "env: OPENAI_API_KEY",
      "imports: codex",
    ]);
  });

  it("initializes a team project", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "spawnfile-cli-init-"),
    );
    temporaryDirectories.push(directory);

    const stdout: string[] = [];
    const exitCode = await runCli(["init", directory, "--team"], {
      stderr: () => undefined,
      stdout: (message) => stdout.push(message),
    });

    expect(exitCode).toBe(0);
    await expect(fileExists(path.join(directory, "TEAM.md"))).resolves.toBe(
      true,
    );
    expect(stdout[0]).toContain("initialized");
  });

  it("initializes an agent project for a selected runtime", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "spawnfile-cli-runtime-init-"),
    );
    temporaryDirectories.push(directory);

    const initProject = vi.fn(async () => ({
      createdFiles: [
        path.join(directory, "Spawnfile"),
        path.join(directory, "AGENTS.md"),
      ],
      directory,
    }));

    const stdout: string[] = [];
    const exitCode = await runCli(
      ["init", directory, "--runtime", "picoclaw"],
      {
        stderr: () => undefined,
        stdout: (message) => stdout.push(message),
      },
      { initProject },
    );

    expect(exitCode).toBe(0);
    expect(initProject).toHaveBeenCalledWith({
      directory,
      runtime: "picoclaw",
      team: undefined,
    });
    expect(stdout[0]).toContain("initialized");
  });

  it("adds an agent member to a team project without requiring --runtime", async () => {
    const addAgentProject = vi.fn(async () => ({
      createdFiles: [
        "/tmp/project/agents/writer/Spawnfile",
        "/tmp/project/agents/writer/AGENTS.md",
      ],
      targetDirectory: "/tmp/project",
      updatedFiles: ["/tmp/project/Spawnfile"],
    }));

    const stdout: string[] = [];
    const exitCode = await runCli(
      ["add", "agent", "writer", "/tmp/project"],
      {
        stderr: () => undefined,
        stdout: (message) => stdout.push(message),
      },
      { addAgentProject },
    );

    expect(exitCode).toBe(0);
    expect(addAgentProject).toHaveBeenCalledWith({
      id: "writer",
      path: "/tmp/project",
      runtime: undefined,
    });
    expect(stdout).toEqual([
      "updated /tmp/project/Spawnfile",
      "created /tmp/project/agents/writer/Spawnfile",
      "created /tmp/project/agents/writer/AGENTS.md",
    ]);
  });

  it("adds an agent member to a team project with an explicit runtime override", async () => {
    const addAgentProject = vi.fn(async () => ({
      createdFiles: [
        "/tmp/project/agents/writer/Spawnfile",
        "/tmp/project/agents/writer/AGENTS.md",
      ],
      targetDirectory: "/tmp/project",
      updatedFiles: ["/tmp/project/Spawnfile"],
    }));

    const stdout: string[] = [];
    const exitCode = await runCli(
      ["add", "agent", "writer", "/tmp/project", "--runtime", "picoclaw"],
      {
        stderr: () => undefined,
        stdout: (message) => stdout.push(message),
      },
      { addAgentProject },
    );

    expect(exitCode).toBe(0);
    expect(addAgentProject).toHaveBeenCalledWith({
      id: "writer",
      path: "/tmp/project",
      runtime: "picoclaw",
    });
    expect(stdout).toEqual([
      "updated /tmp/project/Spawnfile",
      "created /tmp/project/agents/writer/Spawnfile",
      "created /tmp/project/agents/writer/AGENTS.md",
    ]);
  });

  it("adds a subagent to an agent project", async () => {
    const addSubagentProject = vi.fn(async () => ({
      createdFiles: [
        "/tmp/project/subagents/critic/Spawnfile",
        "/tmp/project/subagents/critic/AGENTS.md",
      ],
      targetDirectory: "/tmp/project",
      updatedFiles: ["/tmp/project/Spawnfile"],
    }));

    const stdout: string[] = [];
    const exitCode = await runCli(
      ["add", "subagent", "critic", "/tmp/project"],
      {
        stderr: () => undefined,
        stdout: (message) => stdout.push(message),
      },
      { addSubagentProject },
    );

    expect(exitCode).toBe(0);
    expect(addSubagentProject).toHaveBeenCalledWith({
      id: "critic",
      path: "/tmp/project",
    });
    expect(stdout).toEqual([
      "updated /tmp/project/Spawnfile",
      "created /tmp/project/subagents/critic/Spawnfile",
      "created /tmp/project/subagents/critic/AGENTS.md",
    ]);
  });

  it("adds a nested team to a team project", async () => {
    const addTeamProject = vi.fn(async () => ({
      createdFiles: [
        "/tmp/project/teams/platform/Spawnfile",
        "/tmp/project/teams/platform/TEAM.md",
      ],
      targetDirectory: "/tmp/project",
      updatedFiles: ["/tmp/project/Spawnfile"],
    }));

    const stdout: string[] = [];
    const exitCode = await runCli(
      ["add", "team", "platform", "/tmp/project"],
      {
        stderr: () => undefined,
        stdout: (message) => stdout.push(message),
      },
      { addTeamProject },
    );

    expect(exitCode).toBe(0);
    expect(addTeamProject).toHaveBeenCalledWith({
      id: "platform",
      path: "/tmp/project",
    });
    expect(stdout).toEqual([
      "updated /tmp/project/Spawnfile",
      "created /tmp/project/teams/platform/Spawnfile",
      "created /tmp/project/teams/platform/TEAM.md",
    ]);
  });

  it("exits 2 with friendly guidance when the Spawnfile path does not exist", async () => {
    const stderr: string[] = [];
    const exitCode = await runCli(
      ["validate", path.join(fixturesRoot, "does-not-exist")],
      {
        stderr: (message) => stderr.push(message),
        stdout: () => undefined,
      },
    );

    expect(exitCode).toBe(2);
    expect(stderr[0]).toContain("No Spawnfile found");
  });

  it("formats Spawnfile errors without leaking the internal code", async () => {
    const stderr: string[] = [];
    const exitCode = await runCli(
      ["validate", path.join(fixturesRoot, "single-agent")],
      {
        stderr: (message) => stderr.push(message),
        stdout: () => undefined,
      },
      {
        buildCompilePlan: vi.fn(async () => {
          throw new SpawnfileError("validation_error", "bad auth");
        }),
      },
    );

    expect(exitCode).toBe(2);
    expect(stderr).toEqual(["error: bad auth"]);
  });

  it("formats non-Error failures using String(value)", async () => {
    const stderr: string[] = [];
    const exitCode = await runCli(
      ["validate", path.join(fixturesRoot, "single-agent")],
      {
        stderr: (message) => stderr.push(message),
        stdout: () => undefined,
      },
      {
        buildCompilePlan: vi.fn(async () => {
          throw "plain failure";
        }),
      },
    );

    expect(exitCode).toBe(1);
    expect(stderr).toEqual(["error: plain failure"]);
  });

  it("uses default process streams when custom streams are not provided", async () => {
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    try {
      const exitCode = await runCli(["runtimes"]);

      expect(exitCode).toBe(0);
      expect(stdoutSpy).toHaveBeenCalled();
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  it("prints commander errors through the default stderr stream", async () => {
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    try {
      const exitCode = await runCli(["unknown-command"]);

      expect(exitCode).toBe(2);
      expect(stderrSpy).toHaveBeenCalled();
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("rejects image-mode run with guidance to use up", async () => {
    const stderr: string[] = [];
    const exitCode = await runCli(["run", "you/org:1.0.0"], {
      stderr: (message) => stderr.push(message),
      stdout: () => undefined,
    });
    expect(exitCode).toBe(2);
    expect(stderr.join("\n")).toContain("Image-mode run is not supported");
  });

  it("rejects an unresolvable up argument", async () => {
    const stderr: string[] = [];
    const exitCode = await runCli(["up", "not-a-project-or-ref"], {
      stderr: (message) => stderr.push(message),
      stdout: () => undefined,
    });
    expect(exitCode).toBe(2);
    expect(stderr.join("\n")).toContain("Cannot resolve");
  });

  it("rejects an unresolvable run argument", async () => {
    const stderr: string[] = [];
    const exitCode = await runCli(["run", "not-a-project-or-ref"], {
      stderr: (message) => stderr.push(message),
      stdout: () => undefined,
    });
    expect(exitCode).toBe(2);
    expect(stderr.join("\n")).toContain("Cannot resolve");
  });

  it("rejects image-mode run forced with --image", async () => {
    const stderr: string[] = [];
    const exitCode = await runCli(["run", "bare-name", "--image"], {
      stderr: (message) => stderr.push(message),
      stdout: () => undefined,
    });
    expect(exitCode).toBe(2);
    expect(stderr.join("\n")).toContain("Image-mode run is not supported");
  });

  it("publishes a project and prints the digest", async () => {
    const stdout: string[] = [];
    const publishProject = vi.fn(async () => ({
      digest: "sha256:pushed",
      imageTag: "localhost:5000/org:1.0.0",
      outputDirectory: "/tmp/.spawn",
      report: {} as never,
      reportPath: "/tmp/.spawn/spawnfile-report.json",
    }));
    const exitCode = await runCli(
      [
        "publish",
        "test/fixtures/single-agent",
        "--tag",
        "localhost:5000/org:1.0.0",
      ],
      { stderr: () => undefined, stdout: (message) => stdout.push(message) },
      { publishProject: publishProject as never },
    );
    expect(exitCode).toBe(0);
    expect(publishProject).toHaveBeenCalled();
    expect(stdout.join("\n")).toContain("digest: sha256:pushed");
  });

  it("prints bounded fallbacks for detached run and digest-free publish results", async () => {
    const runStdout: string[] = [];
    const runProject = vi.fn(async () => ({
      containerName: undefined,
      imageTag: "project:latest"
    }));
    await expect(runCli(
      ["run", path.join(fixturesRoot, "single-agent"), "--detach"],
      { stderr: () => undefined, stdout: (message) => runStdout.push(message) },
      { runProject: runProject as never }
    )).resolves.toBe(0);
    expect(runStdout).toContain("running container unknown");

    const publishStdout: string[] = [];
    const publishProject = vi.fn(async () => ({
      digest: undefined,
      imageTag: "localhost:5000/org:latest"
    }));
    await expect(runCli(
      ["publish", path.join(fixturesRoot, "single-agent"), "--tag", "localhost:5000/org:latest"],
      { stderr: () => undefined, stdout: (message) => publishStdout.push(message) },
      { publishProject: publishProject as never }
    )).resolves.toBe(0);
    expect(publishStdout).toContain("digest: unknown");
  });

  it("rejects missing and conflicting lifecycle lookup identities", async () => {
    for (const args of [
      ["lifecycle", "lookup"],
      ["lifecycle", "lookup", `lci_${"a".repeat(16)}`, "--lifecycle-invocation", `lci_${"b".repeat(16)}`]
    ]) {
      const stderr: string[] = [];
      await expect(runCli(args, {
        stderr: (message) => stderr.push(message),
        stdout: () => undefined
      })).resolves.toBe(2);
      expect(stderr.join("\n")).toContain("requires exactly one lifecycle invocation id");
    }
  });

  it("rejects publish of an image reference", async () => {
    const stderr: string[] = [];
    const exitCode = await runCli(
      ["publish", "you/org:1.0.0", "--tag", "you/org:1.0.0"],
      { stderr: (message) => stderr.push(message), stdout: () => undefined },
    );
    expect(exitCode).toBe(2);
    expect(stderr.join("\n")).toContain("operates on a project path");
  });

  it("deploys an image reference through the consumeImageUp handler", async () => {
    const stdout: string[] = [];
    const consumeImageUp = vi.fn(async () => ({
      containerName: "spawnfile-prod",
      deploymentName: "prod",
      imageRef: "you/org:1.0.0",
      record: {} as never,
      recordPath: "/home/.spawnfile/deployments/prod/record.json",
    }));
    const exitCode = await runCli(
      ["up", "you/org:1.0.0", "--deployment", "prod", "--detach"],
      { stderr: () => undefined, stdout: (message) => stdout.push(message) },
      { consumeImageUp: consumeImageUp as never },
    );
    expect(exitCode).toBe(0);
    expect(consumeImageUp).toHaveBeenCalledWith(
      "you/org:1.0.0",
      expect.objectContaining({
        deploymentName: "prod",
      }),
    );
    expect(stdout.join("\n")).toContain("deployed image you/org:1.0.0");
    expect(stdout.join("\n")).toContain(
      "record: /home/.spawnfile/deployments/prod/record.json",
    );
  });

  it("summarizes the previous → new ref/digest when redeploying an image", async () => {
    const stdout: string[] = [];
    const consumeImageUp = vi.fn(async () => ({
      containerName: "spawnfile-prod",
      deploymentName: "prod",
      imageRef: "you/org:2.0.0",
      previous: { digest: "sha256:" + "a".repeat(64), ref: "you/org:1.0.0" },
      record: {
        source: {
          digest: "sha256:" + "b".repeat(64),
          kind: "image",
          ref: "you/org:2.0.0",
        },
      } as never,
      recordPath: "/home/.spawnfile/deployments/prod/record.json",
    }));
    const exitCode = await runCli(
      ["up", "you/org:2.0.0", "--deployment", "prod"],
      { stderr: () => undefined, stdout: (message) => stdout.push(message) },
      { consumeImageUp: consumeImageUp as never },
    );
    expect(exitCode).toBe(0);
    const out = stdout.join("\n");
    expect(out).toContain(
      "redeployed image: you/org:1.0.0 (aaaaaaaaaaaa) → you/org:2.0.0 (bbbbbbbbbbbb)",
    );
    expect(out).not.toContain("deployed image you/org:2.0.0");
  });

  it("reports an unchanged digest when redeploying the same ref and digest", async () => {
    const stdout: string[] = [];
    const digest = "sha256:" + "c".repeat(64);
    const consumeImageUp = vi.fn(async () => ({
      containerName: "spawnfile-prod",
      deploymentName: "prod",
      imageRef: "you/org:1.0.0",
      previous: { digest, ref: "you/org:1.0.0" },
      record: {
        source: { digest, kind: "image", ref: "you/org:1.0.0" },
      } as never,
      recordPath: "/home/.spawnfile/deployments/prod/record.json",
    }));
    const exitCode = await runCli(
      ["up", "you/org:1.0.0", "--deployment", "prod"],
      { stderr: () => undefined, stdout: (message) => stdout.push(message) },
      { consumeImageUp: consumeImageUp as never },
    );
    expect(exitCode).toBe(0);
    expect(stdout.join("\n")).toContain(
      "redeployed image you/org:1.0.0 (digest unchanged cccccccccccc)",
    );
  });

  it("renders a spawnfile.up-receipt.v1 with `up --json`", async () => {
    const stdout: string[] = [];
    const upResult = {
      authProfileName: null,
      containerName: "spawnfile-single-agent",
      deploymentRecordPath: "/tmp/spawnfile-up-out/deployments/default.json",
      imageTag: "spawnfile-single-agent",
      outputDirectory: "/tmp/spawnfile-up-out",
      report: {
        compile_fingerprint: "sf1:abc123",
        diagnostics: [],
        nodes: [],
        root: path.join(fixturesRoot, "single-agent"),
        spawnfile_version: "0.1" as const,
      },
      reportPath: "/tmp/spawnfile-up-out/spawnfile-report.json",
      supportDirectory: null,
    };
    const upProject = vi.fn(async () => upResult);
    const receipt = {
      compiled_schedule: [],
      deployment: { container_ids: ["container-123"], name: "default" },
      fingerprint: "sf1:abc123",
      readiness: { moltnet_base_url: null, state: "running" as const },
      run_id: "run-abc123",
      version: "spawnfile.up-receipt.v1" as const,
    };
    const buildUpReceipt = vi.fn(async () => receipt);

    const exitCode = await runCli(
      ["up", path.join(fixturesRoot, "single-agent"), "--detach", "--json"],
      { stderr: () => undefined, stdout: (message) => stdout.push(message) },
      {
        upProject: upProject as never,
        buildUpReceipt: buildUpReceipt as never,
      },
    );

    expect(exitCode).toBe(0);
    expect(buildUpReceipt).toHaveBeenCalledWith(
      path.join(fixturesRoot, "single-agent"),
      upResult,
    );
    expect(stdout).toEqual([JSON.stringify(receipt, null, 2)]);
  });

  it("durably replays an exact JSON lifecycle completion and exposes read-only lookup", async () => {
    const home = await mkdtemp(
      path.join(os.tmpdir(), "spawnfile-lifecycle-cli-"),
    );
    const priorHome = process.env.SPAWNFILE_HOME;
    process.env.SPAWNFILE_HOME = home;
    temporaryDirectories.push(home);
    const id = `lci_${"a".repeat(16)}`;
    const selectedTargetReceipt = {
      fingerprint: `sha256:${"f".repeat(32)}`,
      handle: "opaque_fedcba9876543210",
      version: "spawnfile.target-resource.selected-target.v1",
    };
    const selectedTargetReceiptBytes = JSON.stringify(selectedTargetReceipt);
    const selectedTargetReceiptFile = path.join(home, "selected-target.json");
    await writeFile(selectedTargetReceiptFile, selectedTargetReceiptBytes);
    const selectedTargetReceiptDigest = `sha256:${createHash("sha256").update(selectedTargetReceiptBytes).digest("hex")}`;
    const receipt = {
      compiled_schedule: [],
      deployment: { container_ids: ["container-123"], name: "default" },
      fingerprint: "sf1:abc123",
      readiness: { moltnet_base_url: null, state: "running" as const },
      run_id: "run-abc123",
      version: "spawnfile.up-receipt.v1" as const,
    };
    const upProject = vi.fn(async () => ({
      report: { compile_fingerprint: "sf1:abc123" },
    }));
    const buildUpReceipt = vi.fn(async () => receipt);
    const first: string[] = [];
    const second: string[] = [];
    try {
      const argv = [
        "up",
        path.join(fixturesRoot, "single-agent"),
        "--json",
        "--lifecycle-invocation",
        id,
        "--detach",
        "--deployment",
        "default",
        "--organization-handoff-run-id",
        "run-abc123",
        "--descriptor-digest",
        `sha256:${"d".repeat(64)}`,
        "--selected-target-receipt",
        selectedTargetReceiptFile,
        "--network-attachment-handle",
        "opaque_0123456789abcdef",
        "--selected-target-receipt-digest",
        selectedTargetReceiptDigest,
        "--world-bindings",
        "/tmp/world-bindings.json",
      ];
      await runCli(
        argv,
        { stderr: () => undefined, stdout: (message) => first.push(message) },
        {
          upProject: upProject as never,
          buildUpReceipt: buildUpReceipt as never,
        },
      );
      await runCli(
        argv,
        { stderr: () => undefined, stdout: (message) => second.push(message) },
        {
          upProject: upProject as never,
          buildUpReceipt: buildUpReceipt as never,
        },
      );
      const lookup: string[] = [];
      await runCli(["lifecycle", "lookup", id], {
        stderr: () => undefined,
        stdout: (message) => lookup.push(message),
      });
      expect(upProject).toHaveBeenCalledTimes(1);
      expect(second).toEqual(first);
      expect(JSON.parse(lookup.join("\n"))).toMatchObject({
        status: "completed",
        outcome_bytes: first[0],
      });
    } finally {
      if (priorHome === undefined) delete process.env.SPAWNFILE_HOME;
      else process.env.SPAWNFILE_HOME = priorHome;
    }
  });

  it("rejects `up --json` for image-mode deployments", async () => {
    const stderr: string[] = [];
    const exitCode = await runCli(
      ["up", "you/org:1.0.0", "--deployment", "prod", "--detach", "--json"],
      { stderr: (message) => stderr.push(message), stdout: () => undefined },
    );
    expect(exitCode).toBe(2);
    expect(stderr.join("\n")).toContain(
      "not yet supported for image-mode deployments",
    );
  });

  it("tears down a deployment and renders a spawnfile.down-receipt.v1 with `down --json`", async () => {
    const stdout: string[] = [];
    const downDeployment = vi.fn(async () => ({
      deployment: "default",
      errors: [],
      retained_volumes: ["spawnfile-project-memory-abc123"],
      units_stopped: ["default-container"],
      version: "spawnfile.down-receipt.v1" as const,
    }));

    const exitCode = await runCli(
      [
        "down",
        path.join(fixturesRoot, "single-agent"),
        "--deployment",
        "default",
        "--json",
      ],
      { stderr: () => undefined, stdout: (message) => stdout.push(message) },
      { downDeployment: downDeployment as never },
    );

    expect(exitCode).toBe(0);
    expect(downDeployment).toHaveBeenCalledWith(
      expect.objectContaining({
        deploymentName: "default",
        force: undefined,
        removeVolumes: undefined,
      }),
    );
    expect(stdout).toEqual([
      JSON.stringify(await downDeployment.mock.results[0]!.value, null, 2),
    ]);
  });

  it("prints a human-readable down summary without --json", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const downDeployment = vi.fn(async () => ({
      deployment: "default",
      errors: [
        "unable to remove container spawnfile-project (unit default-container): timeout",
      ],
      retained_volumes: ["spawnfile-project-memory-abc123"],
      units_stopped: [],
      version: "spawnfile.down-receipt.v1" as const,
    }));

    const exitCode = await runCli(
      [
        "down",
        path.join(fixturesRoot, "single-agent"),
        "--deployment",
        "default",
        "--force",
      ],
      {
        stderr: (message) => stderr.push(message),
        stdout: (message) => stdout.push(message),
      },
      { downDeployment: downDeployment as never },
    );

    expect(exitCode).toBe(0);
    expect(downDeployment).toHaveBeenCalledWith(
      expect.objectContaining({ force: true }),
    );
    expect(stdout).toEqual([
      "deployment: default",
      "retained volume: spawnfile-project-memory-abc123",
    ]);
    expect(stderr).toEqual([
      "error: unable to remove container spawnfile-project (unit default-container): timeout",
    ]);
  });
});
