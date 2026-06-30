# Memory Backend Research Notes

Research snapshot for external memory systems cloned under `runtimes/`.

Purpose:

- keep Spawnfile memory compatible with real local/open systems
- avoid designing a memory contract that cannot map to common backends
- separate external backend research from the normative spec

This file is not normative. `../SPEC.md` defines the portable authoring
contract.

---

## Local Clones

| Backend | Local path | Remote | Snapshot |
|---------|------------|--------|----------|
| Mem0 | `runtimes/mem0` | `https://github.com/mem0ai/mem0.git` | `main` |
| Graphiti | `runtimes/graphiti` | `https://github.com/getzep/graphiti.git` | `main` |
| LangMem | `runtimes/langmem` | `https://github.com/langchain-ai/langmem.git` | `main` |

The parent repository ignores `runtimes/`, so these clones are local research
dependencies and are not committed as vendored source.

---

## Compatibility Conclusion

Spawnfile should own the portable memory contract:

```text
memory banks
  -> principal/scope policy
  -> memory.search / locate / register / summarize / forget
  -> audit and activity metadata
```

External systems should be backend adapters behind that contract, not the
contract itself. The Spawnfile memory model must preserve:

- explicit principals derived from runtime context
- scope aliases such as current room, current pair, current team, task, and
  artifact
- append-only provenance and tombstone/redaction semantics
- raw/private/summary/locate-only policy outcomes
- optional lexical, vector, graph, and rerank retrieval paths

That shape is compatible with the three systems below.

The safest runtime pattern is:

```text
agent runtime
  -> Spawnfile memory skill/instructions
  -> Spawnfile memory tools
  -> Spawnfile memory policy wrapper
  -> native or external backend
```

Do not expose an external backend's native tool surface directly to an agent by
default. Native backend tools usually know nothing about Spawnfile teams, rooms,
pairs, sealed memories, or locate-only disclosures. They should sit behind a
Spawnfile wrapper that translates and filters.

Current Daimon state:

- The memory kernel already has `search`, `locate`, `register`, `summarize`, and
  `forget` methods.
- The Pi harness currently prepares a memory packet before the turn and records
  memory activity after the turn.
- First-class model-callable memory tools still need to be wired into the Daimon
  engine surface.
- OpenClaw/PicoClaw should receive those same tools through generated private
  MCP once compiler lowering exists.

---

## Mem0

Observed surfaces:

- Python package and TypeScript package.
- Self-hosted server under `runtimes/mem0/server`.
- Server endpoints include memory add, search, get, update, history, delete,
  reset, entities, auth, and API keys.
- Client supports add/search plus filters for users, agents, sessions, created
  time ranges, and expired memories.
- README describes self-hosting through Docker Compose and cloud usage.

Working dynamics:

```text
POST /memories
  messages: [{ role, content }]
  user_id / agent_id / run_id
  metadata
  infer: true | false
  expiration_date

POST /search
  query
  filters
  top_k
  threshold
  explain
  show_expired

GET /memories/{id}/history
PUT /memories/{id}
DELETE /memories/{id}
```

Mem0 can run as:

- a local Python library
- a self-hosted FastAPI server
- a cloud platform

Good fit:

- User/session/agent dimensions map to Spawnfile principal and scope metadata.
- Add/search/history/delete map to `register`, `search`, audit/history, and
  `forget`.
- Its hybrid retrieval direction aligns with our lexical/vector/entity plan.

Adapter constraints:

- Spawnfile policy must wrap Mem0. Do not rely on Mem0 identifiers alone for
  privacy isolation.
- We need a mapping layer from Spawnfile scopes to Mem0 filters/metadata.
- Forgetting must be checked against Mem0 delete/history behavior so tombstone
  audit remains available in Spawnfile even if Mem0 deletes content.

Likely mapping:

```text
memory.register(raw event)
  -> /memories with infer=false and Spawnfile metadata

memory.register(candidate conversation)
  -> /memories with infer=true only after policy/write mode allows extraction

memory.search
  -> /search with filters derived from allowed scopes
  -> post-filter every result through Spawnfile policy

memory.locate
  -> /search with content suppressed
  -> return handles keyed by Spawnfile scope/principal metadata

memory.forget
  -> append Spawnfile tombstone
  -> optionally DELETE /memories/{id}
  -> keep Spawnfile audit even if Mem0 deletes backend content
```

---

## Graphiti

Observed surfaces:

