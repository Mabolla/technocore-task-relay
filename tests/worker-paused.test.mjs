import test from "node:test";
import assert from "node:assert/strict";
import close1Worker from "../src/close1-worker.mjs";
import probeWorker from "../src/probe-worker.mjs";

test("paused trading does no network or order work", async () => {
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const logs = [];
  globalThis.fetch = async () => { throw new Error("paused Worker fetched data"); };
  console.log = (message) => logs.push(JSON.parse(message));
  try {
    await close1Worker.scheduled(null, {
      CLOSE1_TRADING_ENABLED: "false",
      CLOSE1_STRATEGY_ENABLED: "true",
      CLOSE1_ROOM_REGISTRATION_ENABLED: "true"
    });
    assert.deepEqual(logs, [{ service: "mabolla-close1-agent", action: "trading-paused" }]);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  }
});

test("pending archive evidence stops the runtime before signed-room and market scans", async () => {
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const logs = [];
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return Response.json({ contest: "close-1", sweeps: [] });
  };
  console.log = (message) => logs.push(JSON.parse(message));
  try {
    await close1Worker.scheduled(null, {
      CLOSE1_TRADING_ENABLED: "true",
      CLOSE1_STRATEGY_ENABLED: "true",
      CLOSE1_ARCHIVE_OUTCOME_HINTS: `trade-a:825:${"a".repeat(64)}`
    });
    assert.equal(urls.length, 1);
    assert.match(urls[0], /challenges\.technocore\.chat\/close-1\/index\.json/);
    assert.deepEqual(logs, [{
      service: "mabolla-close1-agent",
      phase: "archive-preflight",
      action: "blocked",
      reason: "archive-outcome-pending",
      tradeIds: ["trade-a"]
    }]);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  }
});

test("disabled probe does not scan rooms while scheduled tasks still execute", async () => {
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const logs = [];
  globalThis.fetch = async () => { throw new Error("disabled probe fetched data"); };
  console.log = (message) => logs.push(JSON.parse(message));
  try {
    await probeWorker.scheduled(null, { PROBE_ENABLED: "false" });
    assert.equal(logs[0].action, "probe-disabled");
    assert.deepEqual(logs[0].taskRelayKeepalive, { action: "disabled" });
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  }
});
