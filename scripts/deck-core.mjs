import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const CHAPTER_TITLES = new Map([
  [1, "基礎知識"], [2, "ネットワークインタフェース層"], [3, "インターネット層"],
  [4, "トランスポート層"], [5, "アプリケーション層"], [6, "セキュリティ"],
  [7, "ネットワーク設計"], [8, "ネットワーク管理"], [9, "仮想化とクラウド"],
]);

const TYPE_FIELDS = {
  "4問": ["何を解決する", "何者", "どこで働く", "壊れたら"],
  "一問一答": ["問", "答"], "双方向": ["問1", "答1", "問2", "答2"],
  "比較": ["問", "答"], "順序": ["問", "答"], "構造・計算": ["問", "答"],
};

// 表示用語を訂正しても既存の復習履歴を失わないよう、v1で使った同一性だけを保持する。
const LEGACY_TERM_IDENTITIES = new Map([
  ["01_fundamentals_p042-083.yaml\u000068\u0000CDN（Content Delivery Network）", "CDN（Contents Delivery Network）"],
]);

function parseYaml(path) {
  const ruby = String.raw`require "yaml"; require "json"
obj = Psych.safe_load(File.read(ARGV[0]), permitted_classes: [], aliases: false)
STDOUT.write(JSON.generate(obj))`;
  const result = spawnSync("ruby", ["-e", ruby, path], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0 || !result.stdout) throw new Error("YAMLの安全な解析に失敗しました。");
  return JSON.parse(result.stdout);
}

function stableId(fileName, locator, term, kind, direction = "forward") {
  const normalized = term.normalize("NFKC").replace(/\s+/gu, " ").trim();
  const identity = [fileName, String(locator), normalized, kind, direction].join("|");
  return `nw-${createHash("sha256").update(identity, "utf8").digest("hex").slice(0, 24)}`;
}

function requireText(card, field) {
  const value = card[field];
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 8_000) {
    throw new Error("カードの必須テキストが不正です。");
  }
  return value;
}

function commonCard(card, context, direction) {
  const term = requireText(card, "用語");
  const kind = requireText(card, "種類");
  return {
    id: stableId(context.fileName, context.identityLocator, context.identityTerm ?? term, kind, direction),
    order: context.order,
    chapter: context.chapter,
    chapterTitle: context.chapterTitle,
    page: String(context.page),
    importance: card["重要度"],
    kind,
    term,
    collectionId: context.collectionId,
    sourceLabel: context.sourceLabel,
    sourceLocator: context.sourceLocator,
    relatedCardIds: [...context.relatedCardIds],
    ...(context.primaryRelatedCardId ? { primaryRelatedCardId: context.primaryRelatedCardId } : {}),
    ...(typeof card["出題"] === "string" ? { exam: card["出題"] } : {}),
    ...(kind === "双方向" ? { direction } : {}),
  };
}

function transformNote(card, context) {
  const kind = card["種類"];
  if (!Object.hasOwn(TYPE_FIELDS, kind)) throw new Error("未対応のカード種類です。");
  for (const field of ["用語", "重要度", "種類", ...TYPE_FIELDS[kind]]) {
    if (card[field] === undefined) throw new Error("カードの必須項目が不足しています。");
  }
  if (kind === "4問") {
    return [{
      ...commonCard(card, context, "forward"),
      prompt: "次の4観点から、この用語の概念を説明してください。",
      answerSections: [
        { label: "何を解決する", text: requireText(card, "何を解決する") },
        { label: "何者", text: requireText(card, "何者") },
        { label: "どこで働く", text: requireText(card, "どこで働く") },
        { label: "壊れたら", text: requireText(card, "壊れたら") },
      ],
    }];
  }
  if (kind === "双方向") {
    return [
      { ...commonCard(card, context, "forward"), prompt: requireText(card, "問1"), answerSections: [{ label: "答え", text: requireText(card, "答1") }] },
      { ...commonCard(card, { ...context, order: context.order + 1 }, "reverse"), prompt: requireText(card, "問2"), answerSections: [{ label: "答え", text: requireText(card, "答2") }] },
    ];
  }
  return [{ ...commonCard(card, context, "forward"), prompt: requireText(card, "問"), answerSections: [{ label: "答え", text: requireText(card, "答") }] }];
}

function uniqueForwardByTerm(cards, term) {
  const matches = cards.filter((card) => card.term === term && card.direction !== "reverse");
  if (matches.length !== 1) throw new Error("補足の追加関連カードを一意に解決できません。");
  return matches[0];
}

