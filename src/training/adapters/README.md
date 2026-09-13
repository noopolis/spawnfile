# Native adapter support

The public `SubjectAdapter` contract receives an isolated workspace, explicit
instructions/model, protected evaluator paths and an awaited observation sink.
The experiment owner stages candidate files, collects immutable artifacts and
decides whether a captured violation authorizes stopping.

| Adapter | Observable tools | Continuity | Native requirements |
| --- | --- | --- | --- |
| `createCodexAdapter` | Native exec JSONL, explicitly partial | Exact returned thread ID; cumulative usage converted into wake deltas | Codex 0.154.0 protocol and saved ChatGPT login |
| `createDaimonAdapter` | Host fixture-tool journal; built-in tools unobserved | One wake with many steps; no cross-wake CLI conversation claim | Optional public Daimon Pi/CLI integration with isolated instruction and causal-context support |

Both consume an explicit supported native model. An unavailable model fails;
neither changes to an API key or another model. Auth selection stays outside
subject-writable roots; credentials are never read into captures or copied.
Native resource loading is limited to explicit instructions and workspace files.
On-demand native skills are not implemented; copying a skill is not loading it.

Codex's permission profile disables network/web search, ignores user config and
rules, disables implicit project instruction discovery and denies selected auth
and evaluator roots. Supply **every evaluator-owned path** through `protectedPaths`.
These must be existing absolute paths; the adapters resolve symlinks before native
permission configuration. Neither writable subject root may overlap saved auth.
This is declared-path protection, not universal isolation from host filesystem reads.
The subject workspace must be separate from protected roots. Daimon consumes the
same controls through its public strict CLI integration.

Codex cancellation confirms only the owned process group. Remote effects and
escaped descendants remain unknown. Daimon returns its public stop acknowledgement;
Paideia cannot independently assert quiescence of that handle's remote work.
Neither cancellation mechanism rolls back a dispatched action. Coverage remains
partial even after a successful terminal frame, so missing tool events cannot
prove absence of a tool call.

Infrastructure failures end the attempt as `failed`; they are distinct from an
explicit caller cancellation. Retry using a fresh session. A model can still
repair an ordinary failed tool call within a healthy wake. Codex resumes only
completed wakes, retaining a measured native cumulative baseline. Unknown or
regressed counters remain unknown rather than assigning earlier costs to a later wake.
After a native leader has been reaped, Paideia sends no signals to its retained
numeric process-group ID. A remaining group then yields an incomplete stop because
its ownership cannot safely be re-established. Daimon wake and stop acknowledgement
deadlines remain bounded even when its public handle ignores cancellation.

Native Daimon receives a trusted per-instance `causalRunId`; it does not mutate
process environment. Explicit causal context with configured Mneme memory is
rejected until that runtime provides a corresponding public context seam.

Protocol tests use deterministic facades and local processes. Separate bounded
live probes have verified real tool effects, denied protected-file reads, native
thread continuation and saved-subscription inference; those generated transcripts
remain outside version control.
