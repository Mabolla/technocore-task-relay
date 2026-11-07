#!/usr/bin/env bash
set -euo pipefail
[ "${1:-}" = --prepare-existing-host ]
cd /opt/flop-miner
C=(docker compose --env-file miner.env -f docker-compose.miner.yml -f docker-compose.backend.yml)
"${C[@]}" ps --all worker backend </dev/null
for read_no in $(seq 1 25); do
  report=$(python3 -c 'import json,urllib.request as u; config=dict(line.split("=",1) for line in open("miner.env").read().splitlines() if line and not line.startswith("#") and "=" in line); req=u.Request("http://127.0.0.1:8645/session/info",headers={"Authorization":"Bearer "+config["SESSION_AUTH_TOKEN"]}); d=json.load(u.urlopen(req,timeout=8)); assert d.get("minerAddress")=="5Ek2J6WSgcunfe8hLRpZRGnCa3aUmvZAMGM5ugfyJ2VhtrWw"; print(json.dumps({k:d.get(k) for k in ("minerAddress","modelHash","calibration","is_ready")}))' </dev/null) || exit 1
  printf '%s\n' "$report"
  if printf '%s\n' "$report" | grep -q '"is_ready": true'; then break; fi
  if [ "$read_no" != 25 ]; then sleep 30; fi
done
"${C[@]}" logs --no-color --tail=350 worker </dev/null 2>&1 | python3 -c 'import re,sys,json; s=sys.stdin.read().splitlines(); p={"ghost_key_published":r"published ghost key", "endpoint_ad_published":r"Endpoint ad.*published", "calibration_messages":r"calibrat", "calibration_accepted":r"calibration.{0,45}(?:accepted|finalized)", "jobs_received":r"(?:ghost|calibration).{0,40}(?:received|assigned)", "jobs_resolved":r"(?:ghost|calibration).{0,40}(?:resolved|completed|submitted)", "error_messages":r"\b(?:error|failed|panic)\b"}; print(json.dumps({k:sum(bool(re.search(v,l,re.I)) for l in s) for k,v in p.items()}))'
# Probe only the existing temporary tunnel without a bearer or signed request.
public_host=$(sed -n 's/^SESSION_PUBLIC_HOST=//p' miner.env)
if [[ "$public_host" =~ ^[a-z0-9-]+\.trycloudflare\.com$ ]]; then
  curl -sS --max-time 10 -o /dev/null -w 'PUBLIC_SESSION_INFO_HTTP=%{http_code}\n' "https://$public_host/session/info" </dev/null || true
fi
# Report only fixed categories, never raw log text, URLs, or credentials.
"${C[@]}" logs --no-color --tail=350 worker </dev/null 2>&1 | python3 -c 'import re,sys,json
patterns={"endpoint_announcement":r"endpoint ad|publish.*endpoint", "ghost_task":r"ghost|canary|calibration", "rpc_or_chain":r"rpc|websocket|extrinsic|finality", "connectivity":r"timeout|timed out|ECONN|fetch failed|network error|ENOTFOUND", "credential_rejected":r"401|403|unauthorized|forbidden", "model_or_backend":r"model|backend|openai", "panic_or_fatal":r"panic|fatal|uncaught", "benign_code_field":r"error[\" ]*:[ ]*(null|false|none|0)"}
counts={k:0 for k in patterns}; unknown=0; total=0
for l in sys.stdin:
 if not re.search(r"\b(error|failed|panic)\b",l,re.I): continue
 total+=1; categories=[k for k,p in patterns.items() if re.search(p,l,re.I)]
 if not categories: unknown+=1
 for k in categories: counts[k]+=1
print(json.dumps({"log_matches":total,"uncategorized":unknown,"categories":{k:v for k,v in counts.items() if v}}))'
