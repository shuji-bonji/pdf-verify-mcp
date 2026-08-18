/**
 * veraPDF の版の読み取り。
 *
 * **なぜ版を記録するのか。** `verapdf.ts` の冒頭が言うとおり「どの veraPDF が
 * 走ったか」は判定の出所の一部で、規則の数（146 / 146 など）は**同じビルドの
 * 実行どうしでしか比べられない**。パスは版の代わりにならない —— 実測
 * （2026-08-18）: Homebrew の置き場は `1.30.2` と言い、veraPDF 自身は
 * `1.30.0` と答える。
 */

import { describe, expect, it } from 'vitest';
import { parseVeraPdfVersion } from '../../src/services/verapdf.js';

/** 実測した veraPDF 1.30.0（Homebrew・2026-08-18）の `--version` 出力そのまま */
const REAL_OUTPUT = [
  'WARNING: Final field flavour in class org.verapdf.pdfa.validation.profiles.ValidationProfileImpl has been mutated reflectively by class com.sun.xml.bind.v2.runtime.reflect.Accessor$FieldReflection in unnamed module @2b80d80f (file:/opt/homebrew/Cellar/verapdf/1.30.2/libexec/bin/gui-1.30.0.jar)',
  'WARNING: Use --enable-final-field-mutation=ALL-UNNAMED to avoid a warning',
  'WARNING: Mutating final fields will be blocked in a future release unless final field mutation is enabled',
  'veraPDF 1.30.0',
  'Built: Wed Jun 03 13:47:00 JST 2026',
  'Developed and released by the veraPDF Consortium.',
  'Funded by the PREFORMA project.',
  'Released under the GNU General Public License v3',
  'and the Mozilla Public License v2 or later.',
  '',
].join('\n');

describe('parseVeraPdfVersion', () => {
  it('reads the version from the real output of veraPDF 1.30.0', () => {
    expect(parseVeraPdfVersion(REAL_OUTPUT)).toBe('1.30.0');
  });

  it('🔴 does not take the first line', () => {
    // JVM の警告が版より前に出る。1 行目を取る実装だと
    // "WARNING:" を版として記録してしまう
    expect(REAL_OUTPUT.split('\n')[0]).toMatch(/^WARNING:/);
    expect(parseVeraPdfVersion(REAL_OUTPUT)).not.toMatch(/WARNING/);
  });

  it('🔴 does not pick the version out of the warning text', () => {
    // 警告文には `1.30.2`（Homebrew の置き場）と `gui-1.30.0.jar` が入っている。
    // 版として答えるのは veraPDF 自身が名乗った 1.30.0 だけである
    expect(parseVeraPdfVersion(REAL_OUTPUT)).not.toBe('1.30.2');
  });

  it('handles CRLF and leading spaces', () => {
    expect(parseVeraPdfVersion('noise\r\n  veraPDF 1.24.1  \r\nmore')).toBe('1.24.1');
  });

  it('returns null when no version line is there', () => {
    expect(parseVeraPdfVersion('')).toBeNull();
    expect(parseVeraPdfVersion('command not found')).toBeNull();
    // 版を名乗らない出力を「不明」として扱う。推測で埋めない
    expect(parseVeraPdfVersion('veraPDF')).toBeNull();
  });

  it('does not match a line that merely mentions veraPDF', () => {
    expect(parseVeraPdfVersion('Validated by veraPDF (/usr/bin/verapdf) — ok')).toBeNull();
  });
});