export async function buildDeckPayload(workspaceRoot) {
  const cardDir = resolve(workspaceRoot, "cards");
  const supplementalDir = resolve(workspaceRoot, "supplemental");
  const fileNames = (await readdir(cardDir)).filter((name) => /^\d{2}_.*\.yaml$/.test(name)).sort();
  if (fileNames.length !== 9) throw new Error("カード章ファイルが9件ではありません。");
  const checker = spawnSync("python3", [resolve(workspaceRoot, "scripts/check.py")], {
    cwd: workspaceRoot, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
  });
  if (checker.status !== 0) throw new Error("カードQAに失敗したため、デッキを生成しません。");

  let textbookNoteCount = 0;
  let order = 0;
  const textbookCards = [];
  for (const fileName of fileNames) {
    const chapter = Number(fileName.slice(0, 2));
    const chapterTitle = CHAPTER_TITLES.get(chapter);
    if (!chapterTitle) throw new Error("章番号を解釈できません。");
    await readFile(resolve(cardDir, fileName), "utf8");
    const notes = parseYaml(resolve(cardDir, fileName));
    if (!Array.isArray(notes)) throw new Error("YAMLの最上位がリストではありません。");
    textbookNoteCount += notes.length;
    for (const note of notes) {
      const page = String(note["ページ"]);
      const identityTerm = LEGACY_TERM_IDENTITIES.get(`${fileName}\u0000${page}\u0000${note["用語"]}`);
      const transformed = transformNote(note, {
        fileName, identityLocator: page, identityTerm, page, chapter, chapterTitle, order,
        collectionId: "textbook-r06", sourceLabel: "令和6年版教科書",
        sourceLocator: `紙面 p.${page}`, relatedCardIds: [],
      });
      textbookCards.push(...transformed);
      order += transformed.length;
    }
  }
  if (textbookNoteCount !== 551 || textbookCards.length !== 559) throw new Error("既存カード件数が期待値と一致しません。");

  const anchorByTermPage = new Map();
  for (const card of textbookCards.filter((item) => item.direction !== "reverse")) {
    const key = `${card.term}\u0000${card.page}`;
    if (anchorByTermPage.has(key)) throw new Error("教科書の関連先候補が重複しています。");
    anchorByTermPage.set(key, card);
  }

  const supplementalNames = (await readdir(supplementalDir)).filter((name) => name.endsWith(".yaml")).sort();
  let supplementalNoteCount = 0;
  const supplementalCards = [];
  for (const fileName of supplementalNames) {
    await readFile(resolve(supplementalDir, fileName), "utf8");
    const notes = parseYaml(resolve(supplementalDir, fileName));
    if (!Array.isArray(notes)) throw new Error("補足YAMLの最上位がリストではありません。");
    supplementalNoteCount += notes.length;
    for (const note of notes) {
      const primary = anchorByTermPage.get(`${note["関連用語"]}\u0000${String(note["関連ページ"])}`);
      if (!primary) throw new Error("補足の主関連カードを解決できません。");
      const additional = note["追加関連用語"].map((term) => uniqueForwardByTerm(textbookCards, term));
      const relatedCardIds = [primary.id, ...additional.map((card) => card.id)];
      if (new Set(relatedCardIds).size !== relatedCardIds.length) throw new Error("補足の関連カードが循環または重複しています。");
      const firstSource = note["出典"][0];
      const transformed = transformNote(note, {
        fileName, identityLocator: firstSource["位置"], page: String(note["関連ページ"]),
        chapter: note["章"], chapterTitle: CHAPTER_TITLES.get(note["章"]), order,
        collectionId: "catchup", sourceLabel: firstSource["名称"], sourceLocator: firstSource["位置"],
        primaryRelatedCardId: primary.id, relatedCardIds,
      });
      supplementalCards.push(...transformed);
      order += transformed.length;
    }
  }

  const supplementIdsByTextbook = new Map();
  for (const supplement of supplementalCards) {
    for (const relatedId of supplement.relatedCardIds) {
      supplementIdsByTextbook.set(relatedId, [...(supplementIdsByTextbook.get(relatedId) ?? []), supplement.id]);
    }
  }
  const linkedTextbookCards = textbookCards.map((card) => ({
    ...card, relatedCardIds: supplementIdsByTextbook.get(card.id) ?? [],
  }));
  const supplementsByPrimary = new Map();
  for (const card of supplementalCards) {
    supplementsByPrimary.set(card.primaryRelatedCardId, [...(supplementsByPrimary.get(card.primaryRelatedCardId) ?? []), card]);
  }
  const cards = [];
  for (const textbook of linkedTextbookCards) {
    cards.push(textbook, ...(supplementsByPrimary.get(textbook.id) ?? []));
  }
  cards.forEach((card, index) => { card.order = index; });
  const ids = new Set(cards.map((card) => card.id));
  if (ids.size !== cards.length || cards.length !== textbookCards.length + supplementalCards.length) {
    throw new Error("安定カードIDが重複しています。");
  }
  return {
    schemaVersion: 2,
    deckId: "nw-r06",
    sourceNoteCount: textbookNoteCount + supplementalNoteCount,
    cardCount: cards.length,
    chapterCount: 9,
    collections: [
      { id: "textbook-r06", label: "令和6年版教科書", sourceNoteCount: textbookNoteCount, cardCount: textbookCards.length },
      { id: "catchup", label: "最新補足", sourceNoteCount: supplementalNoteCount, cardCount: supplementalCards.length, asOfDate: "2026-08-29" },
    ],
    cards,
  };
}
