#!/usr/bin/env node
import { webcrypto } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDeckPayload } from "./deck-core.mjs";

const ITERATIONS = 600_000;
const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..");
const workspaceRoot = resolve(appRoot, "..");
const encoder = new TextEncoder();

function base64(bytes) {
  return Buffer.from(bytes).toString("base64");
}

function validatePassphrase(passphrase) {
  const normalized = passphrase.normalize("NFKC");
  const words = normalized.trim().split(/\s+/u).filter(Boolean).length;
  if (normalized.length < 12 && words < 4) throw new Error("12文字以上、または空白区切りの4単語以上が必要です。");
  if (normalized.length > 256) throw new Error("256文字以内にしてください。");
}

async function hiddenPrompt(prompt) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("安全のため、対話型ターミナルで実行してください。");
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  let value = "";
  return new Promise((resolvePrompt, rejectPrompt) => {
    const finish = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
      process.stdout.write("\n");
    };
    const onData = (character) => {
      if (character === "\u0003") {
        finish();
        rejectPrompt(new Error("中断しました。"));
      } else if (character === "\r" || character === "\n") {
        finish();
        resolvePrompt(value);
      } else if (character === "\u007f") {
        value = value.slice(0, -1);
      } else if (/^[^\u0000-\u001f]$/u.test(character)) {
        value += character;
      }
    };
    process.stdin.on("data", onData);
  });
}

async function encryptDeck(deck, passphrase) {
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const material = await webcrypto.subtle.importKey("raw", encoder.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  const key = await webcrypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: ITERATIONS },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const header = {
    format: "nwdeck",
    version: 1,
    kdf: { name: "PBKDF2", hash: "SHA-256", iterations: ITERATIONS, salt: base64(salt) },
    cipher: { name: "AES-GCM", iv: base64(iv) },
  };
  const aad = encoder.encode([
    header.format,
    header.version,
    header.kdf.name,
    header.kdf.hash,
    header.kdf.iterations,
    header.kdf.salt,
    header.cipher.name,
    header.cipher.iv,
  ].join("|"));
  const plaintext = encoder.encode(JSON.stringify(deck));
  const encrypted = await webcrypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad, tagLength: 128 }, key, plaintext);
  plaintext.fill(0);
  return { ...header, ciphertext: base64(new Uint8Array(encrypted)) };
}

async function main() {
  const deck = await buildDeckPayload(workspaceRoot);
  if (process.argv.includes("--check")) {
    process.stdout.write(`source-notes: ${deck.sourceNoteCount}\nstudy-cards: ${deck.cardCount}\nchapters: ${deck.chapterCount}\nresult: OK\n`);
    return;
  }
  const first = await hiddenPrompt("新しいパスフレーズ: ");
  validatePassphrase(first);
  const second = await hiddenPrompt("もう一度入力: ");
  if (first !== second) throw new Error("2回のパスフレーズが一致しません。");
  const envelope = await encryptDeck(deck, first);
  const outputDir = resolve(workspaceRoot, "private-output");
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const output = resolve(outputDir, `ネスペ暗記カード-R06-${stamp}.nwdeck`);
  await writeFile(output, `${JSON.stringify(envelope)}\n`, { mode: 0o600, flag: "wx" });
  process.stdout.write(`暗号化デッキを作成しました: ${basename(output)}\n保存先: ${outputDir}\n`);
}

main().catch((error) => {
  process.stderr.write(`生成を停止しました: ${error instanceof Error ? error.message : "不明なエラー"}\n`);
  process.exitCode = 1;
});
