import { expect, it, vi } from "vitest";
import { createTrainingSlotRuntime } from "./runtime.js";
import { resolveTrainingGrokRegistration } from "./registration.js";
import { parseTrainingBrokerDeclaration } from "./declaration.js";
import { trainingSlotDescriptors } from "./paths.js";

const mocks = vi.hoisted(() => ({ execute: vi.fn(), read: vi.fn() }));
vi.mock("node:child_process", () => {
  const execFile = Object.assign(() => undefined, { [Symbol.for("nodejs.util.promisify.custom")]: mocks.execute });
  return { execFile };
});
vi.mock("node:fs/promises", async importOriginal => ({ ...await importOriginal<typeof import("node:fs/promises")>(), readFile: mocks.read }));

it("actually probes every sibling root under each slot's own worker uid", async () => {
  const declaration = parseTrainingBrokerDeclaration({ version: "spawnfile.training-broker.v2", slots: 4, engine: "grok", agentId: "agent:a",
    model: "grok-4.6", reasoningEffort: "low", architecture: "arm64", limits: { maxRequests: 4, maxTokens: 100, timeoutMs: 1000 },
    bootstrap: "/var/lib/spawnfile/daimon/grok-bootstrap-auth", organizationUid: 2000, seccompProfileSha256: "a".repeat(64) });
  mocks.execute.mockResolvedValue({ stdout: "denied\n", stderr: "" });
  mocks.read.mockResolvedValue("1 0 0:1 / / rw - ext4 /dev/root rw\n");
  const slots = trainingSlotDescriptors(4);
  for (const p of slots) {
    mocks.execute.mockClear();
    const registration = resolveTrainingGrokRegistration({ ...declaration, slot: p.slot });
    const runtime = createTrainingSlotRuntime({ declaration, registration, projectionSha256: "b".repeat(64), reset: async () => undefined });
    const canaries = await runtime.canaries();
    for (const sibling of slots.filter(other => other.slot !== p.slot)) {
      expect(canaries).toContainEqual({ path: sibling.clockDirectory, method: "sandboxed-read", result: "denied" });
      expect(mocks.execute.mock.calls.some(([command, args]) => command === "setpriv" && args.includes(`--reuid=${p.workerUid}`)
        && args.at(-1).includes("bwrap --die-with-parent") && args.at(-1).includes(sibling.clockDirectory))).toBe(true);
      expect(canaries).toContainEqual({ path: sibling.root, method: "sandboxed-read", result: "denied" });
      expect(mocks.execute.mock.calls.some(([command, args]) => command === "setpriv" && args.includes(`--reuid=${p.workerUid}`)
        && args.at(-1).includes(`test -r '${sibling.root}'`))).toBe(true);
    }
  }
});
