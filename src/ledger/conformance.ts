import type { CausalEdge, CausalEvent } from "@noopolis/stele";
import { checkSeqContiguity, parseCausalJsonl, reconcileEvents, traceCausesBackward } from "@noopolis/stele";
import { checkCauseNamespaces } from "./causeNamespace.js";
import type { EmitterSpec, Exec } from "./emitters.js";
import { collectEmitterFixtures, EMITTER_RUN_ID, EMITTER_SPECS, realExec } from "./emitters.js";
import type { PrincipalEventCheck } from "./principal.js";
import { PRINCIPAL_DISCIPLINE_CHECKS } from "./principal.js";

export interface ConformanceFixtureSource {
  /** JSONL text for this source. In synthetic mode this is seeded fixture text, not a live emitter invocation. */
  jsonl: string;
  name: string;
}

export interface ConformancePayloadMinimum {
  requiredKeys: string[];
  type: string;
}

export interface ConformanceIssue {
  line?: number;
  message: string;
  source: string;
}

export interface ConformanceReport {
  eventCount: number;
  issues: ConformanceIssue[];
  ok: boolean;
}

/**
 * Shared payload minimum for every world.act variant (specs/CAUSAL.md, the
 * simfile runtime AGENTS.md). The wire never carries the literal type
 * `world.act` — simfile emits the family members `world.message`,
 * `world.dm`, and `wake.recommended` — but `world.act` is kept as its own
 * declared type key so a hypothetical direct `world.act` record is still
 * enforced, and so tests can assert the minimum by its family name.
 */
const WORLD_ACT_REQUIRED_KEYS = ["sim_time", "provenance", "actor", "target", "scope", "act_id", "action", "value"];

/**
 * Payload minimums for the event types named in specs/CAUSAL.md and the B57/
 * B92 family packets. `runSyntheticConformance` validates seeded fixture
 * text against these; `runRealConformance` (B92) validates the four real
 * sibling emitters' output against the same minimums.
 */
export const DEFAULT_PAYLOAD_MINIMUMS: ConformancePayloadMinimum[] = [
  { requiredKeys: ["message_id", "content_sha256"], type: "message.accepted" },
  {
    requiredKeys: ["turn_id", "input_message_ids", "input_content_sha256", "prompt_sha256"],
    type: "turn.input.submitted"
  },
  { requiredKeys: ["turn_id", "output_sha256"], type: "turn.output.completed" },
  { requiredKeys: ["memory_id", "content_sha256"], type: "memory.recalled" },
  { requiredKeys: WORLD_ACT_REQUIRED_KEYS, type: "world.act" },
  { requiredKeys: WORLD_ACT_REQUIRED_KEYS, type: "world.message" },
  { requiredKeys: WORLD_ACT_REQUIRED_KEYS, type: "world.dm" },
  { requiredKeys: WORLD_ACT_REQUIRED_KEYS, type: "wake.recommended" },
  // B62 enforcement-point denial payloads (specs/CAUSAL.md §"Enforcement
  // points"). Field names mirror each authority's real emitted shape:
  // moltnet's protocol.MessageDeniedPayload (target/reason/content_sha256),
  // mneme's kernel/support.ts denyWriteScope (requested_scope/reason), and
  // daimon's controlCausal.ts emitControlWakeDenied (reason/target_agent_id).
  { requiredKeys: ["target", "reason", "content_sha256"], type: "message.denied" },
  { requiredKeys: ["requested_scope", "reason"], type: "memory.write.denied" },
  { requiredKeys: ["reason", "target_agent_id"], type: "control.wake.denied" }
];

type EventCheck = PrincipalEventCheck;

