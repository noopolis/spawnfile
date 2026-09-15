# Canonical agent training

`spawnfile train` resolves one agent from its full project and delegates to an installed
Paideia CLI. Spawnfile owns canonical source resolution and native compilation;
Paideia owns datasets, evaluation, cost planning, optimization and isolated trials.

The [container boundary](TRAINING_CONTAINERS.md) runs the complete experiment
inside one immutable image. The v2 training configuration prepares its pinned
image and inputs behind the same command; the v1 image/mount path remains
available. Dry-run remains a host-only estimate.

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
`pin` is the declared bundle SHA or Git `ref`; branch/tag-only Git and volumes use null.
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
