import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verify, genesis, miner } from './flop-direct-preflight.mjs';

const calibration = { phase: 'Active', leaseState: 'active', observationHead: 'finalized',
  observedAtBlock: 100, expiresAtBlock: 200 };
const row = { address: miner, isActive: true, blacklisted: false, calibration };
test('accepts active finalized calibration observation', () => assert.equal(verify(genesis, row, 110).miner, miner));
test('rejects wrong genesis', () => assert.throws(() => verify('wrong', row, 110)));
test('rejects lease expired at RPC head', () => assert.throws(() => verify(genesis, row, 200)));
test('rejects stale explorer observation', () => assert.throws(() =>
  verify(genesis, { ...row, calibration: { ...calibration, expiresAtBlock: 500 } }, 221)));
for (const patch of [{ observationHead: 'best' }, { expiresAtBlock: 100 }, { leaseState: 'unknown' }]) {
  test(`rejects ${JSON.stringify(patch)}`, () =>
    assert.throws(() => verify(genesis, { ...row, calibration: { ...calibration, ...patch } }, 110)));
}
