import { Rating, createEmptyCard } from "ts-fsrs";
import { describe, expect, it } from "vitest";
import { applyRating, buildStudyQueue, getStudyCounts, mergeDeck, tokyoDayKey } from "../src/study";
import { serializeFsrsCard, type DeckPayload, type StudyCard, type VaultPayload } from "../src/types";

function makeCard(index: number): StudyCard {
  return {
    id: `nw-${index.toString(16).padStart(24, "0")}`,
    order: index,
    chapter: Math.min(9, Math.floor(index / 62) + 1),
    chapterTitle: "テスト章",
    page: String(42 + index),
    importance: "A",
    kind: "一問一答",
    term: `用語${index}`,
    prompt: `問${index}`,
    answerSections: [{ label: "答え", text: `答${index}` }],
  };
}

function makeVault(): VaultPayload {
  const cards = Array.from({ length: 559 }, (_, index) => makeCard(index));
  const deck: DeckPayload = {
    schemaVersion: 1,
    deckId: "nw-r06",
    sourceNoteCount: 551,
    cardCount: 559,
    chapterCount: 9,
    cards,
  };
  return {
    schemaVersion: 1,
    deck,
    reviews: {},
    orphanReviews: {},
    settings: { newCardsPerDay: 10, requestRetention: 0.9, timezone: "Asia/Tokyo" },
  };
}

describe("study scheduling", () => {
  it("introduces ten cards in textbook order", () => {
    const vault = makeVault();
    const queue = buildStudyQueue(vault, new Date("2026-08-24T00:00:00.000Z"));
    expect(queue).toHaveLength(10);
    expect(queue.map((card) => card.order)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("places due reviews before unseen cards", () => {
    const vault = makeVault();
    const now = new Date("2026-08-24T00:00:00.000Z");
    const reviewed = applyRating(vault, vault.deck.cards[20]!.id, Rating.Good, new Date("2026-08-01T00:00:00.000Z"));
    const queue = buildStudyQueue(reviewed, now);
    expect(queue[0]?.id).toBe(vault.deck.cards[20]!.id);
  });

  it("records rating and preserves it through a same-id deck update", () => {
    const vault = makeVault();
    const id = vault.deck.cards[0]!.id;
    const now = new Date("2026-08-24T00:00:00.000Z");
    const reviewed = applyRating(vault, id, Rating.Good, now);
    expect(reviewed.reviews[id]?.history[0]?.rating).toBe(Rating.Good);
    const changedDeck = {
      ...reviewed.deck,
      cards: reviewed.deck.cards.map((card) => (card.id === id ? { ...card, answerSections: [{ label: "答え", text: "修正版" }] } : card)),
    };
    const merged = mergeDeck(reviewed, changedDeck);
    expect(merged.reviews[id]?.history).toHaveLength(1);
  });

  it("moves removed review state to the orphan store", () => {
    const vault = makeVault();
    const id = vault.deck.cards[0]!.id;
    const initial = createEmptyCard(new Date());
    vault.reviews[id] = {
      card: serializeFsrsCard(initial),
      firstReviewedAt: new Date().toISOString(),
      history: [],
    };
    const replacement = { ...vault.deck, cards: vault.deck.cards.map((card, index) => (index === 0 ? { ...makeCard(900), order: 0 } : card)) };
    const merged = mergeDeck(vault, replacement);
    expect(merged.reviews[id]).toBeUndefined();
    expect(merged.orphanReviews[id]).toBeDefined();
  });

  it("uses Tokyo calendar days and reports counts", () => {
    expect(tokyoDayKey(new Date("2026-08-23T15:00:00.000Z"))).toBe("2026-08-24");
    const counts = getStudyCounts(makeVault(), new Date());
    expect(counts).toEqual({ due: 0, newAvailable: 10, learned: 0, total: 559 });
  });
});
