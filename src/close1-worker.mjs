import { CLOSE1_AGENT_DID, advanceClose1RoomRegistration, observeClose1 } from "./close1-protocol.mjs";
import { analyzeClose1Market, fetchBenchmarkCandles, fetchNvdaCandles } from "./close1-strategy.mjs";
import { advanceClose1Trading } from "./close1-trading.mjs";

export default {
  async scheduled(_controller, env) {
    let result;
    try {
      result = await observeClose1(env);
    } catch (error) {
      result = { action: "error", error: String(error?.message || error) };
      console.error(JSON.stringify({ service: "mabolla-close1-agent", ...result }));
      return;
    }
    let roomRegistration;
    try {
      roomRegistration = await advanceClose1RoomRegistration(env, result);
    } catch (error) {
      roomRegistration = { action: "error", error: String(error?.message || error) };
      console.error(JSON.stringify({ service: "mabolla-close1-agent", phase: "room-registration", ...roomRegistration }));
    }
    let strategy = { action: "disabled" };
    if (String(env.CLOSE1_STRATEGY_ENABLED || "").toLowerCase() === "true") {
      if (result.action !== "healthy") {
        strategy = { action: "blocked", reason: "unhealthy-signed-snapshot" };
      } else {
        try {
          const marketNow = Date.now();
          const [nvda, benchmark] = await Promise.all([
            fetchNvdaCandles(fetch, marketNow),
            fetchBenchmarkCandles(fetch, marketNow)
          ]);
          strategy = analyzeClose1Market(nvda, benchmark, result, marketNow);
        } catch (error) {
          strategy = { action: "blocked", reason: "market-read-failed", error: String(error?.message || error) };
        }
      }
    }
    let trading = { action: "disabled" };
    try {
      trading = await advanceClose1Trading(env, result, strategy, roomRegistration);
    } catch (error) {
      trading = { action: "blocked", reason: "trading-execution-failed", error: String(error?.message || error) };
      console.error(JSON.stringify({ service: "mabolla-close1-agent", phase: "trading", ...trading }));
    }
    console.log(JSON.stringify({
      service: "mabolla-close1-agent",
      did: CLOSE1_AGENT_DID,
      ...result,
      roomRegistration,
      strategy,
      trading
    }));
  },

  async fetch(_request, env) {
    if (env?.TECHNOCORE_AGENT_DID !== CLOSE1_AGENT_DID) {
      return Response.json({ ok: false, service: "mabolla-close1-agent", reason: "identity-mismatch" }, {
        status: 503,
        headers: { "cache-control": "no-store" }
      });
    }
    return Response.json({
      ok: true,
      service: "mabolla-close1-agent",
      season: "close-1",
      mode: String(env.CLOSE1_TRADING_ENABLED || "").toLowerCase() === "true" ? "trading" : "verified-observer",
      strategy: String(env.CLOSE1_STRATEGY_ENABLED || "").toLowerCase() === "true" ? "market-observer" : "disabled",
      execution: "signed-offer-v1",
      taker: String(env.CLOSE1_TAKER_ENABLED || "").toLowerCase() === "true" ? "enabled" : "disabled",
      failClosed: true
    }, { headers: { "cache-control": "no-store" } });
  }
};
