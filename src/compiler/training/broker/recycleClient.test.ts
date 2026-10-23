import { chmodSync, mkdirSync, mkdtempSync, rmSync, type Stats } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The supervisor's only uid gate is the socket node's ownership, which a
 * non-root test cannot create. Ownership facts alone are stubbed: the server,
 * the socket, the wire protocol and the recycle state machine are all real.
 */
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  const rooted = (target: string, stats: Stats): Stats => {
    if (!target.startsWith(path.join(process.env.TMPDIR ?? "/private/tmp", "sfr-"))) return stats;
    return Object.assign(Object.create(Object.getPrototypeOf(stats) as object) as Stats, stats,
      { uid: 0, gid: stats.isSocket() ? 2000 : 0 });
  };
  return { ...actual, chownSync: vi.fn(), lstatSync: vi.fn((target: string) => rooted(target, actual.lstatSync(target))) };
});

const { recycleTrainingSlot, TRAINING_RECYCLE_MAX_REPLY_BYTES } = await import("./recycleClient.js");
const { createTrainingSlotSupervisor, serveTrainingSlotSupervisor, TRAINING_SUPERVISOR_PROTOCOL } = await import("./supervisor.js");
const { trainingSlotPaths } = await import("./paths.js");
type Runtime = import("./supervisor.js").TrainingSlotRuntime;

const nonce = "c".repeat(64);
const servers: Server[] = [];
const roots: string[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const socketPath = (): string => {
  const root = mkdtempSync(path.join(process.env.TMPDIR ?? "/private/tmp", "sfr-"));
  roots.push(root);
  const directory = path.join(root, "s");
  mkdirSync(directory);
  chmodSync(directory, 0o711);
  return path.join(directory, "c.sock");
};

const runtime = (slot: number, overrides: Partial<Runtime> = {}): Runtime => {
  let generation = 0;
  return {
    reset: async () => undefined, wipe: async () => undefined, provision: async () => undefined,
    canaries: async () => [{ path: "/run/spawnfile-training", method: "sandboxed-read" as const, result: "denied" as const }],
    nextGeneration: async () => ++generation,
    publishReceipt: async () => trainingSlotPaths(slot).preflightReceipt,
    log: () => undefined, ...overrides
  };
};

const listening = async (server: Server): Promise<void> => {
  if (server.listening) return;
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
};

const serve = async (runtimes: Runtime[]): Promise<string> => {
  const file = socketPath();
  const server = serveTrainingSlotSupervisor(createTrainingSlotSupervisor({ runtimes }), file, () => undefined);
  servers.push(server);
  await listening(server);
  return file;
};

/** A hand-written peer for answers the real supervisor never sends. */
const fake = async (reply: (socket: Socket, request: string) => void): Promise<string> => {
  const file = socketPath();
  const server = createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (buffer.includes("\n")) reply(socket, buffer.slice(0, buffer.indexOf("\n")));
    });
  });
  servers.push(server);
  server.listen(file);
  await listening(server);
  return file;
};

const connectTo = (file: string) => () => createConnection(file);
const line = (value: Record<string, unknown>): string => `${JSON.stringify(value)}\n`;
const good = (slot: number, extra: Record<string, unknown> = {}) => ({ v: TRAINING_SUPERVISOR_PROTOCOL, ok: true, verb: "recycle", slot,
  generation: 3, nonce, receipt: trainingSlotPaths(slot).preflightReceipt, durationMs: 4, ...extra });

describe("recycleTrainingSlot over the real supervisor socket", () => {
  it("recycles the leased slot and returns the bound receipt", async () => {
    const file = await serve([runtime(0), runtime(1), runtime(2)]);
    const result = await recycleTrainingSlot({ slot: 2, nonce, connect: connectTo(file) });
    expect(result).toMatchObject({ slot: 2, generation: 1, nonce, receipt: "/run/training/slots/2/preflight.json" });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    await expect(recycleTrainingSlot({ slot: 2, nonce, connect: connectTo(file) })).resolves.toMatchObject({ generation: 2 });
  });

  it("surfaces a supervisor refusal with its reason", async () => {
    const file = await serve([runtime(0, { reset: async () => { throw Error("engine broker slot busy"); } })]);
    await expect(recycleTrainingSlot({ slot: 0, nonce, connect: connectTo(file) })).rejects.toThrow(/slot 0 recycle refused: engine broker slot busy/u);
  });

  it("surfaces an undeclared slot as the supervisor's refusal", async () => {
    const file = await serve([runtime(0)]);
    await expect(recycleTrainingSlot({ slot: 3, nonce, connect: connectTo(file) })).rejects.toThrow(/refused: .*declared slot index/u);
  });
});

