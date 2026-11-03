import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { identitiesFor, validateChallenge, MABOLLA_SS58, DEVNET_GENESIS } from "../scripts/flop-devnet-enroll.mjs";

test("derives a DID and SS58 address from the same Ed25519 key", () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const encoded = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
  const identity = identitiesFor(encoded);
  assert.match(identity.did, /^did:key:z6Mk/);
  assert.match(identity.address, /^5/);
});

test("accepts only the exact fresh official v1 statement", () => {
  const now = Date.now();
  const nonce = "a".repeat(64);
  const payload = {
    nonce,
    expires_at: now + 300_000,
    message: [
      "api.flop.network wants you to enroll a FLOP devnet gateway key with your account:",
      MABOLLA_SS58,
      "",
      "Action: flop-devnet-enroll/v1",
      `Genesis: ${DEVNET_GENESIS}`,
      `Nonce: ${nonce}`,
      "Issued At: 2026-11-03T00:00:00.000Z",
      "Expiration Time: 2026-11-03T00:05:00.000Z"
    ].join("\n")
  };
  assert.equal(validateChallenge(payload, now), payload.message);
  assert.throws(() => validateChallenge({ ...payload, message: payload.message.replace("v1", "v2") }, now));
  assert.throws(() => validateChallenge({ ...payload, expires_at: now - 1 }, now));
});
