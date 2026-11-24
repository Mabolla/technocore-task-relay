import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const DID = 'did:key:z6MkfRm7VkjC52pff11L12dbFkChhVkiZqv5Wwd7VMo3fCsG';
export const ADDRESS = '5CPgb5pfqurJbZZT6ts99wCc3Npdjtfxs4VMxNnstLap1omn';
export const GENESIS = '0x918abd58fb16306b30ef3886514cfaebffecb4de43e82b6f8ec4795c43cfd800';
export const RPC = 'https://testnet.flop.network/';
function decode(value) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n;
  for (const char of value) {
    const index = alphabet.indexOf(char);
    if (index < 0) throw Error('Invalid base58');
    n = n * 58n + BigInt(index);
  }
  return Buffer.from(n.toString(16).padStart(2, '0').replace(/^(?=(?:..)*.$)/, '0'), 'hex');
}
export function verifyIdentity(did = DID, address = ADDRESS) {
  if (did !== DID || address !== ADDRESS) throw Error('Alternate identity forbidden');
  const key = decode(did.slice(9));
  const account = decode(address);
  const sum = createHash('blake2b512').update('SS58PRE').update(account.subarray(0, 33)).digest().subarray(0, 2);
  if (key.length !== 34 || key[0] !== 237 || key[1] !== 1 || account.length !== 35 || account[0] !== 42 ||
      !sum.equals(account.subarray(33)) || !key.subarray(2).equals(account.subarray(1, 33))) throw Error('Identity mismatch');
  return true;
}
export function validateChain({ genesis, runtime, health, finalized }) {
  if (genesis !== GENESIS) throw Error('Wrong genesis; no writes allowed');
  if (runtime?.specName !== 'flop-testnet' || runtime.specVersion !== 1014035) throw Error('Runtime requires review');
  if (health?.isSyncing !== false || !Number.isInteger(health.peers) || health.peers < 1) throw Error('Chain health unverified');
  if (!/^0x[0-9a-f]{64}$/.test(finalized ?? '')) throw Error('Finality unverified');
  return true;
}
export async function preflight(fetchImpl = fetch) {
  verifyIdentity();
  const methods = ['chain_getBlockHash', 'state_getRuntimeVersion', 'system_health', 'chain_getFinalizedHead'];
  const results = [];
  for (const [id, method] of methods.entries()) {
    const response = await fetchImpl(RPC, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params: id === 0 ? [0] : [] }) });
    if (!response.ok) throw Error('RPC unavailable; no retries');
    const body = await response.json();
    if (body.id !== id || body.jsonrpc !== '2.0' || body.error || !Object.hasOwn(body, 'result')) throw Error('RPC protocol mismatch');
    results.push(body.result);
  }
  const [genesis, runtime, health, finalized] = results;
  validateChain({ genesis, runtime, health, finalized });
  return { checked_at: new Date().toISOString(), did: DID, address: ADDRESS, rpc: RPC, genesis,
    spec_version: runtime.specVersion, finalized, peers: health.peers, identity_verified: true,
    read_only: true, signing_enabled: false, enrollment_enabled: false, inference_enabled: false,
    pending: ['Official Testnet faucet and finalized funding', 'Official Testnet enrollment statement and model scope',
      'Verified Testnet inference/receipt route', 'Reviewed same-identity workflow and no active or ambiguous request'] };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await preflight(), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
