import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const helpers = path.resolve("dist/deployment/native");
const docker = async (args) => await execFile("docker", args);

for (const architecture of ["x64", "arm64"]) test(`real Linux ${architecture} helper atomically activates and preserves EEXIST destinations`, async () => {
  const platform = architecture === "x64" ? "amd64" : "arm64"; const container = `spawnfile-helper-test-${architecture}-${process.pid}`;
  try {
    await docker(["create", "--name", container, "--platform", `linux/${platform}`, "alpine:3.22", "sleep", "300"]); await docker(["start", container]);
    await docker(["cp", path.join(helpers, `rename-noreplace-${architecture}`), `${container}:/rename-noreplace`]);
    await docker(["exec", container, "mkdir", "-p", "/work/source-success"]); await docker(["exec", container, "sh", "-c", "printf 'move\\n' > /work/source-success/data"]);
    assert.equal((await docker(["exec", container, "/rename-noreplace", "/work", "source-success", "destination-success"])).stdout, '{"ok":true}\n');
    assert.equal((await docker(["exec", container, "cat", "/work/destination-success/data"])).stdout, "move\n");
    for (const nonempty of [false, true]) {
      const suffix = nonempty ? "nonempty" : "empty"; await docker(["exec", container, "mkdir", `/work/source-${suffix}`, `/work/destination-${suffix}`]);
      if (nonempty) await docker(["exec", container, "sh", "-c", `printf 'keep\\n' > /work/destination-${suffix}/keep`]);
      const inode = (await docker(["exec", container, "stat", "-c", "%i", `/work/destination-${suffix}`])).stdout;
      await assert.rejects(docker(["exec", container, "/rename-noreplace", "/work", `source-${suffix}`, `destination-${suffix}`]), (error) => error.stdout === '{"ok":false,"error":"EEXIST","errno":17}\n');
      assert.equal((await docker(["exec", container, "stat", "-c", "%i", `/work/destination-${suffix}`])).stdout, inode);
      if (nonempty) assert.equal((await docker(["exec", container, "cat", `/work/destination-${suffix}/keep`])).stdout, "keep\n");
    }
  } finally { try { await docker(["rm", "--force", container]); } catch {} }
});
