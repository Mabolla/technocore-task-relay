import { test } from 'node:test';
import assert from 'node:assert/strict';
import { githubClaim } from './flop-github-claim.mjs';
import { runOnce } from './flop-session-attempt.mjs';

test('simulated GitHub grants exactly one claim across independent clients', async () => {
  const sha = 'a'.repeat(40);
  let exists = false, sent = 0;
  const request = async (_, options) => {
    const { ref } = JSON.parse(options.body);
    if (exists) return { status: 422 };
    exists = true;
    return { status: 201, json: async () => ({ ref, object: { sha } }) };
  };
  const run = () => runOnce({ claim: githubClaim({ token: 'fixture', sha, request }),
    submit: async () => { sent++; throw Error('ambiguous'); } });
  await Promise.allSettled([run(), run()]);
  await assert.rejects(run(), /not exclusively reserved/);
  assert.equal(sent, 1);
});

test('unexpected creation response fails closed', async () => {
  const claim = githubClaim({ token: 'fixture', sha: 'a'.repeat(40),
    request: async () => ({ status: 201, json: async () => ({ ref: 'other' }) }) });
  await assert.rejects(runOnce({ claim, submit: () => assert.fail('unexpected submit') }));
});
