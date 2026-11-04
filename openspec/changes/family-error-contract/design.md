# Design

## 応答の形

```jsonc
{
  "error": "File not found: /path/to/no-such-file.pdf",   // 0.32.2 の message
  "code": "DOC_NOT_FOUND",
  "retryable": false,
  "hint": "Check that the file exists and the path is correct",  // 0.32.2 の suggestion。無いコードもある
  "detail": { "legacyCode": "FILE_NOT_FOUND" },
  // 移行の版だけ
  "message": "File not found: /path/to/no-such-file.pdf",
  "suggestion": "Check that the file exists and the path is correct"
}
```

`INVALID_ARGUMENT` は `detail.reason` に旧名を書きます（`{ "reason": "RELATIVE_PATH", "legacyCode": "RELATIVE_PATH" }`）。`reason` は旧名を外した後も残ります。

## 旧名の付け方

pdf-agent-stack の S6 の契約テストは、`detail.legacyCode` があるときだけ最上位の `message`・`suggestion` を認めます。名前の変わらないコード（`VERAPDF_NOT_FOUND` など）にも `message`・`suggestion` を残すので、**移行の版のあいだは、すべてのエラーに `detail.legacyCode` を付けます**（値は 0.32.x で返していた `code`。名前が変わらなければ `code` と同じ）。受け側は「`detail.legacyCode` があれば移行の版」と 1 通りに読めます。

## `retryable` の値

規約の定義は「引数・フラグ・環境を変えれば成功しうるか」です。

| `code` | `retryable` | 理由 |
| --- | --- | --- |
| `INVALID_ARGUMENT` | `true` | 引数を直せば通る（spec の `VALIDATION_ERROR` と同じ） |
| `DOC_NOT_FOUND` | `false` | §2.3 の例のとおり。同じ呼び出しを繰り返しても通らず、別のファイルを探すのは呼び出し側の仕事 |
| `INVALID_PDF` | `false` | 文書についての所見。何を変えても同じ文書は読めない |
| `ENCRYPTED_PDF` | `true` | `password` を渡すか `engine: "native"` に変えれば判定まで進む（0.32.2 の案内のとおり） |
| `WRONG_PASSWORD` | `true` | 正しいパスワードで通る |
| `FILE_TOO_LARGE` | `false` | 上限は利用者が変えられない |
| `INVALID_BYTE_RANGE` | `false` | 文書の `/ByteRange` の問題 |
| `VERAPDF_NOT_FOUND`・`VERAPDF_NOT_AVAILABLE` | `true` | `engine: "native"` に変えるか、veraPDF を入れれば通る |
| `VERAPDF_NO_RESULT` | `false` | veraPDF は動いたが結果を返さなかった。同じ入力で繰り返しても同じ |
| `INTERNAL_ERROR` | `false` | サーバーの故障 |

値はコードごとに 1 つに決め、エラーを作る箇所では選ばせません（同じコードに 2 つの値があると、受け側はコードで分岐できない）。

## 実装の置き場

- `src/utils/error-handler.ts` の `PdfVerifyError` が持つ `code` を新しい名前にし、旧名は `legacyCode` で取り出せるようにする（`INVALID_ARGUMENT` は `reason`）。`suggestion` は `hint` に名前を変える。
- `handleStructuredError` が上の形を組む。7 ツールのハンドラは今も全部これを通っているので、ハンドラは変えない。
- `validate_clauses` は `validateClauses` の先頭で `assertReadablePdf` を呼ぶ。

## ライブラリの制約と仕様の制約

- 仕様の制約: PDF でないファイルと 0 バイトのファイルは、ISO 32000-2 §7.5.2（ファイルは `%PDF-` で始まる）に反するので `INVALID_PDF` になる。normativepdf の拒否の文が `no %PDF- header found (§7.5.2)` と条文を名指しする。
- ライブラリの制約: なし。エラーの形は MCP の仕様（ツール結果の `isError`）と family の規約で決まり、PDF のライブラリには依らない。
- veraPDF の有無: veraPDF のある環境と無い環境で、エラーの形は変わらない。どの `code` になるか（`VERAPDF_NOT_FOUND` など）は SPEC-VERIFY-VALIDATE-CONFORMANCE-013 のとおり。
