import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("local deck generator", () => {
  it("validates and transforms all source notes without writing plaintext", () => {
    const output = execFileSync("node", ["scripts/create-deck.mjs", "--check"], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(output.trim().split("\n")).toEqual([
      "source-notes: 551",
      "study-cards: 559",
      "chapters: 9",
      "result: OK",
    ]);
  }, 65_000);
});
