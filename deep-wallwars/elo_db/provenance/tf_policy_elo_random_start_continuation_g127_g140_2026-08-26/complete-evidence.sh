#!/usr/bin/env bash
set -euo pipefail

ROOT=/home/nilo/nil/wallgame/deep-wallwars
EXP=tf_policy_elo_random_start_continuation_g127_g140_2026-08-26
TRAIN=$ROOT/training-runs/phase7-feasibility-34e5f567-random-start-g117-g126
RR=$TRAIN/policy-elo/$EXP
PROV=$ROOT/elo_db/provenance/$EXP
ARCH=$ROOT/elo_db/policy_archive/$EXP
RESULT=$ROOT/elo_db/results/$EXP.csv
FINGERPRINTS=$PROV/raw-fingerprints.json
FINAL=$RR/complete-evidence.final
EXPECTED_ENGINE=f80b9ed1ac90d2a1a38cac2406939bfe840c8ddffe6035e75cca59f6a7664d2b

finish() {
  original=$?
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  engine_after=$(sha256sum "$ROOT/build-tests/deep_ww_bgs_engine" 2>/dev/null | awk '{print $1}' || true)
  status=$original
  [[ "$engine_after" == "$EXPECTED_ENGINE" ]] || status=97
  printf 'status=%s\noriginalStatus=%s\nmeasuredAtUtc=%s\nengineAfter=%s\n' \
    "$status" "$original" "$now" "$engine_after" > "$FINAL"
  exit "$status"
}
trap finish EXIT

test "$(awk -F= '$1=="status"{print $2}' "$RR/runner.final")" = 0
test "$(sha256sum "$ROOT/build-tests/deep_ww_bgs_engine" | awk '{print $1}')" = "$EXPECTED_ENGINE"
if [[ -e "$RESULT" && ! -e "$FINGERPRINTS" ]] || [[ ! -e "$RESULT" && -e "$FINGERPRINTS" ]]; then
  printf 'results and fingerprints must either both exist or both be absent\n' >&2
  exit 2
fi

if [[ ! -e "$RESULT" ]]; then
python3 - "$ARCH" "$RESULT" "$FINGERPRINTS" "$EXP" > "$RR/materialize.stdout" <<'PY'
import csv, hashlib, json, os, re, sys

archive, result_path, fingerprints_path, experiment = sys.argv[1:]
columns = [
    "exp", "sourceFile", "conditionId", "variant", "setup", "board", "p1", "p2",
    "candidateIsP1", "winner", "evidenceStatus", "exclusionReason", "engineSeed",
    "randomStartSeed", "game",
]
generation = re.compile(r"model_(\d+)")
winner_of_result = {"1-0": "p1", "0-1": "p2", "1/2-1/2": "draw"}
records = []
fingerprints = []
seen = set()
accepted = os.path.join(archive, "accepted")
for name in sorted(os.listdir(accepted)):
    if not name.endswith(".jsonl"):
        continue
    path = os.path.join(accepted, name)
    with open(path, "rb") as stream:
        for line_number, raw_line in enumerate(stream, 1):
            assert raw_line.endswith(b"\n"), f"torn archive row: {name}:{line_number}"
            raw_payload = raw_line[:-1]
            wrapper = json.loads(raw_payload)
            game = wrapper["game"]
            assert wrapper["schema"] == "wallgame-policy-elo-game-v2"
            assert wrapper["experiment"] == experiment and wrapper["status"] == "accepted"
            assert wrapper["excludeReason"] is None
            assert wrapper["samples"] == 1 and wrapper["rootNoiseFactor"] == 0
            assert wrapper["moveSelection"] == "policy-argmax"
            assert game["exp"] == experiment and game["legalityErrors"] == []
            assert game["reason"] != "no-legal-move"
            assert game["outcome"] in ("ours", "opp", "draw")
            p1_match = generation.search(os.path.basename(game["whiteModel"]))
            p2_match = generation.search(os.path.basename(game["blackModel"]))
            assert p1_match and p2_match
            p1 = f"tf:{int(p1_match.group(1))}"
            p2 = f"tf:{int(p2_match.group(1))}"
            candidate = p1 if game["candidateIsP1"] else p2
            baseline = p2 if game["candidateIsP1"] else p1
            assert candidate == f"tf:{wrapper['generationA']}"
            assert baseline == f"tf:{wrapper['generationB']}"
            winner = winner_of_result[game["result"]]
            derived = "draw" if winner == "draw" else (
                "ours" if (winner == "p1") == game["candidateIsP1"] else "opp"
            )
            assert derived == game["outcome"]
            identity = wrapper["gameId"]
            assert identity not in seen
            seen.add(identity)
            records.append({
                "exp": experiment,
                "sourceFile": f"accepted/{name}#{identity}",
                "conditionId": wrapper["conditionId"],
                "variant": game["variant"],
                "setup": game["setup"],
                "board": game["board"],
                "p1": p1,
                "p2": p2,
                "candidateIsP1": "true" if game["candidateIsP1"] else "false",
                "winner": winner,
                "evidenceStatus": "accepted",
                "exclusionReason": "",
                "engineSeed": game["engineSeed"],
                "randomStartSeed": "" if game["randomStartSeed"] is None else game["randomStartSeed"],
                "game": game["game"],
            })
            fingerprints.append({
                "gameId": identity,
                "rawRecordSha256": hashlib.sha256(raw_payload).hexdigest(),
                "sourceFile": f"accepted/{name}#{identity}",
                "line": line_number,
            })
