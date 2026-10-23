# Focused semantic judges

A named judge can use the opt-in `evidence-ids` protocol. Keep each rubric focused
on one criterion. Existing `citations` judgments remain the default and retain
exact-substring validation and the authored zero-or-one citation repair.

```yaml
training:
  models:
    local_fast:
      provider: ollama
      endpoint: http://127.0.0.1:11434
      model: ministral-3:8b
      think: false
      keep_alive_seconds: 300
      max_output_tokens: 256
      context_window: 8192
  judges:
    quantities:
      model: local_fast
      protocol: evidence-ids
      timeout_ms: 10000
checks:
  - id: quantities
    eval: llm-rubric
    input: artifact:article
    evidence: input:files
    judge: quantities
    rubric:
      prompt: Check only whether reported quantities preserve the source's units and time windows.
    minimum: 0.9
```

The model and ten-second budget above are illustrative, not a quality or latency
guarantee. Calibrate each model/criterion against labeled real examples before
using it for selection. A fast valid response can still be a wrong judgment.
Existing stage weights and hard floors remain authored independently of this
protocol; changing how evidence is referenced never lowers those floors.

## Evidence and output

Paideia presents `paideia.evidence-units.v1`, containing ordered `units` with an
`id`, `source`, JSON `pointer`, `chunk`, content `digest`, and `value`. Object keys
are sorted, array positions remain indexed, and strings split into at most 2048
Unicode code points per chunk. Concatenating ordered string chunks reconstructs
the original value exactly. Source paths are escaped JSON pointers. Empty strings,
arrays and objects, booleans, numbers and null remain represented.

IDs bind source, pointer, chunk and value; digests bind the exact JSON-encoded
value. The packet rejects more than 256 units, a conservative 128 KiB encoded-byte budget (including envelope allowance), excessive nesting or
non-JSON data before inference. It never silently truncates selected evidence.
Select narrower evidence rather than relying on omitted material.

A judgment returns only:

```json
{"score":0.92,"verdict":"pass","reasons":["The units and period agree."],"evidenceIds":["e-<supplied ID>"]}
```

There must be 1–3 reasons, each at most 240 characters, and 1–8 unique supplied
IDs. Unknown IDs, duplicate keys, extra fields, non-finite scores and malformed
output are errors without a score. An ID proves which unit was referenced; it
**does not prove truth, entailment or sound reasoning**. There is no citation
repair for this protocol, and `citation_repairs: 1` is rejected with it.

All supported native providers receive a JSON Schema. Completion is independently
validated; failed responses retain accounting and protected diagnostic receipts.
Valid exact-cache hits reuse the recorded judgment, not another measurement.
Protocol/system/evidence/model controls bind cache identity; the evaluator version
is 3 and the cache format is v3.

## Local inference controls

Ollama receives `think`, `keep_alive` and `options.num_predict` directly. Keeping a
model loaded avoids cold loading between calls; Paideia performs no model download,
background prewarm generation or unbudgeted inference. These YAML controls reject
subscription providers rather than being silently dropped.

`context_window` sets native `options.num_ctx`, `truncate:false`, and `shift:false`.
A non-generating `/api/version` check requires a tested server version of 0.34.0 or
later, inside the same inference deadline. Completed positive checks are reused;
concurrent first calls may each make their own bounded version request. An older
or unverifiable server is rejected. Context exhaustion must fail rather than
silently removing evidence. Ollama Cloud cannot honor these controls and is
rejected. Boolean thinking controls reject known GPT-OSS models, whose thinking
cannot be disabled; returned thinking despite `think:false` is also an error.

The route's `timeout_ms` is the overall inference deadline across authored
fallbacks, including capability discovery. It is not multiplied per fallback.
See the [native chat API](https://docs.ollama.com/api/chat),
[thinking support](https://docs.ollama.com/capabilities/thinking), and
[versioned native controls](https://github.com/ollama/ollama/blob/v0.34.0/api/types.go).
