import {
  CARD_KINDS, COLLECTION_IDS, IMPORTANCE_LEVELS,
  type AnswerSection, type DeckCollection, type DeckPayload, type EncryptedEnvelope,
  type EncryptedFormat, type ReviewState, type StudyCard, type VaultPayload,
} from "./types";

const V1_DECK_KEYS = ["schemaVersion", "deckId", "sourceNoteCount", "cardCount", "chapterCount", "cards"];
const V1_CARD_KEYS = ["id", "order", "chapter", "chapterTitle", "page", "importance", "kind", "term", "prompt", "answerSections", "exam", "direction"];
const V2_DECK_KEYS = [...V1_DECK_KEYS, "collections"];
const V2_CARD_KEYS = [...V1_CARD_KEYS, "collectionId", "sourceLabel", "sourceLocator", "primaryRelatedCardId", "relatedCardIds"];
const COLLECTION_KEYS = ["id", "label", "sourceNoteCount", "cardCount", "asOfDate"];
const MAX_TEXT_LENGTH = 8_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
function isText(value: unknown, allowEmpty = false): value is string {
  return typeof value === "string" && value.length <= MAX_TEXT_LENGTH && (allowEmpty || value.trim().length > 0);
}
function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
function isId(value: unknown): value is string {
  return typeof value === "string" && /^nw-[a-f0-9]{24}$/.test(value);
}
function isAnswerSection(value: unknown): value is AnswerSection {
  return isRecord(value) && hasOnlyKeys(value, ["label", "text"]) && isText(value.label) && isText(value.text);
}
function isCardBase(value: Record<string, unknown>): boolean {
  const directionOk = value.direction === undefined || value.direction === "forward" || value.direction === "reverse";
  return isId(value.id) && Number.isInteger(value.order) && Number(value.order) >= 0 &&
    Number.isInteger(value.chapter) && Number(value.chapter) >= 1 && Number(value.chapter) <= 9 &&
    isText(value.chapterTitle) && isText(value.page) && IMPORTANCE_LEVELS.includes(value.importance as never) &&
    CARD_KINDS.includes(value.kind as never) && isText(value.term) && isText(value.prompt) &&
    Array.isArray(value.answerSections) && value.answerSections.length >= 1 && value.answerSections.length <= 4 &&
    value.answerSections.every(isAnswerSection) && (value.exam === undefined || isText(value.exam)) && directionOk;
}
function isLegacyStudyCard(value: unknown): boolean {
  return isRecord(value) && hasOnlyKeys(value, V1_CARD_KEYS) && isCardBase(value);
}
function isStudyCard(value: unknown): value is StudyCard {
  if (!isRecord(value) || !hasOnlyKeys(value, V2_CARD_KEYS) || !isCardBase(value)) return false;
  if (!COLLECTION_IDS.includes(value.collectionId as never) || !isText(value.sourceLabel) || !isText(value.sourceLocator)) return false;
  if (/https?:\/\//iu.test(String(value.sourceLabel)) || /https?:\/\//iu.test(String(value.sourceLocator))) return false;
  if (!Array.isArray(value.relatedCardIds) || !value.relatedCardIds.every(isId) || new Set(value.relatedCardIds).size !== value.relatedCardIds.length) return false;
  if (value.primaryRelatedCardId !== undefined && !isId(value.primaryRelatedCardId)) return false;
  if (value.collectionId === "textbook-r06" && value.primaryRelatedCardId !== undefined) return false;
  if (value.collectionId === "catchup" && (value.primaryRelatedCardId === undefined || !value.relatedCardIds.includes(value.primaryRelatedCardId))) return false;
  return !value.relatedCardIds.includes(value.id as string);
}
function isCollection(value: unknown): value is DeckCollection {
  if (!isRecord(value) || !hasOnlyKeys(value, COLLECTION_KEYS) || !COLLECTION_IDS.includes(value.id as never) ||
    !isText(value.label) || !Number.isInteger(value.sourceNoteCount) || Number(value.sourceNoteCount) < 0 ||
    !Number.isInteger(value.cardCount) || Number(value.cardCount) < 0 ||
    (value.asOfDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(value.asOfDate)))) return false;
  return value.id === "catchup" ? value.asOfDate === "2026-08-29" : value.asOfDate === undefined;
}

