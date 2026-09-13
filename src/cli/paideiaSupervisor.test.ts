import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

import { supervisePaideia, type PaideiaSupervisorHost } from "./paideiaSupervisor.js";

const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach((cleanup) => cleanup()); });
function fixture() {
  const process = Object.assign(new EventEmitter(), { pid: 1234, send: vi.fn(), kill: vi.fn(), exit: vi.fn() });
  const child = new EventEmitter();
  const launch = vi.fn(() => child as ChildProcess);
  const host = { process, launch } as unknown as PaideiaSupervisorHost;
  return { process, child, launch, host };
}

describe("Paideia group supervisor", () => {
  it("passes argv unchanged and reports the real child outcome once while retaining group ownership", () => {
    const run = fixture();
    cleanups.push(supervisePaideia(["paideia", "train", "literal $argument"], run.host));
    expect(run.launch).toHaveBeenCalledWith("paideia", ["train", "literal $argument"]);
    run.child.emit("exit", 1, null); run.child.emit("error", new Error("later"));
    expect(run.process.send).toHaveBeenCalledExactlyOnceWith({ type: "paideia.process.exited", code: 1, signal: null });
    expect(run.process.exit).not.toHaveBeenCalled();
    run.process.emit("SIGTERM"); run.process.emit("SIGINT");
    expect(run.process.exit).not.toHaveBeenCalled();
  });

  it("reports launch failures without inventing completion", () => {
    const run = fixture(); cleanups.push(supervisePaideia(["missing"], run.host));
    run.child.emit("error", new Error("ENOENT"));
    expect(run.process.send).toHaveBeenCalledWith({ type: "paideia.process.launch-error", message: "ENOENT" });
  });

  it("cleans its own still-live group if its parent disappears", () => {
    const run = fixture(); cleanups.push(supervisePaideia(["paideia"], run.host));
    run.process.emit("disconnect");
    expect(run.process.kill).toHaveBeenCalledWith(-1234, "SIGKILL");
    expect(run.process.exit).toHaveBeenCalledWith(1);
  });

  it("requires a private parent channel and removes owned listeners on disposal", () => {
    const run = fixture();
    expect(() => supervisePaideia([], run.host)).toThrow("private IPC");
    expect(() => supervisePaideia(["paideia"], { ...run.host, process: { ...run.host.process, send: undefined } })).toThrow("private IPC");
    const cleanup = supervisePaideia(["paideia"], run.host); cleanup();
    expect(run.process.listenerCount("disconnect")).toBe(0);
  });
});
