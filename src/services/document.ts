/**
 * 文書を開く 1 つの入口と、**その読みの射程**。
 *
 * normativepdf は §7.5 を条文どおりに読み、条文に反する文書を受け取らない。
 * それは正しいが、verify は「受け取らない」で終われない —— 監査の対象として持ち込まれる
 * 文書こそ壊れているからである。そこで:
 *
 *   1. まず `parsePdf` に渡す。読めたらそれをそのまま使う（**方針を挟まない**）
 *   2. 断られたら `xref-walk.ts` の回復方針で歩き、読めた節から文書を組み立てる
 *
 * この順番が肝で、2,947 検体のうち 2,930 件は 1 で読める。回復方針が当たるのは
 * 残り 17 件だけであり、そこだけが「ライブラリの答え」ではなく「verify の方針」になる。
 * どちらだったかは `scope.recovered` が申告する。
 *
 * 🔴 **射程は判定ではない。** `scope` は「どこまで読んだか」であって、
 * 「この文書が条文に適合しているか」ではない。適合の判定は validator が下す。
 */

import {
  ByteCursor,
  buildDocumentDecryptor,
  type CosDict,
  type CosObject,
  type DocumentDecryptor,
  dictGet,
  PdfDocument,
  parseIndirectObject,
  parsePdf,
  TokenReader,
  type XrefChainStop,
  type XrefEntry,
} from 'normativepdf';
import type { ReadingScope } from '../types.js';
import { logger } from '../utils/logger.js';
import { asDict, asRef, bytesOf } from './cos.js';
import {
  findOrigin,
  LATIN1,
  reconstructXref,
  type WalkedChain,
  walkXrefChain,
} from './xref-walk.js';

const CONTEXT = 'document';

/** どこまで読めたか。**判定ではない。** */
export interface DocumentScope {
  /**
   * true = normativepdf が受け取らず、verify の回復方針で組み立てた文書である。
   * このとき「条文に反する箇所がある」ことは既に分かっている（`refusal` が条文を名指しする）。
   */
  recovered: boolean;
  /** 回復に入った理由。ライブラリが投げた、条文を名指しするエラーの文面 */
  refusal: string | null;
  /** チェーンの歩きがどこで止まったか（§7.5.6） */
  chainStop: XrefChainStop;
  /** 最後の `startxref` が読めず、古い入口から入った = 末尾のバイトは代表されていない */
  newestSectionUnreadable: boolean;
  /**
   * 読めた相互参照節の数（§7.5.4/§7.5.6）。
   *
   * 🔴 **経路によらず同じ意味を持たせること。** 0.19.0 では、ライブラリが
   * そのまま読んだ経路でこの値を数えておらず、**健全な文書がすべて `0`** を
   * 返していた（2,947 検体のうち 2,931 件）。読み手はそれを「節が 0 個」と読む。
   * 観測していないことと、観測して 0 だったことが同じ顔をしていた ——
   * `observation` で直したのと同じ間違いを、この項目自身が持っていた。
   *
   * 数えられなかったときは `null`。`0` は「節が 1 つも読めなかった」という
   * 観測結果のときだけ使う（表を組み直した経路）。
   */
  sections: number | null;
  /**
   * チェーンが止まったあと、`startxref` の値を頼りに読み続けて文書を組み立てた。
   * **`/Prev` が繋いだものではない**ので、リビジョンの一覧とは別の読み方である。
   * 目録に届かない文書でだけ起きる（§7.5.6 の `/Prev 0` など）。
   */
  continuedPastStop: boolean;
  /**
   * チェーンが辿れない文書で、**表に載っていないオブジェクトを数え上げて埋めた**。
   * 表そのものは信じたうえで、穴だけを埋める（表にある定義は上書きしない）。
   * ここで埋めた分は「ファイルの中にこう書いてある」であって、
   * 「相互参照表がそう言っている」ではない。
   */
  filledFromScan: number;
  /**
   * 🔴 **相互参照表を組み直した。** ファイルの中の `N G obj` を数え上げて作った表であり、
   * ファイルが持っているものではない。リビジョンの境目は言えない
   * （`verify_integrity` の `revisionChain` は `unwalkable` を返す）。
   */
  reconstructed: boolean;
  /** 相互参照表に載っているオブジェクトの数 */
  objects: number;
  /** trailer に `/Encrypt` がある（§7.6） */
  encrypted: boolean;
  /**
   * 暗号化文書の鍵が導けた。false のとき **オブジェクトは 1 つも読めない** ——
   * normativepdf は暗号文を平文の顔で返さない（ADR-0008）。
   * 「読めなかった」ことを申告したうえで、読めた範囲だけで答えるのは呼び出し側の仕事。
   */
  authenticated: boolean;
  /**
   * `/Encrypt` 辞書。**鍵が導けなくても読める** —— §7.6.2 が暗号化の対象から
   * 除いているので、生バイトから直接読んでよい。ISO 14289-1 7.16（支援技術への
   * 許可ビット）はこれだけで判定できる。
   */
  encryptDict: CosDict | null;
}

