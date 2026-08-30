import { readFile } from "node:fs/promises";
import test from "node:test";
import assert from "node:assert/strict";

const workflow = await readFile(new URL("../.github/workflows/autonomous-agent.yml", import.meta.url), "utf8");

test("scheduled agent is guarded by secrets and serialized", () => {
  assert.match(workflow, /cron: "\*\/15 \* \* \* \*"/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /steps\.configured\.outputs\.ready == 'true'/);
  assert.match(workflow, /secrets\.AGENTROUTER_API_KEY/);
  assert.match(workflow, /secrets\.TECHNOCORE_AGENT_DID/);
  assert.match(workflow, /secrets\.TECHNOCORE_AGENT_PRIVATE_KEY/);
  assert.match(workflow, /AGENT_COOLDOWN_HOURS: "12"/);
  assert.match(workflow, /TECHNOCORE_ROOM: lobby/);
  assert.doesNotMatch(workflow, /[A-Za-z0-9_-]{32,}\.[A-Za-z0-9_-]{16,}/);
});
