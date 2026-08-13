import { execFile, spawn } from "node:child_process";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { URL } from "node:url";
import { createServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { promisify } from "node:util";
import { runInNewContext } from "node:vm";
import path from "node:path";

import { renderPiControlSource } from "./appControlSource.js";
import { renderPiCoreSource } from "./appCoreSource.js";
import { renderPiPreludeSource } from "./appPreludeSource.js";

const INVALID_DELIVERY_ERROR = "invalid delivery metadata";
type Spy<T extends (...args: unknown[]) => Promise<unknown>> = T & { mock: { calls: unknown[][] } };
type DeliveryMetadataField = Exclude<keyof DeliveryPayload, "message" | "wake_kind">;
type DeliveryPayload = {
  event_id?: string;
  from?: string;
  to?: string;
  context_id?: string;
  message?: string;
  transport_text?: string;
  wake_kind?: "manual" | "message" | "schedule" | "dream";
};

const createSpy = <T extends (...args: unknown[]) => Promise<unknown>>(impl: T): T & { mock: { calls: unknown[][] } } => {
  const calls: unknown[][] = [];
  const spy = (async (...args: unknown[]) => impl(...args)) as Spy<T>;
  spy.mock = { calls };
  return new Proxy(spy, {
    apply(target, _, argList) {
      calls.push([...argList]);
      return target.apply(_, argList);
    }
  }) as Spy<T>;
};

const stripImports = (source: string): string => source.replace(/^import[\s\S]*?;\n?/gmu, "");
const getFreePort = async (): Promise<number> => new Promise((resolve, reject) => {
  const probe = createNetServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const address = probe.address();
    const port = typeof address === "object" && address ? address.port : 0;
    probe.close(() => resolve(port));
  });
});
const loadControlHarness = (env: Record<string, string>, emitters: {
  emitControlWakeAccepted: Spy<(payload: unknown) => Promise<unknown>>;
  emitControlWakeDenied: Spy<(payload: unknown) => Promise<unknown>>;
  emitDeliveryWakeAccepted: Spy<(payload: unknown) => Promise<unknown>>;
}) => runInNewContext([
    stripImports(renderPiPreludeSource()),
    renderPiCoreSource().slice(
      renderPiCoreSource().indexOf("const normalizeWakeKind"),
      renderPiCoreSource().indexOf("const TEAM_CONTEXTS_FILE")
    ),
    renderPiControlSource(),
    "({ startControlServer });"
  ].join("\n"), {
    Buffer,
    console,
    createServer,
    emitControlWakeAccepted: emitters.emitControlWakeAccepted,
    emitControlWakeDenied: emitters.emitControlWakeDenied,
    emitDeliveryWakeAccepted: emitters.emitDeliveryWakeAccepted,
    execFile,
    promisify,
    spawn,
    path,
    process: { env },
    URL
  }) as { startControlServer: (...args: unknown[]) => Promise<unknown> };

const createFakeAgent = (overrides: Record<string, unknown> = {}) => ({
  config: { id: "agent:mapper", name: "Mapper", slug: "mapper" },
  paths: { runtimeHomePath: "/tmp/noopolis-control-test/mapper" },
  wake: async () => "ok" as const,
  ...overrides
});

const makeBaseDeliveryPayload = (): DeliveryPayload => ({
  event_id: "moltnet:event-α-42  ",
  from: "agent:\"sender-β\"/relay",
  to: "mapper",
  context_id: "room:team A  ",
  message: "room:team A · agent:sender\n\"quoted\" and \\\\backslash test",
  transport_text: "  \"quoted\" and \\\\backslash test  ",
  wake_kind: "message"
});

const makePayload = (field: DeliveryMetadataField, value?: unknown): DeliveryPayload => {
  const payload: DeliveryPayload = { ...makeBaseDeliveryPayload() };
  if (value === undefined) {
    if (field in payload) {
      delete payload[field];
    }
    return payload;
  }
  (payload as Record<DeliveryMetadataField, unknown>)[field] = value;
  return payload;
};

const makeBasePayloadWithoutMessage = () => {
  const payload = makeBaseDeliveryPayload();
  delete payload.message;
  return payload;
};

const assertUtf8BytesEqual = (label: string, expected: string, actual: string): void => {
  assert.equal(
    Buffer.from(expected, "utf8").toString("hex"),
    Buffer.from(actual, "utf8").toString("hex"),
    `${label} must preserve UTF-8 bytes`
  );
};

