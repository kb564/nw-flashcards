import type { Card as FsrsCard, Rating } from "ts-fsrs";

export const CARD_KINDS = ["4問", "一問一答", "双方向", "比較", "順序", "構造・計算"] as const;
export const IMPORTANCE_LEVELS = ["A", "B", "C"] as const;
export const COLLECTION_IDS = ["textbook-r06", "catchup"] as const;

export type CardKind = (typeof CARD_KINDS)[number];
export type Importance = (typeof IMPORTANCE_LEVELS)[number];
export type CollectionId = (typeof COLLECTION_IDS)[number];
export type EncryptedFormat = "nwdeck" | "nwbackup" | "nwvault";

export interface AnswerSection { label: string; text: string }

export interface DeckCollection {
  id: CollectionId;
  label: string;
  sourceNoteCount: number;
  cardCount: number;
  asOfDate?: string;
}

export interface StudyCard {
  id: string;
  order: number;
  chapter: number;
  chapterTitle: string;
  page: string;
  importance: Importance;
  kind: CardKind;
  term: string;
  prompt: string;
  answerSections: AnswerSection[];
  exam?: string;
  direction?: "forward" | "reverse";
  collectionId: CollectionId;
  sourceLabel: string;
  sourceLocator: string;
  primaryRelatedCardId?: string;
  relatedCardIds: string[];
}

export interface DeckPayload {
  schemaVersion: 2;
  deckId: "nw-r06";
  sourceNoteCount: number;
  cardCount: number;
  chapterCount: 9;
  collections: DeckCollection[];
  cards: StudyCard[];
}

export interface SerializedFsrsCard {
  due: string; stability: number; difficulty: number; elapsed_days: number;
  scheduled_days: number; learning_steps: number; reps: number; lapses: number;
  state: number; last_review: string | null;
}

export interface ReviewEvent { reviewedAt: string; rating: Rating; dueBefore: string; dueAfter: string }
export interface ReviewState { card: SerializedFsrsCard; firstReviewedAt: string; history: ReviewEvent[] }
export interface VaultSettings { newCardsPerDay: number; requestRetention: 0.9; timezone: "Asia/Tokyo" }

export interface VaultPayload {
  schemaVersion: 2;
  deck: DeckPayload;
  reviews: Record<string, ReviewState>;
  orphanReviews: Record<string, ReviewState>;
  settings: VaultSettings;
}

export interface EncryptedEnvelope {
  format: EncryptedFormat;
  version: 1;
  kdf: { name: "PBKDF2"; hash: "SHA-256"; iterations: 600000; salt: string };
  cipher: { name: "AES-GCM"; iv: string };
  ciphertext: string;
}

export interface StudyCounts { due: number; newAvailable: number; learned: number; total: number }

export interface CardFilters {
  query: string;
  chapter: number | "all";
  collection: CollectionId | "all";
  importance: Importance | "all";
  kind: CardKind | "all";
  state: "all" | "new" | "due" | "learned";
}

export function serializeFsrsCard(card: FsrsCard): SerializedFsrsCard {
  return {
    due: card.due.toISOString(), stability: card.stability, difficulty: card.difficulty,
    elapsed_days: card.elapsed_days, scheduled_days: card.scheduled_days,
    learning_steps: card.learning_steps, reps: card.reps, lapses: card.lapses,
    state: card.state, last_review: card.last_review?.toISOString() ?? null,
  };
}

export function deserializeFsrsCard(card: SerializedFsrsCard): FsrsCard {
  return { ...card, due: new Date(card.due), last_review: card.last_review ? new Date(card.last_review) : undefined } as FsrsCard;
}
