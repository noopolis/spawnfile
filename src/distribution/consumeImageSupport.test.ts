import { afterEach, describe, expect, it } from "vitest";

import {
  deriveDeploymentName,
  deriveVolumeName,
  renderEnvFileContent,
  resolveImageEnvironment
} from "./consumeImageSupport.js";
import { parseImageReference } from "./imageRef.js";
import type { DistributionReport } from "./types.js";

const ref = (value: string) => {
  const parsed = parseImageReference(value);
  if (!parsed) {
    throw new Error(`bad ref ${value}`);
  }
  return parsed;
};

const reportWithSecrets = (): DistributionReport => ({
  compile_fingerprint: "sf1:abc",
  generated_at: "2026-06-13T00:00:00.000Z",
  internal_ports: [],
  model_auth_methods: {},
  moltnet: { networks: [] },
  organization: { agents: [], project: "p", teams: [] },
  persistent_mounts: [],
  port_mappings: [],
  ports: [],
  resources: [],
  runtime_instances: [],
  secrets: {
    model: [{ generated: false, name: "ANTHROPIC_API_KEY", required: true }],
    project: [],
    runtime: [{ generated: true, name: "OPENCLAW_GATEWAY_TOKEN", required: true }],
    surface: []
  },
  version: "spawnfile.distribution-report.v1"
});

const savedEnv = { ...process.env };
afterEach(() => {
  process.env = { ...savedEnv };
});

describe("deriveDeploymentName", () => {
  it("derives a kebab name from the image repository", () => {
    expect(deriveDeploymentName(ref("you/research-cell:1.0.0"))).toBe("research-cell");
    expect(deriveDeploymentName(ref("ghcr.io/org/my_org:latest"))).toBe("my-org");
  });
});

describe("deriveVolumeName", () => {
  it("namespaces volumes per deployment and mount", () => {
    expect(deriveVolumeName("research", "moltnet-store")).toBe("spawnfile_research_moltnet-store");
  });

  it("derives distinct volume names for two deployments of one image", () => {
    expect(deriveVolumeName("a", "store")).not.toBe(deriveVolumeName("b", "store"));
  });
});

describe("resolveImageEnvironment", () => {
  it("merges auth and env-file values and generates runtime tokens", () => {
    const env = resolveImageEnvironment({
      authValues: { ANTHROPIC_API_KEY: "sk" },
      envFileEnv: { EXTRA: "1" },
      report: reportWithSecrets()
    });
    expect(env.ANTHROPIC_API_KEY).toBe("sk");
    expect(env.EXTRA).toBe("1");
    expect(env.OPENCLAW_GATEWAY_TOKEN).toMatch(/^[0-9a-f]{48}$/);
  });

  it("lets the process env override declared secrets", () => {
    process.env.ANTHROPIC_API_KEY = "from-process";
    const env = resolveImageEnvironment({
      authValues: { ANTHROPIC_API_KEY: "from-profile" },
      report: reportWithSecrets()
    });
    expect(env.ANTHROPIC_API_KEY).toBe("from-process");
  });

  it("drops values with newlines that cannot enter an env file", () => {
    const env = resolveImageEnvironment({
      authValues: { BAD: "line1\nline2", GOOD: "value" },
      report: reportWithSecrets()
    });
    expect(env.BAD).toBeUndefined();
    expect(env.GOOD).toBe("value");
  });
});

describe("renderEnvFileContent", () => {
  it("writes a sorted KEY=VALUE env file", () => {
    expect(renderEnvFileContent({ B: "2", A: "1" })).toBe("A=1\nB=2\n");
  });
});
