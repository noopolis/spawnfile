import { skipAdapterOptions } from "./adapterOptions.js";

export const targetLookupValueOptions: ReadonlySet<string> = new Set(["--config"]);

const MAX_ARGUMENTS = 64;
const MAX_ARGUMENT_BYTES = 4_096;

const bounded = (value: unknown): value is string =>
  typeof value === "string"
  && value.length > 0
  && Buffer.byteLength(value, "utf8") <= MAX_ARGUMENT_BYTES;

/** Locates a possible lookup subcommand without consuming adapter options. */
export const targetLookupOperandIndex = (
  argv: readonly string[],
  start: number,
  allowAdapters = true
): number => {
  let index = start;
  while (index < argv.length) {
    if (allowAdapters) index = skipAdapterOptions(argv, index);
    const token = argv[index];
    if (token === "--config") {
      if (!bounded(argv[index + 1])) return -1;
      index += 2;
    } else if (token?.startsWith("--config=") && token.length > "--config=".length) {
      index += 1;
    } else {
      return token && !token.startsWith("-") ? index : -1;
    }
  }
  return -1;
};

/** Routes only when the first actual target subcommand is lookup_operation. */
export const isTargetLookupInvocation = (raw: readonly unknown[]): boolean => {
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > MAX_ARGUMENTS
    || raw.some((value) => !bounded(value)) || raw[0] !== "target") return false;
  const argv = raw as readonly string[];
  return argv[targetLookupOperandIndex(argv, 1, false)] === "lookup_operation";
};
