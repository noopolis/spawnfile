import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parse as parseYaml } from "yaml";

import { discoverRuntimeImages, repositoryRoot } from "./runtime-image-catalog.ts";

type Step = { id?: string; name?: string; run?: string; if?: string; uses?: string };
type Workflow = {
  on: {
    pull_request: { paths: string[] };
    push: { paths: string[] };
    workflow_dispatch: { inputs: { runtime: { type: string; default: string } } };
  };
  jobs: Record<string, { if?: string; steps: Step[]; concurrency?: { group: string } }>;
};
const source = readFileSync(".github/workflows/runtime-images.yml", "utf8");
const workflow = parseYaml(source) as Workflow;
const step = (job: string, name: string): Step | undefined => workflow.jobs[job]?.steps.find((item) => item.name === name);
const publisher = "src/runtime/daimon/image/publishRuntime.ts";

test("CI discovers repository images and gates both build lanes on the same publishing mode", () => {
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.runtime.type, "string");
  assert.equal(workflow.on.workflow_dispatch.inputs.runtime.default, "all");
  for (const event of [workflow.on.pull_request, workflow.on.push]) {
    for (const trigger of ["src/runtime/**/image/**", "src/runtime/**/contract-manifest.*", "scripts/runtime-image-catalog.ts"]) {
      assert.ok(event.paths.includes(trigger), `missing ${trigger}`);
    }
  }
  assert.equal(workflow.jobs.build?.if, "needs.catalog.outputs.dockerfiles != '[]'");
  assert.equal(workflow.jobs.scripted?.if, "needs.catalog.outputs.scripted != '[]'");
  assert.match(source, /fromJSON\(needs.catalog.outputs.dockerfiles\)/u);
  assert.match(source, /fromJSON\(needs.catalog.outputs.scripted\)/u);
  assert.equal(workflow.jobs.scripted?.concurrency?.group, "runtime-images-${{ matrix.runtime }}-publish");
  assert.equal(step("catalog", "Check Docker Hub credentials")?.if, "steps.publish.outputs.push == 'true'");
  for (const job of ["build", "scripted"]) {
    assert.equal(step(job, "Set up Buildx")?.uses, "docker/setup-buildx-action@v3");
    assert.equal(step(job, "Log in to Docker Hub")?.if, "needs.catalog.outputs.push == 'true'");
  }
  assert.match(source, /secrets\.DOCKERHUB_USERNAME/u);
  assert.match(source, /secrets\.DOCKERHUB_TOKEN/u);
  assert.match(source, /platforms: amd64,arm64/u);
  assert.match(source, /runner.temp.*matrix.runtime.*-runtime-identity\.json/u);
  assert.match(step("scripted", "Record published identity")?.run ?? "", /Publishing finished without a/u);
});

test("Daimon dispatch selects just its scripted publisher and all retains both Dockerfile images", () => {
  const catalog = discoverRuntimeImages(repositoryRoot);
  assert.deepEqual(catalog.dockerfiles, [
    {runtime: "openclaw", context: "src/runtime/openclaw/image", image: "noopolis/spawnfile-runtime-openclaw", version: "2026.6.11", build_args: ["OPENCLAW_VERSION=2026.6.11"]},
    {runtime: "picoclaw", context: "src/runtime/picoclaw/image", image: "noopolis/spawnfile-runtime-picoclaw", version: "0.3.1", build_args: ["PICOCLAW_VERSION=v0.3.1"]}
  ]);
  assert.deepEqual(discoverRuntimeImages(repositoryRoot, "daimon"), {
    dockerfiles: [],
    scripted: [{runtime: "daimon", publisher, local_builder: "src/runtime/daimon/image/buildLocalRuntime.ts"}]
  });
  assert.throws(() => discoverRuntimeImages(repositoryRoot, "missing"), /Unknown repository runtime image/u);
});

