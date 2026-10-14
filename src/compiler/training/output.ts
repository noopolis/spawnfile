import { createHash } from "node:crypto";
import path from "node:path";
import { within } from "./preparation/files.js";

/** Durable default namespace disjoint from every declared input, even a project ancestor. */
export const defaultTrainingOutputRoot = (projectRoot: string, inputs: readonly string[] = []): string => {
  const sources = [projectRoot, ...inputs].map(source => path.resolve(source));
  if (sources.includes(path.parse(projectRoot).root)) throw Error("No training output location exists outside declared inputs; supply --out");
  const identity = createHash("sha256").update(projectRoot).digest("hex").slice(0, 16);
  let ancestor = path.dirname(projectRoot);
  for (;;) {
    const candidate = path.join(ancestor, ".spawn-training", `${path.basename(projectRoot)}-${identity}`);
    if (!sources.some(source => within(source, candidate) || within(candidate, source))) return candidate;
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw Error("No training output location exists outside declared inputs; supply --out");
    ancestor = parent;
  }
};
