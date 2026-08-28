/**
 * 暗号化文書の**平文の写し**を作る。
 *
 * 用途は 1 つだけ: **veraPDF に渡すファイル**である。veraPDF は暗号化された文書を
 * 読めないので、判定させたければ平文のバイト列を書き出すしかない。
 * verify 自身の読み取りには要らない —— `openDocument` が §7.6 の復号込みで開くので、
 * 構造木も注釈も暗号化されたオブジェクトストリームの中から読める（L4 で実測）。
 *
 * 🔴 **これは「元のファイル」ではない。** 1 リビジョンに書き直した写しであり、
 * veraPDF が判定するのはその写しである。呼び出し側は報告にそう書くこと。
 *
 * normativepdf の `rewrite` は暗号化文書を名指しで拒む（§7.6.2・ADR-0008: trailer が
 * `/Encrypt` を持ったまま書くと、平文のバイト列に「暗号化されている」と書いた文書ができる）。
 * ここでは `/Encrypt` を**落としてから**書く —— オブジェクトは復号済みで材料化されており、
 * 出力は本当に暗号化されていないので、拒否の条件そのものを解いている。
 * `rewrite` のもう 1 つの拒否（チェーンを歩き切れていない文書）は、ここで同じ条件を課す。
 */

import { type CosDict, type CosObject, collectObjects, writeFile } from 'normativepdf';
import { logger } from '../utils/logger.js';
import { openDocument } from './document.js';

const CONTEXT = 'plaintext-copy';

/**
 * 復号した 1 リビジョンの写しを返す。作れないときは `null`
 * （呼び出し側が「veraPDF には渡せない」と判断する材料にする）。
 * 暗号化されていない文書は入力をそのまま返す。
 */
export async function decryptedCopy(
  bytes: Uint8Array,
  password: string,
): Promise<Uint8Array | null> {
  let doc: Awaited<ReturnType<typeof openDocument>>;
  try {
    doc = await openDocument(bytes, { password });
  } catch (error) {
    logger.debug(CONTEXT, `cannot open: ${String(error)}`);
    return null;
  }
  if (!doc.scope.encrypted) return bytes;
  if (!doc.scope.authenticated) return null;

  // `rewrite` と同じ拒否: 歩き切れていないチェーンを書き直すと、読めていない
  // リビジョンが定義するオブジェクトが落ちて、参照だけが残る。
  if (doc.scope.reconstructed || doc.doc.chainStop.kind !== 'complete') {
    logger.debug(
      CONTEXT,
      `refusing to rewrite: chainStop=${doc.doc.chainStop.kind} reconstructed=${doc.scope.reconstructed}`,
    );
    return null;
  }

  try {
    const objects = await collectObjects(doc.doc);
    const entries = new Map<string, CosObject>(
      [...doc.doc.trailer.entries].filter(([key]) => key !== 'Encrypt'),
    );
    const trailer: CosDict = { kind: 'dict', entries };
    return writeFile(objects, trailer);
  } catch (error) {
    logger.debug(CONTEXT, `cannot write: ${String(error)}`);
    return null;
  }
}