export interface OpenedDocument {
  doc: PdfDocument;
  scope: DocumentScope;
}

export interface OpenOptions {
  /** 暗号化文書のパスワード（既定は空 —— §7.6.4.4 の NOTE が言う「まず空を試す」） */
  password?: string;
}

/** 目録（catalog）に届くか。届かない文書は「1 オブジェクトの文書」として扱えない。 */
async function catalogReachable(doc: PdfDocument): Promise<boolean> {
  try {
    return (await doc.getCatalog()).kind === 'dict';
  } catch {
    return false;
  }
}

/** §7.5.2 のヘッダ版。無い文書では null（それを違反と呼ぶのは validator の仕事）。 */
function headerVersionOf(bytes: Uint8Array, origin: number): string | null {
  const head = LATIN1.decode(bytes.subarray(origin, origin + 32));
  return /^%PDF-(\d+\.\d+)/.exec(head)?.[1] ?? null;
}

/**
 * 節の trailer を新しい順に重ねる（§7.5.6）。増分更新の trailer は
 * `/Root` などを繰り返すことになっているが、繰り返していない文書が実在するので、
 * **古い節で埋める**。埋めたことは隠さない（重ねた結果しか使わないので、
 * どの節から来たかを知りたい場合は `sections` を見ること）。
 */
function mergeTrailers(chain: WalkedChain): CosDict {
  const entries = new Map<string, CosObject>();
  for (let i = chain.sections.length - 1; i >= 0; i -= 1) {
    for (const [key, value] of chain.sections[i].trailer.entries) {
      if (!entries.has(key)) entries.set(key, value);
    }
  }
  return { kind: 'dict', entries };
}

/** 新しい節が古い節を上書きする形で 1 枚の相互参照表にする（§7.5.4 / §7.5.6）。 */
function mergeXref(chain: WalkedChain): Map<number, XrefEntry> {
  const merged = new Map<number, XrefEntry>();
  for (const section of chain.sections) {
    for (const [objectNumber, entry] of section.entries) merged.set(objectNumber, entry);
  }
  return merged;
}

/**
 * `/Encrypt` 辞書を復号器なしで読む。§7.6.2 は「Encrypt 辞書の中の文字列」を
 * 暗号化の対象から除いているので、生バイトから直接読むのが正しい読み方である。
 */
function readEncryptDict(
  bytes: Uint8Array,
  origin: number,
  trailer: CosDict,
  xref: ReadonlyMap<number, XrefEntry>,
): CosDict | null {
  const entry = dictGet(trailer, 'Encrypt');
  if (entry === undefined) return null;
  if (entry.kind === 'dict') return entry;
  const ref = asRef(entry);
  if (!ref) return null;
  const located = xref.get(ref.objectNumber);
  if (located?.type !== 'in-use') return null;
  try {
    const reader = new TokenReader(new ByteCursor(bytes, origin + located.offset));
    return asDict(parseIndirectObject(reader).object);
  } catch {
    return null;
  }
}

