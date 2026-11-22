/** A canonical directory representable in both Docker volume argument formats. */
export const isContainerMountTarget = (value: unknown): value is string =>
  typeof value === "string" && value.startsWith("/")
  && !/[,:\s"\\\u0000-\u001f\u007f]/u.test(value)
  && value.slice(1).split("/").every((part) => part !== "" && part !== "." && part !== "..");
