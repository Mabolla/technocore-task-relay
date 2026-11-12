// Offline policy only: does not read keys, contact services, or submit work.
export function checkSession(plan) {
  if (plan.genesis !== '0x99c172c095340ace980631f9123544c6bebd4839f3437e463533422d8be2d631' ||
      plan.agent !== '5CPgb5pfqurJbZZT6ts99wCc3Npdjtfxs4VMxNnstLap1omn' ||
      plan.miner !== '5Ek2J6WSgcunfe8hLRpZRGnCa3aUmvZAMGM5ugfyJ2VhtrWw' ||
      typeof plan.maxRaw !== 'bigint' || plan.maxRaw <= 0n || plan.maxRaw > 10_000_000_000_000_000n ||
      plan.priorState !== 'verified-unused' || plan.mode !== 'offer' || plan.attempts !== 1) {
    throw new Error('Session preflight rejected');
  }
}
