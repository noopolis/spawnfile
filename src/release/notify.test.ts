import { describe, expect, it } from "vitest";

import { createNotification, resolveNotifierConfig, resolveWebhookUrl, sendNotification, shortReason } from "./notify.js";

const notification = createNotification({ deployment: "org", identity: null, message: "deploy failed in /var/lib/thing/state", now: new Date("2026-10-08T00:00:00.000Z"), reason: "deploy-failed" });

describe("shortReason", () => {
  it("scrubs paths and caps the length", () => {
    expect(shortReason("could not write /home/op/releases/org/ledger.json now")).toBe("could not write <path> now");
    expect(shortReason("x".repeat(900))).toHaveLength(500);
  });
});

describe("resolveNotifierConfig", () => {
  it("accepts one absolute command or one env-named webhook", () => {
    expect(resolveNotifierConfig({})).toEqual({ kind: "none" });
    expect(resolveNotifierConfig({ notifyCommand: "/usr/local/bin/page" })).toEqual({ command: "/usr/local/bin/page", kind: "command" });
    expect(resolveNotifierConfig({ notifyWebhookEnv: "ALERT_URL" })).toEqual({ kind: "webhook", urlEnv: "ALERT_URL" });
    expect(() => resolveNotifierConfig({ notifyCommand: "page" })).toThrow("absolute");
    expect(() => resolveNotifierConfig({ notifyWebhookEnv: "not a name" })).toThrow("environment variable");
    expect(() => resolveNotifierConfig({ notifyCommand: "/a", notifyWebhookEnv: "B" })).toThrow("one notifier");
  });
});

describe("resolveWebhookUrl", () => {
  it("requires https except on loopback", () => {
    expect(resolveWebhookUrl({ U: "https://hooks.example/x" }, "U").href).toBe("https://hooks.example/x");
    expect(resolveWebhookUrl({ U: "http://127.0.0.1:9/x" }, "U").hostname).toBe("127.0.0.1");
    expect(() => resolveWebhookUrl({ U: "http://hooks.example/x" }, "U")).toThrow("https");
    expect(() => resolveWebhookUrl({}, "U")).toThrow("not set");
    expect(() => resolveWebhookUrl({ U: "::" }, "U")).toThrow("not a URL");
  });
});

describe("sendNotification", () => {
  it("runs the command with the notification on stdin and the short reason in its environment", async () => {
    let seen: { env: NodeJS.ProcessEnv; input: string } | null = null;
    const result = await sendNotification({ command: "/bin/page", kind: "command" }, notification, {
      env: {},
      runCommand: async (_command, input, env) => { seen = { env, input }; return 0; }
    });
    expect(result).toEqual({ channel: "command", delivered: true });
    expect(JSON.parse(seen!.input)).toMatchObject({ deployment: "org", message: "deploy failed in <path>", reason: "deploy-failed", version: "spawnfile.release-notification.v1" });
    expect(seen!.env).toMatchObject({ SPAWNFILE_RELEASE_DEPLOYMENT: "org", SPAWNFILE_RELEASE_REASON: "deploy-failed" });
  });

  it("reports a failing or missing command instead of throwing", async () => {
    expect(await sendNotification({ command: "/bin/page", kind: "command" }, notification, { runCommand: async () => 3 })).toMatchObject({ delivered: false, error: "notifier exited 3" });
    expect(await sendNotification({ command: "/nonexistent/notifier", kind: "command" }, notification)).toMatchObject({ delivered: false });
  });

  it("actually executes a real command", async () => {
    expect(await sendNotification({ command: "/usr/bin/true", kind: "command" }, notification)).toEqual({ channel: "command", delivered: true });
    expect(await sendNotification({ command: "/usr/bin/false", kind: "command" }, notification)).toMatchObject({ delivered: false });
  });

  it("POSTs the JSON to the webhook and retries before giving up", async () => {
    const bodies: string[] = [];
    let attempt = 0;
    const fetchImpl = (async (_url: URL, init: RequestInit) => {
      bodies.push(String(init.body));
      attempt += 1;
      return new Response(null, { status: attempt < 3 ? 503 : 204 });
    }) as unknown as typeof fetch;
    const result = await sendNotification({ kind: "webhook", urlEnv: "U" }, notification, { env: { U: "https://hooks.example/x" }, fetchImpl, sleep: async () => undefined });
    expect(result).toEqual({ channel: "webhook", delivered: true });
    expect(bodies).toHaveLength(3);
    expect(JSON.parse(bodies[0]!)).toMatchObject({ reason: "deploy-failed" });
  });

  it("gives up after the attempts and says why", async () => {
    const fetchImpl = (async () => { throw new Error("down"); }) as unknown as typeof fetch;
    expect(await sendNotification({ kind: "webhook", urlEnv: "U" }, notification, { attempts: 2, env: { U: "https://hooks.example/x" }, fetchImpl, sleep: async () => undefined }))
      .toEqual({ channel: "webhook", delivered: false, error: "request failed; request failed" });
    expect(await sendNotification({ kind: "webhook", urlEnv: "U" }, notification, { env: {} })).toMatchObject({ delivered: false, error: "U is not set, so the webhook notifier has no URL" });
    expect(await sendNotification({ kind: "none" }, notification)).toMatchObject({ channel: "none", delivered: false });
  });
});
