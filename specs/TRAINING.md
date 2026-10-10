# Canonical agent training

`spawnfile train` resolves one agent from its full project and delegates to an installed
Paideia CLI. Spawnfile owns canonical source resolution, training authoring and native
compilation; Paideia owns evaluation, cost planning, optimization and isolated trials.

The [container boundary](TRAINING_CONTAINERS.md) runs the complete experiment
inside one immutable image. The v2 training configuration prepares its pinned
image and inputs behind the same command; the v1 image/mount path remains
available. Dry-run remains a host-only estimate.

`spawnfile.training-container.v3` adds a brokered Grok slot to that boundary:
the subject's model runs in the same container under a root-provisioned broker,
the evaluator recycles that slot between trials through a single-verb root
supervisor, and judges spend the one dedicated training Grok login through
bounded inference grants instead of holding it. Import that login with
`spawnfile auth import grok --profile paideia-training --from <directory>`; the
desktop `~/.grok` is refused, because a training run rotates the credential it
is given.

```sh
spawnfile train ./Spawnfile --agent agent:writer \
  --train evals/train.paideia.yaml --test evals/test.paideia.yaml \
  --editable agents/writer/AGENTS.md --cost-config local-costs.yaml --dry-run
```

Paideia supplies the cost-config format and training options. Dataset roles are explicit.

`--resume` forwards to Paideia for the same output directory. Paideia validates
unchanged canonical inputs, the isolated integration's execution identity and
cumulative budgets before restoring its optimizer and native evidence. Spawnfile
does not interpret checkpoints, repeat trials or deploy the optimized candidate.
`--agent` is an exact resolved node ID; omission is allowed only for one-agent projects.
`--paideia-command` selects an installed executable, default `paideia`; no shell,
automatic installation, model-provider fallback or production launch is involved.

## Authoring

Teams (including the root organization) MAY declare `shared.training`; agents and
inline agent members MAY declare `training`. No other training fields are accepted.
All training file paths MUST be relative, use forward slashes, and resolve from
the declaring manifest's directory.

```yaml
# Team Spawnfile
shared:
  training:
    record: { keep: 30d, volumes: [edition-state] }
    optimizer: { method: gepa, model: claude-opus-5-5, variants: 8, keep: 3, budget: { rounds: 10 } }
    graders: { writing: training/writing.grader.yaml }
    targets:
      - files: [SOUL.md]
        grader: writing
        datasets: { train: training/train.yaml, test: training/test.yaml }

# Direct agent member's Spawnfile
training:
  optimizer: { budget: { rounds: 30 } }
  targets:
    - files: [AGENTS.md]
      grader: writing
      datasets: { train: training/train.yaml, validation: training/validation.yaml, test: training/test.yaml }
```

- `record` MAY contain `keep` and `volumes`. `keep` MUST match `^[1-9][0-9]*[mhd]$`;
  volumes MUST be unique nonempty resource IDs. Recording is off without an effective
  `record`; `record: {}` enables the format's recording intent.
- Every optimizer field is OPTIONAL at declaration time. `method` and `model` MUST
  be nonempty strings; `variants`, `keep`, and `budget.rounds` MUST be positive integers.
  An agent plan with any target MUST have all five effective fields and `keep <= variants`;
  a validation error MUST name missing fields. An incomplete optimizer without targets
  is represented by `null` in the plan.
- Grader names MUST match `^[A-Za-z0-9_-]+$` and MUST NOT be `__proto__`.
  Each name maps to one relative file path.
- Each target MUST contain nonempty, unique `.md` file paths, a grader name, and
  `datasets` with required `train` and `test` paths and OPTIONAL `validation`.

`shared.training` applies ONLY to direct agent members, referenced or inline. It
MUST NOT cross a nested-team boundary or propagate to subagents. Effective training
merges that direct team's declaration (excluding targets) with the agent's declaration:
`record` and `optimizer` merge by field, including `optimizer.budget`; closer fields
win, and arrays replace wholesale. Graders merge by name with agent-local shadowing;
each path retains its declaring directory and node. Targets are never inherited.
The team retains its own declared targets and graders. Reaching one canonical agent
through incompatible effective training declarations MUST fail validation; equivalent
declarations are accepted. Grader source and declaring-node provenance participate in
that comparison.

