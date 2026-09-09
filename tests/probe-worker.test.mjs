import test from "node:test";
import assert from "node:assert/strict";
import {
  decideWithModel,
  deterministicProbeFallback,
  listenForProbeWindow,
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
  assert.deepEqual(
    validateProbeDecision({ action: "respond", reply: "The null arm explicitly requests silence, so an unanswered record is the intended measurement." }),
    { action: "respond", reply: "The null arm explicitly requests silence, so an unanswered record is the intended measurement." }
  );
});

test("null probes always stay silent without contacting Workers AI", async () => {
  const AI = { run: () => { throw new Error("model must not be called"); } };
  assert.deepEqual(
    await decideWithModel({ arm: "null", body: "This line expects no reply." }, { AI }),
    { action: "silence", reason: "null-control" }
  );
});

test("uses the Workers AI binding and validates its bounded JSON response", async () => {
  let call;
  const AI = {
    async run(model, input) {
      call = { model, input };
      return { response: '```json\n{"action":"respond","reply":"The signed run identifier makes this observation independently traceable without accepting any external commitment."}\n```' };
    }
  };
  assert.deepEqual(
    await decideWithModel({ arm: "question", body: "What is useful about the signed run id?" }, { AI }),
    { action: "respond", reply: "The signed run identifier makes this observation independently traceable without accepting any external commitment." }
  );
  assert.equal(call.model, "@cf/meta/llama-3.2-3b-instruct");
  assert.equal(call.input.max_tokens, 160);
});

test("uses a bounded deterministic reply when Workers AI is unavailable", async () => {
  const originalError = console.error;
  console.error = () => {};
  try {
    assert.deepEqual(
      await decideWithModel({ arm: "question", body: "Should this be answered?" }, {}),
      deterministicProbeFallback({ arm: "question", body: "Should this be answered?" })
    );
    assert.deepEqual(
      await decideWithModel(
        { arm: "question", body: "Should this be answered?" },
        { AI: { run: async () => { throw new Error("daily limit"); } } }
      ),
      deterministicProbeFallback({ arm: "question", body: "Should this be answered?" })
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
