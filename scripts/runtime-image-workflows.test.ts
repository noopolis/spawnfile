import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

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
  assert.match(action, /\$\{SPAWNFILE\} build --release "\$\{PROJECT\}" --tag "\$\{REFERENCE\}" --out "\$\{RUNNER_TEMP\}/u);
  assert.match(action, /docker\/login-action@v3[\s\S]*registry: \$\{\{ steps\.target\.outputs\.registry \}\}/u);
  assert.match(action, /docker push "\$\{REFERENCE\}"/u);
  assert.match(action, /imagetools inspect "\$\{REFERENCE\}" --format '\{\{json \.Manifest\}\}'/u);
  assert.match(action, /digest:\n\s+description: [^\n]+\n\s+value: \$\{\{ steps\.push\.outputs\.digest \}\}/u);
  // Credentials only ever flow through inputs into the login action.
  assert.doesNotMatch(action, /secrets\./u);
  assert.doesNotMatch(action, /echo[^\n]*inputs\.password/u);
});
