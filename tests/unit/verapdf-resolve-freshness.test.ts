/**
 * veraPDF を探した結果の鮮度（#24）
 *
 * MCP のホストは会話の間ずっと同じサーバーのプロセスを使う。探した結果
 * （見つからなかったことを含む）をプロセスが終わるまで覚えると、起動後に
 * veraPDF を入れても「PATH に実行ファイルが無い」と答え続ける。
 *
 * 環境変数 `PDF_VERIFY_VERAPDF` の経路で測る。PATH と決まった場所の経路は
 * 手元の Mac（Homebrew の veraPDF がある）と CI（無い）で結果が変わるため、
 * 環境変数が先に決まる経路（PATH に落ちない）を使う。
 */

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VERAPDF_ENV } from '../../src/constants.js';
import { resetVeraPdfCache, resolveVeraPdf, veraPdfVersion } from '../../src/services/verapdf.js';

const isWindows = process.platform === 'win32';

/** `--version` に `veraPDF <version>` と答える偽の veraPDF */
function writeFakeVeraPdf(path: string, version: string): void {
  writeFileSync(path, `#!/bin/sh\necho "veraPDF ${version}"\n`);
  chmodSync(path, 0o755);
}

describe.skipIf(isWindows)('veraPDF を探した結果の鮮度', () => {
  let dir: string;
  let saved: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'verapdf-fresh-'));
    saved = process.env[VERAPDF_ENV];
    resetVeraPdfCache();
  });

  afterEach(() => {
    if (saved === undefined) delete process.env[VERAPDF_ENV];
    else process.env[VERAPDF_ENV] = saved;
    resetVeraPdfCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it('見つからなかった結果を覚えず、置いた後の呼び出しで見つける', async () => {
    const exe = join(dir, 'verapdf');
    process.env[VERAPDF_ENV] = exe;

    const before = await resolveVeraPdf();
    expect(before).toMatchObject({ available: false, reason: 'configured_path_unusable' });

    writeFakeVeraPdf(exe, '1.0.0');
    const after = await resolveVeraPdf();
    expect(after).toEqual({ available: true, path: exe, source: 'env' });
  });

  it('見つけた実行ファイルが消えたら、次の呼び出しで見つからないと答える', async () => {
    const exe = join(dir, 'verapdf');
    writeFakeVeraPdf(exe, '1.0.0');
    process.env[VERAPDF_ENV] = exe;

    expect((await resolveVeraPdf()).available).toBe(true);
    rmSync(exe);
    expect(await resolveVeraPdf()).toMatchObject({
      available: false,
      reason: 'configured_path_unusable',
      detail: 'no such file',
    });
  });

  it('同じパスの実行ファイルが入れ替わったら、版を読み直す', async () => {
    const exe = join(dir, 'verapdf');
    writeFakeVeraPdf(exe, '1.0.0');
    process.env[VERAPDF_ENV] = exe;

    expect(await veraPdfVersion(exe)).toBe('1.0.0');
    // 上書きで大きさが変わる（Homebrew で上げたとき、パスは同じまま中身が変わる）
    writeFakeVeraPdf(exe, '1.30.10');
    expect(await veraPdfVersion(exe)).toBe('1.30.10');
  });

  it('実行ファイルが変わらなければ、版は 1 回だけ読む', async () => {
    const exe = join(dir, 'verapdf');
    const counter = join(dir, 'count');
    writeFileSync(exe, `#!/bin/sh\necho x >> "${counter}"\necho "veraPDF 1.0.0"\n`);
    chmodSync(exe, 0o755);

    expect(await veraPdfVersion(exe)).toBe('1.0.0');
    expect(await veraPdfVersion(exe)).toBe('1.0.0');
    expect(readFileSync(counter, 'utf8').trim().split('\n')).toHaveLength(1);
  });
});
