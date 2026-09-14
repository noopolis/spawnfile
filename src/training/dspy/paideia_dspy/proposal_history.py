"""Bounded reflection context over durable callbacks; never validation evidence."""
import hashlib
import json
import re


def encoded(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=True, separators=(",", ":"))


def prompt_id(components):
    return hashlib.sha256(encoded(components).encode()).hexdigest()


def normalized(components):
    return {key: " ".join(text.split()) for key, text in components.items()}


def change_ratio(before, after):
    """Token-trigram Jaccard distance, a lexical guard rather than semantic quality."""
    def shingles(components):
        result = set()
        for key, text in components.items():
            tokens = re.findall(r"\w+|[^\w\s]", text)
            width = min(3, len(tokens))
            result.update((key, tuple(tokens[i:i + width]))
                          for i in range(len(tokens) - width + 1) if width)
        return result
    left, right = shingles(before), shingles(after)
    union = left | right
    return 1 - len(left & right) / len(union) if union else 0.0


def policy_for(session):
    return {"strategy": "refine", "min_change": 0.0, "max_attempts": 2,
            "history_entries": 20, "history_bytes": 65536,
            **(session.request.proposal.model_dump(exclude_none=True)
               if session.request.proposal else {})}


def readable(value):
    try:
        return json.loads(value)
    except (ValueError, TypeError):
        return value


def bounded_value(value, limit):
    """Keep small values exact; large values remain identifiable in durable state."""
    text = encoded(value)
    if len(text) <= limit:
        return value
    digest = hashlib.sha256(text.encode()).hexdigest()
    result = {"truncated": True, "originalBytes": len(text), "sha256": digest, "excerpt": ""}
    # JSON escaping can expand excerpt bytes. Binary search the actual wire size.
    lo, hi = 0, len(text)
    while lo < hi:
        middle = (lo + hi + 1) // 2
        result["excerpt"] = text[:middle]
        if len(encoded(result)) <= limit:
            lo = middle
        else:
            hi = middle - 1
    result["excerpt"] = text[:lo]
    return result


def feedback_summary(value):
    value = readable(value)
    if not isinstance(value, dict):
        return value
    # Current feedback supplies the task and authored criteria. Historical rows
    # retain measurements/reasons and subject usage rather than repeat rubrics.
    return {key: item for key, item in value.items() if key not in {"task", "criteria"}}


def measurements(feedback):
    """Numerical evidence stays ahead of optional prose/excerpts in the budget."""
    feedback = readable(feedback)
    if not isinstance(feedback, dict):
        return {}
    evaluation = feedback.get("evaluation", {})
    if not isinstance(evaluation, dict) or not isinstance(evaluation.get("stages", []), list):
        evaluation = {}
    checks = []
    def visit(check, stage):
        if not isinstance(check, dict):
            return
        checks.append({"stage": stage, **{key: check[key] for key in ["id", "status", "score"] if key in check}})
        for child in (check.get("children") or []) if isinstance(check.get("children", []), list) else []:
            visit(child, stage)
    for stage in evaluation.get("stages", []):
        if not isinstance(stage, dict) or not isinstance(stage.get("checks", []), list):
            continue
        for check in stage.get("checks", []):
            visit(check, stage.get("id"))
    return {"criteria": checks, "subjectUsage": feedback.get("subjectUsage")}


def compact_rows(rows, limit, maximum):
    selected = rows[-maximum:]
    def bases(items):
        return [{key: value for key, value in row.items() if key != "details"} for row in items]
    # Reserve enough space for each selected row's bounded detail. Under very
    # small authored budgets, omission is explicit and oldest-first.
    while selected and len(encoded({"entries": bases(selected), "omittedEntries": len(rows) - len(selected)})) + 256 * len(selected) > limit:
        selected = selected[1:]
    result = {"entries": bases(selected), "omittedEntries": len(rows) - len(selected)}
    if not selected:
        return result
    allowance = (limit - len(encoded(result))) // len(selected) - 16
    for target, source in zip(result["entries"], selected, strict=True):
        details = source.get("details", {})
        # Equal field shares prevent a large article from consuming prompt and
        # measurement history. Full originals remain in session callbacks.
        share = max(128, allowance // max(1, len(details)) - 32)
        compact = {key: bounded_value(value, share) for key, value in details.items()}
        if len(encoded(compact)) <= allowance:
            target.update(compact)
        else:
            target["details"] = bounded_value(details, allowance)
    return result


def current_feedback(reflective_dataset, limit=65536):
    rows = {}
    for examples in reflective_dataset.values():
        for example in examples:
            generated = example.get("Generated Outputs", {})
            row = {"caseId": example.get("Inputs", {}).get("case_id"),
                   "score": generated.get("score"),
                   "measurements": measurements(example.get("Feedback", generated.get("feedback", ""))), "details": {
                   "feedback": readable(example.get("Feedback", generated.get("feedback", ""))),
                   "output": readable(generated.get("output", ""))}}
            rows.setdefault(encoded(row), row)
    return compact_rows(list(rows.values()), limit, len(rows))


def history_view(session, policy):
    rows = []
    for sequence, item in enumerate(session.results, 1):
        if item["method"] != "evaluate" or item["params"]["split"] != "train":
            continue
        params, result = item["params"], item["result"]
        rows.append({"sequence": sequence, "kind": "trial", "promptId": prompt_id(params["components"]),
                     "caseId": params["caseId"], "score": result["score"],
                     "measurements": measurements(result["feedback"]), "details": {
                     "components": params["components"], "feedback": feedback_summary(result["feedback"]),
                     "outputReference": {"callbackSequence": sequence, "sha256": prompt_id(readable(result["output"]))}}})
    for proposal in session.proposal_records:
        rows.append({**{key: value for key, value in proposal.items()
                        if key not in {"components", "hypothesis", "expectedImpact", "usage"}},
                     "details": {key: proposal[key] for key in ["components", "hypothesis", "expectedImpact", "usage"]}})
    rows.sort(key=lambda row: row["sequence"])
    return compact_rows(rows, policy["history_bytes"], policy["history_entries"])


def classify_proposal(session, parent, components, minimum):
    normalized_candidate = normalized(components)
    seen = [session.request.components, *[row["components"] for row in session.proposal_records
                                         if "components" in row]]
    if any(normalized_candidate == normalized(prior) for prior in seen):
        return "duplicate", 0.0
    change = change_ratio(parent, components)
    return ("below-novelty" if change < minimum else "accepted"), change
