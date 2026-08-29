import { createEmptyCard, fsrs, Rating, type Card as FsrsCard, type Grade } from "ts-fsrs";
import {
  deserializeFsrsCard,
  serializeFsrsCard,
  type CardFilters,
  type ReviewState,
  type StudyCard,
  type StudyCounts,
  type VaultPayload,
} from "./types";

const scheduler = fsrs({ request_retention: 0.9, maximum_interval: 36_500 });

export const RATINGS = [Rating.Again, Rating.Hard, Rating.Good, Rating.Easy] as const;

export const RATING_LABELS: Record<Grade, string> = {
  [Rating.Again]: "忘れた",
  [Rating.Hard]: "難しい",
  [Rating.Good]: "正解",
  [Rating.Easy]: "簡単",
};

export function tokyoDayKey(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${read("year")}-${read("month")}-${read("day")}`;
}

function introducedToday(review: ReviewState, now: Date): boolean {
  return tokyoDayKey(new Date(review.firstReviewedAt)) === tokyoDayKey(now);
}

export function getStudyCounts(vault: VaultPayload, now: Date): StudyCounts {
  const learned = Object.keys(vault.reviews).length;
  const due = Object.values(vault.reviews).filter((review) => new Date(review.card.due) <= now).length;
  return {
    due,
    newAvailable: selectNewCards(vault, now).length,
    learned,
    total: vault.deck.cards.length,
  };
}

function selectNewCards(vault: VaultPayload, now: Date): StudyCard[] {
  const cardsById = new Map(vault.deck.cards.map((card) => [card.id, card]));
  const introduced = Object.entries(vault.reviews)
    .filter(([, review]) => introducedToday(review, now))
    .map(([id]) => cardsById.get(id))
    .filter((card): card is StudyCard => card !== undefined);
  const limit = Math.max(vault.settings.newCardsPerDay - introduced.length, 0);
  if (limit === 0) return [];
  const dailyCatchupTarget = Math.round(vault.settings.newCardsPerDay * 0.2);
  const dailyTextbookTarget = vault.settings.newCardsPerDay - dailyCatchupTarget;
  const introducedTextbook = introduced.filter((card) => card.collectionId === "textbook-r06").length;
  const introducedCatchup = introduced.filter((card) => card.collectionId === "catchup").length;
  const unseen = vault.deck.cards.filter((card) => vault.reviews[card.id] === undefined).sort((a, b) => a.order - b.order);
  const selected: StudyCard[] = [];
  const selectedIds = new Set<string>();
  const eligible = (card: StudyCard) => card.collectionId === "textbook-r06" ||
    (card.primaryRelatedCardId !== undefined && (vault.reviews[card.primaryRelatedCardId] !== undefined || selectedIds.has(card.primaryRelatedCardId)));
  const take = (collectionId: StudyCard["collectionId"], count: number) => {
    for (const card of unseen) {
      if (count <= 0 || selected.length >= limit) break;
      if (selectedIds.has(card.id) || card.collectionId !== collectionId || !eligible(card)) continue;
      selected.push(card);
      selectedIds.add(card.id);
      count -= 1;
    }
  };
  take("textbook-r06", Math.max(dailyTextbookTarget - introducedTextbook, 0));
  take("catchup", Math.max(dailyCatchupTarget - introducedCatchup, 0));
  while (selected.length < limit) {
    const fallback = unseen.find((card) => !selectedIds.has(card.id) && eligible(card));
    if (!fallback) break;
    selected.push(fallback);
    selectedIds.add(fallback.id);
  }
  return selected;
}

export function buildStudyQueue(vault: VaultPayload, now: Date): StudyCard[] {
  const cardsById = new Map(vault.deck.cards.map((card) => [card.id, card]));
  const due = Object.entries(vault.reviews)
    .filter(([, review]) => new Date(review.card.due) <= now)
    .sort((left, right) => {
      const dueDifference = Date.parse(left[1].card.due) - Date.parse(right[1].card.due);
      if (dueDifference !== 0) return dueDifference;
      return (cardsById.get(left[0])?.order ?? 0) - (cardsById.get(right[0])?.order ?? 0);
    })
    .map(([id]) => cardsById.get(id))
    .filter((card): card is StudyCard => card !== undefined);

  return [...due, ...selectNewCards(vault, now)];
}

function cardForReview(review: ReviewState | undefined, now: Date): FsrsCard {
  return review ? deserializeFsrsCard(review.card) : createEmptyCard(now);
}

export function previewIntervals(vault: VaultPayload, cardId: string, now: Date): Record<Grade, Date> {
  const current = cardForReview(vault.reviews[cardId], now);
  const preview = scheduler.repeat(current, now);
  return {
    [Rating.Again]: preview[Rating.Again].card.due,
    [Rating.Hard]: preview[Rating.Hard].card.due,
    [Rating.Good]: preview[Rating.Good].card.due,
    [Rating.Easy]: preview[Rating.Easy].card.due,
  };
}

export function applyRating(vault: VaultPayload, cardId: string, grade: Grade, now: Date): VaultPayload {
  const currentReview = vault.reviews[cardId];
  const currentCard = cardForReview(currentReview, now);
  const result = scheduler.next(currentCard, now, grade);
  const nextState: ReviewState = {
    card: serializeFsrsCard(result.card),
    firstReviewedAt: currentReview?.firstReviewedAt ?? now.toISOString(),
    history: [
      ...(currentReview?.history ?? []),
      {
        reviewedAt: now.toISOString(),
        rating: grade,
        dueBefore: currentCard.due.toISOString(),
        dueAfter: result.card.due.toISOString(),
      },
    ],
  };
  return { ...vault, reviews: { ...vault.reviews, [cardId]: nextState } };
}

export function formatInterval(due: Date, now: Date): string {
  const minutes = Math.max(1, Math.round((due.getTime() - now.getTime()) / 60_000));
  if (minutes < 60) return `${minutes}分`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}時間`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}日`;
  const months = Math.round(days / 30);
  if (months < 18) return `${months}か月`;
  return `${Math.round(months / 12)}年`;
}

export function filterCards(vault: VaultPayload, filters: CardFilters, now: Date): StudyCard[] {
  const query = filters.query.normalize("NFKC").toLocaleLowerCase("ja").trim();
  const passesNonQuery = (card: StudyCard) => {
    if (filters.chapter !== "all" && card.chapter !== filters.chapter) return false;
    if (filters.collection !== "all" && card.collectionId !== filters.collection) return false;
    if (filters.importance !== "all" && card.importance !== filters.importance) return false;
    if (filters.kind !== "all" && card.kind !== filters.kind) return false;
    const review = vault.reviews[card.id];
    if (filters.state === "new" && review !== undefined) return false;
    if (filters.state === "learned" && review === undefined) return false;
    if (filters.state === "due" && (review === undefined || new Date(review.card.due) > now)) return false;
    return true;
  };
  const matchesQuery = (card: StudyCard) => {
    if (!query) return true;
    const searchable = [
      card.term, card.prompt, card.chapterTitle, card.page, card.sourceLabel, card.sourceLocator, card.exam ?? "",
      ...card.answerSections.flatMap((section) => [section.label, section.text]),
    ]
      .join("\n")
      .normalize("NFKC")
      .toLocaleLowerCase("ja");
    return searchable.includes(query);
  };
  const direct = vault.deck.cards.filter((card) => passesNonQuery(card) && matchesQuery(card));
  if (!query) return direct;
  const ids = new Set(direct.map((card) => card.id));
  const cardsById = new Map(vault.deck.cards.map((card) => [card.id, card]));
  for (const card of direct) {
    for (const id of card.relatedCardIds) {
      const related = cardsById.get(id);
      if (related && passesNonQuery(related)) ids.add(id);
    }
  }
  return vault.deck.cards.filter((card) => ids.has(card.id));
}

export function mergeDeck(vault: VaultPayload, deck: VaultPayload["deck"]): VaultPayload {
  const ids = new Set(deck.cards.map((card) => card.id));
  const reviews: Record<string, ReviewState> = {};
  const orphanReviews = { ...vault.orphanReviews };
  for (const [id, review] of Object.entries(vault.reviews)) {
    if (ids.has(id)) reviews[id] = review;
    else orphanReviews[id] = review;
  }
  for (const id of Object.keys(orphanReviews)) {
    if (ids.has(id)) {
      reviews[id] = orphanReviews[id]!;
      delete orphanReviews[id];
    }
  }
  return { ...vault, deck, reviews, orphanReviews };
}
