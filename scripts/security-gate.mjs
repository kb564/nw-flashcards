import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, "dist");
const forbiddenExtensions = [".yaml", ".yml", ".pdf", ".nwdeck", ".nwbackup", ".map"];
const plaintextFingerprints = [
  { length: 13, sha256: "8e4b3e581a08df1a95233aba41d4bb8d003b7b33f7f901b08fd9a59c351b8873" },
  { length: 26, sha256: "f5fd14b28cc3a9a598bbac2ca1138dc19195dfbf493ee31e540d1a4657f33192" },
  { length: 28, sha256: "4bce1dacfdcee449b93b4e939c1d20ed12cbbbba4eae9b2d02f485e8e89c351a" },
];
const forbiddenRuntimePatterns = [/\beval\s*\(/u, /new\s+Function\s*\(/u, /console\.(?:log|debug|info|warn|error)\s*\(/u];

async function list(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await list(path)));
    else files.push(path);
  }
  return files;
}

const files = await list(dist);
const errors = [];
for (const file of files) {
  const name = relative(dist, file);
  if (forbiddenExtensions.some((extension) => name.endsWith(extension))) errors.push(`${name}: 禁止拡張子`);
  if ((await stat(file)).size > 5 * 1024 * 1024) errors.push(`${name}: 5MiBを超過`);
  const text = await readFile(file, "utf8").catch(() => "");
  const codePoints = Array.from(text);
  for (const fingerprint of plaintextFingerprints) {
    for (let index = 0; index <= codePoints.length - fingerprint.length; index += 1) {
      const candidate = codePoints.slice(index, index + fingerprint.length).join("");
      const digest = createHash("sha256").update(candidate).digest("hex");
      if (digest === fingerprint.sha256) {
        errors.push(`${name}: カード本文の指紋を検出`);
        break;
      }
    }
  }
  if (/\.(?:js|html)$/u.test(name)) {
    for (const pattern of forbiddenRuntimePatterns) if (pattern.test(text)) errors.push(`${name}: 禁止実行パターン ${pattern}`);
  }
  if (/https?:\/\//u.test(text) && name !== "manifest.webmanifest") errors.push(`${name}: 外部URLを検出`);
}

const index = await readFile(resolve(dist, "index.html"), "utf8");
const head = index.match(/<head>([\s\S]*?)<\/head>/iu)?.[1] ?? "";
const firstMeta = head.match(/<meta[^>]+>/iu)?.[0] ?? "";
if (!firstMeta.includes("Content-Security-Policy")) errors.push("index.html: CSPが最初のmeta要素ではありません");
for (const directive of ["connect-src 'none'", "object-src 'none'", "form-action 'none'", "base-uri 'none'"]) {
  if (!index.includes(directive)) errors.push(`index.html: CSP不足 ${directive}`);
}
if (!files.some((file) => file.endsWith("/sw.js"))) errors.push("Service Workerがありません");
if (errors.length > 0) {
  process.stderr.write(`security gate: FAILED (${errors.length})\n${errors.map((error) => `- ${error}`).join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(`security gate: OK (${files.length} files)\n`);
