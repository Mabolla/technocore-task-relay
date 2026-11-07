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