const assertDeliveryMetadataBytes = (payload: DeliveryPayload, wakeEvent: Record<string, unknown>): void => {
  assert.equal(wakeEvent.id, payload.event_id);
  assert.equal(wakeEvent.text, payload.message);
  assert.equal(wakeEvent.transportText, payload.transport_text);
  const delivery = wakeEvent.delivery as {
    eventId?: string;
    sender?: string;
    target?: string;
    contextId?: string;
  };
  assert.equal(typeof delivery, "object");
  assert.equal(delivery.eventId, payload.event_id);
  assert.equal(delivery.sender, payload.from);
  assert.equal(delivery.target, "agent:mapper");
  assert.equal(delivery.contextId, payload.context_id);
  assertUtf8BytesEqual("wakeEvent.id", payload.event_id ?? "", wakeEvent.id as string);
  assertUtf8BytesEqual("wakeEvent.text", payload.message ?? "", wakeEvent.text as string);
  assertUtf8BytesEqual(
    "wakeEvent.transportText",
    payload.transport_text ?? "",
    wakeEvent.transportText as string
  );
  assertUtf8BytesEqual("delivery.eventId", payload.event_id ?? "", delivery.eventId ?? "");
  assertUtf8BytesEqual("delivery.sender", payload.from ?? "", delivery.sender ?? "");
  assertUtf8BytesEqual("delivery.contextId", payload.context_id ?? "", delivery.contextId ?? "");
};

