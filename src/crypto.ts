import type { EncryptedEnvelope, EncryptedFormat } from "./types";
import { assertEncryptedEnvelope } from "./validation";

export const MAX_IMPORT_BYTES = 8 * 1024 * 1024;
const ITERATIONS = 600_000 as const;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(value: string, expectedLength?: number): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new Error("暗号化データの符号化が正しくありません。");
  }
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new Error("暗号化データの符号化が正しくありません。");
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (expectedLength !== undefined && bytes.length !== expectedLength) {
    throw new Error("暗号化パラメータの長さが正しくありません。");
  }
  return bytes;
}

function aadFor(envelope: Omit<EncryptedEnvelope, "ciphertext">): Uint8Array<ArrayBuffer> {
  return encoder.encode(
    [
      envelope.format,
      envelope.version,
      envelope.kdf.name,
      envelope.kdf.hash,
      envelope.kdf.iterations,
      envelope.kdf.salt,
      envelope.cipher.name,
      envelope.cipher.iv,
    ].join("|"),
  );
}

export function validatePassphrase(passphrase: string): void {
  const normalized = passphrase.normalize("NFKC");
  const wordCount = normalized.trim().split(/\s+/u).filter(Boolean).length;
  if (normalized.length < 12 && wordCount < 4) {
    throw new Error("パスフレーズは12文字以上、または空白区切りの4単語以上にしてください。");
  }
  if (normalized.length > 256) {
    throw new Error("パスフレーズは256文字以内にしてください。");
  }
}

export async function importPassphrase(passphrase: string): Promise<CryptoKey> {
  validatePassphrase(passphrase);
  return crypto.subtle.importKey("raw", encoder.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
}

async function deriveAesKey(material: CryptoKey, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: ITERATIONS },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptPayload(
  format: EncryptedFormat,
  payload: unknown,
  material: CryptoKey,
): Promise<EncryptedEnvelope> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const header: Omit<EncryptedEnvelope, "ciphertext"> = {
    format,
    version: 1,
    kdf: {
      name: "PBKDF2",
      hash: "SHA-256",
      iterations: ITERATIONS,
      salt: bytesToBase64(salt),
    },
    cipher: { name: "AES-GCM", iv: bytesToBase64(iv) },
  };
  const key = await deriveAesKey(material, salt);
  const plaintext = encoder.encode(JSON.stringify(payload));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aadFor(header), tagLength: 128 },
    key,
    plaintext,
  );
  plaintext.fill(0);
  return { ...header, ciphertext: bytesToBase64(new Uint8Array(ciphertext)) };
}

export async function decryptPayload<T>(
  envelope: EncryptedEnvelope,
  material: CryptoKey,
  expected: EncryptedFormat | readonly EncryptedFormat[],
): Promise<T> {
  assertEncryptedEnvelope(envelope, expected);
  const salt = base64ToBytes(envelope.kdf.salt, 16);
  const iv = base64ToBytes(envelope.cipher.iv, 12);
  const ciphertext = base64ToBytes(envelope.ciphertext);
  if (ciphertext.length < 17 || ciphertext.length > MAX_IMPORT_BYTES) {
    throw new Error("暗号化データのサイズが正しくありません。");
  }
  const { ciphertext: _ignored, ...header } = envelope;
  void _ignored;
  try {
    const key = await deriveAesKey(material, salt);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: aadFor(header), tagLength: 128 },
      key,
      ciphertext,
    );
    const bytes = new Uint8Array(plaintext);
    try {
      return JSON.parse(decoder.decode(bytes)) as T;
    } finally {
      bytes.fill(0);
    }
  } catch {
    throw new Error("パスフレーズが違うか、ファイルが破損しています。");
  }
}

export function parseEnvelopeText(
  text: string,
  expected: EncryptedFormat | readonly EncryptedFormat[],
): EncryptedEnvelope {
  if (new Blob([text]).size > MAX_IMPORT_BYTES) throw new Error("ファイルが大きすぎます。");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("暗号化ファイルをJSONとして読めません。");
  }
  assertEncryptedEnvelope(parsed, expected);
  return parsed;
}
