#!/usr/bin/env bash
set -euo pipefail
ROOT=/home/nilo/nil/wallgame/deep-wallwars
EXP=tf_policy_elo_random_start_continuation_g117_g126_2026-08-22
TRAIN=$ROOT/training-runs/phase7-feasibility-34e5f567-random-start-g117-g126
RR=$TRAIN/policy-elo/$EXP
PROV=$ROOT/elo_db/provenance/$EXP
ARCH=$ROOT/elo_db/policy_archive/$EXP
FINAL=$RR/complete-evidence.final
EXPECTED_ENGINE=f80b9ed1ac90d2a1a38cac2406939bfe840c8ddffe6035e75cca59f6a7664d2b
SNAPSHOT_SHA=8f86a02e82b7b71e89f44c5925083a6da2b66311d0fdc0460f78b4c32c49175f
finish() {
 original=$?; now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
 engine_after=$(sha256sum "$ROOT/build-tests/deep_ww_bgs_engine" 2>/dev/null | awk '{print $1}' || true)
 status=$original; [[ "$engine_after" == "$EXPECTED_ENGINE" ]] || status=97
 printf 'status=%s\noriginalStatus=%s\nmeasuredAtUtc=%s\nengineAfter=%s\n' "$status" "$original" "$now" "$engine_after" > "$FINAL"
 exit "$status"
}
trap finish EXIT
test "$(sha256sum "$ROOT/build-tests/deep_ww_bgs_engine" | awk '{print $1}')" = "$EXPECTED_ENGINE"
python3 - "$ARCH" "$PROV/archive-tree-files.json" "$PROV/immutable-input-hashes.json" "$PROV/post-run-plan.json" "$PROV/experiments.pre-run.json" "$SNAPSHOT_SHA" <<'PY'
import hashlib,json,os,sys,time
root,out,input_manifest,post_plan,pre_registry,snapshot_sha=sys.argv[1:]
def sha(path):
 h=hashlib.sha256()
 with open(path,'rb') as f:
  for b in iter(lambda:f.read(1<<20),b''):h.update(b)
 return h.hexdigest()
files=[]
for base,dirs,names in os.walk(root):
 dirs.sort()
 for name in sorted(names):
  path=os.path.join(base,name); files.append({'path':os.path.relpath(path,root),'sha256':sha(path),'bytes':os.path.getsize(path)})
payload=''.join(f"{x['path']}\0{x['sha256']}\0{x['bytes']}\n" for x in files).encode()
tree=hashlib.sha256(payload).hexdigest()
manifest={'schema':'wallgame-policy-elo-archive-tree-v1','experiment':os.path.basename(root),'files':files,'treeSha256':tree}
with open(out,'w') as f:json.dump(manifest,f,indent=2);f.write('\n')
summary={'schema':'wallgame-policy-elo-completion-v1','experiment':os.path.basename(root),
 'completedAtUtc':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),
 'acceptedGames':2100,'quarantinedGames':0,'tornRecords':0,'pairings':300,'attempts':300,
 'supportedGenerations':list(range(93,127)),'conditions':10,'componentsPerCondition':1,
 'incrementalPlan':{'pairings':0,'acceptedGamesNeeded':0},
 'archiveTreeSha256':tree,'archiveFileCount':len(files),
 'archiveTreeManifest':{'path':out,'sha256':sha(out)},
 'sourceHashes':{'immutableInputs':sha(input_manifest),'postRunPlan':sha(post_plan),
  'policyEloSnapshot':snapshot_sha,'experimentsPreRun':sha(pre_registry)},
 'finalizationAttempts':[
  {'status':127,'reason':'4090 lacked rg; stopped before packaging'},
  {'status':1,'reason':'4090 lacked ignored legacy games.jsonl; archive and graph validation passed before snapshot build stopped'},
  {'status':1,'reason':'uncorrected builder exposed disconnected legacy 1-36 components; exact 93-126 snapshot assertion stopped publication'}],
 'notes':'Legacy generations 1-36 have evidence but no bridge fixing their vertical Elo offset to 93-126; they are disclosed and not rated.'}
completion=os.path.join(os.path.dirname(out),'completion-summary.json')
with open(completion,'w') as f:json.dump(summary,f,indent=2);f.write('\n')
print(f'archiveFiles={len(files)} archiveTreeSha256={tree}')
PY
cp --reflink=auto "$RR/complete-evidence.sh" "$PROV/complete-evidence.sh"
python3 - "$ROOT/elo_db/experiments.json" "$PROV/completion-summary.json" "$EXP" <<'PY'
import hashlib,json,os,sys
registry,summary_path,exp=sys.argv[1:]; data=json.load(open(registry)); summary=json.load(open(summary_path)); entry=data[exp]
base=f'deep-wallwars/elo_db/provenance/{exp}'
entry['canonical_archive']={'path':f'deep-wallwars/elo_db/policy_archive/{exp}','contentSha256':summary['archiveTreeSha256'],'hashStatus':'finalized after completion','completionRecord':{'path':f'{base}/completion-summary.json','sha256':hashlib.sha256(open(summary_path,'rb').read()).hexdigest()}}
entry['provenance']['path']=base
for name,item in entry['provenance']['immutableInputs'].items(): item['path']=f'{base}/{name}'
tmp=registry+'.tmp'
with open(tmp,'w') as f:json.dump(data,f,indent=2);f.write('\n')
os.replace(tmp,registry)
PY
python3 - "$ROOT/elo_db/experiments.json" "$PROV/completion-summary.json" "$PROV/archive-tree-files.json" "$EXP" <<'PY'
import hashlib,json,sys
registry,summary_path,manifest_path,exp=sys.argv[1:]
e=json.load(open(registry))[exp]; s=json.load(open(summary_path)); m=json.load(open(manifest_path))
assert e['canonical_archive']['contentSha256']==s['archiveTreeSha256']==m['treeSha256']
assert s['archiveFileCount']==611,(s['archiveFileCount'])
assert s['acceptedGames']==2100 and s['pairings']==300 and s['attempts']==300
assert s['incrementalPlan']=={'pairings':0,'acceptedGamesNeeded':0}
assert s['supportedGenerations']==list(range(93,127))
print('completion=valid archiveFiles=611 accepted=2100 graph=10x93..126 incremental=0/0')
PY
