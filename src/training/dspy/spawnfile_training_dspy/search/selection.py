"""Deterministic bounded selection from complete validation score vectors."""


def select(candidates: list[dict], pool: list[int], keep: int, mode: str) -> list[int]:
    """Prefer the Pareto front, then mean; stable candidate index breaks ties."""
    if keep < 1:
        raise ValueError("keep must be positive")
    if mode not in {"pareto", "top-k"}:
        raise ValueError("selection must be pareto or top-k")
    ranked = sorted(set(pool), key=lambda index: (-candidates[index]["validationScore"], index))
    if mode == "top-k" or not ranked:
        return ranked[:keep]
    case_ids = set(candidates[ranked[0]]["perCaseScores"])
    if not case_ids or any(set(candidates[index]["perCaseScores"]) != case_ids for index in ranked):
        raise ValueError("Pareto selection requires complete matching per-case scores")

    def dominates(other: int, index: int) -> bool:
        a, b = candidates[other]["perCaseScores"], candidates[index]["perCaseScores"]
        return all(a[case] >= b[case] for case in case_ids) and any(a[case] > b[case] for case in case_ids)

    front = [index for index in ranked
             if not any(dominates(other, index) for other in ranked if other != index)]
    remainder = [index for index in ranked if index not in front]
    return (front + remainder)[:keep]
