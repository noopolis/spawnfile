import { EventEmitter } from "node:events";
import type { createConnection } from "node:net";
import { expect, it, vi } from "vitest";
import { TRAINING_SUPERVISOR_PROTOCOL } from "../broker/supervisor.js";
import { recycleTrainingSessionSlot } from "./recycle.js";

const fixture = () => {
  const socket = Object.assign(new EventEmitter(), { write: vi.fn(), destroy: vi.fn(), setTimeout: vi.fn() });
  const connect = vi.fn(() => socket) as unknown as typeof createConnection;
  const controller = new AbortController(), nonce = "a".repeat(64);
  const answer = { v: TRAINING_SUPERVISOR_PROTOCOL, ok: true, verb: "recycle", slot: 1, nonce, generation: 2,
    receipt: "/run/training/slots/1/preflight.json", durationMs: 1 };
  return { socket, connect, controller, nonce, answer };
};

it("sends the one bounded recycle verb and verifies split response identity", async () => {
  const f = fixture(), result = recycleTrainingSessionSlot(1, f.nonce, f.controller.signal, f.connect);
  f.socket.emit("connect");
  expect(JSON.parse(f.socket.write.mock.calls[0]![0])).toEqual({ v: TRAINING_SUPERVISOR_PROTOCOL, verb: "recycle", slot: 1, nonce: f.nonce });
  const bytes = JSON.stringify(f.answer);
  f.socket.emit("data", Buffer.from(bytes.slice(0, 10))); f.socket.emit("data", Buffer.from(bytes.slice(10) + "\n"));
  await expect(result).resolves.toMatchObject({ generation: 2, nonce: f.nonce });
  expect(f.socket.destroy).toHaveBeenCalledOnce();
  f.socket.emit("close");
});

it.each([{ nonce: "b".repeat(64) }, { slot: 0 }, { ok: false }, { generation: 0 }, { v: "old" }, { extra: true }])
  ("refuses foreign or malformed recycle acknowledgement %j", async patch => {
    const f = fixture(), result = recycleTrainingSessionSlot(1, f.nonce, f.controller.signal, f.connect);
    const rejected = result.then(() => false, () => true);
    f.socket.emit("data", Buffer.from(JSON.stringify({ ...f.answer, ...patch }) + "\n"));
    expect(await rejected, "recycle identity guarantee").toBe(true); expect(f.socket.destroy).toHaveBeenCalledOnce();
  });

it("fails closed on abort, timeout, disconnect, oversized and trailing replies", async () => {
  for (const fail of [(f: ReturnType<typeof fixture>) => f.controller.abort(),
    (f: ReturnType<typeof fixture>) => f.socket.setTimeout.mock.calls[0]![1](),
    (f: ReturnType<typeof fixture>) => f.socket.emit("close"),
    (f: ReturnType<typeof fixture>) => f.socket.emit("error", Error("transport")),
    (f: ReturnType<typeof fixture>) => f.socket.emit("data", Buffer.from("x".repeat(4097))),
    (f: ReturnType<typeof fixture>) => f.socket.emit("data", Buffer.from("invalid\n")),
    (f: ReturnType<typeof fixture>) => f.socket.emit("data", Buffer.from(JSON.stringify(f.answer) + "\n{}"))]) {
    const f = fixture(), result = recycleTrainingSessionSlot(1, f.nonce, f.controller.signal, f.connect);
    const rejected = expect(result).rejects.toThrow(); fail(f); await rejected;
  }
  const f = fixture();
  expect(() => recycleTrainingSessionSlot(9, f.nonce, f.controller.signal, f.connect)).toThrow("identity");
  expect(() => recycleTrainingSessionSlot(1, "short", f.controller.signal, f.connect)).toThrow("identity");
  expect(() => recycleTrainingSessionSlot(1, f.nonce, AbortSignal.abort(), f.connect)).toThrow();
});
