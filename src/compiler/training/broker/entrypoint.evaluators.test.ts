import { afterEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

const control = vi.hoisted(() => ({ order: [] as string[], env: {} as NodeJS.ProcessEnv }));
vi.mock("node:fs/promises", () => ({ lstat: async () => ({ isFile: () => true, isSymbolicLink: () => false, size: 23 }),
  readFile: async () => "{}" }));
vi.mock("./declaration.js", () => ({ parseTrainingBrokerDeclaration: () => ({ slots: 1, organizationUid: 2000,
  bootstrap: "/var/lib/spawnfile/daimon/grok-bootstrap-auth" }) }));
vi.mock("./paths.js", async importOriginal => ({ ...await importOriginal<typeof import("./paths.js")>(),
  assertTrainingSlotsDocument: () => {} }));
vi.mock("./registration.js", () => ({ resolveTrainingGrokRegistration: () => ({ slot: 0 }) }));
vi.mock("./projection.js", () => ({ resolveTrainingGrokProjection: async () => ({ projectionSha256: "test" }),
  loadDaimonProjectionModule: async () => ({}) }));
vi.mock("./runtime.js", () => ({ createTrainingSlotRuntime: () => ({}) }));
vi.mock("./supervisor.js", () => ({ startTrainingSlot: async () => {}, createTrainingSlotSupervisor: () => ({}),
  serveTrainingSlotSupervisor: () => ({ close() {} }) }));
vi.mock("./processes.js", () => ({ startBrokerProcesses: async () => { control.order.push("broker"); return []; },
  stopBrokerProcesses: async () => {} }));
vi.mock("./evaluatorSecrets.js", () => ({ stageTrainingEvaluatorSecret: async () => { control.order.push("secret"); } }));
vi.mock("./provisioning.js", () => ({ renderTrainingBrokerProvisioning: () => [] }));
vi.mock("node:child_process", () => ({
  execFile: (_command: string, _args: string[], _options: unknown, done: (error: unknown) => void) => {
    control.order.push("provision"); done(null);
  },
  spawn: (_command: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
    control.order.push("evaluator"); control.env = options.env;
    const child = new EventEmitter(); Object.assign(child, { kill() {} });
    queueMicrotask(() => child.emit("exit", 0, null)); return child;
  }
}));
import { runTrainingBrokerEntrypoint } from "./entrypoint.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
it("stages evaluator credentials before transferring tmpfs ownership or dropping to the evaluator", async () => {
  vi.spyOn(process as { getuid: () => number }, "getuid").mockReturnValue(0);
  vi.stubEnv("PAIDEIA_TYPESAFE_SECRET_FILE", "/run/paideia/secrets/typesafe");
  control.order.length = 0;
  const listeners = new Map((["SIGINT", "SIGTERM", "SIGHUP"] as const).map(signal => [signal, process.listeners(signal)]));
  try {
    expect(await runTrainingBrokerEntrypoint({ argv: [], log() {} })).toBe(0);
    expect(control.order, "evaluator secret staging order guarantee").toEqual(["secret", "provision", "broker", "evaluator"]);
    expect(control.env.PAIDEIA_TYPESAFE_SECRET_FILE).toBe("/run/paideia/secrets/typesafe");
    expect(control.env.TYPESAFE_API_KEY).toBeUndefined();
  } finally {
    for (const [signal, previous] of listeners) {
      for (const listener of process.listeners(signal)) if (!previous.includes(listener)) process.removeListener(signal, listener);
    }
  }
});
