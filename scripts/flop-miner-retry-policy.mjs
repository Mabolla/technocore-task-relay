// Pure decision function. This module cannot sign, enroll, start a VM or run SSH.
export function minerRetryDecision(s, now = Date.now()) {
  const deny = reason => ({allowed:false,reason});
  if (!s || !Number.isFinite(now)) return deny('invalid_input');
  if (s.activeRun !== false) return deny('active_or_unknown_run');
  if (s.registered !== false) return deny('registered_or_unknown');
  if (s.address !== '5Ek2J6WSgcunfe8hLRpZRGnCa3aUmvZAMGM5ugfyJ2VhtrWw')
    return deny('identity_mismatch');
  if (s.genesis !== '0x99c172c095340ace980631f9123544c6bebd4839f3437e463533422d8be2d631')
    return deny('genesis_mismatch');
  if (s.signerRootOwned !== true || s.signerMode !== '600') return deny('unsafe_signer');
  const p=s.previous;
  if (!p || p.httpStatus!==429 || p.reason!=='auto_miner_cap_full' ||
      p.action!=='retry_later' || !Number.isFinite(p.retryAfterSeconds) ||
      p.retryAfterSeconds<0 || !Number.isFinite(p.completedAt))
    return deny('previous_outcome_not_explicit_cap_refusal');
  if (p.completedAt>now || now-p.completedAt<p.retryAfterSeconds*1000)
    return deny('retry_after_not_elapsed');
  const l=s.limits, age=now-Date.parse(l?.asOf), m=l?.sponsor?.miner;
  if(l?.network!=='devnet' || l?.stale!==false || !Number.isFinite(age) ||
     age < -60000 || age > 180000) return deny('stale_or_invalid_limits');
  if(m?.status!=='open' || m?.automatic?.open!==true ||
     !Number.isInteger(m.automatic.uncalibrated) || !Number.isInteger(m.automatic.max) ||
     m.automatic.uncalibrated<0 || m.automatic.max<=0 ||
     m.automatic.uncalibrated>=m.automatic.max) return deny('sponsor_not_open');
  if(s.attemptsThisCheck!==0) return deny('attempt_already_consumed_or_unknown');
  if(s.userAuthorizedPaidResume!==true || s.instanceRunning!==true)
    return deny('paid_resume_not_authorized_or_not_running');
  return {allowed:true,reason:'one_same_identity_attempt_permitted',maxAttempts:1};
}
