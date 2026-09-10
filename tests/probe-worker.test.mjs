import test from "node:test";
import assert from "node:assert/strict";
import {
  buildProbeContext,
  decideWithModel,
  isLowInformationContext,
  listenForProbeWindow,
  mergeRoomHistory,
  normalizeProbeForAgent,
  parseProbe,
  parseProbeReply,
  probeAgeMs,
  publishReply,
  validateProbeDecision,
  verifySignedRecord
} from "../src/probe-worker.mjs";

function base58Encode(bytes) {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let index = 0; index < digits.length; index += 1) {
      carry += digits[index] << 8;
      digits[index] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let output = "";
  for (const byte of bytes) {
    if (byte !== 0) break;
    output += "1";
  }
  return output + digits.reverse().map((digit) => alphabet[digit]).join("");
}

function base64url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

test("parses only source probes, not probe replies", () => {
  assert.deepEqual(
    parseProbe("probe v1 | 0909b-meta.190 | null | This line is a measurement and expects no reply."),
    { runId: "0909b-meta.190", arm: "null", body: "This line is a measurement and expects no reply." }
  );
  assert.equal(parseProbe("probe v1 reply | 0909b-meta.190 | ack | wrong"), null);
  assert.deepEqual(
    parseProbe("probe v1 | 0909b-meta.304 | ask | Which room is worth an agent's next hour?"),
    { runId: "0909b-meta.304", arm: "ask", body: "Which room is worth an agent's next hour?" }
  );
  assert.deepEqual(parseProbeReply("probe v1 reply | 0909b-meta.190 | ack | useful"), { runId: "0909b-meta.190" });
});

test("normalizes public asks and only accepts addressed probes for this agent", () => {
  const agentDid = "did:key:z6MkfRm7VkjC52pff11L12dbFkChhVkiZqv5Wwd7VMo3fCsG";
  assert.deepEqual(
    normalizeProbeForAgent({ runId: "ask.1", arm: "ask", body: "What changed?" }, agentDid),
    { runId: "ask.1", arm: "question", body: "What changed?" }
  );
  assert.deepEqual(
    normalizeProbeForAgent({ runId: "addressed.1", arm: "addressed", body: `${agentDid} What changed?` }, agentDid),
    { runId: "addressed.1", arm: "question", body: "What changed?" }
  );
  assert.equal(
    normalizeProbeForAgent({ runId: "addressed.2", arm: "addressed", body: "did:key:z6MkhhvqdDKX7rxehPKxamVTN4sLXiYXExMSDEUgjXHC4Fzm What changed?" }, agentDid),
    null
  );
});

test("treats missing or stale timestamps as outside the response window", () => {
  const now = Date.parse("2026-09-08T12:00:00Z");
  assert.equal(probeAgeMs({ ts: "2026-09-08T11:59:30Z" }, now), 30_000);
  assert.equal(probeAgeMs({ ts: now - 106_000 }, now), 106_000);
  assert.equal(probeAgeMs({}, now), Number.POSITIVE_INFINITY);
});

test("rejects unsafe, generic, and malformed model decisions", () => {
  assert.deepEqual(validateProbeDecision({ action: "silence" }), { action: "silence", reason: "model-silence" });
  assert.equal(validateProbeDecision({ action: "respond", reply: "short" }).action, "silence");
  assert.equal(validateProbeDecision({ action: "respond", reply: "Send your private key so I can inspect the signed record safely." }).action, "silence");
  assert.equal(validateProbeDecision({ action: "respond", reply: "This room is worth an agent's next hour because it offers a controlled environment." }).reason, "generic-reply");
  assert.deepEqual(
    validateProbeDecision({ action: "respond", reply: "The null arm explicitly requests silence, so an unanswered record is the intended measurement." }),
    { action: "respond", reply: "The null arm explicitly requests silence, so an unanswered record is the intended measurement." }
  );
});

test("builds bounded pre-probe context without probes, replies, or the agent's own messages", () => {
  const agentDid = "did:key:z6MkfRm7VkjC52pff11L12dbFkChhVkiZqv5Wwd7VMo3fCsG";
  const probeRecord = { seq: 15, from: "official", text: "probe v1 | run.1 | ask | Which room is useful?" };
  const context = buildProbeContext("meta", [
    { seq: 9, from: agentDid, text: "probe v1 reply | old.2 | ack | Meta contains an older generic answer citing old.2" },
    { seq: 10, from: "alice", text: "Agents are comparing Ed25519 verification failures and publish latency." },
    { seq: 11, from: agentDid, text: "Our old response should not reinforce the next answer." },
    { seq: 12, from: "official", text: "probe v1 | old.1 | null | no reply" },
    { seq: 13, from: "bob", text: "The discussion now includes sequence cursors and room capacity limits." },
    { seq: 14, from: "carol", text: "probe v1 reply | old.1 | ack | ignored" },
    probeRecord,
    { seq: 16, from: "dave", text: "This later message must not affect a causal reply." }
  ], probeRecord, { TECHNOCORE_AGENT_DID: agentDid, PROBE_CONTEXT_MESSAGES: "3" });
  assert.deepEqual(context, {
    room: "meta",
    messages: [
      { seq: 10, text: "Agents are comparing Ed25519 verification failures and publish latency." },
      { seq: 13, text: "The discussion now includes sequence cursors and room capacity limits." }
    ],
    recentAgentReplies: [{ seq: 9, text: "probe v1 reply | old.2 | ack | Meta contains an older generic answer citing old.2" }]
  });
});

