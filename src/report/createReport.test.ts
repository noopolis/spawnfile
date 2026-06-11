import { describe, expect, it } from "vitest";

import { createCompileReport } from "./createReport.js";

describe("createCompileReport", () => {
  it("builds a v0.1 compile report", () => {
    expect(createCompileReport("/tmp/Spawnfile", [], [], undefined, {
      generatedAt: "2026-01-01T00:00:00.000Z",
      outputDirectory: "/tmp/.spawn"
    })).toEqual({
      compile_fingerprint: "sf1:ac07cc88b986",
      diagnostics: [],
      generated_at: "2026-01-01T00:00:00.000Z",
      nodes: [],
      output_directory: "/tmp/.spawn",
      root: "/tmp/Spawnfile",
      spawnfile_version: "0.1"
    });
  });

  it("keeps the compile fingerprint stable across timestamps", () => {
    const first = createCompileReport("/tmp/Spawnfile", [], [], undefined, {
      generatedAt: "2026-01-01T00:00:00.000Z"
    });
    const second = createCompileReport("/tmp/Spawnfile", [], [], undefined, {
      generatedAt: "2026-02-01T00:00:00.000Z"
    });

    expect(first.compile_fingerprint).toBe(second.compile_fingerprint);
  });

  it("includes container metadata when provided", () => {
    expect(
      createCompileReport(
        "/tmp/Spawnfile",
        [],
        [],
        {
          dockerfile: "Dockerfile",
          entrypoint: "entrypoint.sh",
          env_example: ".env.example",
          model_secrets_required: ["ANTHROPIC_API_KEY"],
          ports: [18789],
          runtime_instances: [
            {
              config_path: "/var/lib/spawnfile/instances/openclaw/agent-assistant/home/.openclaw/openclaw.json",
              home_path: "/var/lib/spawnfile/instances/openclaw/agent-assistant/home",
              id: "agent-assistant",
              model_auth_methods: {
                anthropic: "api_key"
              },
              model_secrets_required: ["ANTHROPIC_API_KEY"],
              runtime: "openclaw"
            }
          ],
          runtime_homes: ["/var/lib/spawnfile/instances/openclaw/agent-assistant/home"],
          runtime_secrets_required: ["OPENCLAW_GATEWAY_TOKEN"],
          runtimes_installed: ["openclaw"],
          secrets_required: ["ANTHROPIC_API_KEY", "OPENCLAW_GATEWAY_TOKEN"]
        },
        {
          generatedAt: "2026-01-01T00:00:00.000Z"
        }
      )
    ).toEqual({
      compile_fingerprint: "sf1:519f91f17f91",
      container: {
        dockerfile: "Dockerfile",
        entrypoint: "entrypoint.sh",
        env_example: ".env.example",
        model_secrets_required: ["ANTHROPIC_API_KEY"],
        ports: [18789],
        runtime_instances: [
          {
            config_path: "/var/lib/spawnfile/instances/openclaw/agent-assistant/home/.openclaw/openclaw.json",
            home_path: "/var/lib/spawnfile/instances/openclaw/agent-assistant/home",
            id: "agent-assistant",
            model_auth_methods: {
              anthropic: "api_key"
            },
            model_secrets_required: ["ANTHROPIC_API_KEY"],
            runtime: "openclaw"
          }
        ],
        runtime_homes: ["/var/lib/spawnfile/instances/openclaw/agent-assistant/home"],
        runtime_secrets_required: ["OPENCLAW_GATEWAY_TOKEN"],
        runtimes_installed: ["openclaw"],
        secrets_required: ["ANTHROPIC_API_KEY", "OPENCLAW_GATEWAY_TOKEN"]
      },
      diagnostics: [],
      generated_at: "2026-01-01T00:00:00.000Z",
      nodes: [],
      root: "/tmp/Spawnfile",
      spawnfile_version: "0.1"
    });
  });
});
