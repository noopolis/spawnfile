import { types as nodeTypes } from "node:util";

import { SpawnfileError } from "../shared/index.js";
import type { ResolvedExternalParticipant } from "./organizationIdentity.js";
import type { EmittedFile } from "../runtime/index.js";
import type { MoltnetExternalParticipantIntent } from "./types.js";
import { createMoltnetExternalParticipantArtifactPath } from "./moltnetArtifactPaths.js";

export const MOLTNET_EXTERNAL_PARTICIPANT_ARTIFACT_VERSION = "spawnfile.moltnet-external-participant.v1" as const;
export interface MoltnetExternalParticipantArtifactV1 {
  readonly version: typeof MOLTNET_EXTERNAL_PARTICIPANT_ARTIFACT_VERSION;
  readonly participant: { readonly authored_key: string; readonly kind: "service"; readonly member_id: string; readonly principal_id: string };
  readonly network: { readonly id: string };
  readonly auth: { readonly mode: "bearer"; readonly token_id: string; readonly token_env: string };
  readonly direct_messages: readonly { readonly members: readonly [string, string] }[];
}
export interface BuildMoltnetExternalParticipantArtifactInput {
  readonly participant: ResolvedExternalParticipant;
  readonly networkId: string;
  readonly tokenId: string;
  readonly tokenEnv: string;
  readonly directMessagePeers: readonly string[];
}
const idPattern = /^[a-z][a-z0-9-]{0,62}(?:\.[a-z][a-z0-9-]{0,62}){0,7}$/u;
const segmentPattern = /^[a-z][a-z0-9-]{0,62}$/u;
const envPattern = /^[A-Z_][A-Z0-9_]{0,127}$/u;
const MAX_HOSTILE_DEPTH = 16;
const MAX_HOSTILE_NODES = 512;
const isCanonicalMemberId = (value: string): boolean => idPattern.test(value) && Buffer.byteLength(value, "ascii") <= 255;
const fail = (message: string): never => { throw new SpawnfileError("validation_error", `invalid Moltnet external participant artifact: ${message}`); };
const isCanonicalArray = (value: unknown): value is unknown[] => Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype;
const requireCanonicalArray = (value: unknown, label: string): unknown[] => {
  if (value && typeof value === "object" && nodeTypes.isProxy(value)) fail(`${label} proxy`);
  if (!isCanonicalArray(value)) return fail(`${label} array prototype`);
  const array = value as unknown[];
  if (array.length > 128) fail(`${label} cardinality exceeds 128`);
  return array;
};
const keys = (value: object, expected: string[]): void => {
  if (Object.getPrototypeOf(value) !== Object.prototype) fail("object prototype");
  if (Object.getOwnPropertySymbols(value).length > 0) fail("symbol property");
  const actual = Object.getOwnPropertyNames(value).filter((key) => key !== "length");
  if (actual.length !== expected.length || Object.keys(value).length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(`keys must be ${expected.join(",")}`);
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) fail("accessor or non-enumerable property");
  }
};
const stringValue = (value: unknown, label: string, pattern = idPattern): string => {
  if (typeof value !== "string" || !pattern.test(value) || value.length > 255) fail(`${label} value`);
  return value as string;
};
const freezeCopy = <T>(value: T, seen = new WeakSet<object>()): T => {
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) fail("alias or cycle");
  seen.add(value);
  for (const child of Object.values(value as Record<string, unknown>)) freezeCopy(child, seen);
  return Object.freeze(value) as T;
};
const rejectAliases = (
  value: unknown,
  state = { nodes: 0, seen: new WeakSet<object>() },
  depth = 0
): void => {
  if (!value || typeof value !== "object") return;
  if (nodeTypes.isProxy(value)) fail("proxy");
  if (depth > MAX_HOSTILE_DEPTH) fail("object depth exceeds 16");
  state.nodes += 1;
  if (state.nodes > MAX_HOSTILE_NODES) fail("object node count exceeds 512");
  if (state.seen.has(value)) fail("alias or cycle");
  state.seen.add(value);
  if (Array.isArray(value)) {
    requireCanonicalArray(value, "array");
    if (Object.getOwnPropertySymbols(value).length > 0 || Object.getOwnPropertyNames(value).some((key) => key !== "length" && !/^\d+$/u.test(key))) fail("extended array");
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) fail("sparse array");
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) fail("accessor or non-enumerable property");
      rejectAliases(value[index], state, depth + 1);
    }
  } else {
    const ownNames = Object.getOwnPropertyNames(value);
    if (ownNames.length > MAX_HOSTILE_NODES) fail("object property count exceeds 512");
    for (const key of ownNames) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor) {
        fail("missing property descriptor");
        return;
      }
      if (!("value" in descriptor)) {
        fail("accessor property");
        return;
      }
      const child = descriptor.value;
      rejectAliases(child, state, depth + 1);
    }
  }
};

