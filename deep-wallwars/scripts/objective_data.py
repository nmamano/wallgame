"""Deterministic admission for terminal-turn-discount-v1 training data."""

from __future__ import annotations

import hashlib
import json
from collections import defaultdict
from pathlib import Path

OBJECTIVE_VERSION = "terminal-turn-discount-v1"
TRAINING_CAP = 20_000
GAMES_PER_GENERATION = 5_000


def generation_quotas(generations: list[int], cap: int = TRAINING_CAP) -> dict[int, int]:
    generations = sorted(generations)
    if not generations:
        return {}
    base = min(GAMES_PER_GENERATION, cap // len(generations))
    result = {generation: base for generation in generations}
    remaining = min(cap, len(generations) * GAMES_PER_GENERATION) - sum(result.values())
    for generation in reversed(generations):
        if remaining == 0:
            break
        result[generation] += 1
        remaining -= 1
    return result


def _cell(audit: dict) -> tuple:
    state = audit["initialStateRecord"]
    return (
        {"standard": 0, "classic": 1, "animal-cycle": 2}[state["variant"]],
        {"traditional": 0, "random": 1}[state["startMode"]],
        {"low": 0, "high": 1, "random": 2}[state["dimensionMode"]],
        int(state["boardWidth"]),
        int(state["boardHeight"]),
    )


def _largest_remainder(cell_counts: dict[tuple, int], quota: int) -> dict[tuple, int]:
    total = sum(cell_counts.values())
    if total != GAMES_PER_GENERATION:
        raise ValueError(f"native generation has {total} admitted games, expected 5000")
    floors = {cell: quota * count // total for cell, count in cell_counts.items()}
    remaining = quota - sum(floors.values())
    order = sorted(cell_counts, key=lambda cell: (-(quota * cell_counts[cell] % total), cell))
    for cell in order[:remaining]:
        floors[cell] += 1
    return floors


def _admitted_by_cell(directory: Path) -> dict[tuple, list[tuple[str, Path]]]:
    by_cell: dict[tuple, list[tuple[str, Path]]] = defaultdict(list)
    for audit_path in sorted(directory.glob("game_*.audit.json")):
        audit = json.loads(audit_path.read_text())
        if audit.get("objectiveVersion") != OBJECTIVE_VERSION:
            raise ValueError(f"objective mismatch: {audit_path}")
        if audit["endReason"] == "move-limit":
            continue
        csv_path = audit_path.with_name(audit_path.name.removesuffix(".audit.json") + ".csv")
        if not csv_path.is_file():
            raise ValueError(f"admitted audit lacks CSV: {audit_path}")
        csv_hash = hashlib.sha256(csv_path.read_bytes()).hexdigest()
        rank = hashlib.sha256(
            f"{OBJECTIVE_VERSION}|{directory.name}|{audit_path.name}|{csv_hash}".encode()
        ).hexdigest()
        by_cell[_cell(audit)].append((rank, csv_path))
    return by_cell


def select_generation(directory: Path, quota: int) -> list[Path]:
    by_cell = _admitted_by_cell(directory)
    cell_counts = {cell: len(files) for cell, files in by_cell.items()}
    quotas = _largest_remainder(cell_counts, quota)
    selected = []
    for cell in sorted(by_cell):
        files = sorted(by_cell[cell])
        if len(files) < quotas[cell]:
            raise ValueError(f"cell {cell} has {len(files)}, needs {quotas[cell]}")
        selected.extend(path for _, path in files[: quotas[cell]])
    if len(selected) != quota:
        raise AssertionError(f"selected {len(selected)}, expected {quota}")
    return selected


def select_window(generation_directories: dict[int, Path], cap: int = TRAINING_CAP) -> list[Path]:
    quotas = generation_quotas(list(generation_directories), cap)
    return [
        path
        for generation in sorted(generation_directories)
        for path in select_generation(generation_directories[generation], quotas[generation])
    ]
