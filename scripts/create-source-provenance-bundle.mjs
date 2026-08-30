#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createSourceBundle } from "./source-provenance-bundle.mjs";

export const main = (argv = process.argv.slice(2)) => {
  const profile = argv[0] === "--dependencies" ? "dependencies" : argv[0] === "--go-dependencies" ? "go-dependencies" : argv[0] === "--build-source" ? "build-source" : "source", values = profile === "source" ? argv : argv.slice(1);
  if (values.length !== 2 || !values.every(path.isAbsolute)) throw new Error("usage: create-source-provenance-bundle [--build-source|--dependencies|--go-dependencies] <absolute-root> <absolute-output.tar>");
  const receipt = createSourceBundle(values[0], values[1], profile);
  process.stdout.write(`${JSON.stringify({ ...receipt, manifest: undefined, source_archive: values[1], version: "spawnfile.source-provenance-bundle-receipt.v1" })}\n`);
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
