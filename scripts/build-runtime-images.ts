#!/usr/bin/env node
import { execFileSync } from "node:child_process";

import { discoverRuntimeImages, repositoryRoot } from "./runtime-image-catalog.ts";

const catalog = discoverRuntimeImages(repositoryRoot, process.argv[2]);
const options = { cwd: repositoryRoot, stdio: "inherit" } as const;

for (const { context, image, version, build_args } of catalog.dockerfiles) {
  execFileSync("docker", [
    "build", "-f", `${context}/Dockerfile`, "-t", `${image}:${version}-local`,
    ...build_args.flatMap((arg) => ["--build-arg", arg]), context
  ], options);
}
for (const { local_builder } of catalog.scripted) {
  execFileSync(process.execPath, ["--experimental-strip-types", local_builder], options);
}
