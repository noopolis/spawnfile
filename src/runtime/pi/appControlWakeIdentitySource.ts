export const renderPiControlWakeIdentitySource = (): string => String.raw`const CONTROL_TOKEN_ENV = "SPAWNFILE_PI_CONTROL_TOKEN";
const DELIVERY_METADATA_INVALID_ERROR = "invalid delivery metadata";
// The authenticated principal stamped on control.wake.accepted/denied
// events for this endpoint (operator:control, specs/CAUSAL.md §3). Root
// has exactly one operator-control bearer token today, so one static
// operator identity is enough; a future multi-operator token scheme would
// resolve this from the verified token instead.
const CONTROL_OPERATOR_NAME = "control";

const controlWakeRequestId = (targetAgentId) =>
  "wake-" + targetAgentId + "-" + Date.now() + "-" + Math.random().toString(16).slice(2);

// control.wake.accepted should chain to the real inbound moltnet event only
// for message-triggered wakes (the WakeEvent id moltnet's bridge stamped,
// see formatControlEventId above); schedule/dream-kind wakes legitimately
// have no moltnet cause and stay [].
const causeEventIdsForWake = (wakeKind, eventId) =>
  wakeKind === "message" && typeof eventId === "string" && eventId.length > 0 ? [eventId] : [];
`;
