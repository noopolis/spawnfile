import { describe, expect, it } from "vitest";

import { createCompileReport } from "./createReport.js";

describe("createCompileReport", () => {
  it("builds a v0.1 compile report", () => {
    expect(createCompileReport("/tmp/Spawnfile", [])).toEqual({
      diagnostics: [],
      nodes: [],
      root: "/tmp/Spawnfile",
      spawnfile_version: "0.1"
    });
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
        }
      )
    ).toEqual({
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
      nodes: [],
      root: "/tmp/Spawnfile",
      spawnfile_version: "0.1"
    });
  });
});
