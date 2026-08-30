import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, "dist");
const docs = resolve(root, "docs");

// Also fail closed when invoked directly, before touching the existing publish directory.
const audit = spawnSync('python3', [resolve(root, '../scripts/check.py')], { encoding: 'utf8' });
if (audit.status !== 0) throw new Error('カードQAが未完了のため公開物を更新しません。');
const boundary = spawnSync('python3', [resolve(root, '../scripts/check_public_boundary.py')], { encoding: 'utf8' });
if (boundary.status !== 0) throw new Error('非公開データの境界検査に合格していないため公開物を更新しません。');

// docs/ は生成専用。公開前ゲートに合格した dist/ だけから毎回作り直す。
await rm(docs, { recursive: true, force: true });
await mkdir(docs, { recursive: true });
await cp(dist, docs, { recursive: true, force: false });
await writeFile(resolve(docs, ".nojekyll"), "", { mode: 0o644 });
process.stdout.write("GitHub Pages用の公開物を docs/ に準備しました。\n");