const checkPayloadMinimums = (
  event: CausalEvent,
  sourceName: string,
  requiredKeysByType: Map<string, string[]>
): ConformanceIssue[] => {
  const requiredKeys = requiredKeysByType.get(event.type);
  if (!requiredKeys) {
    return [];
  }

  // `key in payload` (not truthiness) is what lets an explicit `null` value
  // (e.g. wake.recommended's `value: null`) pass: absent is a violation,
  // present-but-null is not.
  const missing = requiredKeys.filter(
    (key) => !(key in event.payload) || event.payload[key] === undefined
  );

  if (missing.length === 0) {
    return [];
  }

  return [
    {
      message: `event ${event.event_id} of type ${event.type} is missing required payload keys: ${missing.join(", ")}`,
      source: sourceName
    }
  ];
};

interface ValidateSourcesResult {
  events: CausalEvent[];
  issues: ConformanceIssue[];
}

/**
 * Shared validation core for both synthetic and real conformance: schema
 * parsing (via parseCausalJsonl), payload minimums, and combined per-
 * (run_id, system:stream) seq contiguity across every source (disjoint
 * streams are safe to combine — checkSeqContiguity groups by stream key).
 * An empty source list is always reported as a failure, never a silent
 * no-op.
 */
const validateConformanceSources = (
  sources: ConformanceFixtureSource[],
  payloadMinimums: ConformancePayloadMinimum[],
  extraChecks: EventCheck[] = []
): ValidateSourcesResult => {
  const issues: ConformanceIssue[] = [];

  if (sources.length === 0) {
    issues.push({ message: "no conformance fixture sources were provided", source: "<none>" });
  }

  const requiredKeysByType = new Map(payloadMinimums.map((minimum) => [minimum.type, minimum.requiredKeys]));
  const allEvents: CausalEvent[] = [];

  for (const source of sources) {
    const { errors, events } = parseCausalJsonl(source.jsonl);

    for (const error of errors) {
      issues.push({ line: error.line, message: error.message, source: source.name });
    }

    for (const event of events) {
      issues.push(...checkPayloadMinimums(event, source.name, requiredKeysByType));
      for (const check of extraChecks) {
        issues.push(...check(event, source.name));
      }
    }

    allEvents.push(...events);
  }

  const contiguity = checkSeqContiguity(allEvents);
  for (const gap of contiguity.gaps) {
    issues.push({
      message: `stream ${gap.runId}/${gap.system}:${gap.streamId} has a seq gap at ${gap.missing.map(({ from, to }) => from === to ? `${from}` : `${from}-${to}`).join(", ")} (max seq ${gap.maxSeq})`,
      source: "<seq>"
    });
  }

  return { events: allEvents, issues };
};

/**
 * Validates seeded/synthetic CausalEvent JSONL fixtures against the schema
 * (via parseCausalJsonl), per-stream seq contiguity, payload minimums, and
 * (B62) the principal grammar/consistency discipline in
 * `PRINCIPAL_DISCIPLINE_CHECKS`. An empty source list is always reported as
 * a failure — this harness never silently skips a missing source, even in
 * synthetic mode.
 */
export const runSyntheticConformance = (
  sources: ConformanceFixtureSource[],
  payloadMinimums: ConformancePayloadMinimum[] = DEFAULT_PAYLOAD_MINIMUMS
): ConformanceReport => {
  const { events, issues } = validateConformanceSources(sources, payloadMinimums, PRINCIPAL_DISCIPLINE_CHECKS);
  issues.push(...checkCauseNamespaces(events));
  return { eventCount: events.length, issues, ok: issues.length === 0 };
};

interface ChainRoles {
  issues: ConformanceIssue[];
  m1?: CausalEvent;
  m2?: CausalEvent;
  recalls: CausalEvent[];
  t1?: CausalEvent;
  t1out?: CausalEvent;
}

/**
 * Locates the B92 interaction-chain roles among a flat CausalEvent[] set,
 * scoped to EMITTER_RUN_ID (every real emitter is invoked with that shared
 * run_id — see emitters.ts): M1/M2 are moltnet message.accepted seq 1/2 on
 * the same stream, R[] is every mneme memory.recalled event in seq order,
 * T1/T1out are daimon's turn.input.submitted/turn.output.completed. A
 * missing role is reported as an issue rather than throwing.
 */