assert len(records) == 2940, len(records)
with open(result_path, "x", newline="") as stream:
    writer = csv.DictWriter(stream, fieldnames=columns, lineterminator="\n")
    writer.writeheader()
    writer.writerows(sorted(records, key=lambda row: (
        row["conditionId"], int(row["p1"].split(":")[1]),
        int(row["p2"].split(":")[1]), int(row["game"]),
    )))
with open(fingerprints_path, "x") as stream:
    json.dump({
        "schema": "wallgame-policy-elo-raw-fingerprints-v1",
        "experiment": experiment,
        "rows": len(fingerprints),
        "records": sorted(fingerprints, key=lambda row: row["gameId"]),
    }, stream, sort_keys=True, indent=2)
    stream.write("\n")
print(json.dumps({"rows": len(records), "accepted": len(records), "excluded": 0}, separators=(",",":")))
PY
fi

python3 - "$ARCH" "$PROV/archive-tree-files.json" "$PROV/completion-summary.json" \
  "$PROV/immutable-input-hashes.json" "$PROV/plan.json" "$PROV/experiments.pre-run.json" \
  "$RESULT" "$FINGERPRINTS" <<'PY'
import csv, hashlib, json, os, sys, time
from collections import Counter

archive, manifest_path, summary_path, immutable_path, plan_path, registry_path, result_path, fingerprints_path = sys.argv[1:]

