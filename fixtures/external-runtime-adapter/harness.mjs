import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";

const [mode, configFile] = process.argv.slice(2);
if (mode === "serve") {
  const config = JSON.parse(await readFile(configFile, "utf8"));
  process.stdout.write("external harness ready for " + config.agent + "\n");
  setInterval(() => {}, 60_000);
} else if (mode === "acp") {
  const sessions = new Set();
  for await (const line of createInterface({ input: process.stdin })) {
    const { id, method, params } = JSON.parse(line);
    if (id === undefined) continue;
    let result;
    switch (method) {
      case "initialize":
        result = { protocolVersion: 1, agentCapabilities: { loadSession: false } };
        break;
      case "session/new": {
        const sessionId = randomUUID();
        sessions.add(sessionId);
        result = { sessionId };
        break;
      }
      case "session/prompt": {
        if (!sessions.has(params.sessionId)) throw new Error("unknown session");
        const body = params.prompt.map(block => block.text ?? "").join(" ");
        if (body.includes("SPAWNFILE_EXTERNAL_PING")) {
          const config = JSON.parse(await readFile(process.env.MOLTNET_CLIENT_CONFIG, "utf8"));
          if (!config.attachments?.length || !config.attachments.every(a => new URL(a.base_url).hostname === "127.0.0.1")) {
            throw new Error("fixture requires a disposable loopback network");
          }
          const send = spawnSync("moltnet", ["send", "--target", "room:adapter-proof", "--text", "SPAWNFILE_EXTERNAL_PONG"], { encoding: "utf8" });
          if (send.status !== 0) throw new Error("fixture reply failed: " + send.stderr);
        }
        result = { stopReason: "end_turn" };
        break;
      }
      default:
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } }) + "\n");
        continue;
    }
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
  }
} else {
  throw new Error("expected serve or acp");
}