const identifyChainRoles = (events: CausalEvent[]): ChainRoles => {
  const issues: ConformanceIssue[] = [];
  const inRun = events.filter((event) => event.run_id === EMITTER_RUN_ID);

  const moltnetAccepted = inRun.filter((event) => event.emitter.system === "moltnet" && event.type === "message.accepted");
  const m1 = moltnetAccepted.find((event) => event.emitter.seq === 1);
  const m2 = moltnetAccepted.find(
    (event) => event.emitter.seq === 2 && (m1 === undefined || event.emitter.stream_id === m1.emitter.stream_id)
  );

  const recalls = inRun
    .filter((event) => event.emitter.system === "mneme" && event.type === "memory.recalled")
    .sort((left, right) => left.emitter.seq - right.emitter.seq);

  const daimonEvents = inRun.filter((event) => event.emitter.system === "daimon");
  const t1 = daimonEvents.find((event) => event.type === "turn.input.submitted");
  const t1out = daimonEvents.find((event) => event.type === "turn.output.completed");

  if (!m1) {
    issues.push({ message: "chain stitch: missing moltnet message.accepted seq 1 (M1)", source: "<chain>" });
  }
  if (!m2) {
    issues.push({ message: "chain stitch: missing moltnet message.accepted seq 2 (M2)", source: "<chain>" });
  }
  if (recalls.length === 0) {
    issues.push({ message: "chain stitch: missing mneme memory.recalled events (R)", source: "<chain>" });
  }
  if (!t1) {
    issues.push({ message: "chain stitch: missing daimon turn.input.submitted (T1)", source: "<chain>" });
  }
  if (!t1out) {
    issues.push({ message: "chain stitch: missing daimon turn.output.completed (T1out)", source: "<chain>" });
  }

  return { issues, m1, m2, recalls, t1, t1out };
};

const cloneEvent = (event: CausalEvent): CausalEvent => ({
  ...event,
  cause_event_ids: [...event.cause_event_ids],
  payload: { ...event.payload }
});

/**
 * Stitches the four independent, non-cross-referencing real fixtures into
 * one interaction chain (B92 §4). Pure: never mutates its input, never does
 * I/O. Rewrites ONLY linkage fields — R[i].cause_event_ids, T1.cause_event_ids,
 * T1.payload.input_message_ids, T1.payload.input_content_sha256, and
 * M2.cause_event_ids — every other field of every event is carried through
 * byte-identical. T1out.cause_event_ids is asserted to already equal [T1.id]
 * (daimon stamps that for real) rather than rewritten.
 *
 * Missing roles or a violated T1out->T1 assertion are reported as issues and
 * the input is returned unstitched rather than guessed at.
 */
