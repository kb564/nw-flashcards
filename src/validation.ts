import {
  CARD_KINDS,
  IMPORTANCE_LEVELS,
  type AnswerSection,
  type DeckPayload,
  type EncryptedEnvelope,
  type EncryptedFormat,
  type ReviewState,
  type StudyCard,
  type VaultPayload,
} from "./types";

const EXACT_DECK_KEYS = [
  "schemaVersion",
  "deckId",
  "sourceNoteCount",
  "cardCount",
  "chapterCount",
  "cards",
];
const EXACT_CARD_KEYS = [
  "id",
  "order",
  "chapter",
  "chapterTitle",
  "page",
  "importance",
  "kind",
  "term",
  "prompt",
  "answerSections",
  "exam",
  "direction",
];
const MAX_TEXT_LENGTH = 8_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isText(value: unknown, allowEmpty = false): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_TEXT_LENGTH &&
    (allowEmpty || value.trim().length > 0)
  );
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isAnswerSection(value: unknown): value is AnswerSection {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["label", "text"]) &&
    isText(value.label) &&
    isText(value.text)
  );
}

function isStudyCard(value: unknown): value is StudyCard {
  if (!isRecord(value) || !hasOnlyKeys(value, EXACT_CARD_KEYS)) return false;
  const directionOk =
    value.direction === undefined || value.direction === "forward" || value.direction === "reverse";
  return (
    typeof value.id === "string" &&
    /^nw-[a-f0-9]{24}$/.test(value.id) &&
    Number.isInteger(value.order) &&
    Number(value.order) >= 0 &&
    Number.isInteger(value.chapter) &&
    Number(value.chapter) >= 1 &&
    Number(value.chapter) <= 9 &&
    isText(value.chapterTitle) &&
    isText(value.page) &&
    IMPORTANCE_LEVELS.includes(value.importance as never) &&
    CARD_KINDS.includes(value.kind as never) &&
    isText(value.term) &&
    isText(value.prompt) &&
    Array.isArray(value.answerSections) &&
    value.answerSections.length >= 1 &&
    value.answerSections.length <= 4 &&
    value.answerSections.every(isAnswerSection) &&
    (value.exam === undefined || isText(value.exam)) &&
    directionOk
  );
}

export function assertDeckPayload(value: unknown): asserts value is DeckPayload {
  if (!isRecord(value) || !hasOnlyKeys(value, EXACT_DECK_KEYS)) {
    throw new Error("デッキ形式が正しくありません。");
  }
  if (
    value.schemaVersion !== 1 ||
    value.deckId !== "nw-r06" ||
    value.sourceNoteCount !== 551 ||
    value.cardCount !== 559 ||
    value.chapterCount !== 9 ||
    !Array.isArray(value.cards) ||
    value.cards.length !== 559 ||
    !value.cards.every(isStudyCard)
  ) {
    throw new Error("デッキの件数またはスキーマが一致しません。");
  }
  const ids = new Set(value.cards.map((card) => (card as StudyCard).id));
  if (ids.size !== 559) throw new Error("カードIDが重複しています。");
  const chapters = new Set(value.cards.map((card) => (card as StudyCard).chapter));
  if (chapters.size !== 9) throw new Error("章数が一致しません。");
}

function isSerializedFsrsCard(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const allowed = [
    "due",
    "stability",
    "difficulty",
    "elapsed_days",
    "scheduled_days",
    "learning_steps",
    "reps",
    "lapses",
    "state",
    "last_review",
  ];
  if (!hasOnlyKeys(value, allowed) || !isIsoDate(value.due)) return false;
  if (value.last_review !== null && !isIsoDate(value.last_review)) return false;
  return [
    value.stability,
    value.difficulty,
    value.elapsed_days,
    value.scheduled_days,
    value.learning_steps,
    value.reps,
    value.lapses,
    value.state,
  ].every((number) => typeof number === "number" && Number.isFinite(number));
}

function isReviewState(value: unknown): value is ReviewState {
  if (!isRecord(value) || !hasOnlyKeys(value, ["card", "firstReviewedAt", "history"])) return false;
  if (!isSerializedFsrsCard(value.card) || !isIsoDate(value.firstReviewedAt) || !Array.isArray(value.history)) {
    return false;
  }
  if (value.history.length > 100_000) return false;
  return value.history.every((item) => {
    if (!isRecord(item) || !hasOnlyKeys(item, ["reviewedAt", "rating", "dueBefore", "dueAfter"])) {
      return false;
    }
    return (
      isIsoDate(item.reviewedAt) &&
      [1, 2, 3, 4].includes(Number(item.rating)) &&
      isIsoDate(item.dueBefore) &&
      isIsoDate(item.dueAfter)
    );
  });
}

function isReviewMap(value: unknown): value is Record<string, ReviewState> {
  return (
    isRecord(value) &&
    Object.keys(value).length <= 2_000 &&
    Object.entries(value).every(([id, state]) => /^nw-[a-f0-9]{24}$/.test(id) && isReviewState(state))
  );
}

export function assertVaultPayload(value: unknown): asserts value is VaultPayload {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["schemaVersion", "deck", "reviews", "orphanReviews", "settings"]) ||
    value.schemaVersion !== 1
  ) {
    throw new Error("保管庫形式が正しくありません。");
  }
  assertDeckPayload(value.deck);
  if (!isReviewMap(value.reviews) || !isReviewMap(value.orphanReviews)) {
    throw new Error("復習履歴形式が正しくありません。");
  }
  if (
    !isRecord(value.settings) ||
    !hasOnlyKeys(value.settings, ["newCardsPerDay", "requestRetention", "timezone"]) ||
    !Number.isInteger(value.settings.newCardsPerDay) ||
    Number(value.settings.newCardsPerDay) < 1 ||
    Number(value.settings.newCardsPerDay) > 50 ||
    value.settings.requestRetention !== 0.9 ||
    value.settings.timezone !== "Asia/Tokyo"
  ) {
    throw new Error("設定形式が正しくありません。");
  }
}

export function assertEncryptedEnvelope(
  value: unknown,
  expected?: EncryptedFormat | readonly EncryptedFormat[],
): asserts value is EncryptedEnvelope {
  if (!isRecord(value) || !hasOnlyKeys(value, ["format", "version", "kdf", "cipher", "ciphertext"])) {
    throw new Error("暗号化ファイル形式が正しくありません。");
  }
  const expectedFormats = expected === undefined ? undefined : Array.isArray(expected) ? expected : [expected];
  if (
    !["nwdeck", "nwbackup", "nwvault"].includes(String(value.format)) ||
    (expectedFormats && !expectedFormats.includes(value.format as EncryptedFormat)) ||
    value.version !== 1 ||
    !isRecord(value.kdf) ||
    !hasOnlyKeys(value.kdf, ["name", "hash", "iterations", "salt"]) ||
    value.kdf.name !== "PBKDF2" ||
    value.kdf.hash !== "SHA-256" ||
    value.kdf.iterations !== 600000 ||
    typeof value.kdf.salt !== "string" ||
    !isRecord(value.cipher) ||
    !hasOnlyKeys(value.cipher, ["name", "iv"]) ||
    value.cipher.name !== "AES-GCM" ||
    typeof value.cipher.iv !== "string" ||
    typeof value.ciphertext !== "string"
  ) {
    throw new Error("未対応または改変された暗号化ファイルです。");
  }
}
