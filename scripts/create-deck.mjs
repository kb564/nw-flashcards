#!/usr/bin/env node
import { timingSafeEqual, webcrypto } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
    const onData = (chunk) => {
      // A password-manager paste arrives as one chunk; never echo any part.
      for (const character of chunk) {
        if (character === "\u0003" || character === "\u0004") {
          finish();
          rejectPrompt(new Error("中断しました。"));
          return;
        } else if (character === "\r" || character === "\n") {
          finish();
          resolvePrompt(value);
          return;
        } else if (character === "\u007f" || character === "\b") {
          value = [...value].slice(0, -1).join("");
        } else if (/^[^\u0000-\u001f]$/u.test(character)) {
          value += character;
        }
      }
    };
    process.stdin.on("data", onData);
  });
}

export async function encryptDeck(deck, passphrase) {
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const material = await webcrypto.subtle.importKey("raw", encoder.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  const key = await webcrypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: ITERATIONS },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
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
  let restored;
  try {
    const parameters = { name: "AES-GCM", iv, additionalData: aad, tagLength: 128 };
    const encrypted = await webcrypto.subtle.encrypt(parameters, key, plaintext);
    restored = new Uint8Array(await webcrypto.subtle.decrypt(parameters, key, encrypted));
    if (restored.length !== plaintext.length || !timingSafeEqual(restored, plaintext)) {
      throw new Error("暗号化後の復号検証に失敗しました。");
    }
    return { ...header, ciphertext: base64(new Uint8Array(encrypted)) };
  } finally {
    plaintext.fill(0);
    restored?.fill(0);
  }
}

async function main() {
  const deck = await buildDeckPayload(workspaceRoot);
  if (process.argv.includes("--check")) {
    const textbook = deck.collections.find((item) => item.id === "textbook-r06");
    const catchup = deck.collections.find((item) => item.id === "catchup");
    process.stdout.write(
      `textbook-notes: ${textbook?.sourceNoteCount}\n` +
      `textbook-study-cards: ${textbook?.cardCount}\n` +
      `supplemental-notes: ${catchup?.sourceNoteCount}\n` +
      `supplemental-study-cards: ${catchup?.cardCount}\n` +
      `study-cards: ${deck.cardCount}\nchapters: ${deck.chapterCount}\nresult: OK\n`,
    );
    return;
  }
  let first = "";
  let second = "";
  let envelope;
  try {
    first = await hiddenPrompt("新しいパスフレーズ（12文字以上、または4単語以上）: ");
    validatePassphrase(first);
    second = await hiddenPrompt("もう一度入力: ");
    if (first !== second) throw new Error("2回のパスフレーズが一致しません。");
    envelope = await encryptDeck(deck, first);
  } finally {
    first = "";
    second = "";
  }
  const outputDir = resolve(workspaceRoot, "private-output");
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const output = resolve(outputDir, `ネスペ暗記カード-R06-${stamp}.nwdeck`);
  const serialized = `${JSON.stringify(envelope)}\n`;
  await writeFile(output, serialized, { mode: 0o600, flag: "wx" });
  if (await readFile(output, "utf8") !== serialized) throw new Error("書込み後のファイル照合に失敗しました。新規ファイルは使用しないでください。");
  process.stdout.write(`暗号化・復号・書込み照合: OK\n学習カード: ${deck.cardCount}\n暗号化デッキを作成しました: ${basename(output)}\n保存先: ${outputDir}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => {
  process.stderr.write(`生成を停止しました: ${error instanceof Error ? error.message : "不明なエラー"}\n`);
  process.exitCode = 1;
});