/** trailer `/ID` の第 1 要素（R ≤ 4 の鍵導出が要る・Algorithm 2 step e）。 */
function idFirstOf(trailer: CosDict): Uint8Array | undefined {
  const id = dictGet(trailer, 'ID');
  if (id?.kind !== 'array') return undefined;
  return bytesOf(id.items[0]) ?? undefined;
}

/**
 * 回復方針で歩いた節から `PdfDocument` を組み立てる。
 *
 * 版は 2 回組んで決める: ヘッダ版で 1 度組み、catalog `/Version` を読み、
 * それが後の版ならその版で組み直す（§7.7.2 Table 29 / §7.5.2 NOTE 3）。
 * 復号器も同じ理由で 2 段になる —— `/Encrypt` を解決するには文書が要る。
 */
async function buildFromChain(
  bytes: Uint8Array,
  chain: WalkedChain,
  options: OpenOptions,
): Promise<{
  doc: PdfDocument;
  encrypted: boolean;
  authenticated: boolean;
  encryptDict: CosDict | null;
  filledFromScan: number;
}> {
  const trailer = mergeTrailers(chain);
  const xref = mergeXref(chain);

  // 🔴 チェーンが辿り切れていない文書では、表に載っていないオブジェクトを数え上げて**穴だけ**埋める。
  //
  // 実測（`_wout/dss-pades-5sigs-doctimestamp.pdf`・`/Prev 0` で切れた 8 リビジョン 6 署名）:
  // 目録は読めるのに `/DSS` が指すオブジェクト 127 がどの節にも載っておらず、
  // 失効情報が丸ごと見えなくなって **`revocation: revoked` が `unknown` に化けた**。
  // 表にある定義は上書きしないので、意図的に free にされたオブジェクトが復活することはない。
  let filledFromScan = 0;
  if (chain.stop.kind !== 'complete') {
    const scanned = reconstructXref(bytes, chain.origin);
    if (scanned) {
      for (const [objectNumber, entry] of scanned.entries) {
        if (xref.has(objectNumber)) continue;
        xref.set(objectNumber, entry);
        filledFromScan += 1;
      }
    }
  }
  const headerVersion = headerVersionOf(bytes, chain.origin) ?? '1.0';

  const plain = new PdfDocument(
    bytes,
    chain.origin,
    headerVersion,
    headerVersion,
    trailer,
    xref,
    chain.stop,
  );

  let decryptor: DocumentDecryptor | undefined;
  const encryptEntry = dictGet(trailer, 'Encrypt');
  const encrypted = encryptEntry !== undefined;
  const encryptDict = readEncryptDict(bytes, chain.origin, trailer, xref);
  if (encrypted && encryptDict) {
    try {
      decryptor = buildDocumentDecryptor(
        encryptDict,
        asRef(encryptEntry)?.objectNumber,
        idFirstOf(trailer),
        { password: options.password ?? '' },
      );
    } catch (error) {
      // 🔴 鍵が導けなくても文書は返す。`/Encrypt` 辞書だけは §7.6.2 により読めるので、
      // それだけで決まる規則（ISO 14289-1 7.16）は答えられる。復号器を付けない文書は
      // オブジェクトを 1 つも渡さないので、暗号文を平文の顔で配ることにはならない。
      logger.debug(CONTEXT, `not authenticated: ${String(error)}`);
    }
  }
  const authenticated = !encrypted || decryptor !== undefined;

  const staged = decryptor
    ? new PdfDocument(
        bytes,
        chain.origin,
        headerVersion,
        headerVersion,
        trailer,
        xref,
        chain.stop,
        decryptor,
      )
    : plain;

  // catalog /Version がヘッダより後なら、そちらが実効版になる
  let version = headerVersion;
  try {
    const catalog = asDict(await staged.getCatalog());
    const declared = dictGet(catalog ?? { kind: 'dict', entries: new Map() }, 'Version');
    if (
      declared?.kind === 'name' &&
      /^\d+\.\d+$/.test(declared.value) &&
      declared.value > version
    ) {
      version = declared.value;
    }
  } catch {
    // catalog に届かないこと自体は射程の話で、ここでは版を上げないだけ
  }
  const doc =
    version === headerVersion
      ? staged
      : new PdfDocument(
          bytes,
          chain.origin,
          headerVersion,
          version,
          trailer,
          xref,
          chain.stop,
          decryptor,
        );
  return { doc, encrypted, authenticated, encryptDict, filledFromScan };
}

