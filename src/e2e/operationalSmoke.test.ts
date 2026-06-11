import { describe, expect, it, vi } from "vitest";

import { upProject as realUpProject } from "../compiler/index.js";
import type { UpProjectResult } from "../compiler/index.js";

import { runOperationalSmokeE2E, type OperationalSmokeDependencies } from "./operationalSmoke.js";

const createUpResult = (outputDirectory: string, imageTag: string): UpProjectResult => ({
  authProfileName: null,
  containerName: "operational-container",
  imageTag,
  outputDirectory,
  report: {
    container: {
      dockerfile: "Dockerfile",
      entrypoint: "entrypoint.sh",
      env_example: ".env.example",
      model_secrets_required: [],
      persistent_mounts: [
        {
          id: "moltnet-ops-lab-store",
          mount_path: "/var/lib/spawnfile/moltnet/networks/ops_lab",
          reason: "managed Moltnet sqlite store for ops_lab",
          volume_name: "spawnfile-ops-lab-state"
        }
      ],
      ports: [18990, 19087],
      runtime_homes: [
        "/var/lib/spawnfile/instances/picoclaw/agent-pico-scheduled/picoclaw"
      ],
      runtime_instances: [
        {
          config_path: "/var/lib/spawnfile/instances/picoclaw/agent-pico-scheduled/picoclaw/config.json",
          home_path: "/var/lib/spawnfile/instances/picoclaw/agent-pico-scheduled/picoclaw",
          id: "agent-pico-scheduled",
          model_auth_methods: {
            local: "none"
          },
          model_secrets_required: [],
          runtime: "picoclaw"
        }
      ],
      runtime_secrets_required: [],
      runtimes_installed: ["picoclaw"],
      secrets_required: []
    },
    diagnostics: [],
    nodes: [],
    root: "/fixture/Spawnfile",
    spawnfile_version: "0.1"
  },
  reportPath: `${outputDirectory}/spawnfile-report.json`,
  supportDirectory: "/tmp/spawnfile-operational-support"
});

describe("runOperationalSmokeE2E", () => {
  it("runs spawnfile up and checks runtime, Moltnet, schedule, and workspace links", async () => {
    const dockerCalls: string[][] = [];
    const upProject: typeof realUpProject = vi.fn(async (_inputPath, options = {}) =>
      createUpResult(options.outputDirectory ?? "/tmp/out", options.imageTag ?? "image")
    );
    const runCli = vi.fn(async (
      argv: string[],
      streamsOrOptions?: unknown,
      handlerOverrides?: { upProject?: typeof realUpProject }
    ) => {
      if (argv[0] === "up") {
        const valueAfter = (flag: string): string | undefined => {
          const index = argv.indexOf(flag);
          return index >= 0 ? argv[index + 1] : undefined;
        };
        await handlerOverrides?.upProject?.(argv[1]!, {
          containerName: valueAfter("--name"),
          detach: argv.includes("--detach"),
          imageTag: valueAfter("--tag"),
          outputDirectory: valueAfter("--out")
        });
        return 0;
      }
      if (argv[0] === "status") {
        const streams = streamsOrOptions as { stdout?: (message: string) => void };
        streams.stdout?.(JSON.stringify({
          deployments: [
            {
              units: [
                {
                  id: "default-container",
                  live: {
                    checked: true,
                    running: true,
                    severity: "ok"
                  }
                }
              ]
            }
          ],
          observations: [
            {
              key: "runtime.health",
              severity: "ok",
              source: "runtime",
              subject: "runtime-instance:agent-pico-scheduled"
            },
            {
              key: "runtime.ready",
              severity: "ok",
              source: "runtime",
              subject: "runtime-instance:agent-pico-scheduled"
            },
            {
              key: "schedule.next_run",
              severity: "ok",
              source: "runtime",
              subject: "runtime-instance:agent-pico-scheduled"
            },
            {
              key: "network.reachable",
              severity: "ok",
              source: "network",
              subject: "network:ops_lab"
            },
            {
              key: "network.room",
              severity: "ok",
              source: "network",
              subject: "room:ops_lab:ops-room"
            },
            {
              key: "network.agent.connected",
              severity: "ok",
              source: "network",
              subject: "agent:pico-scheduled"
            }
          ]
        }));
        return 0;
      }
      return 2;
    }) as unknown as NonNullable<OperationalSmokeDependencies["runCli"]>;
    const removeDirectory = vi.fn(async () => undefined);

    const result = await runOperationalSmokeE2E(
      {
        containerName: "operational-container",
        fixtureDirectory: "/fixture",
        imageTag: "operational-image",
        logger: { info: vi.fn() },
        pollIntervalMs: 1,
        timeoutMs: 1
      },
      {
        removeDirectory,
        runCli,
        runDockerCommand: async (_dockerCommand, args) => {
          dockerCalls.push(args);
          const command = args.join(" ");
          if (command.includes("/v1/agents")) {
            return JSON.stringify({
              agents: [
                { id: "pico-scheduled", rooms: ["ops-room"] }
              ]
            });
          }
          return "";
        },
        sleep: async () => undefined,
        upProject
      }
    );

    expect(result.containerName).toBe("operational-container");
    expect(result.imageTag).toBe("operational-image");
    expect(upProject).toHaveBeenCalledWith(
      "/fixture",
      expect.objectContaining({
        containerName: "operational-container",
        detach: true,
        imageTag: "operational-image"
      })
    );
    expect(runCli).toHaveBeenCalledWith([
      "status",
      "/fixture",
      "--out",
      expect.any(String),
      "--live",
      "--deployment",
      "default",
      "--json"
    ], expect.any(Object));
    expect(dockerCalls).toContainEqual(expect.arrayContaining(["exec", "operational-container", "curl", "-sf", "http://127.0.0.1:18990/health"]));
    expect(dockerCalls).toContainEqual(expect.arrayContaining(["exec", "operational-container", "curl", "-sf", "http://127.0.0.1:19123/health"]));
    expect(dockerCalls).toContainEqual(expect.arrayContaining(["exec", "operational-container", "curl", "-sf", "http://127.0.0.1:19087/healthz"]));
    expect(dockerCalls).toContainEqual(expect.arrayContaining(["exec", "operational-container", "test", "-L"]));
    expect(dockerCalls).toContainEqual(expect.arrayContaining([
      "exec",
      "operational-container",
      "test",
      "-f",
      "/var/lib/spawnfile/instances/picoclaw/agent-pico-scheduled/picoclaw/workspace/cron/jobs.json"
    ]));
    expect(dockerCalls).toContainEqual(["rm", "-f", "operational-container"]);
    expect(dockerCalls).toContainEqual(["image", "rm", "-f", "operational-image"]);
    expect(dockerCalls).toContainEqual(["volume", "rm", "-f", "spawnfile-ops-lab-state"]);
    expect(removeDirectory).toHaveBeenCalledWith("/tmp/spawnfile-operational-support");
  });
});
