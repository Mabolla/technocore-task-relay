#!/usr/bin/env bash
# Invoke only on the approved existing GPU host AFTER sponsored registration.
set -euo pipefail
umask 077
[ "$(id -u)" = 0 ]
[ "${1:-}" = '--activate-registered-miner' ] || exit 2
exec 9>/run/lock/mabolla-flop-miner.lock
flock -n 9 || { echo 'Another miner operation active'; exit 1; }
cd /opt/flop-miner
[ -f miner.env ] && [ ! -L miner.env ] && [ "$(stat -c %a miner.env)" = 600 ]
CLI="$(sed -n 's/^FLOP_CLI=//p' miner.env)"
[[ "$CLI" =~ ^ghcr.io/flop-labs/flop-core/cli:v[0-9.]+@sha256:[a-f0-9]{64}$ ]]
ADDRESS=5Ek2J6WSgcunfe8hLRpZRGnCa3aUmvZAMGM5ugfyJ2VhtrWw
MODEL=0x1a52c1abe781db051e70ae357f72bb70161ca0c092df0b618f22a9292ba63306
docker run --rm --network host "$CLI" --network devnet --rpc wss://rpc.devnet.flop.network miner status "$ADDRESS" --json > activation-status.json
# Fail closed when the CLI schema differs; never infer success from a process exit code.
python3 - <<'PY'
import json
d=json.load(open("activation-status.json"))
assert d.get("registered") is True,"Miner registration not explicitly confirmed"
a=d.get("address",d.get("account"))
assert a=="5Ek2J6WSgcunfe8hLRpZRGnCa3aUmvZAMGM5ugfyJ2VhtrWw","Miner address/schema mismatch"
PY
C=(docker compose --env-file miner.env -f docker-compose.miner.yml -f docker-compose.backend.yml)
"${C[@]}" config --quiet
"${C[@]}" up -d backend
# Bounded health checks. These are read-only, never repeat signed requests.
healthy=0
for attempt in $(seq 1 6); do
  if "${C[@]}" exec -T backend python3 -c 'import os,json,urllib.request as u;r=json.load(u.urlopen(u.Request("http://127.0.0.1:8000/health",headers={"Authorization":"Bearer "+os.environ["INFERENCE_API_KEY"]}),timeout=5));assert r.get("model_identity")=="measured";assert r.get("model_hash")=="0x1a52c1abe781db051e70ae357f72bb70161ca0c092df0b618f22a9292ba63306";assert r.get("decode_policy_hash")=="0xeca6a3f9c5a9fa1556892182ffef15b1273c075146a2d1a87814ae83ecea3053";print(json.dumps({k:r.get(k) for k in ("model_identity","model_hash","decode_policy_hash")}))' > activation-backend-health.json 2>/dev/null; then healthy=1; break; fi
  sleep 10
done
if [ "$healthy" != 1 ]; then
  "${C[@]}" ps --all backend
  cid=$("${C[@]}" ps --all -q backend)
  if [ -n "$cid" ]; then
    docker inspect --format='Backend state={{.State.Status}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}} restart_count={{.RestartCount}}' "$cid"
    docker logs --tail 150 "$cid" 2>&1 | python3 -c 'import re,sys;s=sys.stdin.read(); patterns={"model-root":r"(?i)model.{0,25}(?:root|hash).{0,60}(?:mismatch|expected|failed)","checkpoint-missing":r"(?i)(?:no such file|not a directory|filenotfounderror)","gpu-or-cuda":r"(?i)(?:cuda error|no kernel image|no cuda gpus|cuda out of memory|compute capability)","decode-policy":r"(?i)decode.policy.{0,60}(?:mismatch|failed|invalid)","backend-started":r"(?i)(?:application startup complete|uvicorn running)","model-load":r"(?i)(?:loading model|loading safetensors)"};print("Backend diagnostic categories:",",".join(k for k,v in patterns.items() if re.search(v,s)) or "none")'
  fi
  "${C[@]}" exec -T backend python3 -c 'import json,os,urllib.request as u,urllib.error as e; req=u.Request("http://127.0.0.1:8000/health",headers={"Authorization":"Bearer "+os.environ["INFERENCE_API_KEY"]});
