// The adapter must implement an atomic, persistent create-if-absent.
// A runner-local file or GitHub Actions concurrency group is not sufficient.
const attemptKey = 'mabolla-devnet-own-miner-direct-v1';

export async function runOnce({ claim, submit }) {
  if (await claim(attemptKey) !== true) throw Error('Attempt not exclusively reserved');
  // Never release the claim: a thrown error cannot prove no write occurred.
  return submit(attemptKey);
}
