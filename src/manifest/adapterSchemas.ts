import { z } from "zod";

/** Same grammar the adapter plugin contract enforces for `adapter.name`. */
export const RUNTIME_ADAPTER_NAME_PATTERN = /^[a-z][a-z0-9-]*$/u;

/** Installed npm package with an optional subpath; segments cannot start with `.`. */
const PACKAGE_ADAPTER_SPECIFIER =
  /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/u;

export const isLocalAdapterSpecifier = (specifier: string): boolean =>
  specifier.startsWith("./") && !/[\\\0:]/u.test(specifier)
  && specifier.slice(2).split("/").every((part) => part !== "" && part !== "." && part !== "..");

export const isAdapterSpecifier = (specifier: string): boolean =>
  isLocalAdapterSpecifier(specifier) || PACKAGE_ADAPTER_SPECIFIER.test(specifier);

const adapterSpecifierSchema = z.string().refine(isAdapterSpecifier, {
  message: "adapter modules must be a ./relative path inside the project or an installed package name " +
    "(no absolute paths, .. segments, URLs or backslashes)"
});

/** Root-only `adapters` map: runtime id to module specifier. Read as data; never imported here. */
export const adaptersSchema = z.record(
  z.string().regex(RUNTIME_ADAPTER_NAME_PATTERN, "adapter runtime ids must be lowercase letters, digits and hyphens"),
  adapterSpecifierSchema
);

export type AdaptersBlock = z.infer<typeof adaptersSchema>;

export const sortedAdapterEntries = (adapters: AdaptersBlock): Array<[string, string]> =>
  Object.entries(adapters).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);

export const NESTED_ADAPTERS_MESSAGE =
  "adapters may only be declared in the root Spawnfile of a graph; move this declaration to the root manifest";
