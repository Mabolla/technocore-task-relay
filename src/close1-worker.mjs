import { CLOSE1_AGENT_DID, observeClose1 } from "./close1-protocol.mjs";

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
    console.log(JSON.stringify({ service: "mabolla-close1-agent", did: CLOSE1_AGENT_DID, ...result }));
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
      failClosed: true
    }, { headers: { "cache-control": "no-store" } });
  }
};

