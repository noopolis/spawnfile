import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DAIMON_GROK_ENGINE_BROKER } from "../../../runtime/daimon/contractManifest.js";
import { TRAINING_BROKER_SOCKET_PATHS } from "./paths.js";
import { renderTrainingBrokerProvisioning } from "./provisioning.js";
import { resolveTrainingGrokRegistration } from "./registration.js";
import { renderTrainingTaskClockAssertions, renderTrainingTaskClockReset } from "./taskClock.js";

const slot = resolveTrainingGrokRegistration({ agentId: "agent:a", model: "grok-4.6", reasoningEffort: "low" });
const clock = DAIMON_GROK_ENGINE_BROKER.worker.taskClock;

describe("training task clock preflight", () => {
  it("checks installed bytes, exact owners/modes, and worker readability without write authority", () => {
    const lines = renderTrainingTaskClockAssertions(slot), script = lines.join("\n");
    execFileSync("/bin/bash", ["-n"], { input: script });
    expect(script).toContain(`sha256sum '${slot.grokHome}/config.toml'`);
    expect(script).toContain(slot.configSha256);
    expect(script).toContain('= "2100:2100 755"');
    expect(script).toContain('= "2100:2100 644 1"');
    const probe = lines.at(-1)!;
    expect(probe).toContain("--reuid 2200 --regid 2200");
    // Quotes are shell-escaped by the outer command. Verify every access test survives rendering.
    for (const [verb, target] of [["test -r", clock.timestampFilePath], ["test ! -w", clock.timestampFilePath],
      ["test -x", clock.directoryPath], ["test ! -w", clock.directoryPath], ["test -r", clock.preloadPath]]) {
      expect(probe).toContain(`${verb} '"'"'${target}'"'"'`);
    }
    expect(() => renderTrainingTaskClockAssertions({ ...slot, configVariant: "unclocked" })).toThrow(/pinned clocked/u);
    expect(() => renderTrainingTaskClockAssertions({ ...slot, configSha256: "a".repeat(64) })).toThrow(/pinned clocked/u);
  });

  it("checks a nonzero slot's specialized config and clock without touching siblings", () => {
    const selected = resolveTrainingGrokRegistration({ agentId: "agent:a", model: "grok-4.6", reasoningEffort: "low", slot: 3, slots: 4 });
    const script = renderTrainingTaskClockAssertions(selected).join("\n");
    execFileSync("/bin/bash", ["-n"], { input: script });
    expect(script).toContain("/task-clock/slot-3/faketime");
    expect(script).toContain("--reuid 2203 --regid 2203");
    expect(script).toContain(selected.configSha256);
    expect(script).not.toContain("/task-clock/slot-0");
    expect(() => renderTrainingTaskClockAssertions({ ...selected, configSha256: slot.configSha256 })).toThrow(/pinned clocked/u);
  });

  it("rejects a wrong-type, writable, or worker-owned distro library or ancestor", () => {
    const lines = renderTrainingTaskClockAssertions(slot);
    const source = lines.slice(lines.indexOf("node <<'SPAWNFILE_TASK_CLOCK_LIBRARY'") + 1, lines.indexOf("SPAWNFILE_TASK_CLOCK_LIBRARY")).join("\n");
    const target = "/usr/lib/aarch64-linux-gnu/faketime/libfaketime.so.1";
    const run = (bad?: string, change = {}) => new Function("require", source)((name: string) => name === "node:path" ? path.posix : {
      realpathSync: () => target,
      statSync: (file: string) => ({ isFile: () => true, ...(file === bad ? change : {}) }),
      lstatSync: (file: string) => ({ uid: 0, gid: 0, mode: file === target ? 0o644 : 0o755,
        isSymbolicLink: () => file === clock.preloadPath, ...(file === bad ? change : {}) })
    });
    expect(() => run()).not.toThrow();
    expect(() => run(target, { isFile: () => false })).toThrow(/unexpected task clock library/u);
    for (const file of [target, "/usr/lib/aarch64-linux-gnu/faketime", "/usr/local/lib/daimon"]) {
      expect(() => run(file, { uid: 2200 })).toThrow(/unsafe task clock library path/u);
      expect(() => run(file, { mode: 0o777 })).toThrow(/unsafe task clock library path/u);
    }
    expect(() => run(clock.preloadPath, { isSymbolicLink: () => false })).toThrow(/unsafe task clock preload link/u);
  });

  it("reclaims the clock subtree before clearing it and retains socket deny targets for startup attestation", () => {
    const script = renderTrainingBrokerProvisioning(slot).join("\n");
    execFileSync("/bin/bash", ["-n"], { input: script });
    for (const line of renderTrainingTaskClockReset()) {
      expect(script.indexOf(line)).toBeLessThan(script.indexOf('for broker_root in /etc/daimon-engine-broker'));
    }
    expect(script).toContain('unsafe broker socket placeholder');
    for (const socket of TRAINING_BROKER_SOCKET_PATHS) {
      expect(script).toContain(JSON.stringify(socket));
      expect(script).not.toContain(`rm '${socket}'`);
    }
  });
});
