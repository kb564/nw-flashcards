import { createEmptyCard, Rating } from "ts-fsrs";
import { describe, expect, it } from "vitest";
import { lockedImportModes } from "../src/import-policy";
import { serializeFsrsCard } from "../src/types";
import { normalizeDeckPayload, normalizeVaultPayload } from "../src/validation";
import { decryptPayload, encryptPayload, importPassphrase, parseEnvelopeText } from "../src/crypto";
import { applyRating } from "../src/study";

function legacyCard(index: number) {
  return {
    id: `nw-${index.toString(16).padStart(24, "0")}`,
    order: index,
    chapter: Math.min(9, Math.floor(index / 63) + 1),
    chapterTitle: "旧章",
    page: String(42 + index),
    importance: "A",
    kind: "一問一答",
    term: `旧用語${index}`,
    prompt: `旧問${index}`,
    answerSections: [{ label: "答え", text: `旧答${index}` }],
  };
}

function legacyDeck() {
  return {
    schemaVersion: 1,
    deckId: "nw-r06",
    sourceNoteCount: 551,
    cardCount: 559,
    chapterCount: 9,
    cards: Array.from({ length: 559 }, (_, index) => legacyCard(index)),
  };
}

describe("v1 to v2 migration", () => {
  it("restores two independent encrypted backup generations with their histories and settings", async () => {
    const material = await importPassphrase("public synthetic backup phrase");
    const empty = normalizeVaultPayload({ schemaVersion: 1, deck: legacyDeck(), reviews: {}, orphanReviews: {},
      settings: { newCardsPerDay: 10, requestRetention: 0.9, timezone: "Asia/Tokyo" } });
    const first = applyRating(empty, empty.deck.cards[0]!.id, Rating.Good, new Date("2026-08-29T00:00:00Z"));
    const second = applyRating(first, first.deck.cards[1]!.id, Rating.Hard, new Date("2026-08-30T00:00:00Z"));
    const backups = [];
    for (const generation of [first, second]) {
      const backup = await encryptPayload("nwbackup", generation, material);
      backups.push(backup);
      const parsed = parseEnvelopeText(JSON.stringify(backup), "nwbackup");
      const restored = normalizeVaultPayload(await decryptPayload(parsed, material, "nwbackup"));
      expect(restored).toEqual(generation);
    }
    expect(backups[0]!.kdf.salt).not.toBe(backups[1]!.kdf.salt);
    expect(backups[0]!.cipher.iv).not.toBe(backups[1]!.cipher.iv);
    expect(Object.keys(first.reviews)).toHaveLength(1);
    expect(Object.keys(second.reviews)).toHaveLength(2);
  }, 20_000);

  it("preserves every textbook card id while adding the collection", () => {
    const old = legacyDeck();
    const migrated = normalizeDeckPayload(old);
    expect(migrated.schemaVersion).toBe(2);
    expect(migrated.cards).toHaveLength(559);
    expect(migrated.cards.map((card) => card.id)).toEqual(old.cards.map((card) => card.id));
    expect(migrated.cards.every((card) => card.collectionId === "textbook-r06")).toBe(true);
  });

  it("preserves review history, settings, and orphan reviews in memory", () => {
    const id = legacyCard(0).id;
    const orphanId = `nw-${(9000).toString(16).padStart(24, "0")}`;
    const state = { card: serializeFsrsCard(createEmptyCard(new Date("2026-08-29T00:00:00Z"))), firstReviewedAt: "2026-08-29T00:00:00Z", history: [] };
    const migrated = normalizeVaultPayload({
      schemaVersion: 1,
      deck: legacyDeck(),
      reviews: { [id]: state },
      orphanReviews: { [orphanId]: state },
      settings: { newCardsPerDay: 10, requestRetention: 0.9, timezone: "Asia/Tokyo" },
    });
    expect(migrated.schemaVersion).toBe(2);
    expect(migrated.reviews[id]).toEqual(state);
    expect(migrated.orphanReviews[orphanId]).toEqual(state);
    expect(migrated.settings.newCardsPerDay).toBe(10);
  });

  it("rejects unknown legacy fields before migration", () => {
    expect(() => normalizeDeckPayload({ ...legacyDeck(), unexpected: true })).toThrow("旧デッキ形式");
  });
});

describe("locked import policy", () => {
  it("requires unlocking before a deck update when an encrypted vault already exists", () => {
    expect(lockedImportModes(true)).toEqual(["backup"]);
    expect(lockedImportModes(false)).toEqual(["deck", "backup"]);
  });
});
