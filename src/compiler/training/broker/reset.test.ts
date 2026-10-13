import { EventEmitter } from "node:events";
import { beforeEach, expect, it, vi } from "vitest";
import { resetTrainingBrokerSlot, resetTrainingBrokerSlotAsOrganization } from "./reset.js";
import { DAIMON_GROK_ENGINE_BROKER } from "../../../runtime/daimon/contractManifest.js";

const transport = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock("node:net", () => ({ createConnection: transport.connect }));
class Socket extends EventEmitter {
  write = vi.fn();
  destroy = vi.fn();
}
let socket: Socket;
beforeEach(() => { socket = new Socket(); transport.connect.mockReturnValue(socket); });
const start = () => {
  const controller = new AbortController();
  const promise = resetTrainingBrokerSlot(1, controller.signal);
  socket.emit("connect");
  const frame = socket.write.mock.calls[0]![0] as Buffer;
  const request = JSON.parse(frame.subarray(4).toString());
  expect(frame.readUInt32BE(0)).toBe(frame.length - 4);
  const response = { version: request.version, kind: "slot_reset", requestId: request.requestId, slot: 1 };
  return { promise, controller, request, response };
};
const send = (response: unknown) => {
  const body = Buffer.from(JSON.stringify(response)), header = Buffer.alloc(4);
  header.writeUInt32BE(body.length); socket.emit("data", header); socket.emit("data", body);
};
it("sends the declared slot through Daimon's length-prefixed v4 protocol and verifies its acknowledgement", async () => {
  const r = start();
  expect(r.request).toEqual({ version: "noopolis.daimon.engine-broker.v4", kind: "reset_slot", requestId: expect.any(String), slot: 1 });
  expect(transport.connect).toHaveBeenCalledWith(DAIMON_GROK_ENGINE_BROKER.controlSocketPath);
  send(r.response); await r.promise; expect(socket.destroy).toHaveBeenCalled();
});
it.each([
  { version: "old" }, { kind: "completed" }, { slot: 0 }, { requestId: "wrong" }, { unexpected: true }
])("rejects an unbound acknowledgement %j", async override => {
  const r = start(); send({ ...r.response, ...override }); await expect(r.promise).rejects.toThrow(/acknowledgement/);
});
it("rejects malformed JSON, oversized frames and broker refusal", async () => {
  let r = start(); socket.emit("data", Buffer.from([0, 0, 0, 2, 123, 123])); await expect(r.promise).rejects.toThrow();
  socket = new Socket(); transport.connect.mockReturnValue(socket);
  r = start(); socket.emit("data", Buffer.from([0, 0, 16, 1])); await expect(r.promise).rejects.toThrow(/frame/);
  socket = new Socket(); transport.connect.mockReturnValue(socket);
  r = start(); socket.emit("close"); await expect(r.promise).rejects.toThrow(/slot active/);
});
it("fails promptly on cancellation and transport errors", async () => {
  let r = start(); r.controller.abort(); await expect(r.promise).rejects.toThrow(/aborted/);
  socket = new Socket(); transport.connect.mockReturnValue(socket);
  r = start(); socket.emit("error", Error("unavailable")); await expect(r.promise).rejects.toThrow(/unavailable/);
});
it("refuses invalid slot indexes and already-cancelled requests before connecting", () => {
  transport.connect.mockClear();
  expect(() => resetTrainingBrokerSlot(-1, new AbortController().signal)).toThrow();
  expect(() => resetTrainingBrokerSlot(1, AbortSignal.abort())).toThrow();
  expect(transport.connect).not.toHaveBeenCalled();
});

it("drops root to the relay-authorized organization uid and requires the child's success sentinel", async () => {
  await resetTrainingBrokerSlotAsOrganization(2, new AbortController().signal, async (command, args) => {
    expect(command).toBe("setpriv");
    expect(args).toContain("--reuid=2000"); expect(args).toContain("--bounding-set=-all");
    expect(args.at(-1)).toBe("2");
    expect(args[args.indexOf("--eval") + 1]).toContain("await resetTrainingBrokerSlot");
    return { stdout: "slot-reset-complete\n" };
  });
  await expect(resetTrainingBrokerSlotAsOrganization(1, new AbortController().signal, async () => ({ stdout: "" }))).rejects.toThrow(/acknowledgement/);
});