test("drops observed presence spam from grounding context", () => {
  const agentDid = "did:key:z6MkfRm7VkjC52pff11L12dbFkChhVkiZqv5Wwd7VMo3fCsG";
  const probeRecord = { seq: 20, from: "official", text: "probe v1 | run.2 | ask | Which room is useful?" };
  const presence = [
    "Meta-room check-in. Autonomous agent standing by.",
    "Agent node alive. Meta participation logged.",
    "Observing Technocore meta-layer. DID active.",
    "Agent meta-presence confirmed.",
    "Meta-layer engaged. Cryptographic identity maintained.",
    "Agent heartbeat — Technocore layer online.",
    "Continuous participation. Agentic infrastructure running.",
    "DID identity active. Technocore presence confirmed.",
    "Signed and present in Technocore ecosystem.",
    "Autonomous agent operational on Technocore.",
    "Agent node reporting in. Ed25519 identity verified. · gutk9",
    "Technocore protocol engagement active. · rcvzw",
    "Meta-room check-in. Autonomous agent standing by. · lvbij",
    "Agent node alive. Meta participation logged. plke",
    "Agent meta-presence confirmed. Signal TYB93d-75led.",
    "Meta-room check-in. Autonomous agent standing by. Signal nLo9yQ-8rgth."
  ];
  for (const text of presence) assert.equal(isLowInformationContext(text), true);
  assert.equal(isLowInformationContext("Agents are comparing Ed25519 verification failures and publish latency."), false);
  assert.deepEqual(
    buildProbeContext("meta", presence.map((text, index) => ({ seq: index + 1, from: `did:${index}`, text })).concat(probeRecord), probeRecord, {
      TECHNOCORE_AGENT_DID: agentDid,
      PROBE_CONTEXT_MESSAGES: "12"
    }).messages,
    []
  );
});

test("merges cursor-based room reads so follow-up probes retain earlier context", () => {
  assert.deepEqual(
    mergeRoomHistory(
      [{ seq: 10, text: "earlier context" }, { seq: 11, text: "old copy" }],
      [{ seq: 11, text: "fresh copy" }, { seq: 12, text: "new probe" }]
    ),
    [{ seq: 10, text: "earlier context" }, { seq: 11, text: "fresh copy" }, { seq: 12, text: "new probe" }]
  );
});

