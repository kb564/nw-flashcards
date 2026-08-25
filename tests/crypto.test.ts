import { describe, expect, it } from "vitest";
import { decryptPayload, encryptPayload, importPassphrase, parseEnvelopeText, validatePassphrase } from "../src/crypto";

const passphrase = "correct horse battery staple network";

describe("encrypted envelope", () => {
  it("round-trips authenticated content", async () => {
    const material = await importPassphrase(passphrase);
    const envelope = await encryptPayload("nwdeck", { safe: true, count: 559 }, material);
    const restored = await decryptPayload<{ safe: boolean; count: number }>(envelope, material, "nwdeck");
    expect(restored).toEqual({ safe: true, count: 559 });
    expect(JSON.stringify(envelope)).not.toContain("safe");
  }, 20_000);

  it("rejects a modified ciphertext without returning partial data", async () => {
    const material = await importPassphrase(passphrase);
    const envelope = await encryptPayload("nwdeck", { value: "secret" }, material);
    const bytes = Buffer.from(envelope.ciphertext, "base64");
    bytes[0] = (bytes[0] ?? 0) ^ 1;
    const modified = { ...envelope, ciphertext: bytes.toString("base64") };
    await expect(decryptPayload(modified, material, "nwdeck")).rejects.toThrow("破損");
  }, 20_000);

  it("rejects wrong passwords and unknown fields", async () => {
    const material = await importPassphrase(passphrase);
    const wrong = await importPassphrase("wrong horse battery staple network");
    const envelope = await encryptPayload("nwdeck", { value: 1 }, material);
    await expect(decryptPayload(envelope, wrong, "nwdeck")).rejects.toThrow("パスフレーズ");
    expect(() => parseEnvelopeText(JSON.stringify({ ...envelope, extra: true }), "nwdeck")).toThrow("形式");
  }, 20_000);

  it("enforces the shorter passphrase floor", () => {
    expect(() => validatePassphrase("12345678901")).toThrow("12文字");
    expect(() => validatePassphrase("one two three four")).not.toThrow();
    expect(() => validatePassphrase("123456789012")).not.toThrow();
  });
});
