import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("CLI entrypoint", () => {
  it("lets buffered machine output drain before the process exits", async () => {
    const source = await readFile(new URL("./index.ts", import.meta.url), "utf8");
    expect(source).toContain("process.exitCode = exitCode;");
    expect(source).not.toMatch(/process\.exit\(/u);
  });
});

describe("global adapter routing", () => {
  let root: string;
  let adapter: string;
  let loaded: string;
  const tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
  const entry = fileURLToPath(new URL("./index.ts", import.meta.url));

  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), "spawnfile-cli-adapter-")));
    adapter = path.join(root, "adapter.mjs");
    loaded = path.join(root, "loaded");
    await mkdir(path.join(root, "home"), { mode: 0o700 });
    await writeFile(adapter, `
      import { appendFileSync } from "node:fs";
      import { RuntimeAdapterBase } from ${JSON.stringify(new URL("../runtime/adapterBase.ts", import.meta.url).href)};
      appendFileSync(${JSON.stringify(loaded)}, "loaded\\n");
      class Adapter extends RuntimeAdapterBase {
        name = "echo-harness";
        container = {
          configFileName: "agent.json",
          instancePaths: { configPathTemplate: "<config-file>", workspacePathTemplate: "workspace" },
          standaloneBaseImage: "node:24",
          startCommand: ["node"],
          systemDeps: []
        };
        async compileAgent() { throw new Error("unexpected compile"); }
        preflightAgent() {
          if (ForeignError) throw new ForeignError("validation_error", "adapter rejected the project");
        }
      }
      const ForeignError = process.env.TEST_FOREIGN_ERROR
        ? (await import("./node_modules/spawnfile-copy/errors.mjs")).SpawnfileError
        : undefined;
      export const spawnfileAdapter = {
        apiVersion: 1,
        adapter: new Adapter(),
        catalog: { defaultBranch: "main", ref: "1", remote: "local" }
      };
    `);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const invoke = (args: string[], input = "", extraEnv: NodeJS.ProcessEnv = {}) => {
    const child = spawnSync(process.execPath, ["--import", tsx, entry, ...args], {
      cwd: root,
      encoding: "utf8",
      env: { PATH: process.env.PATH, SPAWNFILE_HOME: path.join(root, "home"), ...extraEnv },
      input,
      timeout: 8000
    });
    if (child.error) throw child.error;
    expect(child.signal).toBeNull();
    return { code: child.status, stderr: child.stderr, stdout: child.stdout };
  };

  it("loads an adapter and preserves the dedicated canary, clone and migration routes", async () => {
    const request = path.join(root, "request.json");
    await writeFile(request, "null");
    const manifestError = "Workspace resource source and manifest paths must be absolute\n";
    const invocations = [
      {
        plain: ["canary", "verify-rollback", request],
        withAdapter: ["canary", "--adapter", adapter, "verify-rollback", request],
        stderr: "error: Canary operation failed\n"
      },
      {
        plain: ["product-state", "clone", request],
        withAdapter: ["product-state", "clone", request, `--adapter=${adapter}`],
        stderr: expect.stringContaining("error: Product-state clone failed:")
      },
      {
        plain: ["workspace-resource", "migrate", root, path.join(root, "dest"),
          "--manifest", "relative", "--resolved-identity", "unused", "--source-quiesced", "--json"],
        withAdapter: ["--adapter", adapter, "workspace-resource", "migrate", root, path.join(root, "dest"),
          "--manifest", "relative", "--resolved-identity", "unused", "--source-quiesced", "--json"],
        stderr: manifestError
      }
    ];
    for (const { plain, withAdapter, stderr } of invocations) {
      const baseline = invoke(plain);
      expect(baseline).toEqual({ code: 1, stderr, stdout: "" });
      expect(invoke(withAdapter)).toEqual(baseline);
    }
    expect(await readFile(loaded, "utf8")).toBe("loaded\n".repeat(3));
    expect(invoke(["workspace-resource", "migrate", "--adapter", adapter])).toMatchObject({
      code: 2,
      stderr: expect.stringContaining("usage: spawnfile workspace-resource migrate")
    });
  });

  it("keeps read-only lookup output and passes a literal request filename after --", async () => {
    const request = path.join(root, "--adapter");
    await writeFile(request, JSON.stringify({
      descriptor_digest: `sha256:${"a".repeat(64)}`,
      expected_revision: 0,
      idempotency_key: "idem_aaaaaaaaaaaaaaaa",
      operation: "create_data_network",
      run_id: "run-one",
      selected_target: { fingerprint: `sha256:${"b".repeat(32)}`, handle: "opaque_cccccccccccccccc" },
      version: "spawnfile.target-resource.request.v1"
    }), { mode: 0o600 });
    const stdin = JSON.stringify({ context: "production", version: "spawnfile.target-lookup-config.v1" });
    const args = ["target", "--config=-", "lookup_operation", "--", request];
    const baseline = invoke(args, stdin);
    expect(baseline).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(baseline.stdout)).toMatchObject({ status: "not_applied" });
    expect(invoke(["validate", "--", `--adapter=${adapter}`])).toMatchObject({ code: 2 });
    await expect(readFile(loaded)).rejects.toMatchObject({ code: "ENOENT" });
    expect(invoke(["target", "--config=-", `--adapter=${adapter}`, "lookup_operation", "--", request], stdin))
      .toEqual(baseline);
    expect(await readFile(loaded, "utf8")).toBe("loaded\n");
  });

  it("does not import an adapter token used as a required value on either target route or migration", async () => {
    const literal = `--adapter=${adapter}`;
    const lookup = invoke(["target", "lookup_operation", "--config", literal, "missing.json"]);
    expect(lookup).toEqual({ code: 2, stderr: "error: Invalid target lookup request\n", stdout: "" });
    const resolveArgs = ["target", "resolve_config", "--evidence-destination", root, "--timeout-ms"];
    const baseline = invoke([...resolveArgs, "invalid"]);
    expect(baseline).toMatchObject({ code: 2, stderr: expect.stringContaining("timeout") });
    expect(invoke([...resolveArgs, literal])).toEqual(baseline);
    expect(invoke(["workspace-resource", "migrate", root, path.join(root, "dest"), "--manifest", literal,
      "--resolved-identity", "unused", "--source-quiesced"])).toMatchObject({
      code: 1,
      stderr: "Workspace resource source and manifest paths must be absolute\n"
    });
    await expect(readFile(loaded)).rejects.toMatchObject({ code: "ENOENT" });

    expect(invoke(["--adapter", adapter, ...resolveArgs, "invalid"])).toEqual(baseline);
    expect(await readFile(loaded, "utf8")).toBe("loaded\n");
  });

  it("scopes the installed adapter to validation and maps a second package's thrown error to exit 2", async () => {
    const packageDir = path.join(root, "node_modules", "spawnfile-copy");
    await mkdir(packageDir, { recursive: true });
    const source = await readFile(new URL("../shared/errors.ts", import.meta.url), "utf8");
    await writeFile(path.join(packageDir, "errors.mjs"), transpileModule(source, {
      compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 }
    }).outputText);
    await copyFile(new URL("../../fixtures/external-runtime-adapter/Spawnfile", import.meta.url), path.join(root, "Spawnfile"));

    const args = ["validate", root, "--adapter", adapter];
    expect(invoke(args)).toMatchObject({ code: 0, stderr: "", stdout: expect.stringContaining("validation succeeded") });
    expect(invoke(args, "", { TEST_FOREIGN_ERROR: "1" })).toEqual({
      code: 2, stderr: "error: adapter rejected the project\n", stdout: ""
    });
    expect(invoke(["validate", root])).toMatchObject({
      code: 2, stderr: expect.stringContaining("Unknown runtime binding: echo-harness")
    });
  });
});