export const stitchInteractionChain = (
  events: CausalEvent[]
): { issues: ConformanceIssue[]; stitched: CausalEvent[] } => {
  const roles = identifyChainRoles(events);
  if (roles.issues.length > 0) {
    return { issues: roles.issues, stitched: [...events] };
  }

  const m1 = roles.m1 as CausalEvent;
  const m2 = roles.m2 as CausalEvent;
  const t1 = roles.t1 as CausalEvent;
  const t1out = roles.t1out as CausalEvent;
  const recalls = roles.recalls;

  if (t1out.cause_event_ids.length !== 1 || t1out.cause_event_ids[0] !== t1.event_id) {
    return {
      issues: [
        {
          message:
            `chain stitch: expected daimon turn.output.completed to cause from turn.input.submitted ` +
            `${t1.event_id}, got [${t1out.cause_event_ids.join(", ")}]`,
          source: "<chain>"
        }
      ],
      stitched: [...events]
    };
  }

  const m1MessageId = m1.payload.message_id;
  const m1ContentSha256 = m1.payload.content_sha256;
  if (typeof m1MessageId !== "string" || typeof m1ContentSha256 !== "string") {
    return {
      issues: [
        { message: "chain stitch: moltnet M1 payload is missing string message_id/content_sha256", source: "<chain>" }
      ],
      stitched: [...events]
    };
  }

  const recallIds = new Set(recalls.map((recall) => recall.event_id));

  const stitchedRecallsById = new Map(
    recalls.map((recall) => {
      const clone = cloneEvent(recall);
      clone.cause_event_ids = [m1.event_id];
      return [recall.event_id, clone] as const;
    })
  );

  const stitchedT1 = cloneEvent(t1);
  stitchedT1.cause_event_ids = [m1.event_id, ...recalls.map((recall) => recall.event_id)];
  stitchedT1.payload.input_message_ids = [m1MessageId];
  stitchedT1.payload.input_content_sha256 = m1ContentSha256;

  const stitchedM2 = cloneEvent(m2);
  stitchedM2.cause_event_ids = [t1out.event_id];

  const stitched = events.map((event) => {
    if (event.event_id === t1.event_id) {
      return stitchedT1;
    }
    if (event.event_id === m2.event_id) {
      return stitchedM2;
    }
    if (recallIds.has(event.event_id)) {
      return stitchedRecallsById.get(event.event_id) as CausalEvent;
    }
    return event;
  });

  return { issues: [], stitched };
};

export interface ConformanceSourceCount {
  count: number;
  source: string;
}

export interface ChainSummary {
  edges: CausalEdge[];
  issues: ConformanceIssue[];
  stitchedEventCount: number;
}

export interface RealConformanceReport extends ConformanceReport {
  chain: ChainSummary;
  events: CausalEvent[];
  sourceCounts: ConformanceSourceCount[];
}

export interface RunRealConformanceOptions {
  exec?: Exec;
  specs?: EmitterSpec[];
}

/**
 * Collects the four real sibling emitters (emitters.ts), validates them
 * (schema + payload minimums + combined seq contiguity + (B62) the
 * principal grammar/consistency discipline in `PRINCIPAL_DISCIPLINE_CHECKS`
 * — the real path now enforces exactly what `runSyntheticConformance` does,
 * so a real emitter stamping a non-grammar principal is a reported issue,
 * not a silent pass), stitches them into one interaction chain, and
 * reconciles the result. This is B92's real-mode counterpart to
 * runSyntheticConformance: same validation core, live process spawning
 * instead of seeded fixture text.
 */
export const runRealConformance = async (
  options: RunRealConformanceOptions = {}
): Promise<RealConformanceReport> => {
  const { issues: collectIssues, sources } = await collectEmitterFixtures(
    options.specs ?? EMITTER_SPECS,
    options.exec ?? realExec
  );

  const sourceCounts: ConformanceSourceCount[] = sources.map((source) => ({
    count: parseCausalJsonl(source.jsonl).events.length,
    source: source.name
  }));

  const { events, issues: validateIssues } = validateConformanceSources(
    sources,
    DEFAULT_PAYLOAD_MINIMUMS,
    PRINCIPAL_DISCIPLINE_CHECKS
  );

  const { issues: stitchIssues, stitched } = stitchInteractionChain(events);
  const causeNamespaceIssues = checkCauseNamespaces(stitched);

  let edges: CausalEdge[] = [];
  if (stitchIssues.length === 0) {
    const roles = identifyChainRoles(stitched);
    if (roles.m2) {
      const reconciled = reconcileEvents(stitched);
      edges = traceCausesBackward(reconciled, roles.m2.event_id);
    }
  }

  const issues = [...collectIssues, ...validateIssues, ...stitchIssues, ...causeNamespaceIssues];

  return {
    chain: { edges, issues: stitchIssues, stitchedEventCount: stitched.length },
    eventCount: events.length,
    events,
    issues,
    ok: issues.length === 0,
    sourceCounts
  };
};
