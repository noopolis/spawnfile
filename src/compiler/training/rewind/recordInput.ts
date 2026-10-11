import type { MomentRecord } from "./contract.js";
import type { InputIdentity, RewindInput } from "./types.js";

const sections: Record<string, InputIdentity["section"]> = {
  resource: "resources", resources: "resources", git: "resources", bundle: "resources", bundles: "resources",
  feed: "resources", feeds: "resources", volume: "resources", volumes: "resources",
  memory: "memory", bank: "memory", banks: "memory", moltnet: "networks", network: "networks", networks: "networks"
};
const ownerPattern = "(?:agent|team|org|organization):[A-Za-z0-9_.:/-]+?";
const qualifiedPrefix = new RegExp(`(?:^|[^A-Za-z0-9_.-])(${Object.keys(sections).join("|")})`
  + `(?:[\\s/]+(${ownerPattern}))?[\\s/:]+$`, "iu");
const ownerPrefix = new RegExp(`(?:^|[^A-Za-z0-9_.-])(${ownerPattern})[\\s/]+$`, "u");
const ownerSuffix = new RegExp(`^\\s*(?:\\(\\s*|declaredBy\\s*[=:]\\s*|@\\s*)(${ownerPattern})(?=[\\s):,;]|$)`, "u");

/** Errors are free text in P3: honor explicit qualifications; otherwise conservatively match the whole ID. */
export const recordInputErrors = (record: MomentRecord, input: InputIdentity): string[] => {
  const escaped = input.id.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const namesInput = new RegExp(`(?<![A-Za-z0-9_.-])${escaped}(?![A-Za-z0-9_.-])`, "gu");
  return (record.errors ?? []).filter((error) => {
    let decoded = error;
    try { decoded = decodeURIComponent(error); } catch { /* A literal percent is valid free text. */ }
    return [...decoded.matchAll(namesInput)].some((match) => {
      const prefix = decoded.slice(0, match.index);
      const qualification = qualifiedPrefix.exec(prefix);
      if (qualification && sections[qualification[1]!.toLowerCase()] !== input.section) return false;
      const owner = qualification?.[2] ?? ownerPrefix.exec(prefix)?.[1]
        ?? ownerSuffix.exec(decoded.slice(match.index + match[0].length))?.[1];
      return !owner || owner === input.declaredBy;
    });
  });
};

/** Do not discard healthy pins just because another input made the whole record inexact. */
export const recordForInput = (record: MomentRecord | null, input: RewindInput): MomentRecord | null =>
  record && !recordInputErrors(record, input).length ? record : null;

export const hasRecordPin = (record: MomentRecord | null, input: RewindInput): boolean => {
  if (!record) return false;
  if (input.section === "memory") return record.memory.some((entry) => entry.id === input.id && entry.declaredBy === input.declaredBy);
  if (input.section === "networks") return record.moltnet.some((entry) => entry.network === input.id);
  const pins = input.declaration.kind !== "volume" ? record.resources : input.declaration.feed ? record.feeds : record.volumes;
  return pins.some((entry) => entry.id === input.id);
};
