import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn }));
import { runTrainingDocker } from "./process.js";
afterEach(() => { vi.clearAllMocks(); });
const child = () => {
  const value = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
  value.kill.mockImplementation(() => { queueMicrotask(() => value.emit("close", null)); return true; });
  spawn.mockReturnValue(value); return value;
};
it("runs only Docker without a shell, streams complete lines, and retains bounded tail", async () => {
  const native = child(), output = vi.fn(), errors = vi.fn();
  const result = runTrainingDocker(["start","--attach","owned"],{timeoutMs:1000,stdout:output,stderr:errors});
  native.stdout.write("one\ntw");native.stdout.write("o\nfinal");native.stderr.write("warning\nlast");native.emit("close",0);
  expect(await result).toEqual({code:0,stdout:"final",stderr:"last"});
  expect(output.mock.calls.flat()).toEqual(["one","two","final"]);expect(errors.mock.calls.flat()).toEqual(["warning","last"]);
  expect(spawn).toHaveBeenCalledWith("docker",["start","--attach","owned"],{shell:false,stdio:["ignore","pipe","pipe"]});
});
it("captures short inspection output and preserves exit code",async()=>{
 const native=child();const pending=runTrainingDocker(["inspect"],{timeoutMs:1000});native.stdout.write("first\nlast");native.stderr.write("error\ntail");native.emit("close",2);expect(await pending).toEqual({code:2,stdout:"first\nlast",stderr:"error\ntail"});
});
it("cancels pending operations and refuses already cancelled launches",async()=>{
 const native=child(),controller=new AbortController();const pending=runTrainingDocker(["start"],{timeoutMs:1000,signal:controller.signal});controller.abort();await expect(pending).rejects.toThrow("cancelled");expect(native.kill).toHaveBeenCalledWith("SIGKILL");
 spawn.mockClear();await expect(runTrainingDocker([],{timeoutMs:1000,signal:controller.signal})).rejects.toThrow("cancelled");expect(spawn).not.toHaveBeenCalled();
});
it("bounds hangs and oversized line/cumulative output and surfaces launch errors",async()=>{
 let native=child();let pending=runTrainingDocker([],{timeoutMs:10});await expect(pending).rejects.toThrow("deadline");
 native=child();pending=runTrainingDocker([],{timeoutMs:1000});native.stdout.write("x".repeat(1024*1024+1));await expect(pending).rejects.toThrow("line size");
 native=child();pending=runTrainingDocker([],{timeoutMs:1000});for(let i=0;i<4;i++)native.stdout.write("x".repeat(800000)+"\n");await expect(pending).rejects.toThrow("capture size");
 native=child();pending=runTrainingDocker([],{timeoutMs:1000});native.emit("error",Error("missing docker"));native.emit("close",null);await expect(pending).rejects.toThrow("missing docker");
});

it("releases a stuck Docker client after kill so owned-container cleanup can proceed",async()=>{
 const native=child();native.kill.mockImplementation(()=>true);
 const controller=new AbortController(),pending=runTrainingDocker([],{timeoutMs:5000,signal:controller.signal});
 controller.abort();await expect(pending).rejects.toThrow("cancelled");expect(native.stdout.destroyed).toBe(true);
 native.emit("close",0);
});
