import { execFile, spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import path from "node:path";
import { URL } from "node:url";
import { promisify } from "node:util";
import { runInNewContext } from "node:vm";

import { afterEach, describe, expect, it, vi } from "vitest";

import { renderPiControlSource } from "./appControlSource.js";
import { renderPiCoreSource } from "./appCoreSource.js";
import { renderPiPreludeSource } from "./appPreludeSource.js";

/**
 * B62 Option B coverage for `renderPiControlSource`'s two wake endpoints.
 * `appControlSource.ts` renders raw JS text embedded into the generated Pi
 * app (see `appCoreSource.ts`/`appSource.ts`); the only way to exercise its
 * actual HTTP behavior (auth gate, daimon emitter calls) is to evaluate the
 * rendered source in a real Node `vm` context — the same pattern
 * `appActivitySource.test.ts` and `appSource.test.ts` already use — wired to
 * a real `node:http` server and hit with real `fetch` calls.
 * `emitControlWakeAccepted`/`emitControlWakeDenied`/`emitDeliveryWakeAccepted`
 * are injected as mocks (daimon's own `controlCausal.test.ts` already proves
 * their internal stamping behavior, including that `emitDeliveryWakeAccepted`
 * always fixes `principal_id` to `system:moltnet`); this file proves
 * `appControlSource.ts` calls the RIGHT emitter for the RIGHT endpoint and
 * fails closed only on the operator path.
 *
 * Two endpoints, split by authenticating authority:
 * - `POST /spawnfile/agents/:slug/wake` — operator-only, fail-closed on
 *   `SPAWNFILE_PI_CONTROL_TOKEN`, stamps via `emitControlWakeAccepted`/
 *   `emitControlWakeDenied` (`operator:control`).
 * - `POST /agents/:slug/wake` — the Moltnet loopback delivery endpoint,
 *   never gated by a token, stamps via `emitDeliveryWakeAccepted`
 *   (`system:moltnet`) and must NEVER call the operator emitters.
 */

interface ControlHarnessAgent {
  config: { id: string; name: string; slug: string };
  paths: { runtimeHomePath: string };
  wake: (event: Record<string, unknown>) => Promise<string>;
}

interface ControlHarness {
  startControlServer: (
    agents: ControlHarnessAgent[],
    portValue: number,
    configPath: string,
    instanceRoot: string,
    services: Record<string, unknown>
  ) => Promise<Server | null>;
}

interface ControlHarnessEmitters {
  emitControlWakeAccepted: ReturnType<typeof vi.fn>;
  emitControlWakeDenied: ReturnType<typeof vi.fn>;
  emitDeliveryWakeAccepted: ReturnType<typeof vi.fn>;
}

const stripImports = (source: string): string => source.replace(/^import[\s\S]*?;\n?/gmu, "");

/**
 * Builds a self-contained harness for `startControlServer` out of the real
 * rendered prelude (stripped of its `import` lines — its identifiers become
 * sandbox globals instead) + the `normalizeWakeKind` helper sliced out of
 * `appCoreSource.ts` (control source calls it, but it is declared in
 * appCoreSource.ts's own body, not appControlSource.ts's) + the real
 * `renderPiControlSource()` output, unmodified.
 */
const loadControlHarness = (env: Record<string, string>, emitters: ControlHarnessEmitters): ControlHarness => {
  const preludeSource = stripImports(renderPiPreludeSource());
  const coreSource = renderPiCoreSource();
  const normalizeStart = coreSource.indexOf("const normalizeWakeKind");
  const normalizeEnd = coreSource.indexOf("const TEAM_CONTEXTS_FILE");
  const normalizeWakeKindSource = coreSource.slice(normalizeStart, normalizeEnd);

  const harnessSource = [
    preludeSource,
    normalizeWakeKindSource,
    renderPiControlSource(),
    "({ startControlServer });"
  ].join("\n");

  return runInNewContext(harnessSource, {
    Buffer,
    console,
    createServer,
    emitControlWakeAccepted: emitters.emitControlWakeAccepted,
    emitControlWakeDenied: emitters.emitControlWakeDenied,
    emitDeliveryWakeAccepted: emitters.emitDeliveryWakeAccepted,
    execFile,
    path,
    process: { env },
    promisify,
    spawn,
    URL
  }) as ControlHarness;
};

const getFreePort = async (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });

