#!/usr/bin/env bash
# Explicitly invoked on the existing host only; never starts a paid VM or signs transactions.
set -euo pipefail
umask 077
[ "$(id -u)" = 0 ] || { echo 'Root required'; exit 1; }
[ "${1:-}" = '--prepare-existing-host' ] || { echo 'Explicit prepare flag required'; exit 1; }
exec 9>/run/lock/mabolla-flop-miner.lock
flock -n 9 || { echo 'Another miner operation is active'; exit 1; }
cd /opt/flop-miner
[ -f signer ] && [ ! -L signer ]
[ "$(stat -c %u signer)" = 0 ] && [ "$(stat -c %a signer)" = 600 ]
CLI=ghcr.io/flop-labs/flop-core/cli:v0.1.220@sha256:c8f3456c48d41cec9d0229d1e1dd9eb8d6247a22f350c51078d85f129601bbbd
WORKER=ghcr.io/flop-labs/flop-core/miner-worker:v0.1.286@sha256:78211fe5f63820eeb1191e834f3a1eb7f573bc34348bdd4c0b0f07c7824fe7b5
BACKEND=ghcr.io/flop-labs/flop-core/miner-vllm-toploc:v0.1.239@sha256:9b6c6dfc4d77ac37583d28dbfdcb4fa96207ae95956c1e859b7d5e9eef6f7b9e
MODEL=0x1a52c1abe781db051e70ae357f72bb70161ca0c092df0b618f22a9292ba63306
RPC=wss://rpc.devnet.flop.network
docker compose version
docker pull "$CLI"
# Derive ONLY the public address. Secret stays in its read-only container mount.
address="$(docker run --rm --network none -v /opt/flop-miner/signer:/work/signer:ro --entrypoint node "$CLI" --input-type=module -e 'import {readFileSync} from "node:fs";import {Keyring} from "@polkadot/api";import {cryptoWaitReady} from "@polkadot/util-crypto";await cryptoWaitReady();console.log(new Keyring({type:"sr25519",ss58Format:42}).addFromUri(readFileSync("/work/signer","utf8").trim()).address);')"
[ "$address" = '5Ek2J6WSgcunfe8hLRpZRGnCa3aUmvZAMGM5ugfyJ2VhtrWw' ] || { echo 'Miner identity mismatch'; exit 1; }
docker run --rm --network host "$CLI" --network devnet --rpc "$RPC" network status --json > prepare-network.json
python3 -c 'import json;d=json.load(open("prepare-network.json"));assert d["rpc"]["genesis_hash"]=="0x99c172c095340ace980631f9123544c6bebd4839f3437e463533422d8be2d631" and d["faucet"]["matches_rpc"] is True'
docker pull "$WORKER"
docker pull "$BACKEND"
docker run --rm --network none --gpus all --entrypoint nvidia-smi "$BACKEND" --query-gpu=name,driver_version,memory.total --format=csv
# CLI measures registered bytes; verification failure stops preparation.
docker run --rm --network host -v /opt/flop-miner:/work "$CLI" --network devnet --rpc "$RPC" model fetch "$MODEL" --precision BF16 --output-dir /work/models/qwen2.5-0.5b-instruct --json > prepare-model.json
python3 -c 'import json;d=json.load(open("prepare-model.json"));assert d.get("ok") is True,"Model fetch not verified"'
if [ ! -e miner.env ]; then install -m 600 miner.env.example miner.env; fi
python3 - "$CLI" "$WORKER" "$BACKEND" <<'PY'
import os,secrets,sys
p="miner.env"
assert not os.path.islink(p)
lines=open(p).read().splitlines()
updates=dict(zip(("FLOP_CLI","FLOP_WORKER_IMAGE","FLOP_BACKEND_IMAGE"),sys.argv[1:]))
updates.update(WORKER_NAME="mabolla-devnet-miner-01",COMPOSE_PROJECT_NAME="mabolla-flop-miner",SESSION_BIND_IP="127.0.0.1",SESSION_HOST_PORT="8645")
existing=dict(x.split("=",1) for x in lines if x and not x.startswith("#") and "=" in x)
for k in ("INFERENCE_API_KEY","SESSION_AUTH_TOKEN"):
    if not existing.get(k): updates[k]=secrets.token_hex(32)
out=[x for x in lines if x.split("=",1)[0] not in updates]
out.extend(k+"="+v for k,v in updates.items())
tmp=p+".preparing"
fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
with os.fdopen(fd,"w") as f:f.write("\n".join(out)+"\n")
os.replace(tmp,p)
os.chmod(p,0o600)
os.makedirs("session-keys",mode=0o700,exist_ok=True)
key="session-keys/enclave.seed"
if not os.path.exists(key):
    fd=os.open(key,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,"w") as f:f.write(secrets.token_hex(32)+"\n")
PY
FLOP_CLI="$CLI" bash ./decode-policy.sh miner.env
docker compose --env-file miner.env -f docker-compose.miner.yml -f docker-compose.backend.yml config --quiet
echo 'PREPARATION_GATES_PASSED: images/GPU/model/policy/config'
echo 'NOT ACTIVATED: no sponsor request, no worker start, no tunnel start.'
