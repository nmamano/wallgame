import json
from pathlib import Path


def load_expected_batch(path: Path, games: int) -> list[dict]:
    records = [json.loads(line) for line in path.read_text().splitlines()]
    if len(records) != games:
        raise RuntimeError(f"expected batch has {len(records)} records, not {games}")
    indexes = [record.get("gameIndex") for record in records]
    if indexes != list(range(1, games + 1)):
        raise RuntimeError("expected batch indexes are not exactly 1..games")
    return records


def verify_materialized_prefix(output_dir: Path, expected: list[dict]) -> int:
    csv_indices = {
        int(path.stem.split("_")[1]) for path in output_dir.glob("game_*.csv")
    }
    audits = {
        int(path.name.split("_")[1].split(".")[0]): path
        for path in output_dir.glob("game_*.audit.json")
    }
    audit_indices = set(audits)
    if csv_indices != audit_indices:
        raise RuntimeError("mixed self-play CSV/audit indexes differ; refusing partial resume")
    if len(csv_indices) > len(expected):
        raise RuntimeError("mixed self-play prefix is larger than the configured game count")
    prefix = set(range(1, len(csv_indices) + 1))
    if csv_indices != prefix:
        raise RuntimeError("mixed self-play indexes are not a contiguous prefix")
    for index in sorted(prefix):
        audit = json.loads(audits[index].read_text())
        if audit.get("initialStateRecord") != expected[index - 1]:
            raise RuntimeError(
                f"game_{index} initialStateRecord does not match the deterministic batch"
            )
    return len(prefix)


def write_exact_suffix(path: Path, records: list[dict], start_index: int) -> None:
    contents = "".join(
        json.dumps(record, separators=(",", ":")) + "\n"
        for record in records[start_index - 1 :]
    )
    if path.exists() and path.read_text() != contents:
        raise RuntimeError(f"existing suffix batch differs: {path}")
    if not path.exists():
        path.write_text(contents)
