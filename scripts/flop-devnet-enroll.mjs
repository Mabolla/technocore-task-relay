import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";

export const MABOLLA_DID = "did:key:z6MkfRm7VkjC52pff11L12dbFkChhVkiZqv5Wwd7VMo3fCsG";
export const MABOLLA_SS58 = "5CPgb5pfqurJbZZT6ts99wCc3Npdjtfxs4VMxNnstLap1omn";
export const DEVNET_GENESIS = "0x99c172c095340ace980631f9123544c6bebd4839f3437e463533422d8be2d631";
export const INFERENCE_REQUEST_ID = "mabolla-devnet-identity-proof-v1";
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58(bytes) {
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i += 1) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    digits.push(0);
  }
  return digits.reverse().map((digit) => ALPHABET[digit]).join("");
}

function rawPublicKey(privateKey) {
  const jwk = createPublicKey(privateKey).export({ format: "jwk" });
  return Buffer.from(jwk.x.replace(/-/g, "+").replace(/_/g, "/") + "==", "base64");
}

export function identitiesFor(privateKeyBase64) {
  const privateKey = createPrivateKey({
    key: Buffer.from(privateKeyBase64, "base64"),
    format: "der",
    type: "pkcs8"
  });
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("Signing key must be Ed25519");
  const publicKey = rawPublicKey(privateKey);
  const did = `did:key:z${base58(Buffer.concat([Buffer.from([0xed, 0x01]), publicKey]))}`;
  const body = Buffer.concat([Buffer.from([42]), publicKey]);
  const checksum = createHash("blake2b512").update(Buffer.concat([Buffer.from("SS58PRE"), body])).digest().subarray(0, 2);
  return { privateKey, did, address: base58(Buffer.concat([body, checksum])) };
}

export function validateChallenge(payload, now = Date.now()) {
  if (!payload || typeof payload.message !== "string") throw new Error("Missing enrollment challenge");
  if (!/^[0-9a-f]{64}$/.test(payload.nonce ?? "")) throw new Error("Invalid challenge nonce");
  if (payload.expires_at <= now || payload.expires_at > now + 5 * 60_000 + 10_000) throw new Error("Challenge freshness check failed");
  const lines = payload.message.split("\n");
  const expected = [
    "api.flop.network wants you to enroll a FLOP devnet gateway key with your account:",
    MABOLLA_SS58,
    "",
    "Action: flop-devnet-enroll/v1",
    `Genesis: ${DEVNET_GENESIS}`,
    `Nonce: ${payload.nonce}`
  ];
  if (lines.length !== 8 || expected.some((line, i) => lines[i] !== line)) throw new Error("Unexpected enrollment statement");
  const issuedAt = Date.parse(lines[6].replace("Issued At: ", ""));
  const expiresAt = Date.parse(lines[7].replace("Expiration Time: ", ""));
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) throw new Error("Invalid enrollment timestamps");
  if (Math.abs(issuedAt - now) > 60_000 || expiresAt !== payload.expires_at || expiresAt - issuedAt !== 300_000) {
    throw new Error("Enrollment statement timestamp mismatch");
  }
  return payload.message;
}

export function validatePreflight({ health, catalog, account }) {
  if (health?.status !== "ok" || health?.connected !== true || health?.syncing !== false) {
    throw new Error("Gateway is not healthy and synchronized");
  }
  if (health?.network?.network !== "devnet" || health?.network?.status !== "live") {
    throw new Error("Gateway is not serving the live Devnet");
  }
  if (health?.network?.observed_genesis_hash !== DEVNET_GENESIS || health?.network?.expected_genesis_hash !== DEVNET_GENESIS) {
    throw new Error("Gateway genesis mismatch");
  }
  if (account?.address !== MABOLLA_SS58 || account?.liveBalance !== true || BigInt(account?.balance ?? "0") < 1_000_000_000_000_000_000n) {
    throw new Error("Mabolla account does not have a verified live minimum balance");
  }
  const models = catalog?.data;
  if (!Array.isArray(models) || models.length < 1) throw new Error("No live catalog model");
  for (const model of models) {
    if (model.id !== model.canonical_slug || !model?.["x-flop"]?.registry_model) throw new Error("Catalog model identity is incomplete");
    if (!model.supported_parameters?.includes("max_tokens")) throw new Error("Catalog model does not support max_tokens");
  }
  return new Map(models.map((model) => [model.id, model]));
}

