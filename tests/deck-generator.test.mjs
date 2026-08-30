import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildDeckPayload, sourceFingerprint, assertReviewedNote } from "../scripts/deck-core.mjs";
import { normalizeDeckPayload } from "../src/validation";

const workspaceRoot = resolve(process.cwd(), '..');
const summary = JSON.parse(execFileSync('ruby', ['-ryaml', '-rjson', '-e', 'puts JSON.generate(YAML.safe_load(File.read(ARGV[0]))["集計"])', resolve(workspaceRoot, 'meta/qa-ledger.yaml')], { encoding: 'utf8' }));
const auditReady = summary['公開前未完了'] && Object.values(summary['公開前未完了']).every(count => count === 0);
const baseline = JSON.parse(readFileSync(resolve(workspaceRoot, 'meta/card-id-baseline.json'), 'utf8'));

describe("local deck generator", () => {
  it('rejects source edits after QA even if card id and counts stay the same', () => {
    const note = { question: 'synthetic prompt', answer: 'synthetic answer', nested: { b: 2, a: 1 } };
    const fingerprint = sourceFingerprint(note);
    // Cross-language fixture: Python's canonical JSON + SHA-256 produces this digest.
    expect(fingerprint).toBe('8514561f967ce85bdefa95d42e270ce00deea74fe2b28d4b0dec5c1a3023a4fa');
    const approvals = new Map([['synthetic-id', { 判定: 'OK', 内容指紋: fingerprint }]]);
    expect(() => assertReviewedNote(note, 'synthetic-id', approvals)).not.toThrow();
    expect(sourceFingerprint({ nested: { a: 1, b: 2 }, answer: note.answer, question: note.question })).toBe(fingerprint);
    expect(() => assertReviewedNote({ ...note, answer: 'changed' }, 'synthetic-id', approvals)).toThrow('監査後');
    expect(() => assertReviewedNote(note, 'unknown-id', approvals)).toThrow('監査後');
    approvals.get('synthetic-id').判定 = '未監査';
    expect(() => assertReviewedNote(note, 'synthetic-id', approvals)).toThrow('監査後');
  });

  it.skipIf(!auditReady)("validates and transforms all approved source notes without writing plaintext", () => {
    const output = execFileSync("node", ["scripts/create-deck.mjs", "--check"], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(output.trim().split("\n")).toEqual([
      `textbook-notes: ${summary['教科書ノート']}`,
      `textbook-study-cards: ${summary['教科書学習カード']}`,
      `supplemental-notes: ${summary['補足ノート']}`,
      `supplemental-study-cards: ${summary['合計学習カード'] - summary['教科書学習カード']}`,
      `study-cards: ${summary['合計学習カード']}`,
      "chapters: 9",
      "result: OK",
    ]);
  }, 65_000);

  it.skipIf(auditReady)('refuses to build the actual unreviewed dataset', async () => {
    await expect(buildDeckPayload(workspaceRoot)).rejects.toThrow('カードQAに失敗');
  }, 65_000);

  it("does not disable custom deck files in the iOS file picker", () => {
    const source = readFileSync("src/app.ts", "utf8");
    expect(source).not.toContain("input.accept");
    expect(source).toContain('input.type = "file"');
  });

  it("does not include inactivity or background timeout locking", () => {
    const source = readFileSync("src/app.ts", "utf8");
    expect(source).not.toContain("IDLE_TIMEOUT_MS");
    expect(source).not.toContain("resetIdleTimer");
    expect(source).not.toContain('addEventListener("visibilitychange"');
    expect(source).toContain('lock.addEventListener("click"');
  });

  it.skipIf(!auditReady)("keeps all textbook ids and groups mutually linked catch-up cards after their anchors", async () => {
    const deck = await buildDeckPayload(workspaceRoot);
    // Never give an assertion reporter the private deck (including failure diffs).
    expect(normalizeDeckPayload(deck) === deck).toBe(true);
    const textbook = deck.cards.filter((card) => card.collectionId === "textbook-r06");
    const catchup = deck.cards.filter((card) => card.collectionId === "catchup");
    const byId = new Map(deck.cards.map((card) => [card.id, card]));

    expect(textbook.length).toBe(summary['教科書学習カード']);
    expect(catchup.length).toBe(summary['合計学習カード'] - summary['教科書学習カード']);
    // New items may precede/follow old bookends; only legacy relative order is fixed.
    const legacy = new Set(baseline.textbookIds);
    const retained = textbook.filter(card => legacy.has(card.id)).map(card => card.id);
    expect(retained).toEqual(baseline.textbookIds);
    expect(createHash("sha256").update(retained.join("\n")).digest("hex"))
      .toBe("6465e2b61b90384a177290f7d031cbee8ce79eef899b0a4063f246daba1d4785");

    for (const supplement of catchup) {
      const primary = byId.get(supplement.primaryRelatedCardId);
      expect(primary?.collectionId).toBe("textbook-r06");
      expect(primary?.relatedCardIds).toContain(supplement.id);
      for (const relatedId of supplement.relatedCardIds) {
        expect(byId.get(relatedId)?.relatedCardIds).toContain(supplement.id);
      }
      const between = deck.cards.slice((primary?.order ?? -1) + 1, supplement.order);
      expect(between.every((card) => card.collectionId === "catchup" && card.primaryRelatedCardId === primary?.id)).toBe(true);
    }

    // Source URLs must not enter metadata. A URL syntax example in plain-text
    // study content is legitimate and is never made into a clickable link.
    const hasExternalSource = deck.cards.some(card => /https?:\/\//u.test(`${card.sourceLabel} ${card.sourceLocator}`));
    expect(hasExternalSource).toBe(false);

    const externalSource = structuredClone(deck);
    externalSource.cards.find((card) => card.collectionId === "catchup").sourceLocator = "https://example.invalid/source";
    expect(() => normalizeDeckPayload(externalSource)).toThrow("スキーマ");

    const misplaced = structuredClone(deck);
    const supplementIndex = misplaced.cards.findIndex((card) => card.collectionId === "catchup");
    const laterTextbookIndex = misplaced.cards.findIndex((card, index) => index > supplementIndex && card.collectionId === "textbook-r06");
    [misplaced.cards[supplementIndex], misplaced.cards[laterTextbookIndex]] = [misplaced.cards[laterTextbookIndex], misplaced.cards[supplementIndex]];
    misplaced.cards.forEach((card, index) => { card.order = index; });
    expect(() => normalizeDeckPayload(misplaced)).toThrow("直後");
  }, 65_000);
});
