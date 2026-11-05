## ADDED Requirements

### Requirement: SPEC-VERIFY-COMMON-OUTPUT-001 成功の応答は受け取った file_path を返す

7 ツールの成功の応答は、受け取った `file_path` の値をそのまま返す（SHALL）。JSON では最上位の最初の項目 `file_path` に、markdown では最初の見出しの次の行に `File: <パス>` として書く（SHALL）。値を正規化しない（SHALL）。同じツールを複数のファイルに並べて呼んだとき、応答だけからどのファイルの結果かを読めるようにするためである。エラーの本文には足さない（common-errors の形を変えない）。

#### Scenario: 7 ツールの JSON が file_path を返す

- **WHEN** 7 ツールのそれぞれに、署名付きの検体の絶対パスを `response_format: "json"` で渡す
- **THEN** 本文の JSON の最初の項目は `file_path` で、値は渡したパスと同じ

#### Scenario: markdown も file_path を書く

- **WHEN** `evaluate_policy` を `response_format: "markdown"` で呼ぶ
- **THEN** 本文に `File: <渡したパス>` の行がある

### Requirement: SPEC-VERIFY-COMMON-OUTPUT-002 signatureCount は文書タイムスタンプを除いた署名の数にする

`signatureCount` という名前の項目は、どのツールでも、`/ByteRange` と `/Contents` を持つ署名の辞書のうち文書タイムスタンプ（`/Type /DocTimeStamp`。ISO 32000-2 §12.8.5）を除いた数にする（SHALL）。文書タイムスタンプの数は `documentTimestampCount` として同じ階層に返す（SHALL）。同じ名前の項目がツールによって違うものを数えないようにするためである。

#### Scenario: 署名 1 本と文書タイムスタンプ 1 本の文書（verify_integrity）

- **WHEN** 署名 1 本の後に文書タイムスタンプ 1 本を増分更新で足した文書を `verify_integrity` で読む
- **THEN** `signatureCount` は 1、`documentTimestampCount` は 1

#### Scenario: 署名 1 本と文書タイムスタンプ 1 本の文書（evaluate_policy）

- **WHEN** 同じ文書を `evaluate_policy` で読む
- **THEN** `facts.signatureCount` は 1、`facts.documentTimestampCount` は 1、`facts.signatures` は 2 件

#### Scenario: 文書タイムスタンプの無い文書

- **WHEN** 署名 1 本だけの文書を `verify_integrity` で読む
- **THEN** `signatureCount` は 1、`documentTimestampCount` は 0
