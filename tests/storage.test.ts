import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { encryptPayload, importPassphrase } from "../src/crypto";
import { deleteVaultEnvelope, loadVaultEnvelope, saveVaultEnvelope } from "../src/storage";

describe("encrypted IndexedDB vault", () => {
  beforeEach(async () => {
    await deleteVaultEnvelope();
  });

  it("stores only a validated encrypted envelope", async () => {
    const material = await importPassphrase("one two three four five");
    const envelope = await encryptPayload("nwvault", { privateValue: "never plaintext" }, material);
    await saveVaultEnvelope(envelope);
    const loaded = await loadVaultEnvelope();
    expect(loaded).toEqual(envelope);
    expect(JSON.stringify(loaded)).not.toContain("never plaintext");
  }, 20_000);

  it("deletes the primary vault explicitly", async () => {
    const material = await importPassphrase("one two three four five");
    await saveVaultEnvelope(await encryptPayload("nwvault", { value: 1 }, material));
    await deleteVaultEnvelope();
    expect(await loadVaultEnvelope()).toBeNull();
  }, 20_000);
});
