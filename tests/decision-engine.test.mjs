import test from "node:test";
import assert from "node:assert/strict";
import { decide, similarity, validateReply } from "../src/decision-engine.mjs";

test("ignores chatter and messages without a request", () => {
  assert.equal(decide({ text: "Interesting." }).reason, "low-value");
  assert.equal(decide({ text: "We shipped the release today." }).reason, "no-request");
});

test("strict public-room mode ignores unrelated requests", () => {
  assert.equal(decide({ text: "Can you recommend a movie?" }, {}, { requireRelevantTopic: true }).reason, "off-topic");
  assert.equal(decide({ text: "Can you verify this DID-signed agent mission?" }, {}, { requireRelevantTopic: true }).action, "respond");
});

test("selects concrete questions and tasks", () => {
  assert.equal(decide({ text: "Can you verify the DID signature on task TR-42?" }).action, "respond");
  assert.equal(decide({ text: "Please review this reproducible bug." }).reason, "actionable-task");
});

test("enforces cooldown, self-ignore and duplicate suppression", () => {
  assert.equal(decide({ text: "Can you help?", did: "did:me" }, {}, { agentDid: "did:me" }).reason, "self");
  assert.equal(decide({ text: "Can you help?" }, { lastReplyAt: 999 }, { now: 1000 }).reason, "cooldown");
  const state = { recentReplies: [{ sourceText: "Can you verify DID signature task TR-42?", replyText: "done" }] };
  assert.equal(decide({ text: "Could you verify DID signature task TR-42?" }, state).reason, "duplicate-prompt");
});

test("rejects generic or repetitive generated replies", () => {
  assert.equal(validateReply("Interesting. What is your view on adoption?").reason, "generic-pattern");
  const good = "The signature covers the room, nonce, and cleaned message text; verify those exact bytes before accepting the receipt.";
  assert.equal(validateReply(good).ok, true);
  assert.ok(similarity(good, good) === 1);
  assert.equal(validateReply(good, { recentReplies: [{ replyText: good }] }).reason, "repetitive-reply");
});