export const buildMoltnetExternalParticipantArtifact = (input: BuildMoltnetExternalParticipantArtifactInput): MoltnetExternalParticipantArtifactV1 => {
  const { participant, networkId, tokenId, tokenEnv, directMessagePeers } = input;
  if (participant.kind !== "service" || !segmentPattern.test(participant.authoredParticipantKey) || participant.principalId !== `system:${participant.memberId}`) fail("participant identity");
  rejectAliases(directMessagePeers);
  const peers = [...directMessagePeers];
  if (peers.length === 0 || peers.length > 128 || new Set(peers).size !== peers.length) fail("direct-message peer cardinality");
  if (peers.some((peer) => !isCanonicalMemberId(peer) || peer === participant.memberId)) fail("direct-message peer identity");
  const members = peers.sort().map((peer) => [peer, participant.memberId].sort() as [string, string]);
  const artifact = {
    version: MOLTNET_EXTERNAL_PARTICIPANT_ARTIFACT_VERSION,
    participant: { authored_key: participant.authoredParticipantKey, kind: "service" as const, member_id: participant.memberId, principal_id: participant.principalId },
    network: { id: stringValue(networkId, "network id", segmentPattern) },
    auth: { mode: "bearer" as const, token_id: stringValue(tokenId, "token id"), token_env: stringValue(tokenEnv, "token env", envPattern) },
    direct_messages: members.map((members) => ({ members }))
  };
  return parseMoltnetExternalParticipantArtifact(artifact);
};

export const parseMoltnetExternalParticipantArtifact = (raw: unknown): MoltnetExternalParticipantArtifactV1 => {
  rejectAliases(raw);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("root object");
  const value = raw as Record<string, unknown>;
  keys(value, ["version", "participant", "network", "auth", "direct_messages"]);
  if (value.version !== MOLTNET_EXTERNAL_PARTICIPANT_ARTIFACT_VERSION) fail("version");
  const participant = value.participant as Record<string, unknown>;
  const network = value.network as Record<string, unknown>;
  const auth = value.auth as Record<string, unknown>;
  if (!participant || typeof participant !== "object" || Array.isArray(participant)) fail("participant object");
  if (!network || typeof network !== "object" || Array.isArray(network)) fail("network object");
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) fail("auth object");
  keys(participant, ["authored_key", "kind", "member_id", "principal_id"]); keys(network, ["id"]); keys(auth, ["mode", "token_id", "token_env"]);
  const member = stringValue(participant.member_id, "member id");
  const authoredKey = stringValue(participant.authored_key, "authored key", segmentPattern);
  if (participant.kind !== "service" || participant.principal_id !== `system:${member}` || authoredKey !== member) fail("participant");
  if (auth.mode !== "bearer") fail("auth mode");
  const messages: unknown = value.direct_messages;
  const directMessages = requireCanonicalArray(messages, "direct messages");
  if (directMessages.length === 0 || directMessages.length > 128 || directMessages.some((entry: unknown) => !entry || typeof entry !== "object" || Array.isArray(entry))) fail("direct message cardinality");
  const parsed = directMessages.map((entry: unknown) => {
    const item = entry as Record<string, unknown>; keys(item, ["members"]);
    const members = requireCanonicalArray(item.members, "members");
    if (members.length !== 2 || members.some((member) => typeof member !== "string")) fail("members");
    const pair = members as string[];
    if (!pair.every((entry) => isCanonicalMemberId(entry)) || pair[0] >= pair[1] || !pair.includes(member) || pair[0] === pair[1]) fail("member ordering");
    return { members: [pair[0], pair[1]] as [string, string] };
  });
  const peerFor = (pair: readonly [string, string]): string => pair[0] === member ? pair[1] : pair[0];
  if (parsed.some((entry, index) => index > 0 && peerFor(entry.members) <= peerFor(parsed[index - 1].members))) fail("message ordering");
  const result = { version: value.version as typeof MOLTNET_EXTERNAL_PARTICIPANT_ARTIFACT_VERSION, participant: { authored_key: participant.authored_key as string, kind: "service" as const, member_id: member, principal_id: participant.principal_id as string }, network: { id: stringValue(network.id, "network id", segmentPattern) }, auth: { mode: "bearer" as const, token_id: stringValue(auth.token_id, "token id", segmentPattern), token_env: stringValue(auth.token_env, "token env", envPattern) }, direct_messages: parsed };
  return freezeCopy(structuredClone(result));
};

export const renderMoltnetExternalParticipantArtifact = (artifact: MoltnetExternalParticipantArtifactV1): string => `${JSON.stringify(parseMoltnetExternalParticipantArtifact(artifact), null, 2)}\n`;

export const createMoltnetExternalParticipantArtifactFiles = (intents: readonly MoltnetExternalParticipantIntent[]): { artifacts: MoltnetExternalParticipantArtifactV1[]; files: EmittedFile[] } => {
  const ordered = [...intents].sort((left, right) => byArtifactKey(left, right));
  const keys = new Set<string>();
  for (const intent of ordered) {
    const key = `${intent.networkId}\u0000${intent.participant.memberId}`;
    if (keys.has(key)) fail("duplicate external participant artifact");
    keys.add(key);
  }
  const artifacts = ordered.map((intent) => buildMoltnetExternalParticipantArtifact(intent));
  return {
    artifacts,
    files: artifacts.map((artifact) => ({
      content: renderMoltnetExternalParticipantArtifact(artifact),
      mode: 0o600,
      path: createMoltnetExternalParticipantArtifactPath(artifact.network.id, artifact.participant.member_id)
    }))
  };
};

const byArtifactKey = (left: MoltnetExternalParticipantIntent, right: MoltnetExternalParticipantIntent): number => {
  const a = `${left.networkId}\u0000${left.participant.memberId}`;
  const b = `${right.networkId}\u0000${right.participant.memberId}`;
  return a < b ? -1 : a > b ? 1 : 0;
};
