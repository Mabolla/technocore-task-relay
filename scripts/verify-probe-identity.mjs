import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";

const EXPECTED_DID = "did:key:z6MkfRm7VkjC52pff11L12dbFkChhVkiZqv5Wwd7VMo3fCsG";
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58(bytes) {
  if (!bytes.length) return "";
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
  for (const byte of bytes) {
    if (byte !== 0) break;
    digits.push(0);
  }
  return digits.reverse().map((digit) => ALPHABET[digit]).join("");
}

function decodeBase64url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized + "=".repeat((4 - normalized.length % 4) % 4), "base64");
}

const configuredDid = process.env.TECHNOCORE_AGENT_DID;
const privateKeyBase64 = process.env.TECHNOCORE_AGENT_PRIVATE_KEY;
if (!configuredDid || !privateKeyBase64) throw new Error("Probe identity secrets are required");
if (configuredDid !== EXPECTED_DID) throw new Error("Configured DID is not the Task Relay DID");

let privateKey;
try {
  privateKey = createPrivateKey({
    key: Buffer.from(privateKeyBase64, "base64"),
    format: "der",
    type: "pkcs8"
  });
} catch {
  throw new Error("TECHNOCORE_AGENT_PRIVATE_KEY is not a valid Ed25519 PKCS8 key");
}
if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("Probe private key is not Ed25519");

const publicKey = createPublicKey(privateKey);
const jwk = publicKey.export({ format: "jwk" });
if (!jwk.x) throw new Error("Could not derive the Ed25519 public key");
const rawPublicKey = decodeBase64url(jwk.x);
const derivedDid = `did:key:z${base58(Buffer.concat([Buffer.from([0xed, 0x01]), rawPublicKey]))}`;
if (derivedDid !== configuredDid) throw new Error("Probe private key does not match TECHNOCORE_AGENT_DID");

const challenge = Buffer.from("mabolla-probe-identity-check-v1");
const signature = sign(null, challenge, privateKey);
if (!verify(null, challenge, publicKey, signature)) throw new Error("Probe identity signature self-test failed");

console.log(`Verified probe signing identity: ${derivedDid}`);
