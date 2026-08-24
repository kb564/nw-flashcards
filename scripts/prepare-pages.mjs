import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, "dist");
const docs = resolve(root, "docs");

// docs/ は生成専用。公開前ゲートに合格した dist/ だけから毎回作り直す。
await rm(docs, { recursive: true, force: true });
await mkdir(docs, { recursive: true });
await cp(dist, docs, { recursive: true, force: false });
await writeFile(resolve(docs, ".nojekyll"), "", { mode: 0o644 });
process.stdout.write("GitHub Pages用の公開物を docs/ に準備しました。\n");
