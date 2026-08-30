import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const outputDirectory = path.resolve(sourceDirectory, "artifacts");
mkdirSync(outputDirectory, { recursive: true });
const sourceSha256 = `sha256:${createHash("sha256").update(readFileSync(path.join(sourceDirectory, "renameNoreplace.c"))).digest("hex")}`;
const builderImage = "gcc:14.2.0@sha256:b99b86a28812b1e6453a231a947dc43d76fe192788a12f344a9b568bf9f5d24c";
const compiler = "gcc:14.2.0";
for (const [nodeArchitecture, dockerArchitecture] of [["x64", "amd64"], ["arm64", "arm64"]]) {
  const nonce = randomUUID(); const image = `spawnfile-rename-noreplace:${nonce}`; const container = `spawnfile-rename-noreplace-${nonce}`;
  try {
    execFileSync("docker", ["build", "--platform", `linux/${dockerArchitecture}`, "--tag", image, sourceDirectory], { stdio: "inherit" });
    execFileSync("docker", ["create", "--name", container, image, "/rename-noreplace"], { stdio: "ignore" });
    const output = path.join(outputDirectory, `rename-noreplace-${nodeArchitecture}`);
    execFileSync("docker", ["cp", `${container}:/rename-noreplace`, output], { stdio: "inherit" }); chmodSync(output, 0o755);
    const binarySha256 = `sha256:${createHash("sha256").update(readFileSync(output)).digest("hex")}`;
    writeFileSync(`${output}.provenance.json`, `${JSON.stringify({ version: "spawnfile.rename-noreplace-build.v1", architecture: nodeArchitecture, binary_sha256: binarySha256, builder_image: builderImage, compiler, source_sha256: sourceSha256, target: `linux/${dockerArchitecture}` })}\n`);
  } finally {
    try { execFileSync("docker", ["rm", "--force", container], { stdio: "ignore" }); } catch {}
    try { execFileSync("docker", ["image", "rm", "--force", image], { stdio: "ignore" }); } catch {}
  }
}
