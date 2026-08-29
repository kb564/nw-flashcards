import { Rating, createEmptyCard } from "ts-fsrs";
import { describe, expect, it } from "vitest";
import { applyRating, buildStudyQueue, filterCards, getStudyCounts, mergeDeck, tokyoDayKey } from "../src/study";
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
    collectionId: "textbook-r06",
    sourceLabel: "令和6年版教科書",
    sourceLocator: `紙面 p.${42 + index}`,
    relatedCardIds: [],
  };
}

function makeVault(): VaultPayload {
  const cards = Array.from({ length: 559 }, (_, index) => makeCard(index));
  const deck: DeckPayload = {
    schemaVersion: 2,
    deckId: "nw-r06",
    sourceNoteCount: 551,
    cardCount: 559,
    chapterCount: 9,
    collections: [{ id: "textbook-r06", label: "令和6年版教科書", sourceNoteCount: 551, cardCount: 559 }],
    cards,
  };
  return {
    schemaVersion: 2,
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

  it("uses an 8:2 textbook/catch-up mix only after the anchor is selected first", () => {
    const vault = makeVault();
    const anchor = vault.deck.cards[0]!;
    const catchups = [600, 601].map((index) => ({
      ...makeCard(index),
      order: vault.deck.cards.length + index - 600,
      collectionId: "catchup" as const,
      sourceLabel: "R07 午後II",
      sourceLocator: "問2",
      primaryRelatedCardId: anchor.id,
      relatedCardIds: [anchor.id],
    }));
    vault.deck = {
      ...vault.deck,
      sourceNoteCount: 553,
      cardCount: 561,
      collections: [
        vault.deck.collections[0]!,
        { id: "catchup", label: "最新補足", sourceNoteCount: 2, cardCount: 2, asOfDate: "2026-08-29" },
      ],
      cards: [...vault.deck.cards, ...catchups],
    };
    const queue = buildStudyQueue(vault, new Date("2026-08-24T00:00:00.000Z"));
    expect(queue).toHaveLength(10);
    expect(queue.filter((card) => card.collectionId === "textbook-r06")).toHaveLength(8);
    expect(queue.filter((card) => card.collectionId === "catchup")).toHaveLength(2);
    expect(queue.findIndex((card) => card.id === anchor.id)).toBeLessThan(queue.findIndex((card) => card.collectionId === "catchup"));
  });

  it("defers catch-up cards whose textbook prerequisite is neither learned nor selected", () => {
    const vault = makeVault();
    const unselectedAnchor = vault.deck.cards[500]!;
    const catchup: StudyCard = {
      ...makeCard(600),
      order: vault.deck.cards.length,
      collectionId: "catchup",
      sourceLabel: "R07 午後II",
      sourceLocator: "問2",
      primaryRelatedCardId: unselectedAnchor.id,
      relatedCardIds: [unselectedAnchor.id],
    };
    vault.deck = {
      ...vault.deck,
      sourceNoteCount: 552,
      cardCount: 560,
      collections: [
        vault.deck.collections[0]!,
        { id: "catchup", label: "最新補足", sourceNoteCount: 1, cardCount: 1, asOfDate: "2026-08-29" },
      ],
      cards: [...vault.deck.cards, catchup],
    };

    const queue = buildStudyQueue(vault, new Date("2026-08-24T00:00:00.000Z"));
    expect(queue).toHaveLength(10);
    expect(queue.every((card) => card.collectionId === "textbook-r06")).toBe(true);
    expect(queue).not.toContainEqual(catchup);
  });

  it("keeps directly related textbook and catch-up cards together in search results", () => {
    const vault = makeVault();
    const anchor = { ...vault.deck.cards[0]!, relatedCardIds: ["nw-aaaaaaaaaaaaaaaaaaaaaaaa"] };
    const catchup: StudyCard = {
      ...makeCard(600),
      id: "nw-aaaaaaaaaaaaaaaaaaaaaaaa",
      order: 1,
      term: "補足固有語",
      collectionId: "catchup",
      sourceLabel: "R07 午後II",
      sourceLocator: "問2",
      primaryRelatedCardId: anchor.id,
      relatedCardIds: [anchor.id],
    };
    vault.deck.cards = [anchor, catchup, ...vault.deck.cards.slice(1).map((card, index) => ({ ...card, order: index + 2 }))];
    const results = filterCards(vault, {
      query: "補足固有語",
      chapter: "all",
      collection: "all",
      importance: "all",
      kind: "all",
      state: "all",
    }, new Date("2026-08-29T00:00:00Z"));
    expect(results.map((card) => card.id)).toEqual([anchor.id, catchup.id]);
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