async function jsonFetch(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(20_000) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${response.status} ${body.error ?? body.message ?? "request failed"}`);
  return body;
}

export async function enrollAndProbe(env = process.env) {
  if (env.TECHNOCORE_AGENT_DID !== MABOLLA_DID) throw new Error("Configured DID is not Mabolla DID");
  const identity = identitiesFor(env.TECHNOCORE_AGENT_PRIVATE_KEY ?? "");
  if (identity.did !== MABOLLA_DID || identity.address !== MABOLLA_SS58) throw new Error("Private key does not match Mabolla DID/account");

  const [health, catalog, account] = await Promise.all([
    jsonFetch("https://api.flop.network/health"),
    jsonFetch("https://api.flop.network/v1/models"),
    jsonFetch(`https://explorer.devnet.flop.network/api/accounts/${MABOLLA_SS58}`)
  ]);
  const catalogById = validatePreflight({ health, catalog, account });

  const challenge = await jsonFetch(`https://api.flop.network/v1/enroll/wallet/challenge?address=${MABOLLA_SS58}`);
  const message = validateChallenge(challenge);
  const signature = `0x${sign(null, Buffer.from(message), identity.privateKey).toString("hex")}`;
  const enrollment = await jsonFetch("https://api.flop.network/v1/enroll/wallet", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address: MABOLLA_SS58, message, signature })
  });
  if (!enrollment.key || !enrollment.model) throw new Error("Enrollment did not return a scoped key");
  if (!catalogById.has(enrollment.model)) throw new Error("Enrollment returned a model outside the live catalog");

  const initialCredential = await jsonFetch("https://api.flop.network/v1/keys/me", {
    headers: { authorization: `Bearer ${enrollment.key}` }
  });
  const catalogModel = catalogById.get(enrollment.model);
  const scopeText = JSON.stringify(initialCredential.scope ?? {});
  const enrollmentQuota = Number(enrollment.remaining_quota);
  const introspectedQuota = Number(initialCredential.remaining_quota);
  if (!["owner", "ephemeral"].includes(initialCredential.credential)
      || !Number.isFinite(enrollmentQuota)
      || !Number.isFinite(introspectedQuota)
      || Math.abs(enrollmentQuota - introspectedQuota) > 1e-9
      || (!scopeText.includes(enrollment.model) && !scopeText.includes(catalogModel["x-flop"].registry_model))) {
    throw new Error("Enrollment allowance introspection mismatch");
  }

  const completion = await jsonFetch("https://api.flop.network/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${enrollment.key}`,
      "content-type": "application/json",
      "x-request-id": INFERENCE_REQUEST_ID
    },
    body: JSON.stringify({
      model: enrollment.model,
      messages: [{ role: "user", content: "Reply with exactly: Mabolla devnet identity verified" }],
      max_tokens: 16
    })
  });
  const [finalCredential, receipt] = await Promise.all([
    jsonFetch("https://api.flop.network/v1/keys/me", {
      headers: { authorization: `Bearer ${enrollment.key}` }
    }),
    jsonFetch(`https://api.flop.network/v1/keys/me/receipts/${encodeURIComponent(INFERENCE_REQUEST_ID)}`, {
      headers: { authorization: `Bearer ${enrollment.key}` }
    })
  ]);
  return {
    did: MABOLLA_DID,
    address: MABOLLA_SS58,
    model: enrollment.model,
    initial_quota: enrollment.remaining_quota,
    remaining_quota: finalCredential.remaining_quota,
    uses_remaining: finalCredential.uses_remaining,
    expires_at: enrollment.expires_at,
    inference: completion.choices?.[0]?.message?.content ?? null,
    usage: completion.usage ?? null,
    gateway_receipt: completion.x_flop_receipt ?? null,
    ledger_receipt: receipt
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await enrollAndProbe();
  const summary = JSON.stringify(result, null, 2);
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFile } = await import("node:fs/promises");
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `## FLOP Devnet enrollment\n\n\`\`\`json\n${summary}\n\`\`\`\n`);
  }
}
