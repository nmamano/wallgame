#!/usr/bin/env python3
"""Run a frozen policy-Elo plan with resumable immutable journals."""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import re
import signal
import sys
import time
from collections import Counter
from pathlib import Path


def args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--plan", type=Path, required=True)
    parser.add_argument("--run-root", type=Path, required=True)
    parser.add_argument("--archive-root", type=Path, required=True)
    parser.add_argument("--bun", type=Path, required=True)
    parser.add_argument("--concurrency", type=int, required=True)
    return parser.parse_args()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def canonical_sha(value) -> str:
    payload = json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(payload).hexdigest()


def write_all(fd: int, payload: bytes):
    offset = 0
    while offset < len(payload):
        written = os.write(fd, payload[offset:])
        if written <= 0:
            raise OSError("short JSONL write")
        offset += written


def fsync_directory(path: Path):
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def atomic_json(path: Path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = (json.dumps(value, indent=2) + "\n").encode()
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
    try:
        write_all(fd, payload)
        os.fsync(fd)
    finally:
        os.close(fd)
    os.replace(temporary, path)
    fsync_directory(path.parent)


def append_jsonl(path: Path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    existed = path.exists()
    payload = (json.dumps(value, separators=(",", ":")) + "\n").encode()
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
    try:
        write_all(fd, payload)
        os.fsync(fd)
    finally:
        os.close(fd)
    if not existed:
        fsync_directory(path.parent)


def game_id(pair, row):
    material = ":".join((
        pair["conditionId"], str(pair["generationA"]), str(pair["generationB"]),
        str(row["game"]), str(row["engineSeed"]), str(row.get("randomStartSeed", "")),
    ))
    return hashlib.sha256(material.encode()).hexdigest()[:24]


def pair_key(pair):
    return f'{pair["conditionId"]}-g{pair["generationA"]}-g{pair["generationB"]}'


def validate_game(pair, row, plan):
    if not isinstance(row, dict):
        raise ValueError("game row is not an object")
    required_types = {
        "game": int, "engineSeed": int, "candidateIsP1": bool,
        "outcome": str, "result": str, "reason": str,
        "legalityErrors": list, "moves": list,
    }
    for field, expected in required_types.items():
        if type(row.get(field)) is not expected:
            raise ValueError(f"invalid or missing {field}")
    if row["game"] < 0 or row["outcome"] not in ("ours", "opp", "draw"):
        raise ValueError("invalid game index or outcome")
    if any(not isinstance(error, str) for error in row["legalityErrors"]):
        raise ValueError("legalityErrors must contain strings")
    expected = {
        "exp": plan["experiment"], "variant": pair["variant"],
        "setup": pair["setup"], "board": f'{pair["width"]}x{pair["height"]}',
    }
    for field, value in expected.items():
        if row.get(field) != value:
            raise ValueError(f"wrong {field}: expected {value!r}, got {row.get(field)!r}")
    if Path(row.get("candidateModel", "")).resolve() != Path(pair["modelA"]).resolve():
        raise ValueError("candidate model does not match frozen plan")
    if Path(row.get("baselineModel", "")).resolve() != Path(pair["modelB"]).resolve():
        raise ValueError("baseline model does not match frozen plan")
    if row["outcome"] == "draw":
        expected_result = "1/2-1/2"
    else:
        candidate_wins = row["outcome"] == "ours"
        winner_is_p1 = row["candidateIsP1"] == candidate_wins
        expected_result = "1-0" if winner_is_p1 else "0-1"
    if row["result"] != expected_result:
        raise ValueError("result and outcome disagree")


def validate_attempt_row(pair, row, metadata):
    if row.get("engineSeed") != metadata.get("engineSeed"):
        raise ValueError("game engine seed does not match attempt metadata")
    submitted = metadata.get("submittedGames")
    if type(submitted) is not int or submitted <= 0 or submitted % 2:
        raise ValueError("attempt submitted game count is not positive and balanced")
    if row.get("game") not in range(submitted):
        raise ValueError("game index is outside submitted attempt range")
    if row.get("candidateIsP1") != (row["game"] % 2 == 0):
        raise ValueError("seat alternation does not match game index")
    random_seed = row.get("randomStartSeed")
    if pair["setup"] == "random-start" and type(random_seed) is not int:
        raise ValueError("Random Start row lacks an integer seed")
    if random_seed is not None and type(random_seed) is not int:
        raise ValueError("randomStartSeed has the wrong type")
    expected_random_seed = metadata["engineSeed"] * 1_000_003 + row["game"]
    if random_seed != expected_random_seed:
        raise ValueError("randomStartSeed does not match the frozen attempt seed and game index")


class Archive:
    def __init__(self, root: Path, experiment: str, plan):
        self.root = root / experiment
        self.accepted = self.root / "accepted"
        self.quarantine = self.root / "quarantine"
        self.torn = self.root / "torn"
        for path in (self.accepted, self.quarantine, self.torn):
            path.mkdir(parents=True, exist_ok=True)
        self.plan = plan
        self.pairs = {
            (item["conditionId"], item["generationA"], item["generationB"]): item
            for item in plan.get("pairings", [])
        }
        self.records = {}
        self.accepted_by_pair = Counter()
        self.engine_seeds = set(plan.get("usedEngineSeeds", []))
        for status, directory in (("accepted", self.accepted), ("excluded", self.quarantine)):
            for path in sorted(directory.glob("*.jsonl")):
                for row in self._read_archive(path):
                    if row.get("status") != status:
                        raise ValueError(f"wrong status in {path}")
                    self._validate_archive_row(row)
                    self._index(row)

    def _frozen_pair(self, pair):
        key = (pair["conditionId"], pair["generationA"], pair["generationB"])
        frozen = self.pairs.get(key)
        if frozen is None:
            raise ValueError(f"pair is absent from frozen plan: {key}")
        fields = ("variant", "setup", "width", "height", "modelA", "modelB", "games")
        if any(pair.get(field) != frozen.get(field) for field in fields):
            raise ValueError(f"pair settings differ from frozen plan: {key}")
        return frozen

    def _validate_archive_row(self, row):
        if (row.get("schema") != "wallgame-policy-elo-game-v2"
                or row.get("experiment") != self.plan["experiment"]
                or row.get("samples") != 1 or row.get("rootNoiseFactor") != 0
                or row.get("moveSelection") != "policy-argmax"):
            raise ValueError("archive settings or schema do not match frozen plan")
        key = (row.get("conditionId"), row.get("generationA"), row.get("generationB"))
        pair = self.pairs.get(key)
        if pair is None:
            raise ValueError(f"archive pair is absent from frozen plan: {key}")
        validate_game(pair, row.get("game"), self.plan)
        game = row["game"]
        rejected = game["reason"] == "no-legal-move" or bool(game["legalityErrors"])
        expected_status = "excluded" if rejected else "accepted"
        if row.get("status") != expected_status or row.get("gameFingerprint") != canonical_sha(game):
            raise ValueError("archive status or game fingerprint is invalid")

    def _save_torn(self, path: Path, payload: bytes):
        if not payload:
            return
        digest = hashlib.sha256(payload).hexdigest()
        target = self.torn / f"{path.name}.{digest[:16]}.torn"
        if target.exists():
            return
        fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
        try:
            write_all(fd, payload)
            os.fsync(fd)
        finally:
            os.close(fd)
        fsync_directory(target.parent)

    def _read_archive(self, path: Path):
        payload = path.read_bytes()
        complete = payload
        if payload and not payload.endswith(b"\n"):
            boundary = payload.rfind(b"\n") + 1
            complete, tail = payload[:boundary], payload[boundary:]
            self._save_torn(path, tail)
            fd = os.open(path, os.O_WRONLY)
            try:
                os.ftruncate(fd, boundary)
                os.fsync(fd)
            finally:
                os.close(fd)
        rows = []
        for number, line in enumerate(complete.splitlines(), 1):
            try:
                rows.append(json.loads(line))
            except (TypeError, ValueError) as error:
                raise ValueError(f"malformed complete line {path}:{number}") from error
        return rows

    def _index(self, row):
        identifier = row.get("gameId")
        fingerprint = row.get("gameFingerprint")
        if not identifier or not fingerprint:
            raise ValueError("archive row lacks stable identity")
        if identifier in self.records:
            if self.records[identifier] != fingerprint:
                raise ValueError(f"duplicate identity has different payload: {identifier}")
            return False
        self.records[identifier] = fingerprint
        game = row.get("game", {})
        if isinstance(game.get("engineSeed"), int):
            self.engine_seeds.add(game["engineSeed"])
        if row["status"] == "accepted":
            key = (row["conditionId"], row["generationA"], row["generationB"])
            self.accepted_by_pair[key] += 1
        return True

    def accepted_count(self, pair):
        key = (pair["conditionId"], pair["generationA"], pair["generationB"])
        return self.accepted_by_pair[key]

    def append(self, pair, row, attempt_id):
        pair = self._frozen_pair(pair)
        validate_game(pair, row, self.plan)
        identifier = game_id(pair, row)
        fingerprint = canonical_sha(row)
        if identifier in self.records:
            if self.records[identifier] != fingerprint:
                raise ValueError(f"duplicate identity has different payload: {identifier}")
            return False
        errors = row["legalityErrors"]
        rejected = row["reason"] == "no-legal-move" or bool(errors)
        enriched = {
            "schema": "wallgame-policy-elo-game-v2", "gameId": identifier,
            "gameFingerprint": fingerprint,
            "status": "excluded" if rejected else "accepted",
            "excludeReason": (
                "engine-no-legal-move" if row["reason"] == "no-legal-move"
                else ("legality-error" if errors else None)
            ),
            "experiment": self.plan["experiment"], "attemptId": attempt_id,
            "conditionId": pair["conditionId"],
            "generationA": pair["generationA"], "generationB": pair["generationB"],
            "samples": 1, "rootNoiseFactor": 0, "moveSelection": "policy-argmax",
            "archivedAtUtc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "game": row,
        }
        target = (self.quarantine if rejected else self.accepted) / f'{pair["conditionId"]}.jsonl'
        append_jsonl(target, enriched)
        self._index(enriched)
        return True

    def preserve_journal_tail(self, raw: Path, tail: bytes):
        self._save_torn(raw, tail)


def complete_journal_rows(raw: Path, archive: Archive):
    if not raw.exists():
        return []
    payload = raw.read_bytes()
    if payload and not payload.endswith(b"\n"):
        boundary = payload.rfind(b"\n") + 1
        archive.preserve_journal_tail(raw, payload[boundary:])
        payload = payload[:boundary]
    rows = []
    for number, line in enumerate(payload.splitlines(), 1):
        try:
            rows.append(json.loads(line))
        except (TypeError, ValueError) as error:
            raise ValueError(f"malformed complete line {raw}:{number}") from error
    return rows


def recover_journals(run_root: Path, archive: Archive, plan):
    recovered = 0
    raw_root = (run_root / "raw").resolve()
    for meta_path in sorted(raw_root.glob("*.meta.json")):
        meta = json.loads(meta_path.read_text())
        if (meta.get("schema") != "wallgame-policy-elo-journal-v1"
                or meta.get("experiment") != plan["experiment"]
                or not isinstance(meta.get("attemptId"), str)):
            raise ValueError(f"wrong experiment in {meta_path}")
        pair = meta["pair"]
        raw = Path(meta["rawPath"]).resolve()
        expected_name = meta_path.name[:-len(".meta.json")] + ".jsonl"
        if raw.parent != raw_root or raw.name != expected_name:
            raise ValueError(f"journal path escapes or disagrees with metadata: {meta_path}")
        for row in complete_journal_rows(raw, archive):
            validate_attempt_row(pair, row, meta)
            recovered += archive.append(pair, row, meta["attemptId"])
    return recovered


def verify_frozen_inputs(plan, bun: Path):
    inputs = [
        plan["engine"], plan["benchmark"], plan["config"], plan["loadabilityMap"],
        *plan["models"].values(),
    ]
    for item in inputs:
        path = Path(item["path"])
        if not path.is_file() or sha256(path) != item["sha256"]:
            raise ValueError(f"frozen input drift: {path}")
    if not bun.is_file():
        raise ValueError(f"Bun executable missing: {bun}")
    return {"path": str(bun.resolve()), "sha256": sha256(bun.resolve())}


def allocate_seed(pair, attempt_index, plan, archive):
    salt = 0
    while True:
        material = f'{plan["experiment"]}:{pair_key(pair)}:{attempt_index}:{salt}'
        seed = int(hashlib.sha256(material.encode()).hexdigest()[:8], 16) & 0x7FFFFFFF
        if seed not in archive.engine_seeds:
            archive.engine_seeds.add(seed)
            return seed
        salt += 1


async def terminate(process):
    if process is None:
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        if process.returncode is None:
            await asyncio.wait_for(process.wait(), timeout=5)
    except asyncio.TimeoutError:
        pass
    try:
        os.killpg(process.pid, 0)
    except ProcessLookupError:
        return
    os.killpg(process.pid, signal.SIGKILL)
    if process.returncode is None:
        await process.wait()


async def drain_raw(raw: Path, pair, archive: Archive, process, metadata):
    offset, remainder = 0, b""
    while process.returncode is None or (raw.exists() and raw.stat().st_size > offset):
        if raw.exists():
            with raw.open("rb") as stream:
                stream.seek(offset)
                chunk = stream.read()
                offset = stream.tell()
            remainder += chunk
            lines = remainder.split(b"\n")
            remainder = lines.pop()
            for line in lines:
                if line.strip():
                    row = json.loads(line)
                    validate_attempt_row(pair, row, metadata)
                    archive.append(pair, row, metadata["attemptId"])
        if process.returncode is None:
            await asyncio.sleep(0.1)
        else:
            break
    if remainder.strip():
        archive.preserve_journal_tail(raw, remainder)
        raise ValueError(f"torn final journal line: {raw}")


def next_attempt_index(run_root: Path, key: str):
    indexes = []
    for path in (run_root / "raw").glob(f"{key}-attempt*.meta.json"):
        match = re.search(r"-attempt(\d+)(?:-|\.)", path.name)
        if not match:
            raise ValueError(f"invalid attempt journal name: {path}")
        indexes.append(int(match.group(1)))
    return max(indexes, default=0) + 1


async def run_attempt(pair, plan, opt, archive, attempt_index, games):
    key = pair_key(pair)
    seed = allocate_seed(pair, attempt_index, plan, archive)
    attempt_id = f"{key}-attempt{attempt_index:04d}-seed{seed}"
    raw = (opt.run_root / "raw" / f"{attempt_id}.jsonl").resolve()
    meta = raw.with_suffix(".meta.json")
    log = opt.run_root / "logs" / f"{attempt_id}.stderr"
    stdout = opt.run_root / "logs" / f"{attempt_id}.stdout"
    if raw.exists() or meta.exists():
        raise RuntimeError(f"immutable attempt already exists: {attempt_id}")
    metadata = {
        "schema": "wallgame-policy-elo-journal-v1", "experiment": plan["experiment"],
        "attemptId": attempt_id, "attemptIndex": attempt_index, "engineSeed": seed,
        "submittedGames": games, "pair": pair, "rawPath": str(raw),
        "startedAtUtc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    atomic_json(meta, metadata)
    log.parent.mkdir(parents=True, exist_ok=True)
    engine_command = f'{plan["engine"]["path"]} --parallel_samples 1 --thread_pool_size 1'
    command = [
        str(opt.bun), plan["benchmark"]["path"], "--engine", engine_command,
        "--ours", pair["modelA"], "--our-samples", "1",
        "--opp", pair["modelB"], "--opp-samples", "1",
        "--our-noise", "0", "--opp-noise", "0",
        "--variant", pair["variant"], "--setup", pair["setup"],
        "--width", str(pair["width"]), "--height", str(pair["height"]),
        "--games", str(games), "--seed", str(seed),
        "--archive", str(raw), "--experiment", plan["experiment"],
    ]
    process = None
    try:
        with log.open("xb") as err, stdout.open("xb") as out:
            process = await asyncio.create_subprocess_exec(
                *command, stdout=out, stderr=err, start_new_session=True,
            )
            await drain_raw(raw, pair, archive, process, metadata)
            code = await process.wait()
        if code:
            raise RuntimeError(f"attempt {attempt_id} exited {code}; see {log}")
    finally:
        await terminate(process)
    return attempt_id


async def run_pair(pair, plan, opt, archive, semaphore):
    async with semaphore:
        target = pair["games"]
        attempt_index = next_attempt_index(opt.run_root, pair_key(pair))
        while archive.accepted_count(pair) < target:
            shortage = target - archive.accepted_count(pair)
            submitted = shortage if shortage % 2 == 0 else shortage + 1
            attempt_id = await run_attempt(pair, plan, opt, archive, attempt_index, submitted)
            print(json.dumps({
                "attempt": attempt_id, "submitted": submitted,
                "accepted": archive.accepted_count(pair), "target": target,
            }, separators=(",", ":")), flush=True)
            attempt_index += 1


async def main_async():
    opt = args()
    if opt.concurrency < 1:
        raise SystemExit("concurrency must be positive")
    plan = json.loads(opt.plan.read_text())
    bun = verify_frozen_inputs(plan, opt.bun.resolve())
    opt.run_root.mkdir(parents=True, exist_ok=True)
    archive = Archive(opt.archive_root, plan["experiment"], plan)
    recovered = recover_journals(opt.run_root, archive, plan)
    run_id = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()) + f"-pid{os.getpid()}"
    history = archive.root / "run-attempts" / f"{run_id}.jsonl"
    append_jsonl(history, {
        "event": "started", "runId": run_id, "experiment": plan["experiment"],
        "planPath": str(opt.plan.resolve()), "planSha256": sha256(opt.plan.resolve()),
        "runnerPath": str(Path(__file__).resolve()), "runnerSha256": sha256(Path(__file__).resolve()),
        "bun": bun, "concurrency": opt.concurrency, "recoveredRows": recovered,
        "atUtc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    })
    semaphore = asyncio.Semaphore(opt.concurrency)
    tasks = [asyncio.create_task(run_pair(pair, plan, opt, archive, semaphore)) for pair in plan["pairings"]]
    try:
        await asyncio.gather(*tasks)
    except BaseException as error:
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        append_jsonl(history, {
            "event": "failed", "error": str(error),
            "atUtc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        })
        raise
    append_jsonl(history, {
        "event": "completed", "acceptedGames": sum(archive.accepted_by_pair.values()),
        "excludedGames": sum(1 for path in archive.quarantine.glob("*.jsonl") for _ in path.open()),
        "atUtc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    })


if __name__ == "__main__":
    try:
        asyncio.run(main_async())
    except Exception as error:
        print(json.dumps({"error": str(error)}, separators=(",", ":")), file=sys.stderr)
        raise
