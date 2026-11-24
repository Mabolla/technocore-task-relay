import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyIdentity, validateChain, preflight, GENESIS, RPC } from '../scripts/flop-testnet-preflight.mjs';
const good = { genesis: GENESIS, runtime: { specName: 'flop-testnet', specVersion: 1014035 }, health: { isSyncing: false, peers: 6 }, finalized: '0x' + 'a'.repeat(64) };
test('existing public DID and SS58 match without a private key', () => assert.equal(verifyIdentity(), true));
test('alternate identity rejected', () => assert.throws(() => verifyIdentity('did:key:other')));
test('Devnet and unknown runtime rejected', () => {
  assert.throws(() => validateChain({ ...good, genesis: '0x' + '0'.repeat(64) }));
  assert.throws(() => validateChain({ ...good, runtime: { ...good.runtime, specVersion: 1014036 } }));
});
test('syncing and missing finality rejected', () => {
  assert.throws(() => validateChain({ ...good, health: { isSyncing: true, peers: 6 } }));
  assert.throws(() => validateChain({ ...good, finalized: null }));
});
test('only pinned read-only RPC methods; signing remains disabled', async () => {
  const values = [good.genesis, good.runtime, good.health, good.finalized];
  let calls = 0;
  const result = await preflight(async (url, options) => {
    assert.equal(url, RPC); assert.equal(options.redirect, 'error');
    const request = JSON.parse(options.body);
    assert.ok(['chain_getBlockHash', 'state_getRuntimeVersion', 'system_health', 'chain_getFinalizedHead'].includes(request.method));
    calls++;
    return Response.json({ jsonrpc: '2.0', id: request.id, result: values[request.id] });
  });
  assert.equal(calls, 4); assert.equal(result.signing_enabled, false); assert.equal(result.inference_enabled, false);
});
test('HTTP error is not retried', async () => {
  let calls = 0;
  await assert.rejects(preflight(async () => { calls++; return new Response('', { status: 429 }); }));
  assert.equal(calls, 1);
});
