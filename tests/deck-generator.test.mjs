import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildDeckPayload } from "../scripts/deck-core.mjs";
import { normalizeDeckPayload } from "../src/validation";

const generatedDeck = buildDeckPayload(resolve(process.cwd(), ".."));

describe("local deck generator", () => {
  it("validates and transforms all source notes without writing plaintext", () => {
    const output = execFileSync("node", ["scripts/create-deck.mjs", "--check"], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(output.trim().split("\n")).toEqual([
      "textbook-notes: 551",
      "textbook-study-cards: 559",
      "supplemental-notes: 25",
      "supplemental-study-cards: 25",
      "study-cards: 584",
      "chapters: 9",
      "result: OK",
    ]);
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

  it("keeps all textbook ids and groups mutually linked catch-up cards after their anchors", async () => {
    const deck = await generatedDeck;
    expect(normalizeDeckPayload(deck)).toBe(deck);
    const textbook = deck.cards.filter((card) => card.collectionId === "textbook-r06");
    const catchup = deck.cards.filter((card) => card.collectionId === "catchup");
    const byId = new Map(deck.cards.map((card) => [card.id, card]));

    expect(textbook).toHaveLength(559);
    expect(catchup).toHaveLength(25);
    expect(textbook[0]?.id).toBe("nw-46f8b32287ba90c4a39f34a0");
    expect(textbook.at(-1)?.id).toBe("nw-1834d4b573c7431d4729fd67");
    expect(textbook.find((card) => card.term === "CDN（Content Delivery Network）")?.id).toBe("nw-799ae346b085002d709cf3c4");
    expect(createHash("sha256").update(textbook.map((card) => card.id).join("\n")).digest("hex"))
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

    expect(JSON.stringify(deck)).not.toContain("https://");

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
