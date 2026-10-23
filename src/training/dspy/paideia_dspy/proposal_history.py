"""Bounded reflection context over durable callbacks; never validation evidence."""
import hashlib
import json
import re

from .protocol import BridgeError


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


def bounded_output(value, limit):
    """Reserve each declared artifact before chat in the proposer's second compaction."""
    if not isinstance(value, dict) or not isinstance(value.get("artifacts"), dict) or not value["artifacts"]:
        return bounded_value(value, limit)
    text = encoded(value)
    if len(text) <= limit:
        return value
    artifacts = value["artifacts"]
    result = {"truncated": True, "originalBytes": len(text),
              "sha256": hashlib.sha256(text.encode()).hexdigest(),
              "artifacts": {name: {"status": item.get("status")}
                            for name, item in artifacts.items() if isinstance(item, dict)}}
    share = (limit - len(encoded(result)) - 32) // len(artifacts) - 16
    if share < 160:
        raise BridgeError("feedback_budget", "Declared artifact identifiers exceed proposal output byte budget")
    for name, item in artifacts.items():
        if isinstance(item, dict) and "value" in item:
            result["artifacts"][name]["value"] = bounded_value(item["value"], share)
    remaining = limit - len(encoded(result)) - len(',"output":')
    if remaining >= 160:
        result["output"] = bounded_value(value.get("output"), remaining)
    return result


def atomic_feedback(feedback):
    """Read only public diagnostics, including the host's oversized envelope."""
    collected = []
    def visit(check):
        if not isinstance(check, dict):
            return
        atomic = check.get("atomic")
        # Feedback is arbitrary JSON at the bridge seam. Recognize the public
        # envelope without turning unrelated user fields into optimizer errors.
        if (isinstance(atomic, dict) and type(atomic.get("failed_check_count")) is int
                and atomic["failed_check_count"] >= 0
                and type(atomic.get("omitted_failed_checks")) is int
                and isinstance(atomic.get("failed_checks"), list)
                and all(isinstance(item, dict) and isinstance(item.get("template"), str)
                        and isinstance(item.get("unit"), str) and "probability" in item
                        and (item["probability"] is None or type(item["probability"]) in (int, float))
                        for item in atomic["failed_checks"])):
            collected.append(atomic)
        children = check.get("children", [])
        for child in children if isinstance(children, list) else []:
            visit(child)
    visit(feedback)
    evaluation = feedback.get("evaluation", {})
    if isinstance(evaluation, dict):
        stages = evaluation.get("stages", [])
        for stage in stages if isinstance(stages, list) else []:
            checks = stage.get("checks", []) if isinstance(stage, dict) else []
            for check in checks if isinstance(checks, list) else []:
                visit(check)
    live = feedback.get("live", [])
    for item in live if isinstance(live, list) else []:
        if isinstance(item, dict):
            visit(item.get("result"))
    if not collected:
        return None
    return {"failed_check_count": sum(item["failed_check_count"] for item in collected),
            "failed_checks": [check for item in collected for check in item["failed_checks"]]}


def bounded_atomic(value, limit):
    """Reserve structured failures before prose; count every omitted check."""
    result = {"failed_check_count": value["failed_check_count"],
              "omitted_failed_checks": value["failed_check_count"], "failed_checks": []}
    for check in value["failed_checks"][:40]:
        item = {"template": check["template"][:256], "unit": check["unit"][:1000],
                "probability": check["probability"]}
        result["failed_checks"].append(item)
        result["omitted_failed_checks"] -= 1
        if len(encoded(result)) <= limit:
            continue
        # Escaped Unicode can exceed the wire budget even below character caps.
        template, unit = item["template"], item["unit"]
        lo, hi = 0, max(len(template), len(unit))
        while lo < hi:
            middle = (lo + hi + 1) // 2
            item.update(template=template[:middle], unit=unit[:middle])
            if len(encoded(result)) <= limit:
                lo = middle
            else:
                hi = middle - 1
        item.update(template=template[:lo], unit=unit[:lo])
        if not lo:
            result["failed_checks"].pop()
            result["omitted_failed_checks"] += 1
        break
    return result


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
    atomic = atomic_feedback(feedback)
    return {"criteria": checks, "subjectUsage": feedback.get("subjectUsage"),
            **({"atomic": atomic} if atomic is not None else {})}


def compact_rows(rows, limit, maximum):
    selected = rows[-maximum:]
    def base(row):
        value = {key: item for key, item in row.items() if key != "details"}
        if "atomic" in value.get("measurements", {}):
            value["measurements"] = {key: item for key, item in value["measurements"].items() if key != "atomic"}
        return value
    def bases(items):
        return [base(row) for row in items]
    def reserve(items):
        return sum(256 + (256 if "atomic" in row.get("measurements", {}) else 0) for row in items)
    # Reserve enough space for each selected row's bounded detail. Under very
    # small authored budgets, omission is explicit and oldest-first.
    while selected and len(encoded({"entries": bases(selected), "omittedEntries": len(rows) - len(selected)})) + reserve(selected) > limit:
        selected = selected[1:]
    result = {"entries": bases(selected), "omittedEntries": len(rows) - len(selected)}
    if not selected:
        return result
    allowance = (limit - len(encoded(result))) // len(selected) - 16
    for target, source in zip(result["entries"], selected, strict=True):
        detail_allowance = allowance
        atomic = source.get("measurements", {}).get("atomic")
        if atomic is not None:
            summary = bounded_atomic(atomic, min(8192, allowance // 2))
            target["measurements"]["atomic"] = summary
            detail_allowance -= len(encoded(summary)) + len(',"atomic":')
        details = source.get("details", {})
        # Equal field shares prevent a large article from consuming prompt and
        # measurement history. Full originals remain in session callbacks.
        share = max(128, detail_allowance // max(1, len(details)) - 32)
        compact = {key: (bounded_output(value, share) if key == "output" else bounded_value(value, share))
                   for key, value in details.items()}
        if len(encoded(compact)) <= detail_allowance:
            target.update(compact)
        else:
            target["details"] = bounded_value(details, detail_allowance)
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
