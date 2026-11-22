export const opencodeOwnerFile = "opencode-acp-owner.cjs";

// This file is emitted into each subscription instance that has a Moltnet
// bridge. Run it with the container's Node, independently of the Spawnfile CLI.
export const openCodeOwnerSource = String.raw`"use strict";
const { spawn } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");

process.umask(0o077);
const maxFrame = 16 * 1024 * 1024;
const workspace = fs.realpathSync(process.cwd());
const home = fs.realpathSync(process.env.HOME);
const uid = process.getuid();
const digest = createHash("sha256").update(home).update("\0").update(workspace).digest("hex").slice(0, 32);
const directory = path.join("/tmp", "spawnfile-opencode-" + uid + "-" + digest);
const address = path.join(directory, "acp.sock");

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function frames(stream, onFrame, onInvalid) {
  let parts = [];
  let size = 0;
  stream.on("data", chunk => {
    try {
      let start = 0;
      while (start < chunk.length) {
        const end = chunk.indexOf(10, start);
        const part = chunk.subarray(start, end === -1 ? chunk.length : end);
        parts.push(part);
        size += part.length;
        if (size >= maxFrame) throw new Error();
        if (end === -1) return;
        const message = JSON.parse(Buffer.concat(parts, size).toString("utf8"));
        parts = [];
        size = 0;
        if (message?.jsonrpc !== "2.0") throw new Error();
        onFrame(message);
        start = end + 1;
      }
    } catch {
      onInvalid();
    }
  });
}

function checkPrivateDirectory() {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o7777) !== 0o700) {
    throw new Error("OpenCode's private ACP directory has unsafe ownership or permissions.");
  }
}

function connect() {
  checkPrivateDirectory();
  const stat = fs.lstatSync(address);
  if (!stat.isSocket() || stat.uid !== uid) throw new Error("OpenCode's private ACP socket has unsafe ownership or permissions.");
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(address);
    socket.on("error", reject);
    socket.once("connect", () => resolve(socket));
  });
}

async function attach(cwd) {
  if (fs.realpathSync(cwd) !== workspace) throw new Error("ACP requires the canonical instance workspace.");
  for (let attempt = 0; attempt <= 50; attempt++) {
    let socket;
    try {
      socket = await connect();
    } catch (error) {
      if (!["ENOENT", "ECONNREFUSED"].includes(error.code)) {
        throw new Error("The instance ACP owner is unavailable.");
      }
    }
    if (socket) {
      // The one-byte handshake precedes all ACP traffic. The native process sees
      // only JSON-RPC frames, and Moltnet sees only the native replies.
      const chunk = await new Promise((resolve, reject) => {
        socket.once("close", () => reject(new Error("The instance ACP owner closed the connection.")));
        socket.once("data", resolve);
      });
      if (chunk[0] === 0) {
        if (chunk.length > 1) process.stdout.write(chunk.subarray(1));
        socket.on("error", () => { process.exitCode = 1; });
        socket.once("close", () => process.stdin.pause());
        socket.pipe(process.stdout, { end: false });
        process.stdin.pipe(socket);
        return;
      }
      socket.destroy();
      if (chunk[0] === 1) throw new Error("OpenCode's ACP owner already has a bridge.");
    }
    await delay(100);
  }
  throw new Error("The instance ACP owner is unavailable or still finishing its last ACP request.");
}

async function prepareSocket() {
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  try {
    const previous = await connect();
    previous.destroy();
    throw new Error("An ACP owner is already listening for this instance.");
  } catch (error) {
    if (error.code === "ENOENT") return;
    if (error.code !== "ECONNREFUSED") throw error;
    fs.unlinkSync(address);
  }
}

async function own(binary, leaseFd, args) {
  await prepareSocket();
  let current;
  let stopping = false;
  const requests = new Map();
  const reverse = new Set();
  const sessions = new Set();
  const server = net.createServer(socket => {
    socket.on("error", () => socket.destroy());
    if (stopping || current || requests.size) {
      socket.end(Buffer.from([current ? 1 : 2]), () => socket.destroy());
      return;
    }
    current = socket;
    socket.write(Buffer.from([0]));
    socket.on("close", () => disconnect(socket));
    frames(socket, message => {
      if (socket.destroyed || current !== socket) return;
      const { id, method, params } = message;
      if (method !== undefined) {
        if (params?.cwd !== undefined) {
          let requested;
          try { requested = fs.realpathSync(params.cwd); } catch {}
          if (requested !== workspace) {
            if (id !== undefined) toBridge(rpcError(id, -32602, "ACP requires the canonical instance workspace."));
            return;
          }
          params.cwd = workspace;
        }
        if ((method === "session/prompt" || method === "session/cancel") && !sessions.has(params?.sessionId)) {
          if (id !== undefined) toBridge(rpcError(id, -32602, "Open the ACP session on this bridge before prompting it."));
          return;
        }
        if (id !== undefined) {
          if (requests.has(id)) { socket.destroy(); return; }
          requests.set(id, { method, sessionId: params?.sessionId });
        }
      } else if (!reverse.delete(id)) {
        return;
      }
      toNative(message);
    }, () => socket.destroy());
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(address, resolve);
  });
  // Inherit the flock file description in the child as well, so the lease
  // still protects the native provider if the supervisor is killed abruptly.
  const child = spawn(binary, ["acp", ...args, "--cwd", workspace], {
    cwd: workspace, stdio: ["pipe", "pipe", "inherit", leaseFd]
  });

  function toNative(message) {
    if (stopping) return;
    if (child.stdin.writableLength >= maxFrame) {
      console.error("OpenCode ACP stopped accepting input.");
      shutdown(1);
      return;
    }
    child.stdin.write(JSON.stringify(message) + "\n");
  }

  function toBridge(message) {
    if (!current || current.destroyed) return;
    if (current.writableLength >= maxFrame) {
      current.destroy();
      return;
    }
    current.write(JSON.stringify(message) + "\n");
  }

  function disconnect(socket) {
    if (current !== socket) return;
    current = undefined;
    sessions.clear();
    for (const id of reverse) toNative(rpcError(id, -32000, "The Moltnet bridge disconnected."));
    reverse.clear();
    // Cancel only prompts issued on this ACP connection. Keep the native
    // process and its HTTP sessions alive while the ACP replies are drained.
    const prompts = new Set();
    for (const { method, sessionId } of requests.values()) {
      if (method === "session/prompt") prompts.add(sessionId);
    }
    for (const sessionId of prompts) {
      toNative({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
    }
  }

  function shutdown(code) {
    if (stopping) return;
    stopping = true;
    process.exitCode = code;
    current?.destroy();
    server.close();
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
  }

  frames(child.stdout, message => {
    if (message.method !== undefined) {
      const sessionId = message.params?.sessionId;
      const openingSession = message.params?.update?.sessionUpdate === "available_commands_update"
        && Array.from(requests.values()).some(request => { return request.method === "session/new"; });
      if (!current || current.destroyed || requests.size === 0 ||
          (sessionId !== undefined && !sessions.has(sessionId) && !openingSession)) {
        if (message.id !== undefined) toNative(rpcError(message.id, -32000, "No active Moltnet ACP request."));
        return;
      }
      if (message.id !== undefined) reverse.add(message.id);
    } else {
      const request = requests.get(message.id);
      if (!request) return;
      requests.delete(message.id);
      if (current && !current.destroyed && message.result) {
        const sessionId = request.method === "session/new" ? message.result.sessionId
          : request.method === "session/load" ? request.sessionId : undefined;
        if (typeof sessionId === "string") sessions.add(sessionId);
      }
    }
    toBridge(message);
  }, () => {
    console.error("OpenCode wrote an invalid ACP frame.");
    shutdown(1);
  });
  child.stdin.on("error", () => shutdown(1));
  child.on("error", () => {
    console.error("OpenCode's native ACP process could not start.");
    shutdown(1);
  });
  child.once("close", code => {
    if (!stopping) console.error("OpenCode's native ACP process exited.");
    shutdown(code || 1);
  });
  server.on("error", () => shutdown(1));
  server.once("close", () => {
    try { fs.rmdirSync(directory); } catch {}
  });
  process.once("SIGTERM", () => shutdown(0));
  process.once("SIGINT", () => shutdown(0));
}

const [mode, ...args] = process.argv.slice(2);
const task = mode === "owner" ? own(args[0], Number(args[1]), args.slice(2)) : attach(args[0]);
task.catch(error => {
  console.error(error.message || "OpenCode could not prepare its private ACP socket.");
  process.exitCode = 1;
});
`;
