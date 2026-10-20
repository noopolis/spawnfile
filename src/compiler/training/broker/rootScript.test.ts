import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { DAIMON_GROK_ENGINE_BROKER } from "../../../runtime/daimon/contractManifest.js";
import { DAIMON_AGENT_SKILLS_BOUNDS } from "../../../runtime/daimon/grokWorkerSkills.js";
import { parseTrainingBrokerDeclaration } from "./declaration.js";
import { renderTrainingBrokerProvisioning } from "./provisioning.js";
import { resolveTrainingGrokRegistration } from "./registration.js";
import { LINUX_MAX_ARG_STRLEN, runTrainingRootScript } from "./rootScript.js";
import { createTrainingSlotRuntime } from "./runtime.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const scratch = (): string => { const root = mkdtempSync(path.join(process.env.TMPDIR ?? "/private/tmp", "root-script-")); roots.push(root); return root; };

/** A 4-slot pool whose subject declares skills at Daimon's total byte bound, each skill a distinct marker. */
const maxBoundRegistrations = () => {
  const count = 16, size = DAIMON_AGENT_SKILLS_BOUNDS.totalBytes / count;
  const skills = Array.from({ length: count }, (_, index) => ({ name: `skill-${index}`, files: [{ path: "SKILL.md", content: `MARK${index}:`.padEnd(size, "x") }] }));
  const declaration = parseTrainingBrokerDeclaration({ version: "spawnfile.training-broker.v2", slots: 4, engine: "grok", agentId: "agent:author",
    model: "grok-4.6", reasoningEffort: "low", architecture: "arm64", limits: DAIMON_GROK_ENGINE_BROKER.turnLimits.v1Defaults,
    bootstrap: "/var/lib/spawnfile/daimon/grok-bootstrap-auth", organizationUid: 2000, seccompProfileSha256: "a".repeat(64), skills });
  return { declaration, registrations: [0, 1, 2, 3].map((slot) => resolveTrainingGrokRegistration({ ...declaration, slot })) };
};

/** A stand-in shell that records each argument's byte length and the script it was handed, then succeeds. */
const recordingShell = () => {
  const root = scratch(), record = path.join(root, "argv.txt"), shell = path.join(root, "shell");
  writeFileSync(shell, `#!/bin/sh\nfor arg in "$@"; do printf '%s\\n' "$(printf '%s' "$arg" | wc -c)" >> ${record}; done\ncat "$4" > ${record}.script\n`);
  chmodSync(shell, 0o755);
  return { shell, lengths: () => readFileSync(record, "utf8").trim().split("\n").map(Number), script: () => readFileSync(`${record}.script`, "utf8") };
};

describe("generated root scripts", () => {
  it("never pass a max-bound 4-slot skills program through one argv element, and embed each tree once", async () => {
    const { registrations } = maxBoundRegistrations();
    const shared = renderTrainingBrokerProvisioning(registrations).join("\n");
    expect(Buffer.byteLength(shared)).toBeGreaterThan(LINUX_MAX_ARG_STRLEN);
    const recorder = recordingShell();
    await runTrainingRootScript(shared, { shell: recorder.shell });
    expect(Math.max(...recorder.lengths())).toBeLessThanOrEqual(LINUX_MAX_ARG_STRLEN);
    expect(recorder.script()).toBe(shared);
    expect(shared.split("MARK7:").length - 1).toBe(1);
  });

  it("runs slot recycle provisioning from a script file, not argv", async () => {
    const { declaration, registrations } = maxBoundRegistrations();
    const recorder = recordingShell();
    const runtime = createTrainingSlotRuntime({ declaration, registration: registrations[2]!, projectionSha256: "b".repeat(64),
      reset: async () => undefined, shell: recorder.shell, logPath: path.join(scratch(), "log") });
    await runtime.provision();
    expect(Math.max(...recorder.lengths())).toBeLessThanOrEqual(LINUX_MAX_ARG_STRLEN);
    expect(recorder.script()).toContain("MARK3:");
  });

  it("runs the program under -eu, surfaces failure, and removes its private script directory", async () => {
    const tmpRoot = scratch();
    expect((await runTrainingRootScript("printf '%s' ok", { tmpRoot })).stdout).toBe("ok");
    await expect(runTrainingRootScript("false\necho unreachable", { tmpRoot })).rejects.toThrow();
    expect(existsSync(tmpRoot)).toBe(true);
    expect(readdirSync(tmpRoot)).toEqual([]);
  });
});