describe("recycleTrainingSlot answer binding", () => {
  it.each([
    ["another slot", good(1), /names slot 1, not the leased slot 0/u],
    ["another nonce", good(0, { nonce: "d".repeat(64) }), /does not echo this trial's nonce/u],
    ["another protocol", good(0, { v: "spawnfile.training-slot-supervisor.v1" }), /another protocol/u],
    ["generation zero", good(0, { generation: 0 }), /no valid generation/u],
    ["a missing slot", { ...good(0), slot: undefined }, /not a recycle receipt/u],
    ["an extra field", good(0, { path: "/etc/shadow" }), /not a recycle receipt/u],
    ["a negative duration", good(0, { durationMs: -1 }), /no valid duration/u],
    ["an empty receipt", good(0, { receipt: "" }), /names no receipt/u]
  ])("refuses an answer with %s", async (_label, answer, message) => {
    const file = await fake((socket) => socket.end(line(answer)));
    await expect(recycleTrainingSlot({ slot: 0, nonce, connect: connectTo(file) })).rejects.toThrow(message);
  });

  it("sends exactly the v2 request shape", async () => {
    let seen = "";
    const file = await fake((socket, request) => { seen = request; socket.end(line(good(0))); });
    await recycleTrainingSlot({ slot: 0, nonce, connect: connectTo(file) });
    expect(JSON.parse(seen)).toEqual({ v: TRAINING_SUPERVISOR_PROTOCOL, verb: "recycle", slot: 0, nonce });
  });

  it("refuses non-JSON, oversized and absent answers", async () => {
    await expect(recycleTrainingSlot({ slot: 0, nonce, connect: connectTo(await fake((socket) => socket.end("nope\n"))) }))
      .rejects.toThrow(/not JSON/u);
    await expect(recycleTrainingSlot({ slot: 0, nonce, connect: connectTo(await fake((socket) => socket.end("[1]\n"))) }))
      .rejects.toThrow(/not an object/u);
    await expect(recycleTrainingSlot({ slot: 0, nonce,
      connect: connectTo(await fake((socket) => socket.write("x".repeat(TRAINING_RECYCLE_MAX_REPLY_BYTES + 1)))) })).rejects.toThrow(/exceeded its bound/u);
    await expect(recycleTrainingSlot({ slot: 0, nonce, connect: connectTo(await fake((socket) => socket.end())) }))
      .rejects.toThrow(/closed before an answer/u);
    await expect(recycleTrainingSlot({ slot: 0, nonce, connect: connectTo(path.join(socketPath(), "missing")) }))
      .rejects.toThrow(/could not reach the root supervisor/u);
  });

  it("times out and aborts instead of waiting forever", async () => {
    const silent = await fake(() => undefined);
    await expect(recycleTrainingSlot({ slot: 0, nonce, timeoutMs: 20, connect: connectTo(silent) })).rejects.toThrow(/timed out/u);
    const controller = new AbortController();
    const pending = recycleTrainingSlot({ slot: 0, nonce, signal: controller.signal, connect: connectTo(silent) });
    controller.abort(Error("lease cancelled"));
    await expect(pending).rejects.toThrow(/lease cancelled/u);
    await expect(recycleTrainingSlot({ slot: 0, nonce, signal: controller.signal, connect: connectTo(silent) })).rejects.toThrow(/lease cancelled/u);
  });

  it("refuses an invalid slot or nonce before connecting", async () => {
    const connect = vi.fn();
    for (const slot of [-1, 8, 0.5, Number.NaN]) {
      await expect(recycleTrainingSlot({ slot, nonce, connect })).rejects.toThrow(/slot index from 0 to 7/u);
    }
    for (const bad of ["", "A".repeat(64), "a".repeat(63)]) {
      await expect(recycleTrainingSlot({ slot: 0, nonce: bad, connect })).rejects.toThrow(/hex nonce/u);
    }
    expect(connect).not.toHaveBeenCalled();
  });
});
