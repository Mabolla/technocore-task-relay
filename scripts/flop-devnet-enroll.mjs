import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";

export const MABOLLA_DID = "did:key:z6MkfRm7VkjC52pff11L12dbFkChhVkiZqv5Wwd7VMo3fCsG";
export const MABOLLA_SS58 = "5CPgb5pfqurJbZZT6ts99wCc3Npdjtfxs4VMxNnstLap1omn";
export const DEVNET_GENESIS = "0x99c172c095340ace980631f9123544c6bebd4839f3437e463533422d8be2d631";
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
  if (!/^Issued At: \d{4}-\d{2}-\d{2}T/.test(lines[6]) || !/^Expiration Time: \d{4}-\d{2}-\d{2}T/.test(lines[7])) {
    throw new Error("Invalid enrollment timestamps");
  }
  return payload.message;
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

  const challenge = await jsonFetch(`https://api.flop.network/v1/enroll/wallet/challenge?address=${MABOLLA_SS58}`);
  const message = validateChallenge(challenge);
  const signature = `0x${sign(null, Buffer.from(message), identity.privateKey).toString("hex")}`;
  const enrollment = await jsonFetch("https://api.flop.network/v1/enroll/wallet", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address: MABOLLA_SS58, message, signature })
  });
  if (!enrollment.key || !enrollment.model) throw new Error("Enrollment did not return a scoped key");

  const completion = await jsonFetch("https://api.flop.network/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${enrollment.key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: enrollment.model,
      messages: [{ role: "user", content: "Reply with exactly: Mabolla devnet identity verified" }],
      max_tokens: 16,
      temperature: 0
    })
  });
  return {
    did: MABOLLA_DID,
    address: MABOLLA_SS58,
    model: enrollment.model,
    remaining_quota: enrollment.remaining_quota,
    expires_at: enrollment.expires_at,
    inference: completion.choices?.[0]?.message?.content ?? null
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
