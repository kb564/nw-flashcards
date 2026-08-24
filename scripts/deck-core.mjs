import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const CHAPTER_TITLES = new Map([
  [1, "基礎知識"],
  [2, "ネットワークインタフェース層"],
  [3, "インターネット層"],
  [4, "トランスポート層"],
  [5, "アプリケーション層"],
  [6, "セキュリティ"],
  [7, "ネットワーク設計"],
  [8, "ネットワーク管理"],
  [9, "仮想化とクラウド"],
]);

const TYPE_FIELDS = {
  "4問": ["何を解決する", "何者", "どこで働く", "壊れたら"],
  "一問一答": ["問", "答"],
  "双方向": ["問1", "答1", "問2", "答2"],
  "比較": ["問", "答"],
  "順序": ["問", "答"],
  "構造・計算": ["問", "答"],
};

function parseYaml(path) {
  const ruby = String.raw`require "yaml"; require "json"
obj = Psych.safe_load(File.read(ARGV[0]), permitted_classes: [], aliases: false)
STDOUT.write(JSON.generate(obj))`;
  const result = spawnSync("ruby", ["-e", ruby, path], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0 || !result.stdout) throw new Error("YAMLの安全な解析に失敗しました。");
  return JSON.parse(result.stdout);
}

function stableId(fileName, page, term, kind, direction = "forward") {
  const identity = [fileName, String(page), term.normalize("NFKC").replace(/\s+/gu, " ").trim(), kind, direction].join("|");
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
    id: stableId(context.fileName, card["ページ"], term, kind, direction),
    order: context.order,
    chapter: context.chapter,
    chapterTitle: context.chapterTitle,
    page: String(card["ページ"]),
    importance: card["重要度"],
    kind,
    term,
    ...(typeof card["出題"] === "string" ? { exam: card["出題"] } : {}),
    ...(kind === "双方向" ? { direction } : {}),
  };
}

function transformNote(card, context) {
  const kind = card["種類"];
  if (!Object.hasOwn(TYPE_FIELDS, kind)) throw new Error("未対応のカード種類です。");
  for (const field of ["用語", "ページ", "重要度", "種類", ...TYPE_FIELDS[kind]]) {
    if (card[field] === undefined) throw new Error("カードの必須項目が不足しています。");
  }
  if (kind === "4問") {
    return [
      {
        ...commonCard(card, context, "forward"),
        prompt: "次の4観点から、この用語の概念を説明してください。",
        answerSections: [
          { label: "何を解決する", text: requireText(card, "何を解決する") },
          { label: "何者", text: requireText(card, "何者") },
          { label: "どこで働く", text: requireText(card, "どこで働く") },
          { label: "壊れたら", text: requireText(card, "壊れたら") },
        ],
      },
    ];
  }
  if (kind === "双方向") {
    return [
      {
        ...commonCard(card, context, "forward"),
        prompt: requireText(card, "問1"),
        answerSections: [{ label: "答え", text: requireText(card, "答1") }],
      },
      {
        ...commonCard(card, { ...context, order: context.order + 1 }, "reverse"),
        prompt: requireText(card, "問2"),
        answerSections: [{ label: "答え", text: requireText(card, "答2") }],
      },
    ];
  }
  return [
    {
      ...commonCard(card, context, "forward"),
      prompt: requireText(card, "問"),
      answerSections: [{ label: "答え", text: requireText(card, "答") }],
    },
  ];
}

export async function buildDeckPayload(workspaceRoot) {
  const cardDir = resolve(workspaceRoot, "cards");
  const fileNames = (await readdir(cardDir)).filter((name) => /^\d{2}_.*\.yaml$/.test(name)).sort();
  if (fileNames.length !== 9) throw new Error("カード章ファイルが9件ではありません。");

  const checker = spawnSync("python3", [resolve(workspaceRoot, "scripts/check.py")], {
    cwd: workspaceRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (checker.status !== 0) throw new Error("既存カードQAに失敗したため、デッキを生成しません。");

  let sourceNoteCount = 0;
  let order = 0;
  const cards = [];
  for (const fileName of fileNames) {
    const chapter = Number(fileName.slice(0, 2));
    const chapterTitle = CHAPTER_TITLES.get(chapter);
    if (!chapterTitle) throw new Error("章番号を解釈できません。");
    // 読み込んだ原文はメモリ内だけで扱い、平文ファイルへは書き出さない。
    await readFile(resolve(cardDir, fileName), "utf8");
    const notes = parseYaml(resolve(cardDir, fileName));
    if (!Array.isArray(notes)) throw new Error("YAMLの最上位がリストではありません。");
    sourceNoteCount += notes.length;
    for (const note of notes) {
      const transformed = transformNote(note, { fileName, chapter, chapterTitle, order });
      cards.push(...transformed);
      order += transformed.length;
    }
  }
  if (sourceNoteCount !== 551 || cards.length !== 559) throw new Error("カード件数が期待値と一致しません。");
  const ids = new Set(cards.map((card) => card.id));
  if (ids.size !== cards.length) throw new Error("安定カードIDが重複しています。");
  return {
    schemaVersion: 1,
    deckId: "nw-r06",
    sourceNoteCount: 551,
    cardCount: 559,
    chapterCount: 9,
    cards,
  };
}
