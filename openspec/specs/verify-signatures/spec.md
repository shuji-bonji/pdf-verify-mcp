---
spec_id: VERIFY
kind: tool
introduced_by: unauthenticated-encrypted-document
---
# verify-signatures Specification

## Purpose
`verify_signatures` ツールが、署名の暗号学的な検証と、信頼・失効の評価を報告するときの規則を定めます。この初版には、鍵を導けない暗号化文書で署名フィールドを探せなかったことを、空の一覧ではなく `signatures: null` と `note` で示す振る舞いだけを書きます。検証の中身は既存のテスト（`tests/unit/verify-signatures.test.ts`）が固定しています。

## Requirements

### Requirement: SPEC-VERIFY-VERIFY-SIGNATURES-001 鍵を導けない文書では、署名を探せなかったことを null と note で示す

文書が暗号化されていて鍵を導けない（`scope.authenticated: false`）ときは、成功の応答のまま、`signatures` を `[]` ではなく `null` にし、`note` に「鍵を導けないので署名フィールドを探せなかった。署名の無い文書ではない」という趣旨の英語の文を書く（SHALL）。markdown でも「No signatures」と書かない（SHALL）。

#### Scenario: 利用者パスワード付きの文書
- **WHEN** 利用者パスワード付きの暗号化文書を `password` なしで `verify_signatures` に渡す
- **THEN** `signatures` は `null`、`note` が空でない文字列

#### Scenario: markdown で No signatures と書かない
- **WHEN** 同じ文書を `response_format: "markdown"` で渡す
- **THEN** 本文に `No signature` の文字列が無く、署名を探せなかったことが書いてある

#### Scenario: 暗号化されていない無署名の文書は空の一覧
- **WHEN** 暗号化されていない無署名の文書を渡す
- **THEN** `signatures` は `[]` で、`note` が無い
