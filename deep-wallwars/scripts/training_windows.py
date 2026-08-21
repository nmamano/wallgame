import re
from pathlib import Path

ARCHIVE_SUFFIX = ".tar.zst"


def expected_generation_ids(model_generation: int, max_window: int) -> set[int]:
    lower = max(model_generation - max_window, (model_generation - 1) // 2)
    return set(range(lower, model_generation))


def _logical_path(path: Path) -> Path:
    if path.name.endswith(ARCHIVE_SUFFIX):
        return path.with_name(path.name[: -len(ARCHIVE_SUFFIX)])
    return path


def _logical_matches(root: Path, pattern: str) -> list[Path]:
    raw = list(root.glob(pattern))
    by_logical: dict[Path, set[str]] = {}
    for path in raw:
        logical = _logical_path(path)
        kind = "archive" if path.name.endswith(ARCHIVE_SUFFIX) else "directory"
        by_logical.setdefault(logical, set()).add(kind)
    for logical, kinds in by_logical.items():
        if kinds == {"archive", "directory"}:
            raise RuntimeError(f"training data has both directory and archive: {logical}")
    return sorted(by_logical)


def discover_universal_training_paths(data_dir: str, model_generation: int, max_window: int) -> list[str]:
    root = Path(data_dir)
    expected = expected_generation_ids(model_generation, max_window)
    paths: list[Path] = []
    discovered: set[int] = set()
    for path in root.glob("generation_*"):
        logical = _logical_path(path)
        match = re.match(r"generation_(\d+)(?:_|$)", logical.name)
        if match and int(match.group(1)) in expected:
            recognized = re.match(
                rf"generation_{match.group(1)}_(?:mixed|standard|classic|animal-cycle)(?:_|$)",
                logical.name,
            )
            if not recognized:
                raise RuntimeError(f"unexpected training data family: {logical}")
    for generation in sorted(expected):
        mixed = _logical_matches(root, f"generation_{generation}_mixed*")
        if len(mixed) > 1:
            raise RuntimeError(f"generation {generation} has duplicate mixed data families")
        legacy: list[Path] = []
        for variant in ("standard", "classic", "animal-cycle"):
            legacy.extend(_logical_matches(root, f"generation_{generation}_{variant}*"))
        legacy = sorted(set(legacy))
        if mixed and legacy:
            raise RuntimeError(f"generation {generation} has both mixed and legacy data families")
        selected = mixed or legacy
        if not selected:
            raise RuntimeError(f"generation {generation} is missing from the training window")
        paths.extend(selected)
        discovered.add(generation)
    if discovered != expected:
        raise RuntimeError(f"training generations {sorted(discovered)} do not equal expected {sorted(expected)}")
    for path in paths:
        match = re.match(r"generation_(\d+)(?:_|$)", path.name)
        if not match or int(match.group(1)) not in expected:
            raise RuntimeError(f"unexpected training data family: {path}")
    return [str(path) for path in paths]
