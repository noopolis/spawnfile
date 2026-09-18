import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { DAIMON_DOCKER_RUNTIME_SECURITY_ARGS } from "../../../shared/index.js";
import { trainingBrokerMounts, trainingBrokerTmpfsTargets } from "../container/security.js";
import { assertNotDesktopGrokAuth, trainingChildArgv, TRAINING_GROK_BROKER_CONTROL_SOCKET_ENV, TRAINING_GROK_GRANT_HOME_ROOT_ENV } from "./entrypoint.js";
import { parseTrainingBrokerDeclaration } from "./declaration.js";
import { brokerProcessPlan } from "./processes.js";
import { TRAINING_REALM_MOUNT, TRAINING_SLOT_ROOT } from "./paths.js";

const declaration = (overrides: Record<string, unknown> = {}) => parseTrainingBrokerDeclaration({
  version: "spawnfile.training-broker.v1", engine: "grok", agentId: "agent:author", model: "grok-4.6",
  reasoningEffort: "low", architecture: "arm64", limits: { maxRequests: 32, maxTokens: 300_000, timeoutMs: 240_000 },
  bootstrap: "/var/lib/spawnfile/daimon/grok-bootstrap-auth", organizationUid: 2000, seccompProfileSha256: "f".repeat(64), ...overrides
});

describe("training broker declaration", () => {
  it("defaults to refusing a deny path on a filesystem that ignores unix ownership", () => {
    expect(declaration().unenforcedBindPolicy).toBe("refuse");
  });

  it("stays strict about engine, model, effort and unknown members", () => {
    expect(() => declaration({ engine: "codex" })).toThrow();
    expect(() => declaration({ model: "gpt-5" })).toThrow();
    expect(() => declaration({ reasoningEffort: "xhigh" })).toThrow();
    expect(() => declaration({ organizationUid: 2200 })).toThrow();
    expect(() => declaration({ extra: 1 })).toThrow();
  });
});

describe("training Grok credential authority", () => {
  it("refuses the desktop Grok login as a training bootstrap", () => {
    const home = path.join(os.tmpdir(), "spawnfile-desktop");
    expect(() => assertNotDesktopGrokAuth(path.join(home, ".grok/auth.json"), home)).toThrow(/desktop ~\/.grok\/auth.json/u);
    expect(() => assertNotDesktopGrokAuth(path.join(home, ".grok", "..", ".grok", "auth.json"), home)).toThrow(/desktop/u);
    expect(assertNotDesktopGrokAuth(path.join(home, "training-grok/auth.json"), home)).toContain("training-grok");
  });
});

describe("training container privilege model", () => {
  it("runs train as the organization uid and refuses to exec with any capability left", () => {
    const argv = trainingChildArgv(["--spawnfile-context", "/run/paideia/context.json"]);
    expect(argv.slice(0, 8)).toEqual(["setpriv", "--clear-groups", "--reuid=2000", "--regid=2000", "--inh-caps=-all", "--ambient-caps=-all", "--bounding-set=-all", "--"]);
    const guard = argv[10]!;
    expect(guard).toContain('test "$(sed -n "s/^CapBnd:[[:space:]]*//p" /proc/self/status)" = 0000000000000000');
    expect(guard).toContain('test "$(sed -n "s/^CapEff:[[:space:]]*//p" /proc/self/status)" = 0000000000000000');
    expect(guard).toContain('if [ "$EUID" -eq 0 ]');
    expect(argv).toContain("/opt/training/bin/train");
  });

  it("keeps the production capability set and never grants CAP_FOWNER or CAP_DAC_OVERRIDE", () => {
    expect([...DAIMON_DOCKER_RUNTIME_SECURITY_ARGS]).toEqual(["--cap-drop=ALL", "--cap-add=CHOWN", "--cap-add=SETUID",
      "--cap-add=SETGID", "--cap-add=DAC_READ_SEARCH", "--cap-add=SETPCAP", "--cap-add=KILL", "--security-opt=no-new-privileges:true"]);
  });

  it("starts the launcher as root and the broker and relay as uid 2100 with an empty bounding set", () => {
    expect(brokerProcessPlan().map((entry) => [entry.uid, entry.capBnd])).toEqual([
      [0, "00000000000000c1"], [2100, "0000000000000000"], [2100, "0000000000000000"]
    ]);
  });

  it("keeps every per-trial path on tmpfs and the realm on a named volume", () => {
    const tmpfs = trainingBrokerTmpfsTargets().map((entry) => entry.path);
    expect(tmpfs).toContain(TRAINING_SLOT_ROOT);
    expect(tmpfs).toContain("/var/lib/daimon-workers");
    expect(tmpfs).not.toContain(TRAINING_REALM_MOUNT);
    const mounts = trainingBrokerMounts({ realmVolume: "training-realm", bootstrap: "/host/auth.json", declaration: "/host/training-broker.json" });
    expect(mounts[0]).toBe(`type=volume,src=training-realm,dst=${TRAINING_REALM_MOUNT}`);
    expect(mounts[1]).toContain("readonly");
    expect(mounts[2]).toContain("dst=/run/paideia/training-broker.json,readonly");
  });

  it("exports the broker control socket and a private grant home root to the evaluator", () => {
    expect(TRAINING_GROK_BROKER_CONTROL_SOCKET_ENV).toBe("PAIDEIA_GROK_BROKER_CONTROL_SOCKET");
    expect(TRAINING_GROK_GRANT_HOME_ROOT_ENV).toBe("PAIDEIA_GROK_GRANT_HOME_ROOT");
  });
});
