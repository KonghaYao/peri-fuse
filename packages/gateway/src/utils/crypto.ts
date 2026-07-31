/**
 * AES-256-GCM encryption/decryption for provider API keys.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { gatewayEnv } from "../env.js";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function getKey(): Buffer {
  const hex = gatewayEnv.encryptionKey;
  // Support both 64-char hex (32 bytes) and raw 32-byte string
  if (hex.length === 64 && /^[0-9a-f]+$/i.test(hex)) {
    return Buffer.from(hex, "hex");
  }
  // Derive a 32-byte key from arbitrary string via SHA-256
  const { createHash } = require("node:crypto");
  return createHash("sha256").update(hex).digest();
}

/**
 * Encrypt a plaintext string. Returns base64-encoded `iv:tag:ciphertext`.
 */
export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: base64(iv + tag + ciphertext)
  const combined = Buffer.concat([iv, tag, encrypted]);
  return combined.toString("base64");
}

/**
 * Decrypt a base64-encoded `iv:tag:ciphertext` string.
 */
export function decrypt(encoded: string): string {
  const key = getKey();
  const combined = Buffer.from(encoded, "base64");
  const iv = combined.subarray(0, IV_LENGTH);
  const tag = combined.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = combined.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext) + decipher.final("utf8");
}
