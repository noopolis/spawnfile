# Fixed reader questions

`evals/delivery.paideia.yaml` shows mechanical code checks, fixed decision-model
questions and the existing LLM rubric in one record. `item.grader.yaml` contains
six human-authored questions. Each additional case selects its own frozen grader
file through record.checks and supplies its own record.context.grounding.

The YAML resolves with a host-declared `prose` judge route. A native integration
must collect the actual `article.json` artifact and supply the public task inputs;
this directory does not implement a native runtime or a delivery task environment.
The article JSON must contain a `body` string or array of paragraph strings.

Grounding, questions and expected answers are evaluator-only. Do not mount them
into the subject workspace; the prompt here is illustrative. TypeSafe is explicitly
API billed, with a declared cap and operator-managed authentication. No live calls
or model-quality acceptance are claimed by this example.

See [the fixed-question contract](../../docs/fixed-questions.md) for exact semantics,
private-hook requirements, offline grading and deterministic-check limitations.
