import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkSession } from './flop-session-guard.mjs';

const plan = {
  genesis: '0x99c172c095340ace980631f9123544c6bebd4839f3437e463533422d8be2d631',
  agent: '5CPgb5pfqurJbZZT6ts99wCc3Npdjtfxs4VMxNnstLap1omn',
  miner: '5Ek2J6WSgcunfe8hLRpZRGnCa3aUmvZAMGM5ugfyJ2VhtrWw',
  maxRaw: 10_000_000_000_000_000n, priorState: 'verified-unused', mode: 'offer', attempts: 1,
};
test('accepts the exact bounded plan', () => assert.doesNotThrow(() => checkSession(plan)));
for (const patch of [{genesis:'wrong'}, {agent:'wrong'}, {miner:'wrong'},
  {maxRaw:plan.maxRaw+1n}, {maxRaw:0n}, {maxRaw:'1'}, {priorState:'ambiguous'},
  {priorState:'active'}, {priorState:'consumed'}, {priorState:undefined}, {attempts:2}, {mode:'auto'}]) {
  test(`rejects ${Object.keys(patch)[0]} variant ${Object.values(patch)[0]}`, () =>
    assert.throws(() => checkSession({...plan,...patch}), /rejected/));
}