try:
 r=json.load(u.urlopen(req,timeout=5)); print(json.dumps({k:r.get(k) for k in ("model_identity","model_hash","decode_policy_hash","precision")}))
except e.HTTPError as x: print("Backend health HTTP",x.code)
except Exception as x: print("Backend health error type",type(x).__name__)' || true
  echo 'Backend health/model gate failed; worker not started'
  exit 1
fi
install -d -m 755 /usr/local/lib/mabolla-flop
BIN=/usr/local/lib/mabolla-flop/cloudflared-2026.10.7
if [ ! -e "$BIN" ]; then
  curl -fsSL --max-time 120 https://github.com/cloudflare/cloudflared/releases/download/2026.10.7/cloudflared-linux-amd64 -o "$BIN.download"
  echo "1f99fb518b83dec2ba8d870a7cc991d82a77e6196295a3d2754ba17ab9f91872  $BIN.download" | sha256sum -c -
  install -m 755 "$BIN.download" "$BIN"
fi
echo "1f99fb518b83dec2ba8d870a7cc991d82a77e6196295a3d2754ba17ab9f91872  $BIN" | sha256sum -c -
# This dedicated service is created once; conflicting existing services are not overwritten.
if [ ! -e /etc/systemd/system/mabolla-flop-tunnel.service ]; then
  python3 - <<'PY'
import os
p="/etc/systemd/system/mabolla-flop-tunnel.service"
fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o644)
with os.fdopen(fd,"w") as f:
 f.write("""[Unit]
Description=Mabolla FLOP HTTPS tunnel
After=network-online.target
Wants=network-online.target
[Service]
ExecStart=/usr/local/lib/mabolla-flop/cloudflared-2026.10.7 tunnel --no-autoupdate --url http://127.0.0.1:8645
Restart=on-failure
RestartSec=10
NoNewPrivileges=true
PrivateTmp=true
[Install]
WantedBy=multi-user.target
""")
PY
else
  grep -Fq "ExecStart=$BIN tunnel --no-autoupdate --url http://127.0.0.1:8645" /etc/systemd/system/mabolla-flop-tunnel.service
fi
systemctl daemon-reload
systemctl enable --now mabolla-flop-tunnel
HOST=''
for attempt in $(seq 1 12); do
 HOST="$(journalctl -u mabolla-flop-tunnel -b --no-pager -n 200 | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1 || true)"
 [ -n "$HOST" ] && break
 sleep 5
done
[[ "$HOST" =~ ^https://[a-z0-9-]+\.trycloudflare\.com$ ]] || { echo 'No verified tunnel hostname; worker not started'; exit 1; }
python3 - "${HOST#https://}" <<'PY'
import os,sys
p="miner.env"
lines=open(p).read().splitlines()
lines=[x for x in lines if not x.startswith("SESSION_PUBLIC_HOST=")]
lines.append("SESSION_PUBLIC_HOST="+sys.argv[1])
tmp=p+".activating"
fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
with os.fdopen(fd,"w") as f:f.write("\n".join(lines)+"\n")
os.replace(tmp,p)
PY
FLOP_CLI="$CLI" bash ./decode-policy.sh miner.env
"${C[@]}" up -d worker
verified=0
for attempt in $(seq 1 18); do
 code="$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' "$HOST/session/info" || true)"
 if [ "$code" = 401 ]; then verified=1; break; fi
 sleep 5
done
[ "$verified" = 1 ] || { echo 'Public endpoint not verified; inspect worker/tunnel, do not recreate identity'; exit 1; }
printf 'HTTPS endpoint verified: %s (401 unauthorized)\n' "$HOST"
echo 'Worker started. Calibration is NOT yet proven: inspect on-chain calibration and verified jobs.'