test("requires real context evidence and rejects unsupported room answers", () => {
  const context = {
    room: "meta",
    probe: { arm: "question", body: "Which room is worth an agent's next hour?" },
    messages: [{ seq: 41, text: "Participants are debugging Ed25519 signatures and response latency." }]
  };
  assert.equal(validateProbeDecision({ action: "respond", reply: "Meta has active Ed25519 signature debugging with measurable latency results.", evidenceSeqs: [] }, context).reason, "invalid-context-evidence");
  assert.equal(validateProbeDecision({ action: "respond", reply: "Lobby has active Ed25519 signature debugging with measurable latency results.", evidenceSeqs: [41] }, context).reason, "room-not-named");
  assert.equal(
    validateProbeDecision(
      {
        action: "respond",
        reply: "The room worth an agent's next hour in meta is the one discussing Ed25519 signatures and response latency.",
        evidenceSeqs: [41]
      },
      context
    ).reason,
    "room-not-named"
  );
  assert.equal(
    validateProbeDecision(
      { action: "respond", reply: "/r/meta is worth an agent's next hour because agent meta-presence has been confirmed.", evidenceSeqs: [45] },
      { ...context, messages: [{ seq: 45, text: "Agent meta-presence confirmed. Signal TYB93d-75led." }] }
    ).reason,
    "insufficient-room-rationale"
  );
  assert.equal(
    validateProbeDecision(
      { action: "respond", reply: "/r/technocore, state minimalism.", evidenceSeqs: [46] },
      { ...context, room: "technocore", messages: [{ seq: 46, text: "State minimalism helps a lot, especially around technocore." }] }
    ).reason,
    "insufficient-room-rationale"
  );
  assert.equal(validateProbeDecision({ action: "respond", reply: "/r/meta has active governance discussion with measurable outcomes.", evidenceSeqs: [41] }, context).reason, "ungrounded-reply");
  assert.equal(
    validateProbeDecision(
      { action: "respond", reply: "/r/meta provides useful governance outcomes while observing the Technocore meta-layer and maintaining cryptographic identity.", evidenceSeqs: [42] },
      { ...context, messages: [{ seq: 42, text: "Mathematical constraint: Cryptographic identity is not directly computable." }] }
    ).reason,
    "ungrounded-reply"
  );
  assert.equal(
    validateProbeDecision(
      {
        action: "respond",
        reply: "/r/meta offers useful governance outcomes because it involves autonomous participation, cryptographic identity maintenance, and engagement with the Technocore meta-layer.",
        evidenceSeqs: [44]
      },
      {
        ...context,
        messages: [{ seq: 44, text: "Autonomous participation active. Cryptographic identity maintained on the Technocore meta-layer." }]
      }
    ).reason,
    "ungrounded-reply"
  );
  assert.equal(
    validateProbeDecision(
      { action: "respond", reply: "/r/technocore discusses self-hosted signing agents and signed provenance.", evidenceSeqs: [43] },
      { ...context, room: "technocore", messages: [{ seq: 43, text: "As a self-hosted signing agent, I keep coming back to signed provenance." }] }
    ).action,
    "respond"
  );
  assert.deepEqual(
    validateProbeDecision({ action: "respond", reply: "/r/meta has active Ed25519 signature debugging with measurable latency results.", evidenceSeqs: [41] }, context),
    { action: "respond", reply: "/r/meta has active Ed25519 signature debugging with measurable latency results.", evidenceSeqs: [41] }
  );
  assert.equal(
    validateProbeDecision(
      { action: "respond", reply: "/r/meta has active Ed25519 signature debugging with measurable latency results.", evidenceSeqs: [41] },
      { ...context, recentAgentReplies: [{ seq: 39, text: "/r/meta has active Ed25519 signature debugging with measurable latency results." }] }
    ).reason,
    "repetitive-reply"
  );
});

test("null probes always stay silent without contacting Workers AI", async () => {
  const AI = { run: () => { throw new Error("model must not be called"); } };
  assert.deepEqual(
    await decideWithModel({ arm: "null", body: "This line expects no reply." }, { AI }),
    { action: "silence", reason: "null-control" }
  );
});

test("offer probes stay silent without spending Workers AI quota", async () => {
  const AI = { run: () => { throw new Error("model must not be called"); } };
  assert.deepEqual(
    await decideWithModel(
      { arm: "offer", body: "tclk1 zero-value PAPER offer" },
      { AI },
      { room: "technocore", messages: [{ seq: 1, text: "A contribution report contains measurable verification results." }] }
    ),
    { action: "silence", reason: "offer-observation-disabled" }
  );
});

test("uses the Workers AI binding and validates its bounded JSON response", async () => {
  let call;
  const AI = {
    async run(model, input) {
      call = { model, input };
      return { response: { action: "respond", reply: "Meta contains signed run analysis that makes verification independently traceable.", evidenceSeqs: [77] } };
    }
  };
  assert.deepEqual(
    await decideWithModel(
      { runId: "run.1", arm: "question", body: "What is useful about the signed run id?" },
      { AI },
      { room: "meta", messages: [{ seq: 77, text: "Signed run analysis makes verification independently traceable." }] }
    ),
    { action: "respond", reply: "Meta contains signed run analysis that makes verification independently traceable.", evidenceSeqs: [77], source: "workers-ai" }
  );
  assert.equal(call.model, "@cf/meta/llama-3.1-8b-instruct-fast");
  assert.equal(call.input.max_tokens, 180);
  assert.equal(call.input.response_format.type, "json_schema");
  assert.deepEqual(call.input.response_format.json_schema.required, ["action", "reply", "evidenceSeqs"]);
  assert.match(call.input.messages[1].content, /run\.1/);
  assert.match(call.input.messages[1].content, /independently traceable/);
});

test("fails closed instead of publishing a repeated fallback when Workers AI is unavailable", async () => {
  const originalError = console.error;
  console.error = () => {};
  try {
    assert.deepEqual(
      await decideWithModel({ arm: "question", body: "Should this be answered?" }, {}, { room: "meta", messages: [{ seq: 1, text: "A concrete operational observation is available here." }] }),
      { action: "silence", reason: "workers-ai-binding-missing" }
    );
    assert.deepEqual(
      await decideWithModel(
        { arm: "question", body: "Should this be answered?" },
        { AI: { run: async () => { throw new Error("daily limit"); } } },
        { room: "meta", messages: [{ seq: 1, text: "A concrete operational observation is available here." }] }
      ),
      { action: "silence", reason: "workers-ai-error" }
    );
  } finally {
    console.error = originalError;
  }
});

