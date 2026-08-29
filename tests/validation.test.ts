import { createEmptyCard } from "ts-fsrs";
import { describe, expect, it } from "vitest";
import { serializeFsrsCard } from "../src/types";
import { normalizeDeckPayload, normalizeVaultPayload } from "../src/validation";

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
