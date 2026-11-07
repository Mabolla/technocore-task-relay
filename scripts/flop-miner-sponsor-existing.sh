#!/usr/bin/env bash
set -euo pipefail
umask 077
[ "$(id -u)" = 0 ]
[ "${1:-}" = '--one-approved-retry' ] || exit 2
exec 9>/run/lock/mabolla-flop-miner.lock
flock -n 9 || { echo 'Another miner operation active'; exit 1; }
cd /opt/flop-miner
test -f signer && test ! -L signer
[ "$(stat -c %u signer)" = 0 ] && [ "$(stat -c %a signer)" = 600 ]
CLI=ghcr.io/flop-labs/flop-core/cli:v0.1.290@sha256:24e32b034b0d3600ee28127dad30d4228e623235f2dc62da34c2c85ba5e21a88
ADDRESS=5Ek2J6WSgcunfe8hLRpZRGnCa3aUmvZAMGM5ugfyJ2VhtrWw
address="$(docker run --rm --network none -v /opt/flop-miner/signer:/work/signer:ro --entrypoint node "$CLI" --input-type=module -e 'import {readFileSync} from "node:fs";import {Keyring} from "@polkadot/api";import {cryptoWaitReady} from "@polkadot/util-crypto";await cryptoWaitReady();console.log(new Keyring({type:"sr25519",ss58Format:42}).addFromUri(readFileSync("/work/signer","utf8").trim()).address);')"
[ "$address" = "$ADDRESS" ] || { echo 'Identity mismatch'; exit 1; }
docker run --rm --network host "$CLI" --network devnet --rpc wss://rpc.devnet.flop.network network status --json > retry-network.json
python3 -c 'import json;d=json.load(open("retry-network.json"));assert d["rpc"]["genesis_hash"]=="0x99c172c095340ace980631f9123544c6bebd4839f3437e463533422d8be2d631" and d["faucet"]["matches_rpc"] is True'
docker run --rm --network host "$CLI" --network devnet --rpc wss://rpc.devnet.flop.network miner status "$ADDRESS" --json > retry-chain-status.json
python3 - <<'PY'
import json
d=json.load(open("retry-chain-status.json"))
assert d.get("registered") is False,"Already registered or unknown schema: no POST"
assert d.get("address",d.get("account"))=="5Ek2J6WSgcunfe8hLRpZRGnCa3aUmvZAMGM5ugfyJ2VhtrWw","Address/schema mismatch"
PY
# An unresolved marker survives interruption and blocks every subsequent request.
test ! -e retry-unresolved || { echo 'Previous retry unresolved; reconcile chain and result first'; exit 1; }
curl -fsSL --max-time 20 https://faucet.flop.network/limits -o retry-limits.json
python3 - <<'PY'
import json,time,os,re,datetime
p="sponsorship-result.json"
s=open(p).read()
assert re.search(r"\b429\s*\{",s),"Previous outcome is not explicit HTTP 429"
assert '"reason": "auto_miner_cap_full"' in s or re.search(r'"reason"\s*:\s*"auto_miner_cap_full"',s)
assert re.search(r'"action"\s*:\s*"retry_later"',s)
m=re.search(r'"retryAfterSeconds"\s*:\s*(\d+)',s)
assert m,"Missing Retry-After"
assert time.time()>=os.stat(p).st_mtime+int(m.group(1)),"Retry-After not elapsed"
d=json.load(open("retry-limits.json"))
age=time.time()-datetime.datetime.fromisoformat(d["asOf"].replace("Z","+00:00")).timestamp()
assert d["network"]=="devnet" and d["stale"] is False and -60<=age<=180
m=d["sponsor"]["miner"];a=m["automatic"]
assert m["status"]=="open" and a["open"] is True and 0<=a["uncalibrated"]<a["max"],"Sponsor not open"
PY
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
install -d -m 700 sponsorship-history
cp -p sponsorship-result.json "sponsorship-history/$stamp.previous.txt"
# O_EXCL prevents concurrent or interrupted attempts from silently replaying.
( set -o noclobber; printf '%s\n' "$stamp" > retry-unresolved )
set +e
FLOP_CLI="$CLI" timeout 120 bash ./sponsor.sh > "sponsorship-history/$stamp.result.txt" 2>&1
status=$?
set -e
# Nonsecret result only. Never include signer or environment dumps.
cat "sponsorship-history/$stamp.result.txt"
echo "Sponsor process exit: $status"
echo 'Outcome retained; retry-unresolved deliberately kept. Reconcile chain before any further attempt.'
exit "$status"