/**
 * 文書を開く。ライブラリが読めればそれを、断ったら回復方針で組み立てたものを返す。
 * どちらも無理なら、**ライブラリが名指しした条文をそのまま**投げる。
 */
export async function openDocument(
  bytes: Uint8Array,
  options: OpenOptions = {},
): Promise<OpenedDocument> {
  const password = options.password ?? '';

  let doc: PdfDocument | null = null;
  let refusal: string | null = null;
  let refused: unknown = null;
  try {
    doc = await parsePdf(bytes, { password });
  } catch (error) {
    refused = error;
    refusal = error instanceof Error ? error.message : String(error);
  }

  // 目録に届き、しかもチェーンが最後まで歩けた文書なら、それが答え。方針は挟まない。
  //
  // 🔴 **チェーンが途中で止まった文書はそのまま使わない。** ライブラリが返すのは
  // 「チェーンが届いた範囲」で、そこには**ファイルが定義しているオブジェクトの一部しか無い**。
  // `/Prev 0` の実検体（`dss-pades-5sigs-doctimestamp.pdf`）で測ると、署名 6 本のうち
  // 5 本が消え、そのうち 1 本は失効した証明書で `invalid` と判定されていたものだった
  // —— 反証がまるごと見えなくなる。監査の道具としては、これが最も避けたい向きの誤りである。
  //
  // そこで文書の組み立てだけは `startxref` の値も頼りに読み進める（`continuePastStop`）。
  // リビジョンの一覧（`revision-diff`）は逆に、チェーンが言うとおりに厳密に読む。
  // **「ファイルが定義しているオブジェクト」と「チェーンが辿れるリビジョン」は別の問いである。**
  if (doc && doc.chainStop.kind === 'complete' && (await catalogReachable(doc))) {
    // 節の数はライブラリが持っていないので、ここで歩いて数える。
    // 2,950 検体で 87 ミリ秒（1 文書あたり 0.03 ミリ秒）—— 数えない理由にはならない。
    const counted = await walkXrefChain(bytes, doc.origin);
    return {
      doc,
      scope: {
        recovered: false,
        refusal: null,
        chainStop: doc.chainStop,
        newestSectionUnreadable: false,
        sections: counted ? counted.sections.length : null,
        continuedPastStop: false,
        filledFromScan: 0,
        reconstructed: false,
        objects: doc.xref.size,
        encrypted: doc.encryption !== undefined,
        authenticated: true,
        encryptDict: readEncryptDict(bytes, doc.origin, doc.trailer, doc.xref),
      },
    };
  }

  // 🔴 ここから先が verify の方針である。2 つの理由でここに来る:
  //   1. ライブラリが条文を名指しして受け取らなかった（構造が壊れている）
  //   2. 読めたが**目録に届かない** —— `/Prev 0` などでチェーンが途中で止まり、
  //      文書の本体が入っている節を読んでいない。「1 オブジェクトの文書」として
  //      答えると、そこに何が書いてあるかを見ないまま「違反なし」を返すことになる
  const origin = findOrigin(bytes);
  const chain = await walkXrefChain(bytes, origin, { continuePastStop: true });
  if (!chain) {
    // 節が 1 つも読めない。ファイルの中のオブジェクトを数え上げて組み直す —— **推測である**。
    const rebuilt = reconstructXref(bytes, origin);
    if (!rebuilt) {
      logger.debug(CONTEXT, `no cross-reference section could be read: ${refusal ?? '(none)'}`);
      if (refused) throw refused;
      throw new Error('no cross-reference section could be read');
    }
    logger.debug(CONTEXT, `reconstructed ${rebuilt.entries.size} object(s) after: ${refusal}`);
    const synthetic: WalkedChain = {
      origin,
      sections: [
        {
          offset: origin,
          kind: 'table',
          entries: rebuilt.entries,
          selfObjectNumber: null,
          trailer: rebuilt.trailer,
        },
      ],
      stop: { kind: 'unreadable', offset: 0, reason: 'no cross-reference section could be read' },
      truncated: true,
      newestSectionUnreadable: true,
      linearized: false,
      continuedPastStop: false,
    };
    const rebuiltDoc = await buildFromChain(bytes, synthetic, { password });
    return {
      doc: rebuiltDoc.doc,
      scope: {
        recovered: true,
        refusal,
        chainStop: synthetic.stop,
        newestSectionUnreadable: true,
        sections: 0,
        continuedPastStop: false,
        filledFromScan: 0,
        reconstructed: true,
        objects: rebuiltDoc.doc.xref.size,
        encrypted: rebuiltDoc.encrypted,
        authenticated: rebuiltDoc.authenticated,
        encryptDict: rebuiltDoc.encryptDict,
      },
    };
  }
  const built = await buildFromChain(bytes, chain, { password });

  // 組み立てても目録に届かず、ライブラリの答えのほうが読めていたなら、そちらを使う。
  if (doc && !(await catalogReachable(built.doc))) {
    return {
      doc,
      scope: {
        recovered: false,
        refusal: null,
        chainStop: doc.chainStop,
        newestSectionUnreadable: false,
        // ここは既に歩いてある。ライブラリの答えを使うだけで、読んだ節は同じ。
        sections: chain.sections.length,
        continuedPastStop: false,
        filledFromScan: 0,
        reconstructed: false,
        objects: doc.xref.size,
        encrypted: doc.encryption !== undefined,
        authenticated: true,
        encryptDict: readEncryptDict(bytes, doc.origin, doc.trailer, doc.xref),
      },
    };
  }

  if (refusal) logger.debug(CONTEXT, `recovered after: ${refusal}`);
  // 「回復した」= ライブラリの答えではなく verify が組み立てた、という意味。
  // 断られた理由がパスワードだけ（鍵が導けないまま）なら、構造は壊れていないので言わない。
  const structurallyRecovered =
    (refusal !== null && built.authenticated) ||
    chain.newestSectionUnreadable ||
    chain.continuedPastStop;
  return {
    doc: built.doc,
    scope: {
      recovered: structurallyRecovered,
      refusal,
      chainStop: chain.stop,
      newestSectionUnreadable: chain.newestSectionUnreadable,
      sections: chain.sections.length,
      continuedPastStop: chain.continuedPastStop,
      filledFromScan: built.filledFromScan,
      reconstructed: false,
      objects: built.doc.xref.size,
      encrypted: built.encrypted,
      authenticated: built.authenticated,
      encryptDict: built.encryptDict,
    },
  };
}

/**
 * 内部の申告を、出力に載せる形にする。落とすのは `encryptDict` だけ
 * —— COS 辞書なので JSON にすると内部表現が出る。`/V` `/R` `/Filter` の値が
 * 要るなら、呼び出し側がそこから取り出す。
 */
export function toReadingScope(scope: DocumentScope): ReadingScope {
  // 鍵の順は手で書く。分割代入の残りを広げると `chainStop` が末尾に回り、
  // 読み手が最初に見る場所が変わってしまう。
  return {
    recovered: scope.recovered,
    refusal: scope.refusal,
    chainStop: { ...scope.chainStop },
    newestSectionUnreadable: scope.newestSectionUnreadable,
    sections: scope.sections,
    continuedPastStop: scope.continuedPastStop,
    filledFromScan: scope.filledFromScan,
    reconstructed: scope.reconstructed,
    objects: scope.objects,
    encrypted: scope.encrypted,
    authenticated: scope.authenticated,
  };
}
