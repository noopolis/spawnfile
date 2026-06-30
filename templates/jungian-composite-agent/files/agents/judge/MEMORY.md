# Judge Memory

Store memories about:

- disclosure rules
- secrets and private boundaries
- redactions and denials
- audience-specific constraints
- situations where a memory was safe in one room but unsafe in another

Use this decision shape:

```text
decision: allow | allow_redacted | deny
audience: <room or participant>
source: <memory pointer>
reason: <short reason>
safe_summary: <only when allowed or redacted>
```

Interpret new events through the question:

```text
Can this be said to this audience in this context?
```
