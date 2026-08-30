import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

  it('retains the original ciphertext when a replacement transaction is aborted', async () => {
    const material = await importPassphrase('one two three four five');
    const original = await encryptPayload('nwvault', { revision: 1 }, material);
    const replacement = await encryptPayload('nwvault', { revision: 2 }, material);
    await saveVaultEnvelope(original);
    const put = IDBObjectStore.prototype.put;
    const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<typeof put>) {
      const request = put.apply(this, args);
      this.transaction.abort();
      return request;
    });
    try { await expect(saveVaultEnvelope(replacement)).rejects.toThrow(); }
    finally { spy.mockRestore(); }
    expect(await loadVaultEnvelope()).toEqual(original);
  }, 20_000);

  it('retains the original ciphertext when storage quota is exceeded', async () => {
    const material = await importPassphrase('one two three four five');
    const original = await encryptPayload('nwvault', { revision: 1 }, material);
    await saveVaultEnvelope(original);
    const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => { throw new DOMException('quota', 'QuotaExceededError'); });
    try { await expect(saveVaultEnvelope(original)).rejects.toThrow(); }
    finally { spy.mockRestore(); }
    expect(await loadVaultEnvelope()).toEqual(original);
  }, 20_000);
});
