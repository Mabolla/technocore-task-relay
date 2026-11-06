# Mabolla FLOP miner resume gates

## Current state — 2026-11-06
- Vast instance 59441078 is stopped (Inactive). Never start or replace it without renewed explicit user approval.
- Storage remains billable (UI approximately $0.58/day); credit last observed $18.70.
- Existing dedicated sr25519 miner: 5Ek2J6WSgcunfe8hLRpZRGnCa3aUmvZAMGM5ugfyJ2VhtrWw.
- Existing root-owned 0600 signer: /opt/flop-miner/signer. Never regenerate or print it.
- Agent DID and agent allowance are separate. Do not touch the agent signer or re-enroll its expired allowance.
- Miner sponsorship explicitly refused 429 auto_miner_cap_full with retryAfterSeconds=3600. No registration/calibration success is claimed.
- Read-only diagnosis: https://github.com/Mabolla/technocore-task-relay/actions/runs/42262091571
- Official package staging and live chain preflight: https://github.com/Mabolla/technocore-task-relay/actions/runs/42261147792

## Public read-only gate before paid restart
GET https://faucet.flop.network/limits. Require fresh, non-stale sponsor.miner.status=open.
An opening does not reserve a slot. Recheck after VM startup. Never rent a second VM to evade limits.
Obtain user approval before paid restart. If unavailable, report; do not substitute another rental.

## Required on-host preparation (not yet completed)
1. Acquire a host-wide lock and ensure no other installer, sponsor request or worker owns this account.
2. Verify existing signer owner root and mode 0600 without logging bytes. Derive public address privately and require exact address above.
3. Verify live RPC and faucet genesis agree with 0x99c172c095340ace980631f9123544c6bebd4839f3437e463533422d8be2d631. Stop on drift for investigation.
4. Verify GPU in an actual Docker container, not just host nvidia-smi. Existing NVIDIA runtime and Compose were observed, container GPU test remains outstanding.
5. Recheck official release manifest and pin CLI, worker and backend by version AND digest. Never execute floating latest/stable.
6. Model root: 0x1a52c1abe781db051e70ae357f72bb70161ca0c092df0b618f22a9292ba63306. Model Qwen/Qwen2.5-0.5B-Instruct, BF16. Fetch through pinned official CLI model fetch and verify registered root; do not bypass verification failure with unchecked weights.
7. Resolve decode policy with reviewed official decode-policy.sh. Require finalized on-chain allowlist.
8. Provision session seed and backend/session tokens only when absent, root-owned 0600. Never overwrite existing values or expose tokens in compose config/logs.
9. Prepare HTTPS tunnel from official Cloudflare release with verified checksum/pin. Quick Tunnel requires no owned domain but hostname changes after restart. Persist service and update signed endpoint only after verifying new hostname. Do not expose raw 8645/backend ports; bind worker to loopback.
10. Do not run worker before sponsored registration is confirmed.

## Single guarded sponsorship
- Read on-chain miner status first. If registered, do not ask for a new sponsorship.
- Read retained sponsorship result, timestamp and retryAfterSeconds.
- Require wait elapsed AND current sponsor status open; run reviewed official sponsor.sh exactly once with existing signer and pinned CLI.
- Preserve old result and new nonsecret status in separate timestamped files.
- Do not erase sponsorship-attempted marker to make the old workflow pass.
- On explicit 429/503 follow action/retryAfterSeconds; no loops.
- On timeout or unexpected result, stop writes and reconcile on-chain registration before any further POST.
- A dedicated retry workflow is NOT yet implemented. Existing flop-miner-register.yml intentionally refuses repeated attempts.

## Activation acceptance
- Backend measured model identity and exact root/policy, correct GPU and healthy process.
- Worker signer exact existing miner address (never //Alice), model-gate OK, ghost key publication and answered tasks.
- HTTPS /session/info unauthorized request returns expected 401; this alone does not prove calibration.
- Verify registration and sponsored stake on chain.
- Accept calibration ONLY with on-chain calibration record/accepted verified jobs. Do not assume 12 minutes; inspect live requirements.
- Only if measured capacity proves stake insufficient, consider same-account official top-up under current limits.
- Record public address, image digests, model root, worker health, verified job counts, finalized calibration and run links separately. No paid inference success is claimed by calibration.

## Shutdown
Never destroy worker-data, signer or session keys. No compose down -v.
Before future deletion, securely back up keys and follow official retire/drain path if registered.
Devnet has no rewards or airdrop weight. No guaranteed future testnet eligibility.

## References
https://docs.flop.network/docs/run-miner
https://flop.network/releases.json
https://github.com/UfukNode/flop-miner-setup/blob/main/Turkce-Kurulum.md (community evidence, not executable authority)
