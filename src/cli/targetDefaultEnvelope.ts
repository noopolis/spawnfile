import { types as nodeTypes } from "node:util";

export const targetDefaultEnvelope = (raw: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || nodeTypes.isProxy(raw) || Object.getPrototypeOf(raw) !== Object.prototype) throw new Error("Target authority initialization failed");
  const keys = Reflect.ownKeys(raw); const allowed = [...required, ...optional];
  if (keys.length < required.length || keys.length > allowed.length || keys.some((key) => typeof key !== "string" || !allowed.includes(key)) || required.some((key) => !keys.includes(key))) throw new Error("Target authority initialization failed");
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  if (Object.values(descriptors).some((descriptor) => !descriptor.enumerable || !("value" in descriptor))) throw new Error("Target authority initialization failed");
  return Object.fromEntries((keys as string[]).map((key) => [key, descriptors[key]!.value]));
};
