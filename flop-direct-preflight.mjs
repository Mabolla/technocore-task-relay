import { pathToFileURL } from 'node:url';

export const genesis = '0x99c172c095340ace980631f9123544c6bebd4839f3437e463533422d8be2d631';
export const miner = '5Ek2J6WSgcunfe8hLRpZRGnCa3aUmvZAMGM5ugfyJ2VhtrWw';
const explorer = 'https://explorer.devnet.flop.network';

export function verify(rpcGenesis, row, finalizedHeight) {
  if (rpcGenesis !== genesis) throw Error('Devnet genesis mismatch');
  const c = row?.calibration;
  if (row?.address !== miner || row.isActive !== true || row.blacklisted !== false)
    throw Error('Expected active miner identity not verified');
  if (c?.phase !== 'Active' || c.leaseState !== 'active')
    throw Error('Explorer did not report an active calibration lease');
  if (c.observationHead !== 'finalized' || !Number.isSafeInteger(c.observedAtBlock) || c.observedAtBlock <= 0)
    throw Error('Explorer calibration has no valid finalized observation');
  if (!Number.isSafeInteger(finalizedHeight) || finalizedHeight < c.observedAtBlock)
    throw Error('RPC finalized height is invalid or behind Explorer observation');
  if (finalizedHeight - c.observedAtBlock > 120)
    throw Error('Explorer calibration observation is stale relative to RPC');
  if (!Number.isSafeInteger(c.expiresAtBlock) || c.expiresAtBlock <= finalizedHeight)
    throw Error('Calibration expiry is missing or already reached');
  return { miner, observedAtBlock: c.observedAtBlock, expiresAtBlock: c.expiresAtBlock };
}

export async function read(url, options, { label, request = fetch,
  pause = () => new Promise(resolve => setTimeout(resolve, 1500)) } = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await request(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (res.ok) return res.json();
    if (attempt === 0 && [502, 503, 504].includes(res.status) && !res.headers?.has('retry-after')) {
      await pause();
      continue;
    }
    throw Error(`${label ?? 'Read-only endpoint'} returned HTTP ${res.status}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const rpc = async (method, params = []) => {
    const response = await read('https://rpc.devnet.flop.network', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }, { label: `Devnet RPC ${method}` });
    if (response?.error || response?.result == null) throw Error('RPC observation unavailable');
    return response.result;
  };
  const [rpcGenesis, row] = await Promise.all([
    rpc('chain_getBlockHash', [0]),
    read(`${explorer}/api/miners/${miner}`, undefined, { label: 'Explorer miner calibration' }),
  ]);
  const head = await rpc('chain_getFinalizedHead');
  if (!/^0x[0-9a-f]{64}$/i.test(head)) throw Error('Invalid finalized head');
  const header = await rpc('chain_getHeader', [head]);
  if (!/^0x[0-9a-f]+$/i.test(header.number)) throw Error('Invalid finalized height');
  const finalizedHeight = Number(header.number);
  console.log(JSON.stringify({ ...verify(rpcGenesis, row, finalizedHeight), finalizedHeight, mode: 'read-only', executionAuthorized: false }));
}
