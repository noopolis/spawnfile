import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";

import { parse as parseYaml } from "yaml";

const section = (source: string, start: string, end?: string): string => {
  const from = source.indexOf(start);
  assert.ok(from >= 0, `missing ${start}`);
  const to = end ? source.indexOf(end, from + start.length) : -1;
  return source.slice(from, to < 0 ? undefined : to);
};

test("runtime-images publishes Daimon through the pinned publisher with the Docker Hub secrets", async () => {
  const workflow = await readFile(".github/workflows/runtime-images.yml", "utf8");
  const daimon = section(workflow, "\n  daimon:\n");
  assert.match(daimon, /docker\/setup-buildx-action@v3/u);
  assert.match(daimon, /platforms: amd64,arm64/u);
  assert.match(daimon, /node --experimental-strip-types scripts\/publish-daimon-runtime\.ts/u);
  assert.match(daimon, /secrets\.DOCKERHUB_USERNAME/u);
  assert.match(daimon, /secrets\.DOCKERHUB_TOKEN/u);
  // Pushing stays gated exactly like the matrix images: tags or an explicit dispatch.
  assert.match(daimon, /refs\/tags\/v\*/u);
  assert.match(daimon, /inputs\.push/u);
  assert.match(daimon, /if: steps\.publish\.outputs\.push == 'true'\n\s+uses: docker\/login-action@v3/u);
  assert.match(daimon, /args\+=\(--push\)/u);
  // A publish run without an identity is a failure, not a quiet success.
  assert.match(daimon, /Publishing finished without a Daimon runtime identity/u);
  const matrix = section(workflow, "matrix:", "\n  daimon:\n");
  assert.doesNotMatch(matrix, /runtime: daimon/u);
  for (const trigger of ["scripts/publish-daimon-runtime.ts", "scripts/daimon-publish-inputs.ts", "src/runtime/daimon/contract-manifest.sha256"]) {
    assert.equal(workflow.split(`- "${trigger}"`).length - 1, 2, `${trigger} must trigger both PR and main runs`);
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

type Step = { id?: string; name?: string; run?: string };
type Workflow = {
  on: { workflow_dispatch: { inputs: { runtime: { type: string; default: string; options: string[] } } } };
  jobs: Record<string, { if?: string; steps: Step[] }>;
};

test("runtime dispatch defaults to all and daimon skips every other image job", () => {
  const workflow = parseYaml(readFileSync(".github/workflows/runtime-images.yml", "utf8")) as Workflow;
  const input = workflow.on.workflow_dispatch.inputs.runtime;
  assert.equal(input.type, "choice");
  assert.equal(input.default, "all");
  assert.deepEqual(input.options, ["all", "daimon"]);
  const jobsFor = (event: string, selection = input.default): string[] => Object.entries(workflow.jobs)
    .filter(([, job]) => job.if === undefined || runInNewContext(job.if, {
      github: { event_name: event }, inputs: { runtime: selection }
    }))
    .map(([name]) => name);
  const allJobs = ["build", "daimon", "training-native"];
  assert.deepEqual(jobsFor("workflow_dispatch"), allJobs);
  assert.deepEqual(jobsFor("workflow_dispatch", "all"), allJobs);
  assert.deepEqual(jobsFor("workflow_dispatch", "daimon"), ["daimon"]);
  for (const event of ["pull_request", "push"]) {
    // Non-dispatch events have no runtime input, even on version tags.
    assert.deepEqual(jobsFor(event, ""), allJobs);
  }
});

/** Executes a job's real "Resolve publishing mode" script under a simulated event. */
const resolveMode = (job: string, event: { name: string; ref: string; push?: boolean; latest?: boolean }): Record<string, string> => {
  const workflow = parseYaml(readFileSync(".github/workflows/runtime-images.yml", "utf8")) as Workflow;
  const script = workflow.jobs[job]?.steps.find((step) => step.id === "publish")?.run;
  assert.ok(script, `${job} has no publish-mode step`);
  const rendered = script
    .replaceAll("${{ inputs.push }}", String(event.push ?? ""))
    .replaceAll("${{ inputs.push_latest }}", String(event.latest ?? ""))
    .replaceAll("${{ matrix.image }}", "example/image")
    .replaceAll("${{ matrix.version }}", "1.0.0");
  const directory = mkdtempSync(path.join(os.tmpdir(), "runtime-images-mode-"));
  try {
    const output = path.join(directory, "output");
    execFileSync("bash", ["-c", rendered], { env: { ...process.env, GITHUB_EVENT_NAME: event.name, GITHUB_OUTPUT: output, GITHUB_REF: event.ref } });
    const raw = readFileSync(output, "utf8");
    const values = Object.fromEntries(raw.split("\n").filter((line) => /^(push|latest)=/u.test(line)).map((line) => line.split("=") as [string, string]));
    const tags = raw.match(/tags<<EOF\n([\s\S]*?)\nEOF/u)?.[1];
    return tags === undefined ? values : { ...values, tags };
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
};

test("runtime images publish only on version-tag pushes or an explicit dispatch", () => {
  for (const job of ["build", "daimon", "training-native"]) {
    assert.equal(resolveMode(job, { name: "push", ref: "refs/tags/v1.2.3" }).push, "true", job);
    assert.equal(resolveMode(job, { name: "push", ref: "refs/heads/main" }).push, "false", job);
    assert.equal(resolveMode(job, { name: "pull_request", ref: "refs/pull/1/merge" }).push, "false", job);
    assert.equal(resolveMode(job, { name: "workflow_dispatch", ref: "refs/heads/main", push: true }).push, "true", job);
    // A dispatch dry run on a version tag must stay a dry run.
    assert.equal(resolveMode(job, { name: "workflow_dispatch", ref: "refs/tags/v1.2.3", push: false, latest: false }).push, "false", job);
  }
  assert.equal(resolveMode("daimon", { name: "workflow_dispatch", ref: "refs/tags/v1.2.3", push: false, latest: false }).latest, "false");
});

test("dispatch push_latest=false omits latest, including when dispatching a version tag", () => {
  for (const ref of ["refs/heads/chore/publish-daimon-0.2.8", "refs/tags/v1.2.3"]) {
    for (const latest of [false, true]) {
      const event = { name: "workflow_dispatch", ref, push: true, latest };
      const matrix = resolveMode("build", event);
      assert.equal(matrix.push, "true");
      assert.equal(matrix.tags, latest ? "example/image:1.0.0\nexample/image:latest" : "example/image:1.0.0");

      const mode = resolveMode("daimon", event);
      assert.equal(mode.push, "true");
      assert.equal(mode.latest, String(latest));
      const workflow = parseYaml(readFileSync(".github/workflows/runtime-images.yml", "utf8")) as Workflow;
      const script = workflow.jobs.daimon?.steps.find((step) => step.name === "Build Daimon runtime image")?.run;
      assert.ok(script);
      const directory = mkdtempSync(path.join(os.tmpdir(), "daimon-publish-args-"));
      try {
        // Intercept only the publisher invocation; run the workflow's real argument assembly.
        execFileSync("bash", ["-c", 'node() { printf "%s\\n" "$@" > "${RUNNER_TEMP}/args"; };\n' + script], {
          env: { ...process.env, RUNNER_TEMP: directory, PUSH: mode.push, LATEST: mode.latest }
        });
        const args = readFileSync(path.join(directory, "args"), "utf8").trim().split("\n");
        assert.deepEqual(args, ["--experimental-strip-types", "scripts/publish-daimon-runtime.ts",
          "--identity-out", `${directory}/daimon-runtime-identity.json`, "--push", ...(latest ? ["--latest"] : [])]);
      } finally {
        rmSync(directory, { force: true, recursive: true });
      }
    }
  }
});


test("training-native uses pinned renderer, serialized publication, digest artifact and path triggers", async () => {
  const workflow = await readFile(".github/workflows/runtime-images.yml", "utf8");
  const job = section(workflow, "\n  training-native:\n");
  for (const required of ["runtime-images-training-native-publish", "platforms: amd64,arm64",
    "npm ci --ignore-scripts", "node --import tsx scripts/publish-training-native.ts",
    "test -s", "actions/upload-artifact@v4", "if-no-files-found: error"]) assert.ok(job.includes(required), required);
  assert.doesNotMatch(job, /args\+=\(--latest\)/u);
  for (const trigger of ["scripts/publish-training-native.ts", "scripts/training-native-image.ts",
    "src/runtime/daimonInstall.ts", "moltnet-releases.json"]) {
    assert.equal(workflow.split(`- "${trigger}"`).length - 1, 2);
  }
});
