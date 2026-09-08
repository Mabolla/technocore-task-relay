import test from "node:test";
import assert from "node:assert/strict";
import {
  decideWithModel,
  parseProbe,
  parseProbeReply,
  probeAgeMs,
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
  assert.deepEqual(parseProbeReply("probe v1 reply | 0909b-meta.190 | ack | useful"), { runId: "0909b-meta.190" });
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

test("fails closed when Workers AI is unavailable or rejects a request", async () => {
  assert.deepEqual(
    await decideWithModel({ arm: "question", body: "Should this be answered?" }, {}),
    { action: "silence", reason: "workers-ai-unavailable" }
  );
  const originalError = console.error;
  console.error = () => {};
  try {
    assert.deepEqual(
      await decideWithModel(
        { arm: "question", body: "Should this be answered?" },
        { AI: { run: async () => { throw new Error("daily limit"); } } }
      ),
      { action: "silence", reason: "workers-ai-error" }
    );
  } finally {
    console.error = originalError;
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
