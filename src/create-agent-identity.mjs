import { generateKeyPairSync } from "node:crypto";
import { writeFile } from "node:fs/promises";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes) {
  let value = BigInt(`0x${Buffer.from(bytes).toString("hex")}`); let output = "";
  while (value > 0n) { const remainder = Number(value % 58n); output = ALPHABET[remainder] + output; value /= 58n; }
  for (const byte of bytes) { if (byte) break; output = "1" + output; }
  return output;
}

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const spki = publicKey.export({ format: "der", type: "spki" });
const rawPublicKey = spki.subarray(-32);
const did = `did:key:z${base58(Buffer.concat([Buffer.from([0xed, 0x01]), rawPublicKey]))}`;
const identity = { format: "technocore-agent-identity-v1", did, privateKeyPkcs8Base64: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64") };
await writeFile(".agent-identity.json", JSON.stringify(identity, null, 2) + "\n", { mode: 0o600, flag: "wx" });
console.log(`Created ${did}\nSaved to .agent-identity.json (never commit this file).`);