def sha(path):
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for block in iter(lambda: stream.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()

files = []
for base, directories, names in os.walk(archive):
    directories.sort()
    for name in sorted(names):
        path = os.path.join(base, name)
        files.append({
            "path": os.path.relpath(path, archive),
            "sha256": sha(path),
            "bytes": os.path.getsize(path),
        })
payload = "".join(
    f"{item['path']}\0{item['sha256']}\0{item['bytes']}\n" for item in files
).encode()
tree_sha = hashlib.sha256(payload).hexdigest()
manifest = {
    "schema": "wallgame-policy-elo-archive-tree-v1",
    "experiment": os.path.basename(archive),
    "files": files,
    "treeSha256": tree_sha,
}
with open(manifest_path, "w") as stream:
    json.dump(manifest, stream, indent=2)
    stream.write("\n")

rows = list(csv.DictReader(open(result_path, newline="")))
conditions = Counter(row["conditionId"] for row in rows)
generations = sorted({
    int(player.split(":", 1)[1])
    for row in rows
    for player in (row["p1"], row["p2"])
})
pairings = {
    (row["conditionId"], tuple(sorted((row["p1"], row["p2"]))))
    for row in rows
}
summary = {
    "schema": "wallgame-policy-elo-completion-v1",
    "experiment": os.path.basename(archive),
    "completedAtUtc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    "acceptedGames": len(rows),
    "quarantinedGames": 0,
    "tornRecords": 0,
    "pairings": len(pairings),
    "attempts": len(pairings),
    "supportedGenerations": generations,
    "conditions": len(conditions),
    "componentsPerCondition": 1,
    "incrementalPlan": {"pairings": 0, "acceptedGamesNeeded": 0},
    "archiveTreeSha256": tree_sha,
    "archiveFileCount": len(files),
    "archiveBytes": sum(item["bytes"] for item in files),
    "archiveTreeManifest": {"path": manifest_path, "sha256": sha(manifest_path)},
    "sourceHashes": {
        "immutableInputs": sha(immutable_path),
        "plan": sha(plan_path),
        "experimentsPreRun": sha(registry_path),
        "resultsTable": sha(result_path),
        "rawFingerprints": sha(fingerprints_path),
    },
    "gamesByCondition": dict(sorted(conditions.items())),
    "notes": "All planned games completed and were archived before this tracked table was materialized.",
}
assert len(rows) == 2940
assert len(pairings) == 420
assert generations == list(range(121, 141))
assert len(files) == 11
with open(summary_path, "w") as stream:
    json.dump(summary, stream, indent=2)
    stream.write("\n")
PY

python3 - "$ROOT/elo_db/experiments.json" "$PROV/completion-summary.json" \
  "$PROV/archive-tree-files.json" "$RESULT" "$FINGERPRINTS" "$EXP" <<'PY'
import csv, hashlib, json, os, sys

registry, summary_path, manifest_path, result_path, fingerprints_path, experiment = sys.argv[1:]
data = json.load(open(registry))
entry = data[experiment]
summary = json.load(open(summary_path))
manifest = json.load(open(manifest_path))

def sha(path):
    return hashlib.sha256(open(path, "rb").read()).hexdigest()

rows = list(csv.DictReader(open(result_path, newline="")))
result_rel = f"deep-wallwars/elo_db/results/{experiment}.csv"
provenance_rel = f"deep-wallwars/elo_db/provenance/{experiment}"
entry["results"] = {
    "path": result_rel,
    "schema": "wallgame-elo-results-table-v1",
    "rows": len(rows),
    "bytes": os.path.getsize(result_path),
    "sha256": sha(result_path),
    "generator": f"{provenance_rel}/complete-evidence.sh",
}
entry["rawFingerprints"] = {
    "path": f"{provenance_rel}/raw-fingerprints.json",
    "schema": "wallgame-policy-elo-raw-fingerprints-v1",
    "rows": len(rows),
    "bytes": os.path.getsize(fingerprints_path),
    "sha256": sha(fingerprints_path),
    "generator": f"{provenance_rel}/complete-evidence.sh",
}
entry["canonical_archive"] = {
    "path": f"deep-wallwars/elo_db/policy_archive/{experiment}",
    "contentSha256": summary["archiveTreeSha256"],
    "hashStatus": "finalized after completion",
    "completionRecord": {
        "path": f"{provenance_rel}/completion-summary.json",
        "sha256": sha(summary_path),
    },
}
entry["localRawArchive"] = {
    "box": "desktop-053vvpl-1",
    "path": f"deep-wallwars/elo_db/policy_archive/{experiment}",
    "tracked": False,
    "hashAlgorithm": "sha256 over sorted path, file sha256, and byte count records",
    "files": summary["archiveFileCount"],
    "rawBytes": summary["archiveBytes"],
    "contentSha256": summary["archiveTreeSha256"],
    "measuredOn": "2026-08-26",
    "note": "Gitignored fsynced raw journals on the 4090 WSL. The repository tracks the exact-v1 results table and per-row fingerprint manifest.",
}
entry["evidenceStatus"] = "accepted"
entry["measured"] = {
    "parsedRows": len(rows),
    "gamesByCondition": summary["gamesByCondition"],
    "pairings": summary["pairings"],
    "generationRange": {"min": 121, "max": 140, "distinct": 20},
    "measuredOn": "2026-08-26",
}
entry["provenance"]["path"] = provenance_rel
for name, item in entry["provenance"]["immutableInputs"].items():
    item["path"] = f"{provenance_rel}/{name}"

assert entry["canonical_archive"]["contentSha256"] == manifest["treeSha256"]
assert entry["results"]["rows"] == entry["rawFingerprints"]["rows"] == 2940
temporary = registry + ".tmp"
with open(temporary, "w") as stream:
    json.dump(data, stream, indent=2)
    stream.write("\n")
os.replace(temporary, registry)
PY

printf 'completion=valid archiveFiles=11 accepted=2940 pairings=420 experiment=10x121..140 incremental=0/0\n'
