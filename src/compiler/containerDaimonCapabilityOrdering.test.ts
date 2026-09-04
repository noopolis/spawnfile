import { describe, expect, it } from "vitest";

import type { RuntimeTargetPlan } from "./containerArtifactsTypes.js";
import { renderDaimonUidEntrypoint } from "./containerDaimonUidEntrypointRender.js";
import { createStateOwnershipCommand } from "./containerStateOwnershipRender.js";

const daimonPlan = {
  engineByNodeId: { "agent:grok": "grok" },
  instancePaths: {
    configPath: "/var/lib/spawnfile/instances/daimon/organization/daimon/config.json",
    instanceRoot: "/var/lib/spawnfile/instances/daimon/organization",
    workspacePath: "/var/lib/spawnfile/instances/daimon/organization/workspace"
  },
  runtimeName: "daimon",
  runtimeRoot: "/opt/daimon"
} as unknown as RuntimeTargetPlan;

describe("Daimon shell capability-safe ordering", () => {
  it("reclaims, modes, and restores existing broker auth ownership", () => {
    const rendered = renderDaimonUidEntrypoint([daimonPlan]);
    expect(rendered).toContain(
      "chown 0:0 '/var/lib/spawnfile/daimon/grok-subscription-realm/auth.json'; chmod 0600 '/var/lib/spawnfile/daimon/grok-subscription-realm/auth.json'; chown 2100:2100 '/var/lib/spawnfile/daimon/grok-subscription-realm/auth.json'"
    );
  });

  it("reclaims, modes, and restores Moltnet config ownership", () => {
    const configPath = "/var/lib/spawnfile/moltnet/nodes/agent.json";
    const rendered = createStateOwnershipCommand([daimonPlan], [], {
      nodePlans: [{ configPath, networkId: "local" }],
      serverPlans: []
    });
    expect(rendered).toContain(
      `chown root:root '${configPath}' && chmod 600 '${configPath}' && chown 2000:2000 '${configPath}'`
    );
  });
});
