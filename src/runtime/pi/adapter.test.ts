import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { piAdapter } from "./adapter.js";
import { createPiTestNode } from "./testHelpers.js";

describe("piAdapter", () => {
  it("exposes generated app container metadata", () => {
    expect(piAdapter.container).toMatchObject({
      configFileName: "pi-app.json",
      configPathEnv: "SPAWNFILE_PI_CONFIG",
      homeEnv: "SPAWNFILE_PI_HOME",
      instancePaths: {
        configPathTemplate: "<instance-root>/pi/<config-file>",
        homePathTemplate: "<instance-root>/home",
        sourceWorkspacePathTemplate: "<instance-root>/workspace/agents/<source-slug>",
        workspacePathTemplate: "<instance-root>/workspace"
      },
      port: 19690,
      portEnv: "SPAWNFILE_PI_CONTROL_PORT",
      standaloneBaseImage: "node:24-bookworm-slim",
      startCommand: ["node", "<runtime-root>/app.mjs", "<config-path>"],
      globalNpmPackages: ["@anthropic-ai/claude-code", "@openai/codex@0.142.3"],
      postRootfsCommands: [
        "curl -fsSL https://x.ai/cli/install.sh | GROK_BIN_DIR=/usr/local/bin bash",
        "if [ -L /usr/local/bin/grok ]; then cp -L /usr/local/bin/grok /usr/local/bin/grok.real && mv /usr/local/bin/grok.real /usr/local/bin/grok && chmod 0755 /usr/local/bin/grok && ln -sf /usr/local/bin/grok /usr/local/bin/agent; fi",
        "curl -fsSL https://antigravity.google/cli/install.sh | bash -s -- --dir /usr/local/bin"
      ],
      systemDeps: ["bash", "ca-certificates", "curl", "git", "procps", "tar"]
    });
  });

  it("supports OpenAI Codex auth and local OpenAI-compatible endpoints", () => {
    expect(() =>
      piAdapter.assertSupportedModelTarget({
        auth: { method: "codex" },
        name: "gpt-5.4-mini",
        provider: "openai"
      })
    ).not.toThrow();

    expect(() =>
      piAdapter.assertSupportedModelTarget({
        auth: { method: "none" },
        endpoint: {
          base_url: "http://127.0.0.1:8080",
          compatibility: "openai"
        },
        name: "local-model",
        provider: "local"
      })
    ).not.toThrow();
  });

  it("supports API-key provider paths and rejects unsupported auth combinations", () => {
    expect(() =>
      piAdapter.assertSupportedModelTarget({
        auth: { method: "api_key" },
        name: "gpt-5.4-mini",
        provider: "openai"
      })
    ).not.toThrow();

    expect(() =>
      piAdapter.assertSupportedModelTarget({
        auth: { method: "api_key" },
        name: "claude-sonnet-4-5",
        provider: "anthropic"
      })
    ).not.toThrow();

    expect(() =>
      piAdapter.assertSupportedModelTarget({
        auth: { method: "claude-code" },
        name: "claude-sonnet-4-5",
        provider: "anthropic"
      })
    ).not.toThrow();

    expect(() =>
      piAdapter.assertSupportedModelTarget({
        auth: { method: "codex" },
        endpoint: {
          base_url: "http://127.0.0.1:11434/v1",
          compatibility: "openai"
        },
        name: "llama3.2",
        provider: "local"
      })
    ).toThrow(/endpoint models only support none or api_key auth/);
  });

  it("emits workspace docs and supports every schedules", async () => {
    const compiled = await piAdapter.compileAgent(createPiTestNode({
      schedule: {
        every: "1s",
        kind: "every",
        prompt: "write a note"
      }
    }));

    expect(compiled.files.map((file) => file.path).sort()).toEqual([
      "workspace/.agents/skills/note/SKILL.md",
      "workspace/.codex/skills/note/SKILL.md",
      "workspace/AGENTS.md"
    ]);
    expect(compiled.capabilities).toContainEqual({
      key: "agent.schedule",
      message: "Pi generated runtime app owns this schedule",
      outcome: "supported"
    });
    expect(compiled.capabilities).toContainEqual({
      key: "execution.sandbox",
      message: "",
      outcome: "degraded"
    });
    expect(compiled.diagnostics).toContainEqual({
      level: "warn",
      message: "Pi runtime relies on container and workspace isolation; Pi itself is not a sandbox engine"
    });
  });

  it("emits exact every schedules for all four autonomous members", async () => {
    const prompts = {
      alpha: "Claim a world turn, observe the environment, choose alpha's strategy, submit one action, then stop.",
      beta: "Claim a world turn, observe the environment, choose beta's strategy, submit one action, then stop.",
      gamma: "Claim a world turn, observe the environment, choose gamma's strategy, submit one action, then stop.",
      delta: "Claim a world turn, observe the environment, choose delta's strategy, submit one action, then stop.",
    } as const;
    const targets = await piAdapter.createContainerTargets?.(
      Object.entries(prompts).map(([member, prompt]) => {
        const node = createPiTestNode({
          name: member,
          schedule: { every: "10s", kind: "every", prompt },
        });
        return {
          emittedFiles: [],
          id: `agent:${member}`,
          kind: "agent" as const,
          slug: member,
          value: node,
        };
      }),
    );
    const configFile = targets?.[0]?.files.find(({ path }) => path === "pi-app.json");
    const config = JSON.parse(configFile?.content ?? "{}") as {
      readonly agents: ReadonlyArray<{ readonly id: string; readonly schedule: unknown }>;
      readonly version: string;
    };

    expect(config.version).toBe("spawnfile.pi-app.v1");
    expect(config.agents.map(({ id, schedule }) => ({ id, schedule }))).toEqual(
      Object.entries(prompts).map(([member, prompt]) => ({
        id: `agent:${member}`,
        schedule: { every: "10s", kind: "every", prompt },
      })),
    );
  });

	  it("reports cron schedules as degraded with a diagnostic", async () => {
    const compiled = await piAdapter.compileAgent(createPiTestNode({
      schedule: {
        cron: "* * * * *",
        kind: "cron",
        prompt: "write a note",
        timezone: "UTC"
      }
    }));

    expect(compiled.capabilities).toContainEqual({
      key: "agent.schedule",
      message: "Pi generated runtime app supports every schedules in Spawnfile v0.1",
      outcome: "degraded"
    });
	    expect(compiled.diagnostics).toContainEqual({
	      level: "warn",
	      message: "Pi generated runtime app supports every schedules in Spawnfile v0.1; cron schedules are degraded"
	    });
	  });

	  it("reports unsupported memory consolidation schedules as degraded diagnostics", async () => {
	    const compiled = await piAdapter.compileAgent(createPiTestNode({
	      memoryAccess: [
	        {
	          agentSource: "/tmp/agent/Spawnfile",
	          bank: {
	            consolidation: { mode: "scheduled", schedule: "0 */6 * * *" },
	            declaredBy: "agent",
	            declaredName: "assistant",
	            id: "self",
	            index: {
	              graph: { enabled: false },
	              lexical: { enabled: true },
	              rerank: { enabled: false },
	              vector: { enabled: false }
	            },
	            retention: { forgetting: "manual" },
	            source: "/tmp/agent/Spawnfile",
	            store: {
	              kind: "sqlite",
	              path: "/var/lib/spawnfile/memory/assistant/self/memory.sqlite",
	              persistence: { mode: "durable" }
	            }
	          },
	          declaringKind: "agent",
	          source: "/tmp/agent/Spawnfile"
	        }
	      ]
	    }));

	    expect(compiled.diagnostics).toContainEqual({
	      level: "warn",
	      message:
	        "Pi generated runtime app supports every memory consolidation schedules in Spawnfile v0.1; memory bank self consolidation is degraded"
	    });
	  });

  it("accepts disabled schedules as supported", async () => {
    const compiled = await piAdapter.compileAgent(createPiTestNode({
      schedule: {
        kind: "disabled"
      }
    }));

    expect(compiled.capabilities).toContainEqual({
      key: "agent.schedule",
      message: "Pi generated runtime app owns this schedule",
      outcome: "supported"
    });
  });

  it("reports Moltnet bridge wake delivery as supported", async () => {
    const compiled = await piAdapter.compileAgent(createPiTestNode({
      surfaces: {
        moltnet: [
          {
            memberId: "assistant",
            network: "local_lab",
            rooms: {
              agora: { wake: "mentions" }
            },
            teamSource: "/tmp/Spawnfile"
          }
        ]
      }
    }));

    expect(compiled.capabilities).toContainEqual({
      key: "surfaces.moltnet",
      message:
        "Pi generated runtime app exposes a control endpoint for Moltnet bridge wake delivery",
      outcome: "supported"
    });
  });

  it("merges agents into one generated Pi app target", async () => {
    const mapper = createPiTestNode({ name: "mapper", source: "/tmp/mapper/Spawnfile" });
    const reviewer = createPiTestNode({ name: "reviewer", source: "/tmp/reviewer/Spawnfile" });
    const mapperCompiled = await piAdapter.compileAgent(mapper);
    const reviewerCompiled = await piAdapter.compileAgent(reviewer);

    const targets = await piAdapter.createContainerTargets?.([
      {
        emittedFiles: mapperCompiled.files,
        id: "agent:mapper",
        kind: "agent",
        slug: "mapper",
        value: mapper
      },
      {
        emittedFiles: reviewerCompiled.files,
        id: "agent:reviewer",
        kind: "agent",
        slug: "reviewer",
        value: reviewer
      }
    ]);

    expect(targets).toHaveLength(1);
    const target = targets?.[0];
    expect(target?.id).toBe("pi-app");
    expect(target?.sourceIds).toEqual(["agent:mapper", "agent:reviewer"]);
    expect(target?.files.map((file) => file.path).sort()).toContain("runtime/app.mjs");
    expect(target?.files.map((file) => file.path).sort()).toContain("runtime/package.json");
    expect(target?.files.map((file) => file.path).sort()).toContain("runtime/schedule.mjs");
    expect(target?.files.map((file) => file.path).sort()).toContain("home/.pi/agent/models.json");
    expect(target?.files.map((file) => file.path).sort()).toContain("pi-app.json");
    expect(target?.files.map((file) => file.path).sort()).toContain("workspace/agents/mapper/AGENTS.md");
    expect(target?.files.map((file) => file.path).sort()).toContain("workspace/agents/reviewer/AGENTS.md");
    const appSource = target?.files.find((file) => file.path === "runtime/app.mjs")?.content ?? "";
    expect(appSource).toContain("new PiHarnessAdapter({");
    expect(appSource).toContain("class CliEngineAgentHandle");
    expect(appSource).toContain("const runCodexEngine = async");
    expect(appSource).toContain("const runClaudeEngine = async");
    expect(appSource).toContain("const runGrokEngine = async");
    expect(appSource).toContain("const runAgyEngine = async");
    expect(appSource).toContain("const cleanCliFinalText = (value) => {");
    expect(appSource).toContain('process.env.DAIMON_GROK_MAX_TURNS ?? "24"');
    expect(appSource).toContain('"--allow",');
    expect(appSource).toContain('"Bash"');
    expect(appSource).toContain("const grokHomePreparations = new Map();");
    expect(appSource).toContain("const getSharedGrokHome = (paths) => {");
    expect(appSource).toContain("GROK_HOME: sharedGrok.grokHomePath");
    expect(appSource).toContain("The Daimon runtime publishes your final CLI output as your reply to the wake source.");
    expect(appSource).toContain("Return only the exact message body that should be published.");
    expect(appSource).toContain("Do not return progress reports such as");
    expect(appSource).toContain("If your instructions include an exact shell command");
    expect(appSource).toContain("const createActivityBroker = (options = {}) => {");
    expect(appSource).toContain("const rebuildAgentKeys = (agents) => {");
    expect(appSource).toContain("const message = await agent.wake({");
    expect(appSource).toContain("context: payload.context && typeof payload.context === \"object\"");
    expect(appSource).toContain("context: event.context");
    expect(appSource).toContain("next.resolve(await this.runWake(next.event));");
    expect(appSource).toContain("Moltnet coordination event.");
    expect(appSource).toContain("Treat it as context first.");
    expect(appSource).toContain('url.pathname === "/spawnfile/agents"');
    expect(appSource).toContain('url.pathname === "/spawnfile/activity/stream"');
	    expect(appSource).toContain('url.pathname === "/spawnfile/agents/load"');
	    expect(appSource).toContain('this.publish("agent.turn.started"');
	    expect(appSource).toContain("wake_kind: event.kind");
	    expect(appSource).toContain('import { installAgentSchedules } from "./schedule.mjs";');
	    const scheduleSource = target?.files.find(
	      (file) => file.path === "runtime/schedule.mjs"
	    )?.content ?? "";
	    expect(scheduleSource).toContain("const scheduleWake = async");
	    expect(scheduleSource).toContain("export const installAgentSchedules = async");
	    expect(scheduleSource).toContain('kind: "dream"');
	    expect(scheduleSource).toContain('from: "mneme"');
	    expect(appSource).toContain("const formatActivityError = (error) => redactActivityText");
    expect(appSource).toContain("this.handle = await this.adapter.startAgent({");
    expect(appSource).toContain("id: this.config.id,");
    expect(appSource).toContain(
      "instructions: createAgentInstructions(this.config, this.paths.workspacePath),"
    );
    expect(appSource).not.toContain(
      'instructions: this.config.instructions + "\\n\\n" + identityPrompt'
    );

    const config = JSON.parse(target?.files.find((file) => file.path === "pi-app.json")?.content ?? "{}");
    expect(config.agents.map((agent: { id: string; model: { provider: string } }) => ({
      id: agent.id,
      provider: agent.model.provider
    }))).toEqual([
      { id: "agent:mapper", provider: "openai-codex" },
      { id: "agent:reviewer", provider: "openai-codex" }
    ]);
  });

});
