# Miner readiness — truthful handoff
Existing Vast 59441078 is stopped. Do not restart automatically.

## Implemented
- Official package integrity, pinned FLOP image references.
- Existing signer identity, owner/mode and live genesis checks in preparation script.
- Container GPU diagnostic and registered-model fetch.
- Non-overwriting token/session key generation, policy resolution and Compose syntax gate.
- Registration gate, backend measured-root/policy health gate.
- Pinned Cloudflare Quick Tunnel download with vendor-published SHA-256.
- Loopback origin, public 401 check, gated worker startup.
- Manual test-only default workflow with distinct prepare and activate phases.
- Pure sponsorship retry decision policy with 22 passing deterministic tests.

## Outstanding — must not be described as completed
- A signed sponsorship retry executor integrating the pure decision policy is NOT implemented.
  Old register workflow intentionally blocks repeated attempts; do not blindly rerun or erase marker.
- Docker/image pulls and GPU/model/tunnel paths have NOT been executed on the stopped host.
- Actual miner-status JSON schema must be confirmed read-only; activation currently fails closed if it differs.
- Quick Tunnel restart hostname reconciliation is not automatic. Verify current hostname and rerun controlled activation after tunnel restart.
- Private key disaster-recovery backup has not been verified. Do not destroy the VM.
- Accepted calibration, successful inference and settlement remain unproven.
- No signed action is authorized merely by a test passing or a GitHub workflow boolean.

## Next executable sequence
1. Test-only workflow (no SSH, no paid host).
2. Fresh public sponsor capacity check; obtain user paid-restart authorization.
3. Start SAME host, verify SSH identity, inspect current on-chain status and retained result.
4. Prepare-host phase, inspect evidence and resolve schema/runtime failures without signing.
5. Implement/review guarded single same-signer retry; only send when fresh capacity and backoff allow.
6. On proven registration, activate-registered phase and monitor finalized calibration.
No guaranteed slot or runtime success; Devnet has no rewards/airdrop weight.
