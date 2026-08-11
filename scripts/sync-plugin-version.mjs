#!/usr/bin/env node
/**
 * plugin.json の version を package.json に同期する。
 *
 * リリースのたびに plugin.json が置き去りになる事故が 2 度起きた
 * (0.11.0→0.14.0 の 8452b4f / 0.14.0→0.14.2 の 5232b20 — どちらも tag の後の追いコミット)。
 * `npm version` の version フックから呼ばれることで、リリースコミット =
 * tag の木に正しい plugin.json が入る。
 *
 *   node scripts/sync-plugin-version.mjs           # 同期(書き換え)
 *   node scripts/sync-plugin-version.mjs --check   # 照合のみ。ずれていれば exit 1
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = join(ROOT, '.claude-plugin', 'plugin.json');

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const plugin = JSON.parse(readFileSync(PLUGIN, 'utf8'));

if (plugin.version === pkg.version) {
  console.log(`plugin.json は同期済み (${pkg.version})`);
  process.exit(0);
}

if (process.argv.includes('--check')) {
  console.error(
    `plugin.json ${plugin.version} ≠ package.json ${pkg.version} — node scripts/sync-plugin-version.mjs で同期してください`,
  );
  process.exit(1);
}

plugin.version = pkg.version;
writeFileSync(PLUGIN, `${JSON.stringify(plugin, null, 2)}\n`);
console.log(`plugin.json: ${plugin.version} に同期しました`);
