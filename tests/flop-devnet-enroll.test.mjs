import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { identitiesFor, validateChallenge, validatePreflight, MABOLLA_SS58, DEVNET_GENESIS } from "../scripts/flop-devnet-enroll.mjs";

test("derives a DID and SS58 address from the same Ed25519 key", () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const encoded = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
  const identity = identitiesFor(encoded);
  assert.match(identity.did, /^did:key:z6Mk/);
  assert.match(identity.address, /^5/);
});

test("accepts only the exact fresh official v1 statement", () => {
  const now = Date.now();
  const issuedAt = new Date(now).toISOString();
  const expiresAt = new Date(now + 300_000).toISOString();
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
      `Issued At: ${issuedAt}`,
      `Expiration Time: ${expiresAt}`
    ].join("\n")
  };
  assert.equal(validateChallenge(payload, now), payload.message);
  assert.throws(() => validateChallenge({ ...payload, message: payload.message.replace("v1", "v2") }, now));
  assert.throws(() => validateChallenge({ ...payload, expires_at: now - 1 }, now));
});

test("preflight pins the live Devnet, Mabolla balance, and catalog scope", () => {
  const input = {
    health: {
      status: "ok",
      connected: true,
      syncing: false,
      network: { network: "devnet", status: "live", expected_genesis_hash: DEVNET_GENESIS, observed_genesis_hash: DEVNET_GENESIS }
    },
    account: { address: MABOLLA_SS58, balance: "25000000000000000000", liveBalance: true },
    catalog: { data: [{ id: "qwen/test", canonical_slug: "qwen/test", supported_parameters: ["max_tokens"], "x-flop": { registry_model: "Qwen/Test" } }] }
  };
  assert.ok(validatePreflight(input).has("qwen/test"));
  assert.throws(() => validatePreflight({ ...input, account: { ...input.account, balance: "0" } }));
  assert.throws(() => validatePreflight({ ...input, health: { ...input.health, network: { ...input.health.network, observed_genesis_hash: "0x00" } } }));
});
