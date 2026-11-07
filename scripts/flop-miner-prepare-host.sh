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
# Keep raw worker logs on the host. Emit only fixed public diagnostic vocabulary.
"${C[@]}" logs --no-color --tail=350 worker </dev/null 2>&1 | python3 -c 'import re,sys,json
v=set("error errors failed failure panic warn warning info debug level message unhandled rejection uncaught exception startup start restarting retry retrying attempt expected optional disabled deprecated ignored recovered transient permanent fatal type invalid missing denied unavailable disconnected refused closed abort aborted cancel cancelled unknown unsupported not found cannot could unable already running ready skipped exhausted session request response status authentication authorization unauthorized forbidden port binding address listen server http https cloudflared tunnel connection gateway mailbox ghost canary calibration proof settlement payment channel receipt wallet signer registration stake capacity chain block rpc model backend health policy worker service job jobs task execution result publish announced duplicate load timeout fetch network configuration config bootstrap read write file directory runtime docker cuda socket client stream transport endpoint advertise sign invalidated signature rejected eof reset expired resolve resolved errorcode reason polling startup indexer catalog openrouter store persistence warmup stopped shutdown signal code caught failed ignored no known cache issue conflict is was the to from for with in of and on at during due but will without by a an".split())
for raw in sys.stdin:
 if not re.search(r"\b(error|failed|panic)\b",raw,re.I): continue
 msg=raw.split("|",1)[-1]; msg=re.sub(r"https?://\S+|\b0x[0-9a-fA-F]+\b|\b[a-zA-Z0-9_-]{16,}\b"," [hidden] ",msg)
 words=re.findall(r"[A-Za-z]+|\b[1-5][0-9]{2}\b",msg)
 safe=[]
 for w in words:
  w=w.lower()
  if w in v or (w in {"400","401","403","404","409","429","500","502","503","504"}): safe.append(w)
  elif not safe or safe[-1]!="…": safe.append("…")
 print(json.dumps({"redacted_log_signature":" ".join(safe[:55])}))'
