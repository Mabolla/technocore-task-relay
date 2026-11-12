import { test } from 'node:test';
import assert from 'node:assert/strict';
import { read, verify, genesis, miner } from './flop-direct-preflight.mjs';

const calibration = { phase: 'Active', leaseState: 'active', observationHead: 'finalized',
  observedAtBlock: 100, expiresAtBlock: 200 };
const row = { address: miner, isActive: true, blacklisted: false, calibration };
test('retries a transient read-only 503 once', async () => {
  let calls = 0;
  await assert.rejects(read('https://example.invalid', undefined, {
    label: 'RPC genesis', pause: async () => {},
    request: async () => { calls++; return { status: 503 }; },
  }), /RPC genesis returned HTTP 503/);
  assert.equal(calls, 2);
});
test('does not retry a 503 carrying Retry-After', async () => {
  let calls = 0;
  await assert.rejects(read('https://example.invalid', undefined, {
    request: async () => { calls++; return { status: 503, headers: new Headers({'retry-after': '60'}) }; },
  }), /HTTP 503/);
  assert.equal(calls, 1);
});
test('accepts active finalized calibration observation', () => assert.equal(verify(genesis, row, 110).miner, miner));
test('rejects wrong genesis', () => assert.throws(() => verify('wrong', row, 110)));
test('rejects lease expired at RPC head', () => assert.throws(() => verify(genesis, row, 200)));
test('rejects stale explorer observation', () => assert.throws(() =>
  verify(genesis, { ...row, calibration: { ...calibration, expiresAtBlock: 500 } }, 221)));
for (const patch of [{ observationHead: 'best' }, { expiresAtBlock: 100 }, { leaseState: 'unknown' }]) {
  test(`rejects ${JSON.stringify(patch)}`, () =>
    assert.throws(() => verify(genesis, { ...row, calibration: { ...calibration, ...patch } }, 110)));
}
