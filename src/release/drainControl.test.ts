import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  controlHelperArgs,
  parseAvailability,
  parseHelperOutput,
  requestDrain,
  requestResume,
  waitForDrained,
  type ControlCall,
  type RuntimeControlTarget
} from "./drainControl.js";

const target: RuntimeControlTarget = {
  containerRef: "abc",
  dockerArgs: ["--context", "prod"],
  dockerCommand: "docker",
  imageRef: "sha256:feed",
  token: "secret-token"
};

const availability = (drain?: "draining" | "drained", status = 200): { body: string; status: number } => ({
  body: JSON.stringify({ agents: [], ...(drain ? { drain: { since: "2026-10-08T00:00:00.000Z", state: drain } } : {}), state: drain ? "paused" : "running", version: "noopolis.daimon.work-availability.v1" }),
  status
});

describe("the vendored Daimon contract", () => {
  const manifest = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "../runtime/daimon/contract-manifest.json"), "utf8")) as {
    operatorDrain: { drainRoute: string; queuedWakes: string; resumeRoute: string; runningTurns: string };
    workAvailabilityResponseSchema: { properties: { drain: { properties: { state: { enum: string[] } } }; version: { const: string } } };
  };

  it("names the routes and drain states this client speaks", () => {
    expect(manifest.operatorDrain).toMatchObject({ drainRoute: "POST /v2/drain", queuedWakes: "retained", resumeRoute: "POST /v2/resume", runningTurns: "finish" });
    expect(manifest.workAvailabilityResponseSchema.properties.drain.properties.state.enum).toEqual(["draining", "drained"]);
    expect(manifest.workAvailabilityResponseSchema.properties.version.const).toBe("noopolis.daimon.work-availability.v1");
  });
});

describe("controlHelperArgs", () => {
  it("runs curl in the target's network namespace with the token on stdin, never in argv", () => {
    const args = controlHelperArgs(target, "POST", "/v2/drain");
    expect(args.slice(0, 9)).toEqual(["--context", "prod", "run", "--rm", "-i", "--pull", "never", "--network", "container:abc"]);
    expect(args).toContain("@-");
    expect(args.at(-1)).toBe("http://127.0.0.1:19700/v2/drain");
    expect(args.join(" ")).not.toContain("secret-token");
  });
});

describe("parseHelperOutput", () => {
  it("splits the body from the trailing status", () => {
    expect(parseHelperOutput("{\"a\":1}\n200")).toEqual({ body: "{\"a\":1}", status: 200 });
    expect(() => parseHelperOutput("garbage")).toThrow("no HTTP status");
  });
});

describe("parseAvailability", () => {
  it("reads the drain state, or null when the runtime is admitting", () => {
    expect(parseAvailability(availability("drained"), "/x")).toEqual({ drain: "drained", state: "paused" });
    expect(parseAvailability(availability(), "/x")).toEqual({ drain: null, state: "running" });
  });

  it("explains a runtime without the drain route, a wrong token and other failures", () => {
    expect(() => parseAvailability({ body: "", status: 404 }, "/v2/drain")).toThrow("predates reversible drain");
    expect(() => parseAvailability({ body: "", status: 401 }, "/v2/drain")).toThrow("SPAWNFILE_DAIMON_CONTROL_TOKEN");
    expect(() => parseAvailability({ body: "", status: 500 }, "/v2/drain")).toThrow("HTTP 500");
    expect(() => parseAvailability({ body: "nope", status: 200 }, "/v2/drain")).toThrow("invalid JSON");
    expect(() => parseAvailability({ body: "{}", status: 200 }, "/v2/drain")).toThrow("work-availability");
    expect(() => parseAvailability({ body: JSON.stringify({ drain: { state: "odd" }, state: "paused", version: "noopolis.daimon.work-availability.v1" }), status: 200 }, "/v2/drain")).toThrow("unknown drain state");
  });
});

describe("requestDrain / requestResume", () => {
  it("POSTs the drain and refuses a runtime that accepted it without reporting a drain", async () => {
    const seen: string[] = [];
    const call: ControlCall = async (_t, method, route) => { seen.push(`${method} ${route}`); return availability("draining"); };
    await expect(requestDrain(target, call)).resolves.toEqual({ drain: "draining", state: "paused" });
    await expect(requestDrain(target, async () => availability())).rejects.toThrow("does not report a drain");
    expect(seen).toEqual(["POST /v2/drain"]);
  });

  it("POSTs the resume and refuses one that leaves a drain in place", async () => {
    await expect(requestResume(target, async () => availability())).resolves.toEqual({ drain: null, state: "running" });
    await expect(requestResume(target, async () => availability("drained"))).rejects.toThrow("still reports a drain");
  });
});

describe("waitForDrained", () => {
  it("returns as soon as the runtime reports drained", async () => {
    const states = ["draining", "draining", "drained"] as const;
    let index = 0;
    const result = await waitForDrained(target, {
      call: async () => availability(states[index++]),
      pollMs: 10,
      sleep: async () => undefined,
      timeoutMs: 1_000
    });
    expect(result.drained).toBe(true);
    expect(index).toBe(3);
  });

  it("gives up at the bound with a timeout and issues nothing but availability reads", async () => {
    let clock = 0;
    const routes: string[] = [];
    const result = await waitForDrained(target, {
      call: async (_t, method, route) => { routes.push(`${method} ${route}`); return availability("draining"); },
      now: () => clock,
      pollMs: 400,
      sleep: async (ms) => { clock += ms; },
      timeoutMs: 1_000
    });
    expect(result).toEqual({ drained: false, reason: "timeout", waitedMs: 1_000 });
    expect(new Set(routes)).toEqual(new Set(["GET /v2/availability"]));
  });

  it("stops when interrupted", async () => {
    const abort = new AbortController();
    abort.abort();
    const result = await waitForDrained(target, { call: async () => availability("draining"), pollMs: 1, signal: abort.signal, timeoutMs: 1_000 });
    expect(result).toMatchObject({ drained: false, reason: "interrupted" });
  });

  it("fails when the drain disappears mid-wait (the runtime restarted)", async () => {
    await expect(waitForDrained(target, { call: async () => availability(), pollMs: 1, timeoutMs: 1_000 })).rejects.toThrow("stopped reporting the drain");
  });
});