Every target MUST be an existing regular `.md` file inside its declaring manifest's
directory, checked by realpath without symlink escape. A nested directory containing
another `Spawnfile` owns its entire tree, even if that node is not in the compiled graph;
an ancestor MUST NOT target its files. A target MUST equal a resolved document or skill
entry `sourcePath` of at least one compiled agent. Errors MUST name the file and declaring
node. Team targets list every consumer's exact node ID, sorted. Each agent's plan includes
its own targets and team targets for which it consumes at least one file; each included
target retains its complete file list and consumer lists. Agent targets use effective
graders; team targets use only their own team's graders, unaffected by agent shadowing.
Target, dataset, and grader filesystem checks occur ONLY during training-plan loading;
ordinary compilation validates training structure without requiring those files to exist.

Dataset and grader paths MUST name existing regular files whose lexical paths and realpaths
are inside the project root (the compiled root manifest's directory).
Dataset YAML MUST reject duplicate keys and unknown fields at every level.
Dataset files use one strict YAML shape for all three roles:

```yaml
examples:
  - id: ice-shooting
    at: 2026-10-09T10:20:31+02:00
    wake: { surface: moltnet, room: assignment, from: brass, text: "@writer report the event" }
    memory: [{ id: self, store: { kind: memory } }]
    resources: [{ id: edition-state, kind: volume, mount: ./edition-state, mode: mutable }]
    networks:
      - id: news
        provider: moltnet
        rooms: [{ id: assignment, members: [writer] }]
```

`examples` MUST be nonempty; IDs MUST be unique within the file and match
`^[A-Za-z0-9._-]+$`. `at` is a REQUIRED ISO-8601 instant with an offset or `Z`.
The strict v1 wake contains only `surface: moltnet` and string `room`, `from`, `text`.
Optional `resources`, `memory`, and `networks` are full declarations validated by the
existing workspace-resource, memory-bank, and team-network schemas, respectively.
Overrides MUST identify an existing effective item; they never add an item. Resource
IDs resolve against compiled `workspaceResources`; memory IDs resolve against the
compiler's accessible own and team banks; network IDs resolve against team networks
present in the agent's resolved surface attachments (including representative attachments).
Zero matches is unknown; more than one distinct item is ambiguous. The resolved plan
reports the matching item's declaring node ID. Team-target datasets MUST resolve for
EVERY consumer; one consumer's failure rejects the plan. Per-agent plans report the
selected consumer's resolved IDs. There is no dataset `files` field or environments file.

The grader file's format is specified by the grader phase; this phase only requires that the path names an existing regular file inside the project.

```sh
spawnfile train ./Spawnfile --agent agent:writer --plan
```

`--plan` prints `spawnfile.training-plan.v1` as JSON with two-space indentation and a
trailing newline, then exits 0. `--train` is not required with `--plan`; `--dry-run`
does not change plan behavior. Selection requires the exact compiled agent ID unless
the project has exactly one agent. Planning reads local sources and builds the resolved
graph; it MUST NOT create a training context, invoke Paideia, emit compiled artifacts,
build images, use Docker/auth, or execute training. Existing delegated training still
requires `--train`; the authoring surface does not change that execution path.

The plan's file entries carry absolute `sourcePath` and project-relative POSIX `path`.
`record.volumes` MUST uniquely resolve to effective unfed volume resources; git/bundle
resources and fed volumes MUST fail (feeds already have a landing log). The plan records
volume declaration IDs, grader file references, targets, and dataset example identities/overrides.
Graders include the selected agent's effective registry plus graders used by included
team targets, retaining provenance when names overlap. Keys and arrays are sorted; pure
resolution MUST be deterministic and perform no I/O or clock reads. The generated schema
appears between the `training-plan-schema` markers below.

## Moment record (format only)

`spawnfile.moment-record.v1` specifies one record per wake; recording and replay are
implemented in a later phase. Recording MUST be off unless an effective `record` exists,
with zero recording cost when off. `record.keep` is snapshot retention.

```json
{
  "version": "spawnfile.moment-record.v1",
  "agent": "agent:writer",
  "wake": { "at": "2026-10-09T08:20:31Z", "surface": "moltnet", "room": "assignment", "from": "brass", "messageId": "42" },
  "recordedAt": "2026-10-09T08:20:32Z",
  "resources": [{ "id": "archive", "kind": "git", "commit": "resolved-commit" }],
  "feeds": [{ "id": "news", "revision": "revision-id", "tree": "tree-id", "commit": "resolved-commit", "paths": ["published"], "landedAt": "2026-10-09T08:00:00Z" }],
  "memory": [{ "id": "self", "declaredBy": "agent:writer", "seq": 42, "generation": 3 }],
  "moltnet": [{ "network": "news", "cursor": "wake-cursor" }],
  "volumes": [{ "id": "edition-state", "snapshot": "incremental-snapshot-id" }]
}
```

`agent` is the exact node ID. `wake.at` MUST be the real wake time (not the dataset's
authored trial time); `recordedAt` is capture time. Both are instants with an offset or
`Z`; `messageId` is OPTIONAL. Resources identify the git/bundle resolved commit per
build/deploy. Feeds identify the fed-volume landing-log entry in effect at the wake.
Memory pins the Mneme ledger sequence and active curation generation for each declared
bank; Moltnet pins each network's per-wake message cursor. Volumes identify an incremental
snapshot for every effective `record.volumes` entry. Rewind MUST use records when present;
otherwise it is best effort and the trial MUST be labelled as such.

## Public handoff

The child invocation is `paideia train --spawnfile-context FILE` followed by the
explicit Paideia options. `FILE` is private evaluator-only JSON, removed after exit.
Dry-run requires neither `--out` nor an optimizer bridge; actual training requires `--out`.
The receiver must save any provenance needed later in its own protected experiment.
The strict `spawnfile.training-context.v1` schema appears below and is generated from
`src/compiler/training/contract.ts`; it is a wire contract, not an internal import API.

Sources cover the full graph's manifests, resolved documents and skill entry files.
Every pin has an absolute `sourcePath`, project-relative POSIX `destinationPath`, and
SHA-256 of the actual file bytes. `destinationPath` preserves source editing locations;
it is **not** a compiled runtime destination. Source files outside the project root
are unsupported in v1. Effective documents retain canonical role order and inheritance.

`project.sourceDigest` is SHA-256 of UTF-8 `JSON.stringify` over the `sources` array
projected to `{destinationPath,sha256}` in that key order, sorted by destinationPath
using code-point lexical order. All digests use the `sha256:` prefix. Absolute roots
do not affect this digest. The receiver must revalidate files and mappings before use.

Resources disclose declaration digests and pins, not mounted or verified archives.
The resource definition digest uses the compiler's recursively key-sorted JSON.
`pin` is the bundle SHA (declared, or hashed for an unpinned prebuilt tar), `bundle-key:<hex>`
for a Spawnfile-built `files` or `dependencies` bundle (the dev cache key for the target
architecture; nothing is built), `bundle-recipe:<hex>` for a `generated` bundle (that key with
tools identified by argv; no command runs), or the Git `ref`; branch/tag-only Git and volumes use null.
This receipt is not a complete packaged-resource closure. No environment values,
transport configuration, resource URLs or credentials are serialized.

`agent.engine` is an explicit runtime engine option or null. Model identity/auth method
use canonical model resolution; absent native model defaults remain null. Runtime-added
instructions, tool schemas, skills loaded at runtime, and native model defaults must be
established from actual compilation/runtime receipts, never invented from this context.

## Execution and outcomes

Dry-run resolves local sources and lets Paideia validate datasets and estimate costs.
It does not compile, use Docker/auth, call models, or start an optimizer. Its final JSON
receipt must have `schema: paideia.training-cost-plan.v1` and `modelCallsMade: 0`.
Unimplemented native preparation is reported as unsupported, not ready to execute.

Actual execution requires a supported preparation integration. Each candidate must
reach native files through Spawnfile compilation; no generic Pi fallback, second agent
declaration or replacement flattened prompt is authorized by this entrypoint. Packaging
exclusion, state isolation and single-agent preparation are not supplied by this handoff.

Repeated options: `--editable`, `--resource`, `--judge`, `--judge-citation-repairs`, `--validation-group`. Other
forwarded options: `--train`, `--test`, `--optimizer-model`, `--bridge-command`, `--out`,
`--max-trials`, `--max-proposals`, `--seed`, `--timeout-ms`, `--view`, `--cost-config`.
The canonical runtime/model/instruction selection cannot be replaced by generic CLI flags.

`--judge-citation-repairs NAME=0|1` is forwarded literally to Paideia. The receiver
requires a matching named judge, unique selections and an exact `0` or `1` before
starting models. Default `0` preserves one judge call per check; `1` reserves one
additional bounded citation repair. It never retries valid quality failures,
authentication/quota failures or malformed JSON. Dry-run records the route policy
and reserves both judge attempts without adding subject trials or optimizer proposals.

Exit 0 requires the mode's final receipt. Completed actual runs also require
`status: completed` and a nonempty `index` path; exit 1 preserves completed failed checks.
Receiver error exits are propagated; empty success is a runtime failure. A supervisor
retains the owned POSIX process-group identity after the native child exits. Cancellation
forwards SIGTERM and escalates after one second; completion also removes group stragglers.
The parent verifies group/output quiescence before returning 0 or cancellation 130/143;
unknown cleanup is a runtime error. No signal uses an identity after its supervisor is reaped.
This delegation requires POSIX process groups; escaped processes and remote effects are not observed.
The child deadline is Paideia's declared deadline plus five seconds for cleanup.

## JSON Schema

<!-- training-context-schema:start -->
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "version": {
      "type": "string",
      "const": "spawnfile.training-context.v1"
    },
    "producer": {
      "type": "object",
      "properties": {
        "package": {
          "type": "string",
          "const": "spawnfile"
        },
        "version": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": ["package", "version"],
      "additionalProperties": false
    },
    "project": {
      "type": "object",
      "properties": {
        "root": {
          "type": "string",
          "minLength": 1,
          "pattern": "^(?:\\/|[A-Za-z]:[\\\\/])"
        },
        "manifest": {
          "type": "string",
          "minLength": 1,
          "pattern": "^(?:\\/|[A-Za-z]:[\\\\/])"
        },
        "sourceDigest": {
          "type": "string",
          "pattern": "^sha256:[a-f0-9]{64}$"
        }
      },
      "required": ["root", "manifest", "sourceDigest"],
      "additionalProperties": false
    },
    "agent": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "minLength": 1
        },
        "name": {
          "type": "string",
          "minLength": 1
        },
        "source": {
          "type": "string",
          "minLength": 1,
          "pattern": "^(?:\\/|[A-Za-z]:[\\\\/])"
        },
        "runtime": {
          "type": "string",
          "minLength": 1
        },
        "engine": {
          "anyOf": [
            {
              "type": "string",
              "minLength": 1
            },
            {
              "type": "null"
            }
          ]
        },
        "model": {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "provider": {
                  "type": "string",
                  "minLength": 1
                },
                "name": {
                  "type": "string",
                  "minLength": 1
                },
                "authMethod": {
                  "type": "string",
                  "minLength": 1
                }
              },
              "required": ["provider", "name", "authMethod"],
              "additionalProperties": false
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": ["id", "name", "source", "runtime", "engine", "model"],
      "additionalProperties": false
    },
    "sources": {
      "minItems": 1,
      "maxItems": 10000,
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "sourcePath": {
            "type": "string",
            "minLength": 1,
            "pattern": "^(?:\\/|[A-Za-z]:[\\\\/])"
          },
          "destinationPath": {
            "type": "string",
            "minLength": 1,
            "pattern": "^(?!\\/)(?!.*(?:^|\\/)\\.\\.(?:\\/|$))[^\\\\]+$"
          },
          "sha256": {
            "type": "string",
            "pattern": "^sha256:[a-f0-9]{64}$"
          }
        },
        "required": ["sourcePath", "destinationPath", "sha256"],
        "additionalProperties": false
      }
    },
    "documents": {
      "maxItems": 128,
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "sourcePath": {
            "type": "string",
            "minLength": 1,
            "pattern": "^(?:\\/|[A-Za-z]:[\\\\/])"
          },
          "destinationPath": {
            "type": "string",
            "minLength": 1,
            "pattern": "^(?!\\/)(?!.*(?:^|\\/)\\.\\.(?:\\/|$))[^\\\\]+$"
          },
          "sha256": {
            "type": "string",
            "pattern": "^sha256:[a-f0-9]{64}$"
          },
          "role": {
            "type": "string",
            "minLength": 1
          }
        },
        "required": ["sourcePath", "destinationPath", "sha256", "role"],
        "additionalProperties": false
      }
    },
    "skills": {
      "maxItems": 1000,
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "sourcePath": {
            "type": "string",
            "minLength": 1,
            "pattern": "^(?:\\/|[A-Za-z]:[\\\\/])"
          },
          "destinationPath": {
            "type": "string",
            "minLength": 1,
            "pattern": "^(?!\\/)(?!.*(?:^|\\/)\\.\\.(?:\\/|$))[^\\\\]+$"
          },
          "sha256": {
            "type": "string",
            "pattern": "^sha256:[a-f0-9]{64}$"
          },
          "name": {
            "type": "string",
            "minLength": 1
          },
          "ref": {
            "type": "string",
            "minLength": 1
          },
          "requiresMcp": {
            "type": "array",
            "items": {
              "type": "string",
              "minLength": 1
            }
          }
        },
        "required": ["sourcePath", "destinationPath", "sha256", "name", "ref", "requiresMcp"],
        "additionalProperties": false
      }
    },
    "resources": {
      "maxItems": 1000,
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "minLength": 1
          },
          "kind": {
            "type": "string",
            "enum": [
              "bundle",
              "git",
              "volume"
            ]
          },
          "mount": {
            "type": "string",
            "minLength": 1
          },
          "mode": {
            "type": "string",
            "enum": [
              "mutable",
              "readonly"
            ]
          },
          "sharing": {
            "type": "string",
            "enum": [
              "per_agent",
              "team"
            ]
          },
          "definitionDigest": {
            "type": "string",
            "pattern": "^sha256:[a-f0-9]{64}$"
          },
          "pin": {
            "anyOf": [
              {
                "type": "string",
                "minLength": 1
              },
              {
                "type": "null"
              }
            ]
          }
        },
        "required": ["id", "kind", "mount", "mode", "sharing", "definitionDigest", "pin"],
        "additionalProperties": false
      }
    },
    "requirements": {
      "type": "object",
      "properties": {
        "nativeCompilation": {
          "type": "boolean",
          "const": true
        },
        "isolatedPreparation": {
          "type": "boolean",
          "const": true
        }
      },
      "required": ["nativeCompilation", "isolatedPreparation"],
      "additionalProperties": false
    }
  },
  "required": ["version", "producer", "project", "agent", "sources", "documents", "skills", "resources", "requirements"],
  "additionalProperties": false
}
```
<!-- training-context-schema:end -->

## Training plan JSON Schema

<!-- training-plan-schema:start -->
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "version": {
      "type": "string",
      "const": "spawnfile.training-plan.v1"
    },
    "producer": {
      "type": "object",
      "properties": {
        "package": {
          "type": "string",
          "const": "spawnfile"
        },
        "version": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "package",
        "version"
      ],
      "additionalProperties": false
    },
    "project": {
      "type": "object",
      "properties": {
        "root": {
          "type": "string",
          "minLength": 1,
          "pattern": "^(?:\\/|[A-Za-z]:[\\\\/])"
        },
        "manifest": {
          "type": "string",
          "minLength": 1,
          "pattern": "^(?:\\/|[A-Za-z]:[\\\\/])"
        }
      },
      "required": [
        "root",
        "manifest"
      ],
      "additionalProperties": false
    },
    "agent": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "minLength": 1
        },
        "name": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "id",
        "name"
      ],
      "additionalProperties": false
    },
    "record": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "keep": {
              "anyOf": [
                {
                  "type": "string",
                  "minLength": 1,
                  "pattern": "^[1-9][0-9]*[mhd]$"
                },
                {
                  "type": "null"
                }
              ]
            },
            "volumes": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "id": {
                    "type": "string",
                    "minLength": 1
                  },
                  "declaredBy": {
                    "type": "string",
                    "minLength": 1
                  }
                },
                "required": [
                  "id",
                  "declaredBy"
                ],
                "additionalProperties": false
              }
            }
          },
          "required": [
            "keep",
            "volumes"
          ],
          "additionalProperties": false
        },
        {
          "type": "null"
        }
      ]
    },
    "optimizer": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "method": {
              "type": "string",
              "minLength": 1
            },
            "model": {
              "type": "string",
              "minLength": 1
            },
            "variants": {
              "type": "integer",
              "minimum": 1,
              "maximum": 9007199254740991
            },
            "keep": {
              "type": "integer",
              "minimum": 1,
              "maximum": 9007199254740991
            },
            "budget": {
              "type": "object",
              "properties": {
                "rounds": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 9007199254740991
                }
              },
              "required": [
                "rounds"
              ],
              "additionalProperties": false
            }
          },
          "required": [
            "method",
            "model",
            "variants",
            "keep",
            "budget"
          ],
          "additionalProperties": false
        },
        {
          "type": "null"
        }
      ]
    },
    "graders": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "sourcePath": {
            "type": "string",
            "minLength": 1,
            "pattern": "^(?:\\/|[A-Za-z]:[\\\\/])"
          },
          "path": {
            "type": "string",
            "minLength": 1,
            "pattern": "^(?!\\/)[^\\\\]+$"
          },
          "name": {
            "type": "string",
            "minLength": 1,
            "pattern": "^[A-Za-z0-9_-]+$"
          },
          "declaredBy": {
            "type": "string",
            "minLength": 1
          }
        },
        "required": [
          "sourcePath",
          "path",
          "name",
          "declaredBy"
        ],
        "additionalProperties": false
      }
    },
    "targets": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "declaredBy": {
            "type": "string",
            "minLength": 1
          },
          "grader": {
            "type": "string",
            "minLength": 1,
            "pattern": "^[A-Za-z0-9_-]+$"
          },
          "files": {
            "minItems": 1,
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "sourcePath": {
                  "type": "string",
                  "minLength": 1,
                  "pattern": "^(?:\\/|[A-Za-z]:[\\\\/])"
                },
                "path": {
                  "type": "string",
                  "minLength": 1,
                  "pattern": "^(?!\\/)[^\\\\]+$"
                },
                "consumers": {
                  "minItems": 1,
                  "type": "array",
                  "items": {
                    "type": "string",
                    "minLength": 1
                  }
                }
              },
              "required": [
                "sourcePath",
                "path",
                "consumers"
              ],
              "additionalProperties": false
            }
          },
          "datasets": {
            "type": "object",
            "properties": {
              "train": {
                "type": "object",
                "properties": {
                  "sourcePath": {
                    "type": "string",
                    "minLength": 1,
                    "pattern": "^(?:\\/|[A-Za-z]:[\\\\/])"
                  },
                  "path": {
                    "type": "string",
                    "minLength": 1,
                    "pattern": "^(?!\\/)[^\\\\]+$"
                  },
                  "examples": {
                    "minItems": 1,
                    "type": "array",
                    "items": {
                      "type": "object",
                      "properties": {
                        "id": {
                          "type": "string",
                          "minLength": 1,
                          "pattern": "^[A-Za-z0-9._-]+$"
                        },
                        "at": {
                          "type": "string",
                          "format": "date-time",
                          "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"
                        },
                        "wake": {
                          "type": "object",
                          "properties": {
                            "surface": {
                              "type": "string",
                              "const": "moltnet"
                            },
                            "room": {
                              "type": "string"
                            },
                            "from": {
                              "type": "string"
                            },
                            "text": {
                              "type": "string"
                            }
                          },
                          "required": [
                            "surface",
                            "room",
                            "from",
                            "text"
                          ],
                          "additionalProperties": false
                        },
                        "overrides": {
                          "type": "array",
                          "items": {
                            "type": "object",
                            "properties": {
                              "id": {
                                "type": "string",
                                "minLength": 1
                              },
                              "declaredBy": {
                                "type": "string",
                                "minLength": 1
                              },
                              "section": {
                                "type": "string",
                                "enum": [
                                  "resources",
                                  "memory",
                                  "networks"
                                ]
                              }
                            },
                            "required": [
                              "id",
                              "declaredBy",
                              "section"
                            ],
                            "additionalProperties": false
                          }
                        }
                      },
                      "required": [
                        "id",
                        "at",
                        "wake",
                        "overrides"
                      ],
                      "additionalProperties": false
                    }
                  }
                },
                "required": [
                  "sourcePath",
                  "path",
                  "examples"
                ],
                "additionalProperties": false
              },
              "validation": {
                "anyOf": [
                  {
                    "type": "object",
                    "properties": {
                      "sourcePath": {
                        "type": "string",
                        "minLength": 1,
                        "pattern": "^(?:\\/|[A-Za-z]:[\\\\/])"
                      },
                      "path": {
                        "type": "string",
                        "minLength": 1,
                        "pattern": "^(?!\\/)[^\\\\]+$"
                      },
                      "examples": {
                        "minItems": 1,
                        "type": "array",
                        "items": {
                          "type": "object",
                          "properties": {
                            "id": {
                              "type": "string",
                              "minLength": 1,
                              "pattern": "^[A-Za-z0-9._-]+$"
                            },
                            "at": {
                              "type": "string",
                              "format": "date-time",
                              "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"
                            },
                            "wake": {
                              "type": "object",
                              "properties": {
                                "surface": {
                                  "type": "string",
                                  "const": "moltnet"
                                },
                                "room": {
                                  "type": "string"
                                },
                                "from": {
                                  "type": "string"
                                },
                                "text": {
                                  "type": "string"
                                }
                              },
                              "required": [
                                "surface",
                                "room",
                                "from",
                                "text"
                              ],
                              "additionalProperties": false
                            },
                            "overrides": {
                              "type": "array",
                              "items": {
                                "type": "object",
                                "properties": {
                                  "id": {
                                    "type": "string",
                                    "minLength": 1
                                  },
                                  "declaredBy": {
                                    "type": "string",
                                    "minLength": 1
                                  },
                                  "section": {
                                    "type": "string",
                                    "enum": [
                                      "resources",
                                      "memory",
                                      "networks"
                                    ]
                                  }
                                },
                                "required": [
                                  "id",
                                  "declaredBy",
                                  "section"
                                ],
                                "additionalProperties": false
                              }
                            }
                          },
                          "required": [
                            "id",
                            "at",
                            "wake",
                            "overrides"
                          ],
                          "additionalProperties": false
                        }
                      }
                    },
                    "required": [
                      "sourcePath",
                      "path",
                      "examples"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "test": {
                "type": "object",
                "properties": {
                  "sourcePath": {
                    "type": "string",
                    "minLength": 1,
                    "pattern": "^(?:\\/|[A-Za-z]:[\\\\/])"
                  },
                  "path": {
                    "type": "string",
                    "minLength": 1,
                    "pattern": "^(?!\\/)[^\\\\]+$"
                  },
                  "examples": {
                    "minItems": 1,
                    "type": "array",
                    "items": {
                      "type": "object",
                      "properties": {
                        "id": {
                          "type": "string",
                          "minLength": 1,
                          "pattern": "^[A-Za-z0-9._-]+$"
                        },
                        "at": {
                          "type": "string",
                          "format": "date-time",
                          "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"
                        },
                        "wake": {
                          "type": "object",
                          "properties": {
                            "surface": {
                              "type": "string",
                              "const": "moltnet"
                            },
                            "room": {
                              "type": "string"
                            },
                            "from": {
                              "type": "string"
                            },
                            "text": {
                              "type": "string"
                            }
                          },
                          "required": [
                            "surface",
                            "room",
                            "from",
                            "text"
                          ],
                          "additionalProperties": false
                        },
                        "overrides": {
                          "type": "array",
                          "items": {
                            "type": "object",
                            "properties": {
                              "id": {
                                "type": "string",
                                "minLength": 1
                              },
                              "declaredBy": {
                                "type": "string",
                                "minLength": 1
                              },
                              "section": {
                                "type": "string",
                                "enum": [
                                  "resources",
                                  "memory",
                                  "networks"
                                ]
                              }
                            },
                            "required": [
                              "id",
                              "declaredBy",
                              "section"
                            ],
                            "additionalProperties": false
                          }
                        }
                      },
                      "required": [
                        "id",
                        "at",
                        "wake",
                        "overrides"
                      ],
                      "additionalProperties": false
                    }
                  }
                },
                "required": [
                  "sourcePath",
                  "path",
                  "examples"
                ],
                "additionalProperties": false
              }
            },
            "required": [
              "train",
              "validation",
              "test"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "declaredBy",
          "grader",
          "files",
          "datasets"
        ],
        "additionalProperties": false
      }
    }
  },
  "required": [
    "version",
    "producer",
    "project",
    "agent",
    "record",
    "optimizer",
    "graders",
    "targets"
  ],
  "additionalProperties": false
}
```
<!-- training-plan-schema:end -->