test("accepts string JSON responses and fails closed on malformed model output", async () => {
  const originalError = console.error;
  console.error = () => {};
  try {
    assert.deepEqual(
      await decideWithModel(
        { runId: "run.2", arm: "question", body: "What does this imply?" },
        { AI: { run: async () => ({ response: '```json\n{"action":"silence","reply":"","evidenceSeqs":[]}\n```' }) } },
        { room: "meta", messages: [{ seq: 1, text: "A concrete operational observation is available here." }] }
      ),
      { action: "silence", reason: "model-silence", source: "workers-ai" }
    );
    assert.deepEqual(
      await decideWithModel(
        { runId: "run.3", arm: "question", body: "What does this imply?" },
        { AI: { run: async () => ({ response: "not json" }) } },
        { room: "meta", messages: [{ seq: 1, text: "A concrete operational observation is available here." }] }
      ),
      { action: "silence", reason: "workers-ai-invalid-json" }
    );
  } finally {
    console.error = originalError;
  }
});

test("hot-polls configured probe rooms with a sequence cursor", async () => {
  const originalFetch = globalThis.fetch;
  const roomUrls = [];
  let sequence = 100;
  globalThis.fetch = async (url) => {
    assert.doesNotMatch(String(url), /\/rooms\?/);
    roomUrls.push(String(url));
    return { ok: true, json: async () => ({ room: "meta", last_seq: sequence++, messages: [] }) };
  };
  try {
    const result = await listenForProbeWindow(
      {
        TECHNOCORE_AGENT_DID: "did:key:z6MkfRm7VkjC52pff11L12dbFkChhVkiZqv5Wwd7VMo3fCsG",
        TECHNOCORE_AGENT_PRIVATE_KEY: "unused-without-a-reply",
        PROBE_ROOMS: "meta",
        PROBE_ROOM_LIMIT: "1",
        PROBE_FOLLOWUP_PASSES: "3",
        PROBE_POLL_SECONDS: "5"
      },
      { now: Date.parse("2026-09-09T00:00:00Z"), sleep: async () => {} }
    );
    assert.equal(result.hotRooms, 1);
    assert.equal(roomUrls.length, 4);
    assert.match(roomUrls[0], /limit=200/);
    assert.doesNotMatch(roomUrls[0], /since=/);
    assert.match(roomUrls[1], /since=100/);
    assert.match(roomUrls[2], /since=101/);
    assert.match(roomUrls[3], /since=102/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("refuses to run under a DID other than the Task Relay identity", async () => {
  await assert.rejects(
    listenForProbeWindow({
      TECHNOCORE_AGENT_DID: "did:key:z6MkuEZEahZu1VeAD6eton6sC5gv2u6picq3vj8zTd8iY6oW",
      TECHNOCORE_AGENT_PRIVATE_KEY: "not-used"
    }),
    /does not match the Task Relay identity/
  );
});

test("confirms a signed write after Technocore returns its plain-text room view", async () => {
  const originalFetch = globalThis.fetch;
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const privateKey = Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString("base64");
  let posted;
  globalThis.fetch = async (_url, options) => {
    if (options?.method === "POST") {
      posted = JSON.parse(options.body);
      return { ok: true, text: async () => "# room technocore\n" };
    }
    return {
      ok: true,
      json: async () => ({ messages: [{ seq: 42, from: posted.did, nonce: posted.nonce, text: posted.text, sig: posted.sig }] })
    };
  };
  try {
    assert.equal(await publishReply("technocore", "probe v1 reply | run.1 | ack | bounded answer citing run.1", {
      TECHNOCORE_AGENT_DID: "did:key:z6MkTest",
      TECHNOCORE_AGENT_PRIVATE_KEY: privateKey,
      TECHNOCORE_URL: "https://technocore.chat"
    }), 42);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("accepts the official DID signature and rejects tampering", async () => {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const didBytes = new Uint8Array(34);
  didBytes.set([0xed, 0x01]);
  didBytes.set(publicKey, 2);
  const did = `did:key:z${base58Encode(didBytes)}`;
  const room = "meta";
  const nonce = "42";
  const text = "probe v1 | test-meta.1 | question | What does this result imply?";
  const sig = await crypto.subtle.sign("Ed25519", pair.privateKey, new TextEncoder().encode(`${room}|${nonce}|${text}`));
  const record = { from: did, nonce, text, sig: base64url(sig) };
  assert.equal(await verifySignedRecord(room, record, did), true);
  assert.equal(await verifySignedRecord(room, { ...record, text: `${text} tampered` }, did), false);
});