describe("renderPiControlSource delivery metadata", () => {
  const closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
  });

  const startServer = async (env: Record<string, string>, agents: unknown[]) => {
    const emitAccepted = createSpy(async () => undefined as unknown);
    const emitDenied = createSpy(async () => undefined as unknown);
    const emitDelivery = createSpy(async () => undefined as unknown);
    const { startControlServer } = loadControlHarness(env, {
      emitControlWakeAccepted: emitAccepted,
      emitControlWakeDenied: emitDenied,
      emitDeliveryWakeAccepted: emitDelivery
    });
    const port = await getFreePort();
    const server = await startControlServer(agents, port, "/tmp/config.json", "/tmp/instance", {});
    closers.push(() => new Promise((resolve) => (server as Server).close(() => resolve())));
    return { emitAccepted, emitDenied, emitDelivery, port, server };
  };

  it("forwards tokenless Moltnet delivery metadata and bytes exactly for a message-kind wake", async () => {
    const wake = createSpy(async () => "delivered");
    const payload = makeBaseDeliveryPayload();
    const agent = createFakeAgent({ wake: wake as unknown });
    const { emitAccepted, emitDenied, emitDelivery, port } = await startServer({}, [agent]);

    const response = await fetch(`http://127.0.0.1:${port}/agents/mapper/wake`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    const responseBody = (await response.json()) as { from: string; message: string };
    const wakeEvent = wake.mock.calls[0]?.[0] as Record<string, unknown>;
    const deliveryCall = emitDelivery.mock.calls[0]?.[0] as {
      causeEventIds?: string[];
      runtimeHomePath?: string;
      targetAgentId?: string;
      wakeKind?: string;
    };

    assert.equal(response.status, 200);
    assert.equal(responseBody.message, "delivered");
    assert.equal(responseBody.from, "agent:mapper");
    assert.equal(wake.mock.calls.length, 1);
    assert.equal(emitAccepted.mock.calls.length, 0);
    assert.equal(emitDenied.mock.calls.length, 0);
    assert.equal(emitDelivery.mock.calls.length, 1);
    assert.equal(deliveryCall.runtimeHomePath, agent.paths.runtimeHomePath);
    assert.equal(deliveryCall.targetAgentId, "mapper");
    assert.equal(Object.prototype.hasOwnProperty.call(deliveryCall, "operatorName"), false);
    assert.equal(deliveryCall.wakeKind, "message");
    assert.equal(deliveryCall.causeEventIds?.length, 1);
    assert.equal(deliveryCall.causeEventIds?.[0], payload.event_id);
    assertDeliveryMetadataBytes(payload, wakeEvent);
  });

  it("rejects every hostile value for delivery metadata and blocks delivery wake acceptance", async () => {
    const fields = ["event_id", "from", "to", "context_id"] as const;
    const cases = [{ kind: "missing", value: undefined }, { kind: "null", value: null }, { kind: "wrong-type-number", value: 77 }, { kind: "empty", value: "" }, { kind: "whitespace-only", value: "   " }] as const;

    for (const field of fields) {
      for (const { kind, value } of cases) {
        const wakeEvent = createSpy(async (_event: unknown) => undefined as unknown),
          agentEvent = createSpy(async (_event: unknown) => undefined as unknown),
          telemetryEmit = createSpy(async (_event: unknown) => undefined as unknown);
        const wake = createSpy(async (event: unknown) => (await wakeEvent(event), await agentEvent(event), await telemetryEmit(event), "no"));
        const agent = createFakeAgent({ wake });
        const { emitAccepted, emitDenied, emitDelivery, port } = await startServer({}, [agent]);
        const payload = makePayload(field, kind === "missing" ? undefined : value);

        const response = await fetch(`http://127.0.0.1:${port}/agents/mapper/wake`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...payload, secret: "private-sentinel" }) });
        const body = (await response.json()) as { error: string };
        assert.equal(response.status, 400);
        assert.equal(body.error, INVALID_DELIVERY_ERROR);
        assert.equal(body.error.includes("private-sentinel"), false, `${field}:${kind}`);
        assert.equal(wake.mock.calls.length, 0, `${field}:${kind}`);
        assert.equal(emitAccepted.mock.calls.length, 0, `${field}:${kind}`);
        assert.equal(emitDenied.mock.calls.length, 0, `${field}:${kind}`);
        assert.equal(emitDelivery.mock.calls.length, 0, `${field}:${kind}`);
        for (const spy of [wakeEvent, agentEvent, telemetryEmit]) {
          assert.equal(spy.mock.calls.length, 0, `${field}:${kind}`);
        }
      }
    }
  });

  it("rejects a delivery whose body target does not resolve to the routed agent", async () => {
    const wake = createSpy(async () => "not delivered");
    const agent = createFakeAgent({ wake: wake as unknown });
    const { emitAccepted, emitDenied, emitDelivery, port } = await startServer({}, [agent]);

    const response = await fetch(`http://127.0.0.1:${port}/agents/mapper/wake`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...makeBaseDeliveryPayload(), to: "someone-else" })
    });
    const body = (await response.json()) as { error: string };

    assert.equal(response.status, 400);
    assert.equal(body.error, INVALID_DELIVERY_ERROR);
    assert.equal(wake.mock.calls.length, 0);
    assert.equal(emitAccepted.mock.calls.length, 0);
    assert.equal(emitDenied.mock.calls.length, 0);
    assert.equal(emitDelivery.mock.calls.length, 0);
  });

  it("normalizes a bare Moltnet target to the agent's canonical id", async () => {
    const wake = createSpy(async () => "delivered");
    const agent = createFakeAgent({ wake: wake as unknown });
    const { port } = await startServer({}, [agent]);

    const response = await fetch(`http://127.0.0.1:${port}/agents/mapper/wake`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...makeBaseDeliveryPayload(), to: "mapper" })
    });
    const wakeEvent = wake.mock.calls[0]?.[0] as { delivery: { target: string } };

    assert.equal(response.status, 200);
    assert.equal(wakeEvent.delivery.target, agent.config.id);
    assert.notEqual(wakeEvent.delivery.target, "mapper");
  });

  it("does not attach delivery on operator wakes and keeps event-id identity", async () => {
    const wake = createSpy(async () => "ok");
    const agent = createFakeAgent({ wake: wake as unknown });
    const { port } = await startServer({ SPAWNFILE_PI_CONTROL_TOKEN: "secret-token" }, [agent]);

    await fetch(`http://127.0.0.1:${port}/spawnfile/agents/mapper/wake`, {
      method: "POST",
      headers: { authorization: "Bearer secret-token", "content-type": "application/json" },
      body: JSON.stringify({ message: "hello from operator", event_id: "operator-event", wake_kind: "manual" })
    });
    const wakeEvent = wake.mock.calls[0]?.[0] as Record<string, unknown> & {
      id: string;
      delivery?: Record<string, unknown>;
    };

    assert.equal(wakeEvent.delivery, undefined);
    assert.equal(wakeEvent.id, "operator-event");
  });

  it("chains control.wake.accepted cause_event_ids to moltnet event ids for message delivery", async () => {
    const wake = createSpy(async () => "delivered");
    const agent = createFakeAgent({ wake: wake as unknown });
    const payload = makeBaseDeliveryPayload();
    const { emitDelivery, port } = await startServer({}, [agent]);

    await fetch(`http://127.0.0.1:${port}/agents/mapper/wake`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...payload, event_id: "moltnet:msg_abc123" })
    });

    const deliveryCall = emitDelivery.mock.calls[0]?.[0] as { causeEventIds?: string[] };
    assert.equal(deliveryCall.causeEventIds?.length, 1);
    assert.equal(deliveryCall.causeEventIds?.[0], "moltnet:msg_abc123");
  });

  it("keeps cause_event_ids empty for schedule and dream delivery wakes", async () => {
    const wake = createSpy(async () => "ok");
    const agent = createFakeAgent({ wake: wake as unknown });
    const { emitDelivery, port } = await startServer({}, [agent]);
    const scheduleCase = [
      { wake_kind: "schedule", event_id: "moltnet:schedule-1" },
      { wake_kind: "dream", event_id: "moltnet:dream-1" }
    ] as const;

    for (const request of scheduleCase) {
      const payload = makeBasePayloadWithoutMessage();
      await fetch(`http://127.0.0.1:${port}/agents/mapper/wake`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...payload, ...request, message: "run" })
      });
      const deliveryCall = emitDelivery.mock.calls.at(-1)?.[0] as { causeEventIds?: string[] };
      assert.equal(deliveryCall.causeEventIds?.length, 0);
    }
  });

  it("threads moltnet's event_id verbatim into WakeEvent.id for message-kind delivery", async () => {
    const wake = createSpy(async () => "delivered");
    const agent = createFakeAgent({ wake: wake as unknown });
    const payload = { ...makeBasePayloadWithoutMessage() };
    payload.event_id = "moltnet:event-id-preserved";
    payload.message = "hello";
    const { port } = await startServer({}, [agent]);

    const response = await fetch(`http://127.0.0.1:${port}/agents/mapper/wake`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });

    assert.equal(response.status, 200);
    const wakeEvent = wake.mock.calls[0]?.[0] as { id: string };
    assert.equal(wakeEvent.id, "moltnet:event-id-preserved");
  });

  it("requires a real, known agent key and does not emit for unknown delivery targets", async () => {
    const { emitAccepted, emitDenied, emitDelivery, port } = await startServer({}, []);

    const response = await fetch(`http://127.0.0.1:${port}/agents/does-not-exist/wake`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(makeBaseDeliveryPayload())
    });

    assert.equal(response.status, 404);
    assert.equal(emitAccepted.mock.calls.length, 0);
    assert.equal(emitDenied.mock.calls.length, 0);
    assert.equal(emitDelivery.mock.calls.length, 0);
  });

  it("operates regardless of SPAWNFILE_PI_CONTROL_TOKEN for tokenless delivery", async () => {
    const wake = createSpy(async () => "ok");
    const agent = createFakeAgent({ wake: wake as unknown });
    const { emitAccepted, emitDelivery, emitDenied, port } = await startServer({ SPAWNFILE_PI_CONTROL_TOKEN: "secret-token" }, [agent]);

    const response = await fetch(`http://127.0.0.1:${port}/agents/mapper/wake`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(makeBaseDeliveryPayload())
    });

    assert.equal(response.status, 200);
    assert.equal(emitAccepted.mock.calls.length, 0);
    assert.equal(emitDenied.mock.calls.length, 0);
    assert.equal(emitDelivery.mock.calls.length, 1);
  });

  it("skips delivery wake processing for blank or missing messages while metadata remains valid", async () => {
    const messageCase = [
      { kind: "blank", message: "   " },
      { kind: "missing", message: undefined }
    ] as const;
    for (const test of messageCase) {
      const wake = createSpy(async () => "unused");
      const agent = createFakeAgent({ wake: wake as unknown });
      const { emitAccepted, emitDenied, emitDelivery, port } = await startServer({}, [agent]);
      const payload = makeBaseDeliveryPayload();
      if (test.message === undefined) {
        delete payload.message;
      } else {
        payload.message = test.message;
      }

      const response = await fetch(`http://127.0.0.1:${port}/agents/mapper/wake`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      });
      const responseBody = (await response.json()) as { from: string; message: string };

      assert.equal(response.status, 200);
      assert.equal(responseBody.message, "");
      assert.equal(wake.mock.calls.length, 0, test.kind);
      assert.equal(emitAccepted.mock.calls.length, 0, test.kind);
      assert.equal(emitDenied.mock.calls.length, 0, test.kind);
      assert.equal(emitDelivery.mock.calls.length, 0, test.kind);
    }
  });

  it("never lets a telemetry emitter failure break the HTTP response", async () => {
    const wake = createSpy(async () => "still works");
    const agent = createFakeAgent({ wake: wake as unknown });
    const emitAccepted = createSpy(async () => undefined as unknown);
    const emitDenied = createSpy(async () => undefined as unknown);
    const emitDelivery = createSpy(async () => {
      throw new Error("disk full");
    });
    const { startControlServer } = loadControlHarness(
      {},
      { emitControlWakeAccepted: emitAccepted, emitControlWakeDenied: emitDenied, emitDeliveryWakeAccepted: emitDelivery }
    );
    const port = await getFreePort();
    const server = await startControlServer([agent], port, "/tmp/config.json", "/tmp/instance", {});
    closers.push(() => new Promise((resolve) => (server as Server).close(() => resolve())));

    const response = await fetch(`http://127.0.0.1:${port}/agents/mapper/wake`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(makeBaseDeliveryPayload())
    });
    const responseBody = (await response.json()) as { message: string };

    assert.equal(response.status, 200);
    assert.equal(responseBody.message, "still works");
    assert.equal(emitDelivery.mock.calls.length, 1);
  });
});