function validateDeckV2(value: unknown): DeckPayload {
  if (!isRecord(value) || !hasOnlyKeys(value, V2_DECK_KEYS) || value.schemaVersion !== 2 ||
      value.deckId !== "nw-r06" || value.chapterCount !== 9 || !Number.isInteger(value.sourceNoteCount) ||
      !Number.isInteger(value.cardCount) || !Array.isArray(value.collections) || !value.collections.every(isCollection) ||
      !Array.isArray(value.cards) || !value.cards.every(isStudyCard)) {
    throw new Error("デッキの件数またはスキーマが一致しません。");
  }
  const deck = value as unknown as DeckPayload;
  if (deck.cards.length !== deck.cardCount || deck.collections.reduce((sum, item) => sum + item.sourceNoteCount, 0) !== deck.sourceNoteCount ||
      deck.collections.reduce((sum, item) => sum + item.cardCount, 0) !== deck.cardCount) {
    throw new Error("デッキのコレクション件数が一致しません。");
  }
  const collectionIds = new Set(deck.collections.map((item) => item.id));
  if (collectionIds.size !== deck.collections.length || !collectionIds.has("textbook-r06")) throw new Error("コレクションが重複または欠落しています。");
  const usedCollectionIds = new Set(deck.cards.map((card) => card.collectionId));
  if (usedCollectionIds.size !== collectionIds.size || [...usedCollectionIds].some((id) => !collectionIds.has(id))) throw new Error("未使用または未定義のコレクションがあります。");
  const ids = new Set(deck.cards.map((card) => card.id));
  if (ids.size !== deck.cards.length || deck.cards.some((card, index) => card.order !== index)) throw new Error("カードIDまたは紙面順が不正です。");
  const cardsById = new Map(deck.cards.map((card) => [card.id, card]));
  for (const card of deck.cards) {
    if (card.relatedCardIds.some((id) => !cardsById.has(id))) throw new Error("存在しない関連カードがあります。");
    for (const relatedId of card.relatedCardIds) {
      const related = cardsById.get(relatedId)!;
      if (!related.relatedCardIds.includes(card.id) || related.collectionId === card.collectionId) throw new Error("関連カードが非対称または同一コレクション内です。");
    }
    if (card.primaryRelatedCardId && cardsById.get(card.primaryRelatedCardId)?.collectionId !== "textbook-r06") throw new Error("補足の主関連カードが不正です。");
    if (card.collectionId === "catchup") {
      const primary = cardsById.get(card.primaryRelatedCardId!);
      const between = deck.cards.slice((primary?.order ?? -1) + 1, card.order);
      if (!primary || primary.order >= card.order || between.some((item) => item.collectionId !== "catchup" || item.primaryRelatedCardId !== primary.id)) {
        throw new Error("補足が主関連カード直後のグループにありません。");
      }
    }
  }
  for (const collection of deck.collections) {
    if (deck.cards.filter((card) => card.collectionId === collection.id).length !== collection.cardCount) throw new Error("コレクション内カード数が一致しません。");
  }
  if (new Set(deck.cards.map((card) => card.chapter)).size !== 9) throw new Error("章数が一致しません。");
  return deck;
}

function migrateLegacyDeck(value: unknown): DeckPayload {
  if (!isRecord(value) || !hasOnlyKeys(value, V1_DECK_KEYS) || value.schemaVersion !== 1 || value.deckId !== "nw-r06" ||
      value.sourceNoteCount !== 551 || value.cardCount !== 559 || value.chapterCount !== 9 ||
      !Array.isArray(value.cards) || value.cards.length !== 559 || !value.cards.every(isLegacyStudyCard)) {
    throw new Error("旧デッキ形式が正しくありません。");
  }
  const legacyCards = value.cards as Array<Record<string, unknown>>;
  if (new Set(legacyCards.map((card) => card.id)).size !== 559) throw new Error("旧デッキのカードIDが重複しています。");
  const cards = legacyCards.map((card) => ({
    ...card,
    collectionId: "textbook-r06" as const,
    sourceLabel: "令和6年版教科書",
    sourceLocator: `紙面 p.${String(card.page)}`,
    relatedCardIds: [],
  })) as unknown as StudyCard[];
  return validateDeckV2({
    schemaVersion: 2, deckId: "nw-r06", sourceNoteCount: 551, cardCount: 559, chapterCount: 9,
    collections: [{ id: "textbook-r06", label: "令和6年版教科書", sourceNoteCount: 551, cardCount: 559 }],
    cards,
  });
}

export function normalizeDeckPayload(value: unknown): DeckPayload {
  return isRecord(value) && value.schemaVersion === 1 ? migrateLegacyDeck(value) : validateDeckV2(value);
}
export function assertDeckPayload(value: unknown): asserts value is DeckPayload { void validateDeckV2(value); }