test("a new repository image is discovered from static metadata alone", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "runtime-images-catalog-"));
  try {
    const context = "src/runtime/future-runtime/image";
    mkdirSync(path.join(root, context), { recursive: true });
    writeFileSync(path.join(root, context, "Dockerfile"), "FROM scratch\n");
    writeFileSync(path.join(root, context, "build.json"), '{"image":"example/future","version":"1.0.0"}');
    writeFileSync(path.join(root, context, "..", "adapter.ts"), "throw new Error('unexpected adapter import');");
    assert.deepEqual(discoverRuntimeImages(root, "future-runtime"), {
      dockerfiles: [{runtime: "future-runtime", context, image: "example/future", version: "1.0.0", build_args: []}],
      scripted: []
    });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("release-image action builds with --release, pushes to the named registry, and outputs the registry digest", async () => {
  const action = await readFile(".github/actions/release-image/action.yml", "utf8");
  assert.match(action, /using: composite/u);
  for (const input of ["project:", "image:", "tag:", "registry:", "username:", "password:", "spawnfile-version:"]) assert.ok(action.includes(`\n  ${input}`), `missing input ${input}`);
  assert.match(action, /"\$\{spawnfile\[@\]\}" build --release "\$\{PROJECT\}" --tag "\$\{REFERENCE\}" --out "\$\{RUNNER_TEMP\}/u);
  assert.match(action, /docker\/login-action@v3[\s\S]*registry: \$\{\{ steps\.target\.outputs\.registry \}\}/u);
  // The output digest is the one this push reported, then proven served by the registry.
  assert.match(action, /digest="\$\(docker push "\$\{REFERENCE\}"/u);
  assert.match(action, /imagetools inspect "\$\{IMAGE\}@\$\{digest\}" --format '\{\{json \.Manifest\}\}'/u);
  assert.doesNotMatch(action, /imagetools inspect "\$\{REFERENCE\}"/u);
  assert.match(action, /digest:\n\s+description: [^\n]+\n\s+value: \$\{\{ steps\.push\.outputs\.digest \}\}/u);
  // Credentials only ever flow through inputs into the login action.
  assert.doesNotMatch(action, /secrets\./u);
  assert.doesNotMatch(action, /echo[^\n]*inputs\.password/u);
});

const runWorkflowScript = (script: string | undefined, environment: NodeJS.ProcessEnv): void => {
  assert.ok(script);
  execFileSync("bash", ["-c", script], { env: { ...process.env, ...environment } });
};

const resolveMode = (event: { name: string; ref: string; push?: boolean; latest?: boolean }): Record<string, string> => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "runtime-images-mode-"));
  try {
    const output = path.join(directory, "output");
    runWorkflowScript(step("catalog", "Resolve publishing mode")?.run, {
      GITHUB_EVENT_NAME: event.name,
      GITHUB_OUTPUT: output,
      GITHUB_REF: event.ref,
      REQUEST_PUSH: String(event.push ?? ""),
      REQUEST_LATEST: String(event.latest ?? "")
    });
    return Object.fromEntries(readFileSync(output, "utf8").trim().split("\n").map((line) => line.split("=")));
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
};

test("runtime images publish only on version-tag pushes or an explicit dispatch", () => {
  assert.deepEqual(resolveMode({ name: "push", ref: "refs/tags/v1.2.3" }), { push: "true", latest: "true" });
  assert.equal(resolveMode({ name: "push", ref: "refs/heads/main" }).push, "false");
  assert.equal(resolveMode({ name: "pull_request", ref: "refs/pull/1/merge" }).push, "false");
  assert.equal(resolveMode({ name: "workflow_dispatch", ref: "refs/heads/main", push: true }).push, "true");
  assert.deepEqual(resolveMode({ name: "workflow_dispatch", ref: "refs/tags/v1.2.3", push: false, latest: false }), { push: "false", latest: "false" });
});

test("dispatch builds exact image tags and publisher argv, including on a version tag", () => {
  for (const ref of ["refs/heads/chore/publish-daimon-0.2.8", "refs/tags/v1.2.3"]) {
    for (const latest of [false, true]) {
      const mode = resolveMode({ name: "workflow_dispatch", ref, push: true, latest });
      assert.deepEqual(mode, { push: "true", latest: String(latest) });
      const directory = mkdtempSync(path.join(os.tmpdir(), "runtime-image-publish-args-"));
      try {
        const output = path.join(directory, "tags");
        runWorkflowScript(step("build", "Resolve image tags")?.run, {
          GITHUB_OUTPUT: output, IMAGE: "example/image", VERSION: "1.0.0", LATEST: mode.latest
        });
        assert.equal(readFileSync(output, "utf8"), `tags<<EOF\nexample/image:1.0.0\n${latest ? "example/image:latest\n" : ""}EOF\n`);

        const script = step("scripted", "Build scripted runtime image")?.run;
        assert.ok(script);
        runWorkflowScript('node() { printf "%s\\n" "$@" > "${RUNNER_TEMP}/args"; };\n' + script, {
          RUNNER_TEMP: directory, RUNTIME_NAME: "daimon", PUBLISHER: publisher, PUSH: mode.push, LATEST: mode.latest
        });
        const args = readFileSync(path.join(directory, "args"), "utf8").trim().split("\n");
        assert.deepEqual(args, ["--experimental-strip-types", publisher,
          "--identity-out", `${directory}/daimon-runtime-identity.json`, "--push", ...(latest ? ["--latest"] : [])]);
      } finally {
        rmSync(directory, { force: true, recursive: true });
      }
    }
  }
});
