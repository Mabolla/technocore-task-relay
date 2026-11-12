// Use from a reviewed workflow with repository-scoped contents:write.
// Never delete the ref automatically or retry a failed creation.
export function githubClaim({ token, sha, request = fetch }) {
  if (!token || !/^[0-9a-f]{40}$/.test(sha)) throw Error('Missing GitHub claim configuration');
  return async key => {
    if (key !== 'mabolla-devnet-own-miner-direct-v1') throw Error('Unexpected attempt key');
    const ref = `refs/tags/${key}`;
    const response = await request('https://api.github.com/repos/Mabolla/technocore-task-relay/git/refs', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json',
        'content-type': 'application/json' },
      body: JSON.stringify({ ref, sha }),
    });
    if (response.status !== 201) return false;
    const result = await response.json();
    return result?.ref === ref && result?.object?.sha === sha;
  };
}
