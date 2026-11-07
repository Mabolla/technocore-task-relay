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
CLI=ghcr.io/flop-labs/flop-core/cli:v0.1.290@sha256:24e32b034b0d3600ee28127dad30d4228e623235f2dc62da34c2c85ba5e21a88
WORKER=ghcr.io/flop-labs/flop-core/miner-worker:v0.1.286@sha256:78211fe5f63820eeb1191e834f3a1eb7f573bc34348bdd4c0b0f07c7824fe7b5
BACKEND=ghcr.io/flop-labs/flop-core/miner-vllm-toploc:v0.1.239@sha256:9b6c6dfc4d77ac37583d28dbfdcb4fa96207ae95956c1e859b7d5e9eef6f7b9e
MODEL=0x1a52c1abe781db051e70ae357f72bb70161ca0c092df0b618f22a9292ba63306
RPC=wss://rpc.devnet.flop.network
# Dedicated existing Vast VM only. Do not repair a missing host driver.
command -v nvidia-smi >/dev/null
nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv
nvidia-smi --query-gpu=name --format=csv,noheader | grep -Fx 'NVIDIA GeForce RTX 5090'
gpu_probe() {
  timeout 35 docker run --rm --pull never --network none --gpus all --entrypoint nvidia-smi "$BACKEND" --query-gpu=name,driver_version,memory.total --format=csv
}
if ! gpu_probe; then
  . /etc/os-release
  case "$ID" in ubuntu|debian) ;; *) echo 'Unsupported OS for this repair'; exit 1;; esac
  test -d /run/systemd/system
  test -z "$(docker ps -q)" || { echo 'Running containers; no daemon restart'; exit 1; }
  if ! command -v nvidia-ctk >/dev/null; then
    nvidia_tmp=$(mktemp -d)
    trap 'rm -f -- "$nvidia_tmp/key" "$nvidia_tmp/keyring.gpg"; rmdir -- "$nvidia_tmp"' EXIT
    curl -fsS --max-time 20 https://nvidia.github.io/libnvidia-container/gpgkey -o "$nvidia_tmp/key"
    key_fpr=$(gpg --batch --show-keys --with-colons "$nvidia_tmp/key" | awk -F: '$1=="fpr"{print $10;exit}')
    test "$key_fpr" = C95B321B61E88C1809C4F759DDCAE044F796ECB0
    gpg --batch --dearmor -o "$nvidia_tmp/keyring.gpg" "$nvidia_tmp/key"
    install -m 0644 "$nvidia_tmp/keyring.gpg" /usr/share/keyrings/mabolla-nvidia-container-toolkit.gpg
    if ! grep -qs 'nvidia.github.io/libnvidia-container/stable/deb' /etc/apt/sources.list /etc/apt/sources.list.d/*; then
      printf '%s\n' 'deb [signed-by=/usr/share/keyrings/mabolla-nvidia-container-toolkit.gpg] https://nvidia.github.io/libnvidia-container/stable/deb/$(ARCH) /' > /etc/apt/sources.list.d/mabolla-nvidia-container-toolkit.list
    fi
    timeout 120 apt-get -o Acquire::Retries=0 -o Acquire::https::Timeout=20 update
    export DEBIAN_FRONTEND=noninteractive
    timeout 180 apt-get install -y --no-remove --no-install-recommends nvidia-container-toolkit=1.20.1-1 nvidia-container-toolkit-base=1.20.1-1 libnvidia-container-tools=1.20.1-1 libnvidia-container1=1.20.1-1
  fi
  test -z "$(docker ps -q)" || { echo 'Running containers; no daemon restart'; exit 1; }
  test ! -L /etc/docker/daemon.json
  repair_backup=$(mktemp -d /opt/flop-miner/docker-runtime-repair.XXXXXXXX)
  if test -f /etc/docker/daemon.json; then cp -p -- /etc/docker/daemon.json "$repair_backup/daemon.json"; fi
  rollback_runtime() {
    if test -f "$repair_backup/daemon.json"; then cp -p -- "$repair_backup/daemon.json" /etc/docker/daemon.json; else rm -f -- /etc/docker/daemon.json; fi
    timeout 45 systemctl restart docker
  }
  if ! nvidia-ctk runtime configure --runtime=docker || ! timeout 45 systemctl restart docker || ! gpu_probe; then
    rollback_runtime
    echo 'GPU probe failed; Docker configuration rolled back'
    exit 1
  fi
fi
echo 'NVIDIA_DOCKER_GPU_VERIFIED'
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
# Reuse only a verified receipt on this exact host. Never redownload on an unexplained refusal.
if [ ! -e prepare-model.json ]; then
  docker run --rm --network host -v /opt/flop-miner:/work "$CLI" --network devnet --rpc "$RPC" model fetch "$MODEL" --precision BF16 --output-dir /work/models/qwen2.5-0.5b-instruct --json > prepare-model.json
fi
python3 - "$MODEL" <<'PY'
import json,re,sys,pathlib
p=pathlib.Path('prepare-model.json')
assert p.is_file() and not p.is_symlink() and p.stat().st_size < 1048576
d=json.loads(p.read_text())
assert isinstance(d,dict)
root=d.get('verified_root')
err=d.get('error') or d.get('code')
if isinstance(err,dict): err=err.get('code')
if not isinstance(err,str) or not re.fullmatch(r'[a-zA-Z0-9_-]{1,100}',err): err=None
print(json.dumps({'fields':[k for k in d if re.fullmatch(r'[a-zA-Z0-9_-]{1,50}',k)][:40], 'ok': d.get('ok') if isinstance(d.get('ok'),bool) else None, 'verified_root':root if isinstance(root,str) and re.fullmatch(r'0x[a-f0-9]{64}',root) else None,'error_code':err}),flush=True)
assert d.get('ok') is not False and d.get('success') is not False and not d.get('error'), 'CLI returned an explicit model refusal'
assert root==sys.argv[1], 'Measured model root missing or mismatched'
checkpoint=pathlib.Path('models/qwen2.5-0.5b-instruct')
assert (checkpoint/'config.json').is_file() and any(p.is_file() for p in checkpoint.glob('*.safetensors')), 'Verified checkpoint files not present'
PY
if [ ! -e miner.env ]; then install -m 600 miner.env.example miner.env; fi
python3 - "$CLI" "$WORKER" "$BACKEND" <<'PY'
import os,secrets,sys
p="miner.env"
assert not os.path.islink(p)
lines=open(p).read().splitlines()
updates=dict(zip(("FLOP_CLI","FLOP_WORKER_IMAGE","FLOP_BACKEND_IMAGE"),sys.argv[1:]))
updates.update(WORKER_NAME="mabolla-devnet-miner-01",COMPOSE_PROJECT_NAME="mabolla-flop-miner",SESSION_BIND_IP="127.0.0.1",SESSION_HOST_PORT="8645",MODEL_NAME="Qwen/Qwen2.5-0.5B-Instruct",MODEL_HASH="0x1a52c1abe781db051e70ae357f72bb70161ca0c092df0b618f22a9292ba63306",MODEL_CHECKPOINT_DIR="/opt/flop-miner/models/qwen2.5-0.5b-instruct",MODEL_PRECISION="BF16",TOPLOC_PRECISION="bf16",OPENROUTER_MODEL_SLUG="qwen/qwen2.5-0.5b-instruct")
existing=dict(x.split("=",1) for x in lines if x and not x.startswith("#") and "=" in x)
for k in ("INFERENCE_API_KEY","SESSION_AUTH_TOKEN"):
    value=existing.get(k,"")
    template=dict(x.split("=",1) for x in open("miner.env.example").read().splitlines() if x and not x.startswith("#") and "=" in x)
    if not value or value==template.get(k): updates[k]=secrets.token_hex(32)
    elif len(value)<32: raise SystemExit("Existing private session credential too short; no activation")
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
