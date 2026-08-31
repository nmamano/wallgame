import json
from dataclasses import dataclass
from pathlib import Path


OBJECTIVE_VERSION = "terminal-turn-discount-v1"
MAX_ATTEMPT_FACTOR = 4


@dataclass(frozen=True)
class ReplacementRequest:
    source_game_index: int
    replacement_attempt: int
    game_index: int


@dataclass(frozen=True)
class MaterializedProgress:
    attempted: int
    initial_attempted: int
    admitted: int
    replacements: tuple[ReplacementRequest, ...]


def load_expected_batch(path: Path, games: int) -> list[dict]:
    records = [json.loads(line) for line in path.read_text().splitlines()]
    if len(records) != games:
        raise RuntimeError(f"expected batch has {len(records)} records, not {games}")
    indexes = [record.get("gameIndex") for record in records]
    if indexes != list(range(1, games + 1)):
        raise RuntimeError("expected batch indexes are not exactly 1..games")
    return records


def _cell(record: dict) -> tuple:
    return (
        record.get("variant"),
        record.get("startMode"),
        record.get("dimensionMode"),
        record.get("boardWidth"),
        record.get("boardHeight"),
    )


def verify_materialized_progress(output_dir: Path, expected: list[dict]) -> MaterializedProgress:
    target = len(expected)
    audit_paths = {
        int(path.name.split("_")[1].split(".")[0]): path
        for path in output_dir.glob("game_*.audit.json")
    }
    csv_indices = {int(path.stem.split("_")[1]) for path in output_dir.glob("game_*.csv")}
    artifact_indices = set(audit_paths) | csv_indices
    if not artifact_indices:
        return MaterializedProgress(0, 0, 0, ())
    attempted = max(artifact_indices)
    if artifact_indices != set(range(1, attempted + 1)):
        raise RuntimeError("mixed self-play artifacts are not a contiguous attempt prefix")
    if csv_indices - set(audit_paths):
        raise RuntimeError("mixed self-play CSV lacks its audit")
    if set(audit_paths) != set(range(1, attempted + 1)):
        raise RuntimeError("mixed self-play attempt lacks its audit")
    if attempted > target * MAX_ATTEMPT_FACTOR:
        raise RuntimeError("materialized self-play exceeded the attempt safety ceiling")

    records: dict[int, dict] = {}
    capped: dict[int, bool] = {}
    replacements_by_source: dict[int, list[tuple[int, int]]] = {}
    identities: set[str] = set()
    game_seeds: set[int] = set()
    admitted = 0
    for index in range(1, attempted + 1):
        audit = json.loads(audit_paths[index].read_text())
        if audit.get("objectiveVersion") != OBJECTIVE_VERSION:
            raise RuntimeError(f"game_{index} has the wrong objective version")
        record = audit.get("initialStateRecord")
        if not isinstance(record, dict):
            raise RuntimeError(f"game_{index} audit lacks initialStateRecord")
        if record.get("gameIndex") != index:
            raise RuntimeError(f"game_{index} initialStateRecord has the wrong identity")
        game_seed = record.get("gameSeed")
        if not isinstance(game_seed, int) or game_seed in game_seeds:
            raise RuntimeError(f"game_{index} game seed collides or is invalid")
        game_seeds.add(game_seed)
        records[index] = record

        is_cap = audit.get("endReason") == "move-limit"
        has_csv = index in csv_indices
        if is_cap and has_csv:
            raise RuntimeError(f"game_{index} capped attempt must not have a CSV")
        if not is_cap and not has_csv:
            raise RuntimeError(f"game_{index} non-cap attempt is missing its CSV")
        capped[index] = is_cap
        admitted += int(has_csv)

        if index <= target:
            if record != expected[index - 1]:
                raise RuntimeError(
                    f"game_{index} initialStateRecord does not match the deterministic batch"
                )
            continue

        source = record.get("replacementOfGameIndex")
        attempt = record.get("replacementAttempt")
        identity = record.get("replacementIdentity")
        if not isinstance(source, int) or not 1 <= source <= target:
            raise RuntimeError(f"game_{index} replacement source is invalid")
        if not isinstance(attempt, int) or attempt < 1:
            raise RuntimeError(f"game_{index} replacement attempt is invalid")
        expected_identity = f"{source}:{attempt}"
        if identity != expected_identity or identity in identities:
            raise RuntimeError(f"game_{index} replacement identity collides or is invalid")
        identities.add(identity)
        if _cell(record) != _cell(expected[source - 1]):
            raise RuntimeError(f"game_{index} replacement changed its source cell")
        replacements_by_source.setdefault(source, []).append((attempt, index))

    initial_attempted = min(attempted, target)
    if attempted > target and initial_attempted != target:
        raise RuntimeError("replacement attempts started before the initial batch completed")
    if initial_attempted < target:
        return MaterializedProgress(attempted, initial_attempted, admitted, ())

    pending: list[ReplacementRequest] = []
    for source in range(1, target + 1):
        chain = sorted(replacements_by_source.get(source, []))
        if [attempt for attempt, _ in chain] != list(range(1, len(chain) + 1)):
            raise RuntimeError(f"replacement attempts for game_{source} are not contiguous")
        chain_indices = [source, *(index for _, index in chain)]
        if any(not capped[index] for index in chain_indices[:-1]):
            raise RuntimeError(f"game_{source} has a replacement after an admitted attempt")
        latest = chain_indices[-1]
        if capped[latest]:
            pending.append(
                ReplacementRequest(source, len(chain) + 1, attempted + len(pending) + 1)
            )

    if admitted + len(pending) != target:
        raise RuntimeError("materialized replacement accounting does not reach the target")
    if pending and attempted + len(pending) > target * MAX_ATTEMPT_FACTOR:
        raise RuntimeError("materialized self-play would exceed the attempt safety ceiling")
    return MaterializedProgress(attempted, initial_attempted, admitted, tuple(pending))


def verify_materialized_prefix(output_dir: Path, expected: list[dict]) -> int:
    progress = verify_materialized_progress(output_dir, expected)
    if progress.replacements:
        raise RuntimeError("mixed self-play prefix contains capped attempts requiring replacement")
    return progress.initial_attempted


def write_exact_suffix(path: Path, records: list[dict], start_index: int) -> None:
    contents = "".join(
        json.dumps(record, separators=(",", ":")) + "\n"
        for record in records[start_index - 1 :]
    )
    if path.exists() and path.read_text() != contents:
        raise RuntimeError(f"existing suffix batch differs: {path}")
    if not path.exists():
        path.write_text(contents)


def write_replacement_requests(
    path: Path, expected: list[dict], requests: tuple[ReplacementRequest, ...]
) -> None:
    contents = "".join(
        json.dumps(
            {
                "sourceRecord": expected[request.source_game_index - 1],
                "replacementAttempt": request.replacement_attempt,
                "gameIndex": request.game_index,
            },
            separators=(",", ":"),
        )
        + "\n"
        for request in requests
    )
    if path.exists() and path.read_text() != contents:
        raise RuntimeError(f"existing replacement requests differ: {path}")
    if not path.exists():
        path.write_text(contents)
