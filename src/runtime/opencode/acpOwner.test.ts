import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { expect, it } from "vitest";

import { opencodeOwnerFile, openCodeOwnerSource } from "./acpOwner.js";

const nativeSource = String.raw`#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { createServer } = require("node:http");
const { createInterface } = require("node:readline");
assert.deepEqual(process.argv.slice(2), ["acp", "--hostname", "127.0.0.1", "--port", process.env.PORT, "--cwd", process.cwd()]);
assert.ok(fs.fstatSync(3).isFile());
fs.appendFileSync(process.env.HOME + "/starts", process.pid + "\n");
const pid = () => ({ pid: process.pid });
let held;
let prompt;
let denied = false;
const server = createServer((req, res) => {
  if (req.url === "/hold") {
    held = res;
    res.writeHead(200);
    res.write("waiting ");
  } else {
    res.end(JSON.stringify(pid()));
  }
});
server.listen(Number(process.env.PORT), "127.0.0.1");
function send(frame) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...frame }) + "\n"); }
createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ id: message.id, result: { protocolVersion: 1, ...pid() } });
  if (message.method === "session/new") send({ id: message.id, result: { sessionId: "session-a" } });
  if (message.method === "session/load") send({ id: message.id, result: {} });
  if (message.method === "session/prompt") {
    prompt = message.id;
    send({ id: "permission", method: "session/request_permission", params: message.params });
  }
  if (message.id === "permission" && message.error) denied = true;
  if (message.method === "session/cancel") {
    assert.equal(message.params.sessionId, "session-a");
    assert.ok(denied);
    setTimeout(() => {
      send({ method: "session/update", params: { sessionId: "session-a", old: true } });
      send({ id: prompt, result: { stopReason: "cancelled" } });
      if (held) held.end(String(process.pid));
    }, 350);
  }
});
`;

it("keeps one native owner for health, a Moltnet bridge and an HTTP turn through bridge reconnect", async () => {
  const root = await mkdtemp(join(tmpdir(), "spawnfile-opencode-owner-test-"));
  const workspace = join(root, "workspace ".repeat(12));
  await mkdir(workspace);
  const port = await new Promise<number>(resolve => {
    const reservation = createServer().listen(0, "127.0.0.1", () => {
      const address = reservation.address();
      if (typeof address !== "object" || address === null) throw new Error("No test port");
      reservation.close(() => resolve(address.port));
    });
  });
  const script = join(root, opencodeOwnerFile);
  const binary = join(root, "opencode");
  const lease = await open(join(root, "lease"), "w");
  await writeFile(script, openCodeOwnerSource, { mode: 0o600 });
  await writeFile(binary, nativeSource, { mode: 0o700 });
  const env = { ...process.env, HOME: root, PORT: String(port) };
  const origin = `http://127.0.0.1:${port}`;
  const owner = spawn(process.execPath, [script, "owner", binary, "3", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: workspace, env, stdio: ["ignore", "ignore", "pipe", lease.fd]
  });
  await lease.close();
  const ownerExit = once(owner, "exit");
  const sockets: ChildProcess[] = [];

  function attach() {
    const bridge = spawn(process.execPath, [script, "attach", workspace], { cwd: workspace, env });
    const stderr: string[] = [];
    bridge.stdin.on("error", () => {});
    bridge.stderr.setEncoding("utf8").on("data", chunk => stderr.push(chunk));
    const lines = createInterface({ input: bridge.stdout });
    const result = {
      bridge,
      finished: once(bridge, "close"),
      stderr,
      async receive() { return JSON.parse((await once(lines, "line"))[0]); },
      send(frame: Record<string, unknown>) { bridge.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...frame }) + "\n"); }
    };
    sockets.push(bridge);
    return result;
  }

  try {
    await expect.poll(async () => (await fetch(`${origin}/global/health`)).ok).toBe(true);
    const { pid } = await (await fetch(`${origin}/global/health`)).json();
    const one = attach();
    one.send({ id: 1, method: "initialize" });
    expect(await one.receive()).toEqual({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1, pid } });

    const duplicate = attach();
    expect(await duplicate.finished).toEqual([1, null]);
    expect(duplicate.stderr.join("")).toContain("already has a bridge");

    one.send({ id: 2, method: "session/new", params: { cwd: root } });
    expect(await one.receive()).toMatchObject({ id: 2, error: { code: -32602 } });
    one.send({ id: 3, method: "session/new", params: { cwd: workspace } });
    expect(await one.receive()).toMatchObject({ id: 3, result: { sessionId: "session-a" } });

    const ongoing = await fetch(`${origin}/hold`);
    one.send({ id: 4, method: "session/prompt", params: { sessionId: "session-a" } });
    expect(await one.receive()).toMatchObject({ id: "permission", method: "session/request_permission" });
    one.bridge.kill("SIGKILL");
    await one.finished;
    // Deliberately reuse the previous bridge's IDs. A delayed reply or update
    // from the dead bridge would arrive before these exact expected responses.
    const two = attach();
    two.send({ id: 1, method: "initialize" });
    expect(await ongoing.text()).toBe(`waiting ${pid}`);
    expect(await two.receive()).toEqual({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1, pid } });
    two.send({ id: 4, method: "session/load", params: { cwd: workspace, sessionId: "session-a" } });
    expect(await two.receive()).toEqual({ jsonrpc: "2.0", id: 4, result: {} });
    expect(await readFile(join(root, "starts"), "utf8")).toBe(`${pid}\n`);
  } finally {
    for (const socket of sockets) socket.kill();
    owner.kill();
    await ownerExit;
    await rm(root, { recursive: true, force: true });
  }
});
