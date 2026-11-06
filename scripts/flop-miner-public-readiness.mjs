// Read-only: no enrollment, signing, SSH, paid restart or credential access.
export function evaluateLimits(d, now = Date.now()) {
  const age = now - Date.parse(d?.asOf);
  const m = d?.sponsor?.miner;
  const valid = d?.network === 'devnet' && d?.stale === false &&
    Number.isFinite(age) && age >= -60000 && age <= 180000 &&
    typeof m?.automatic?.open === 'boolean' &&
    Number.isInteger(m?.automatic?.uncalibrated) &&
    Number.isInteger(m?.automatic?.max) &&
    m.automatic.uncalibrated >= 0 && m.automatic.max > 0;
  if (!valid) return {ready:false, reason:'invalid_or_stale_limits'};
  return {
    ready:m.status === 'open' && m.automatic.open === true &&
      m.automatic.uncalibrated < m.automatic.max,
    reason:m.status,
    occupancy:m.automatic.uncalibrated,
    capacity:m.automatic.max,
    asOf:d.asOf,
    paidRestartAuthorized:false,
    warning:'An opening is not a reservation. User approval and fresh on-host gates are required.'
  };
}
if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://').href) {
  try {
    const r=await fetch('https://faucet.flop.network/limits',{signal:AbortSignal.timeout(15000),redirect:'error'});
    if(!r.ok) throw new Error('limits_http_'+r.status);
    const result=evaluateLimits(await r.json());
    console.log(JSON.stringify(result,null,2));
    process.exitCode=result.ready?0:2;
  } catch(e) {
    console.log(JSON.stringify({ready:false,reason:String(e.message),paidRestartAuthorized:false}));
    process.exitCode=2;
  }
}
