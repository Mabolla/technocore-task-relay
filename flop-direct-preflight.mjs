import { pathToFileURL } from 'node:url';

export const genesis = '0x99c172c095340ace980631f9123544c6bebd4839f3437e463533422d8be2d631';
export const miner = '5Ek2J6WSgcunfe8hLRpZRGnCa3aUmvZAMGM5ugfyJ2VhtrWw';
const explorer = 'https://explorer.devnet.flop.network';

export function verify(rpcGenesis, row, finalizedHeight) {
  if (rpcGenesis !== genesis) throw Error('Devnet genesis mismatch');
  const c = row?.calibration;
  if (row?.address !== miner || row.isActive !== true || row.blacklisted !== false ||
      c?.phase !== 'Active' || c.leaseState !== 'active' || c.observationHead !== 'finalized' ||
      !Number.isSafeInteger(c.observedAtBlock) || c.observedAtBlock <= 0 ||
      !Number.isSafeInteger(finalizedHeight) || finalizedHeight < c.observedAtBlock ||
      finalizedHeight - c.observedAtBlock > 120 ||
      !Number.isSafeInteger(c.expiresAtBlock) || c.expiresAtBlock <= finalizedHeight) {
    throw Error('Active miner calibration not verified');
  }
  return { miner, observedAtBlock: c.observedAtBlock, expiresAtBlock: c.expiresAtBlock };
}

async function read(url, options) {
  const res = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw Error(`Read-only endpoint returned HTTP ${res.status}`);
  return res.json();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const rpc = async (method, params = []) => {
    const response = await read('https://rpc.devnet.flop.network', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    if (response?.error || response?.result == null) throw Error('RPC observation unavailable');
    return response.result;
  };
  const [rpcGenesis, row] = await Promise.all([
    rpc('chain_getBlockHash', [0]),
    read(`${explorer}/api/miners/${miner}`),
  ]);
  const head = await rpc('chain_getFinalizedHead');
  if (!/^0x[0-9a-f]{64}$/i.test(head)) throw Error('Invalid finalized head');
  const header = await rpc('chain_getHeader', [head]);
  if (!/^0x[0-9a-f]+$/i.test(header.number)) throw Error('Invalid finalized height');
  const finalizedHeight = Number(header.number);
  console.log(JSON.stringify({ ...verify(rpcGenesis, row, finalizedHeight), finalizedHeight, mode: 'read-only', executionAuthorized: false }));
}
