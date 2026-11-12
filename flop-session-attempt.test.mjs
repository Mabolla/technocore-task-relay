import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runOnce } from './flop-session-attempt.mjs';

test('overlapping calls submit once; ambiguous failure consumes the claim', async () => {
  const claims = new Set();
  let sends = 0;
  const deps = {
    claim: async key => {
      if (claims.has(key)) return false;
      claims.add(key);
      return true;
    },
    submit: async () => { sends++; throw Error('ambiguous response'); },
  };
  await Promise.allSettled([runOnce(deps), runOnce(deps)]);
  await assert.rejects(runOnce(deps), /not exclusively reserved/);
  assert.equal(sends, 1);
});

test('uncertain claim never submits', async () => {
  await assert.rejects(runOnce({
    claim: async () => { throw Error('claim unavailable'); },
    submit: () => assert.fail('unexpected submit'),
  }), /claim unavailable/);
});
