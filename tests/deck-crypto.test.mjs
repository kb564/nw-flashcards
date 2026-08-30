import { describe, expect, it } from 'vitest';
import { encryptDeck } from '../scripts/create-deck.mjs';
import { decryptPayload, importPassphrase, parseEnvelopeText } from '../src/crypto';

// Public synthetic fixture only; no private deck or real passphrase enters reports.
describe('local encrypted deck compatibility', () => {
  it('round-trips the CLI envelope with the PWA and rejects wrong keys and tampering', async () => {
    const sample = { synthetic: true, count: 759 };
    const passphrase = 'public synthetic testing phrase';
    const envelope = await encryptDeck(sample, passphrase);
    const parsed = parseEnvelopeText(JSON.stringify(envelope), 'nwdeck');
    const material = await importPassphrase(passphrase);
    expect(await decryptPayload(parsed, material, 'nwdeck')).toEqual(sample);
    const wrong = await importPassphrase('different synthetic testing phrase');
    await expect(decryptPayload(parsed, wrong, 'nwdeck')).rejects.toThrow('パスフレーズ');
    const bytes = Buffer.from(parsed.ciphertext, 'base64');
    bytes[0] ^= 1;
    await expect(decryptPayload({ ...parsed, ciphertext: bytes.toString('base64') }, material, 'nwdeck')).rejects.toThrow('破損');
  }, 20_000);
});
