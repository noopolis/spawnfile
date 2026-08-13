const MAX_ARGUMENTS = 64;
const MAX_ARGUMENT_BYTES = 4_096;

const bounded = (value: unknown): value is string =>
  typeof value === "string"
  && value.length > 0
  && Buffer.byteLength(value, "utf8") <= MAX_ARGUMENT_BYTES;

/** Routes only when the first actual target subcommand is lookup_operation. */
export const isTargetLookupInvocation = (raw: readonly unknown[]): boolean => {
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > MAX_ARGUMENTS
    || raw.some((value) => !bounded(value)) || raw[0] !== "target") return false;
  const argv = raw as readonly string[];
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "--config") {
      if (!bounded(argv[index + 1])) return false;
      index += 1;
      continue;
    }
    if (token.startsWith("--config=")) {
      if (token.length === "--config=".length) return false;
      continue;
    }
    if (token.startsWith("-")) return false;
    return token === "lookup_operation";
  }
  return false;
};