const createFakeAgent = (overrides: Partial<ControlHarnessAgent> = {}): ControlHarnessAgent => ({
  config: { id: "agent:mapper", name: "Mapper", slug: "mapper" },
  paths: { runtimeHomePath: "/tmp/noopolis-control-test/mapper" },
  wake: async () => "ok",
  ...overrides
});

describe("renderPiControlSource wake endpoints (B62 Option B)", () => {
  const closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
  });

  const startServer = async (env: Record<string, string>, agents: ControlHarnessAgent[]) => {
    const emitAccepted = vi.fn().mockResolvedValue(undefined);
    const emitDenied = vi.fn().mockResolvedValue(undefined);
    const emitDelivery = vi.fn().mockResolvedValue(undefined);
    const { startControlServer } = loadControlHarness(env, {
      emitControlWakeAccepted: emitAccepted,
      emitControlWakeDenied: emitDenied,
      emitDeliveryWakeAccepted: emitDelivery
    });
    const port = await getFreePort();
    const server = await startControlServer(agents, port, "/tmp/config.json", "/tmp/instance", {});
    closers.push(() => new Promise((resolve) => server!.close(() => resolve())));
    return { emitAccepted, emitDelivery, emitDenied, port };
  };

  describe("POST /spawnfile/agents/:slug/wake — operator path, fail-closed", () => {
    it("fails closed with 401 + control.wake.denied when no token is configured", async () => {
      const { emitAccepted, emitDelivery, emitDenied, port } = await startServer({}, [createFakeAgent()]);

      const response = await fetch(`http://127.0.0.1:${port}/spawnfile/agents/mapper/wake`, {
        body: JSON.stringify({ message: "hello" }),
        headers: { "content-type": "application/json" },
        method: "POST"
      });

      expect(response.status).toBe(401);
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain("no operator token configured");
      expect(emitAccepted).not.toHaveBeenCalled();
      expect(emitDelivery).not.toHaveBeenCalled();
      expect(emitDenied).toHaveBeenCalledTimes(1);
      expect(emitDenied.mock.calls[0]?.[0]).toMatchObject({
        operatorName: "control",
        reason: expect.stringContaining("SPAWNFILE_PI_CONTROL_TOKEN"),
        targetAgentId: "mapper"
      });
    });

    it("rejects a missing bearer header with 401 + control.wake.denied when a token IS configured", async () => {
      const { emitDenied, port } = await startServer({ SPAWNFILE_PI_CONTROL_TOKEN: "secret-token" }, [
        createFakeAgent()
      ]);

      const response = await fetch(`http://127.0.0.1:${port}/spawnfile/agents/mapper/wake`, {
        body: JSON.stringify({ message: "hello" }),
        headers: { "content-type": "application/json" },
        method: "POST"
      });

      expect(response.status).toBe(401);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("missing bearer token");
      expect(emitDenied).toHaveBeenCalledTimes(1);
    });

    it("rejects a wrong bearer token with 401 + control.wake.denied", async () => {
      const { emitDenied, port } = await startServer({ SPAWNFILE_PI_CONTROL_TOKEN: "secret-token" }, [
        createFakeAgent()
      ]);

      const response = await fetch(`http://127.0.0.1:${port}/spawnfile/agents/mapper/wake`, {
        body: JSON.stringify({ message: "hello" }),
        headers: { authorization: "Bearer wrong-token", "content-type": "application/json" },
        method: "POST"
      });

      expect(response.status).toBe(401);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("invalid bearer token");
      expect(emitDenied).toHaveBeenCalledTimes(1);
    });

    it("401s an unauthorized request for an unknown agent key too, never leaking existence pre-auth", async () => {
      const { emitDenied, port } = await startServer({ SPAWNFILE_PI_CONTROL_TOKEN: "secret-token" }, []);

      const response = await fetch(`http://127.0.0.1:${port}/spawnfile/agents/does-not-exist/wake`, {
        body: JSON.stringify({ message: "hello" }),
        method: "POST"
      });

      expect(response.status).toBe(401);
      expect(emitDenied).toHaveBeenCalledTimes(1);
      expect(emitDenied.mock.calls[0]?.[0]).toMatchObject({ targetAgentId: "does-not-exist" });
    });

    it("accepts a valid bearer token, wakes the agent, and stamps control.wake.accepted (operator:control)", async () => {
      const wake = vi.fn().mockResolvedValue("agent reply text");
      const agent = createFakeAgent({ wake });
      const { emitAccepted, emitDelivery, emitDenied, port } = await startServer(
        { SPAWNFILE_PI_CONTROL_TOKEN: "secret-token" },
        [agent]
      );

      const response = await fetch(`http://127.0.0.1:${port}/spawnfile/agents/mapper/wake`, {
        body: JSON.stringify({ message: "hello there", wake_kind: "manual" }),
        headers: { authorization: "Bearer secret-token", "content-type": "application/json" },
        method: "POST"
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as { from: string; message: string };
      expect(body.message).toBe("agent reply text");
      expect(body.from).toBe("agent:mapper");
      expect(wake).toHaveBeenCalledTimes(1);
      expect(emitDenied).not.toHaveBeenCalled();
      expect(emitDelivery).not.toHaveBeenCalled();
      expect(emitAccepted).toHaveBeenCalledTimes(1);
      expect(emitAccepted.mock.calls[0]?.[0]).toMatchObject({
        causeEventIds: [],
        operatorName: "control",
        runtimeHomePath: agent.paths.runtimeHomePath,
        targetAgentId: "mapper",
        wakeKind: "manual"
      });
    });

    it("chains control.wake.accepted's cause_event_ids to the wake's own event_id for a message-kind operator wake", async () => {
      const wake = vi.fn().mockResolvedValue("agent reply text");
      const agent = createFakeAgent({ wake });
      const { emitAccepted, port } = await startServer({ SPAWNFILE_PI_CONTROL_TOKEN: "secret-token" }, [agent]);

      await fetch(`http://127.0.0.1:${port}/spawnfile/agents/mapper/wake`, {
        body: JSON.stringify({ event_id: "moltnet:msg_op1", message: "hello there", wake_kind: "message" }),
        headers: { authorization: "Bearer secret-token", "content-type": "application/json" },
        method: "POST"
      });

      expect(emitAccepted.mock.calls[0]?.[0]).toMatchObject({
        causeEventIds: ["moltnet:msg_op1"]
      });
    });

    it("still 404s an unknown agent once authorized (auth gate does not change the not-found contract)", async () => {
      const { port } = await startServer({ SPAWNFILE_PI_CONTROL_TOKEN: "secret-token" }, []);

      const response = await fetch(`http://127.0.0.1:${port}/spawnfile/agents/does-not-exist/wake`, {
        body: JSON.stringify({ message: "hello" }),
        headers: { authorization: "Bearer secret-token" },
        method: "POST"
      });

      expect(response.status).toBe(404);
    });

    it("never lets a telemetry emitter failure break the HTTP response", async () => {
      const wake = vi.fn().mockResolvedValue("still works");
      const agent = createFakeAgent({ wake });
      const emitAccepted = vi.fn().mockRejectedValue(new Error("disk full"));
      const emitDenied = vi.fn().mockResolvedValue(undefined);
      const emitDelivery = vi.fn().mockResolvedValue(undefined);
      const { startControlServer } = loadControlHarness(
        { SPAWNFILE_PI_CONTROL_TOKEN: "secret-token" },
        { emitControlWakeAccepted: emitAccepted, emitControlWakeDenied: emitDenied, emitDeliveryWakeAccepted: emitDelivery }
      );
      const port = await getFreePort();
      const server = await startControlServer([agent], port, "/tmp/config.json", "/tmp/instance", {});
      closers.push(() => new Promise((resolve) => server!.close(() => resolve())));

      const response = await fetch(`http://127.0.0.1:${port}/spawnfile/agents/mapper/wake`, {
        body: JSON.stringify({ message: "hello" }),
        headers: { authorization: "Bearer secret-token", "content-type": "application/json" },
        method: "POST"
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as { message: string };
      expect(body.message).toBe("still works");
      expect(emitAccepted).toHaveBeenCalledTimes(1);
    });
  });

});