- Open-source temporal context graph engine.
- Docker Compose and MCP server are present under `runtimes/graphiti`.
- MCP server exposes episode add/delete/get, node search, fact search, saga
  summaries, episode provenance, and status tools.
- Supports temporal facts, provenance episodes, semantic/keyword/graph retrieval,
  entity/fact validity windows, and graph backends such as FalkorDB or Neo4j.

Working dynamics:

```text
add_memory
  episode body: text | messages | json
  group_id
  reference_time
  previous_episode_uuids
  custom extraction instructions
  saga linkage

search_nodes
  query
  group_ids
  entity_types
  center_node_uuid

search_memory_facts
  query
  group_ids
  edge_types
  center_node_uuid
  valid_at / invalid_at

get_episode_entities
get_episodes
delete_episode
summarize_saga
get_status
```

Graphiti can run as:

- a Python library (`graphiti-core`)
- an MCP server with HTTP or stdio transport
- a local Docker stack with FalkorDB or Neo4j

Good fit:

- Graphiti episodes map naturally to Spawnfile raw events.
- Facts/edges map to semantic and relationship projections.
- Validity windows map to `valid_from`, `valid_to`, and historical query
  behavior.
- Its MCP server validates our choice to expose memory through generated MCP for
  non-Daimon runtimes.

Adapter constraints:

- Graphiti is a graph projection/backend, not the whole Spawnfile memory policy
  system.
- Spawnfile still needs its own access filter before any graph query result is
  returned to an agent.
- Group ids or graph namespaces should be derived from memory bank id plus
  trusted scope, not from model-supplied text.

Likely mapping:

```text
memory.register(raw event)
  -> add_memory episode with group_id derived from memory bank/scope
  -> reference_time from observed_at

memory.search(semantic/relationship/temporal)
  -> search_memory_facts and/or search_nodes
  -> post-filter and redact through Spawnfile policy

memory.locate
  -> search_nodes/search_memory_facts
  -> return opaque candidate handles, not raw facts, unless policy allows

memory.summarize
  -> summarize_saga for scoped episode streams or native summary projection

memory.forget
  -> append Spawnfile tombstone
  -> delete_episode/delete edge only when backend deletion is desired
```

---

## LangMem

Observed surfaces:

- Python library, not a standalone server.
- Provides `create_manage_memory_tool` and `create_search_memory_tool`.
- Uses LangGraph `BaseStore` namespaces.
- Supports hot-path memory tools and background memory managers for extraction,
  consolidation, enrichment, and prompt refinement.

Working dynamics:

```text
create_manage_memory_tool(namespace, actions_permitted)
  action: create | update | delete
  content
  id

create_search_memory_tool(namespace)
  query
  limit
  offset
  filter

create_memory_store_manager(...)
  background extraction/consolidation/enrichment
```

LangMem can run as:

- a Python library in a LangGraph app
- a set of generated tools over a LangGraph `BaseStore`
- a background manager process if we host one

Good fit:

- Its tool-first design matches Daimon in-process tools and generated MCP tools.
- Namespaces map well to Spawnfile scopes.
- Background memory manager patterns inform our consolidation jobs.

Adapter constraints:

- LangMem does not replace Spawnfile storage/policy unless we run it inside a
  generated service.
- Namespace templates must be compiled from trusted context; the model must not
  provide arbitrary namespace values.
- Its delete/update semantics must be wrapped so Spawnfile audit and tombstones
  remain stable.

Likely mapping:

```text
memory.register
  -> manage_memory(create/update) inside a trusted namespace

memory.search
  -> search_memory inside allowed namespaces

memory.forget
  -> manage_memory(delete) plus Spawnfile tombstone

consolidation
  -> optional LangMem background manager
```

LangMem is closest to our "tools plus instructions" runtime shape, but it is
Python/LangGraph-native. It is better used as a reference or generated sidecar
than as a direct dependency of the TypeScript Daimon core.

---

## Design Guardrails

To stay compatible with these systems:

- Keep `memory.register` as an event/episode write, not only a key-value upsert.
- Keep `memory.search` filterable by type, entity, tag, artifact, time, and
  supersession.
- Keep `memory.locate` separate from `memory.search`; many backends can find
  relevant namespaces/entities without safely disclosing content.
- Keep external backend ids out of portable agent prompts unless policy allows
  them.
- Treat vector and graph indexes as optional projections.
- Keep the native SQLite/FTS path as the baseline so memory works locally without
  cloud or graph infrastructure.