function isSerializedFsrsCard(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const allowed = ["due", "stability", "difficulty", "elapsed_days", "scheduled_days", "learning_steps", "reps", "lapses", "state", "last_review"];
  if (!hasOnlyKeys(value, allowed) || !isIsoDate(value.due) || (value.last_review !== null && !isIsoDate(value.last_review))) return false;
  return [value.stability, value.difficulty, value.elapsed_days, value.scheduled_days, value.learning_steps, value.reps, value.lapses, value.state]
    .every((number) => typeof number === "number" && Number.isFinite(number));
}
function isReviewState(value: unknown): value is ReviewState {
  if (!isRecord(value) || !hasOnlyKeys(value, ["card", "firstReviewedAt", "history"]) || !isSerializedFsrsCard(value.card) ||
      !isIsoDate(value.firstReviewedAt) || !Array.isArray(value.history) || value.history.length > 100_000) return false;
  return value.history.every((item) => isRecord(item) && hasOnlyKeys(item, ["reviewedAt", "rating", "dueBefore", "dueAfter"]) &&
    isIsoDate(item.reviewedAt) && [1, 2, 3, 4].includes(Number(item.rating)) && isIsoDate(item.dueBefore) && isIsoDate(item.dueAfter));
}
function isReviewMap(value: unknown): value is Record<string, ReviewState> {
  return isRecord(value) && Object.keys(value).length <= 5_000 && Object.entries(value).every(([id, state]) => isId(id) && isReviewState(state));
}
function assertSettings(value: unknown): void {
  if (!isRecord(value) || !hasOnlyKeys(value, ["newCardsPerDay", "requestRetention", "timezone"]) ||
      !Number.isInteger(value.newCardsPerDay) || Number(value.newCardsPerDay) < 1 || Number(value.newCardsPerDay) > 50 ||
      value.requestRetention !== 0.9 || value.timezone !== "Asia/Tokyo") throw new Error("設定形式が正しくありません。");
}
function validateVaultParts(value: Record<string, unknown>): void {
  if (!isReviewMap(value.reviews) || !isReviewMap(value.orphanReviews)) throw new Error("復習履歴形式が正しくありません。");
  assertSettings(value.settings);
}
export function normalizeVaultPayload(value: unknown): VaultPayload {
  if (!isRecord(value) || !hasOnlyKeys(value, ["schemaVersion", "deck", "reviews", "orphanReviews", "settings"]) || ![1, 2].includes(Number(value.schemaVersion))) {
    throw new Error("保管庫形式が正しくありません。");
  }
  validateVaultParts(value);
  const deck = normalizeDeckPayload(value.deck);
  return { schemaVersion: 2, deck, reviews: value.reviews, orphanReviews: value.orphanReviews, settings: value.settings } as VaultPayload;
}
export function assertVaultPayload(value: unknown): asserts value is VaultPayload {
  if (!isRecord(value) || value.schemaVersion !== 2) throw new Error("保管庫形式が正しくありません。");
  const normalized = normalizeVaultPayload(value);
  if (normalized.deck !== value.deck) throw new Error("保管庫形式が正しくありません。");
}

export function assertEncryptedEnvelope(value: unknown, expected?: EncryptedFormat | readonly EncryptedFormat[]): asserts value is EncryptedEnvelope {
  if (!isRecord(value) || !hasOnlyKeys(value, ["format", "version", "kdf", "cipher", "ciphertext"])) throw new Error("暗号化ファイル形式が正しくありません。");
  const expectedFormats = expected === undefined ? undefined : Array.isArray(expected) ? expected : [expected];
  if (!["nwdeck", "nwbackup", "nwvault"].includes(String(value.format)) || (expectedFormats && !expectedFormats.includes(value.format as EncryptedFormat)) ||
      value.version !== 1 || !isRecord(value.kdf) || !hasOnlyKeys(value.kdf, ["name", "hash", "iterations", "salt"]) ||
      value.kdf.name !== "PBKDF2" || value.kdf.hash !== "SHA-256" || value.kdf.iterations !== 600000 || typeof value.kdf.salt !== "string" ||
      !isRecord(value.cipher) || !hasOnlyKeys(value.cipher, ["name", "iv"]) || value.cipher.name !== "AES-GCM" ||
      typeof value.cipher.iv !== "string" || typeof value.ciphertext !== "string") throw new Error("未対応または改変された暗号化ファイルです。");
}
