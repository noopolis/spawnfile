import { createHash } from "node:crypto";

import { CompilePlanNode } from "./types.js";

export const createShortHash = (value: string): string =>
  createHash("sha1").update(value).digest("hex").slice(0, 8);

export const slugify = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

export const stableStringify = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
};

export const assignStableNodeIds = (
  nodes: Array<Omit<CompilePlanNode, "id"> & { source: string }>
): CompilePlanNode[] => {
  const counts = new Map<string, number>();

  return nodes.map((node) => {
    const baseId = `${node.kind}:${node.value.name}`;
    const seen = counts.get(baseId) ?? 0;
    counts.set(baseId, seen + 1);

    const id = seen === 0 ? baseId : `${baseId}#${createShortHash(node.source)}`;
    const slug = seen === 0 ? slugify(node.value.name) : `${slugify(node.value.name)}-${createShortHash(node.source)}`;

    return {
      id,
      kind: node.kind,
      runtimeName: node.runtimeName,
      slug,
      value: node.value
    };
  });
};
