import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  DaimonControlError,
  daimonControlHelperArgs,
  daimonControlHelperConfig,
  daimonHelperControlCall,
  parseDaimonControlHelperOutput,
  type DaimonControlTarget
} from "./control.js";

const target: DaimonControlTarget = { containerRef: "abc", dockerArgs: [], dockerCommand: "docker", imageRef: "sha256:feed", token: "secret-token" };
const body = { agent_id: "agent:a", delivery_id: "d-1", event: { text: "say \"pong\"\n\\ done", version: "v" } };

describe("Daimon control client", () => {
  it("keeps the token and body out of argv", () => {
    const args = daimonControlHelperArgs(target, "POST", "/v2/wakes");
    expect(args).toContain("container:abc");
    expect(args.at(-1)).toBe("http://127.0.0.1:19700/v2/wakes");
    expect(args.join(" ")).not.toContain("secret-token");
  });

  it("renders a curl config real curl reads back byte for byte, header and JSON body", async () => {
    const seen: { auth?: string; type?: string; body: string } = { body: "" };
    const server = createServer((request, response) => {
      seen.auth = request.headers.authorization; seen.type = request.headers["content-type"];
      request.on("data", (chunk: Buffer) => { seen.body += chunk.toString("utf8"); });
      request.on("end", () => { response.writeHead(202); response.end("{}"); });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v2/wakes`;
      const curl = execFileCallback("curl", ["-sS", "-X", "POST", "--config", "-", "--output", "-", "--write-out", "\\n%{http_code}", url]);
      curl.stdin!.end(daimonControlHelperConfig("secret-token", body));
      const stdout = await new Promise<string>((resolve, reject) => {
        let text = ""; curl.stdout!.on("data", (chunk: Buffer) => { text += chunk.toString("utf8"); });
        curl.once("close", (code) => code === 0 ? resolve(text) : reject(new Error(`curl exit ${code}`)));
      });
      expect(parseDaimonControlHelperOutput(stdout)).toEqual({ body: "{}", status: 202 });
      expect(seen).toEqual({ auth: "Bearer secret-token", type: "application/json", body: JSON.stringify(body) });
    } finally { server.close(); }
  });

  it("sends only the bearer header without a body, and fails without echoing the token", async () => {
    expect(daimonControlHelperConfig("t")).toBe('header = "Authorization: Bearer t"\n');
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-control-"));
    const docker = path.join(directory, "docker");
    await writeFile(docker, `#!/bin/sh\ncat > ${directory}/stdin; echo "refused secret-token" >&2; exit 7\n`);
    await chmod(docker, 0o755);
    const failure = daimonHelperControlCall({ ...target, dockerCommand: docker }, "POST", "/v2/wakes", body);
    await expect(failure).rejects.toBeInstanceOf(DaimonControlError);
    await expect(failure).rejects.toThrow(/exit 7.*\[redacted\]/u);
    expect(await readFile(`${directory}/stdin`, "utf8")).toContain("data-binary = ");
    expect(() => parseDaimonControlHelperOutput("garbage")).toThrow("no HTTP status");
  });
});
