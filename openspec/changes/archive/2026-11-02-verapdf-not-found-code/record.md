# record: verapdf-not-found-code

PDF family の OpenSpec + spec-ids 導入（pdf-agent-stack `docs/specs/31`）の Phase 2、pdf-verify-mcp の 1 件目の記録です。書式は計画 §8 です。時刻は JST です。仕様 PR の時点の記録に、実装 PR で書き足しました。

| 項目 | 記録 |
| --- | --- |
| 版 | OpenSpec 1.14.1 / spec-ids 0.5.0 / pdf-verify-mcp 0.32.0 → 次の版（人が決める。patch の 0.32.1 を提案）/ Claude（claude.ai、モデル claude-opus-5-5）/ 2026-11-02 |
| きっかけ | 初版起こし（`spec-init/validate-conformance`、#26 → 出し直しの PR でマージ）の途中で、`engine: "verapdf"` の既存テスト 1 件が veraPDF のある環境で先頭の `return` に入り、何も確かめないことに気づいた。調べると、そのテストが守るはずの `VERAPDF_NOT_FOUND` は `tools/list` の説明にも正本にも書かれていなかった |
| PR の切り方 | 2 段（計画 §10-3 の層 3）。この仕様 PR（`spec/verapdf-not-found-code`）→ 実装 PR（`fix/verapdf-not-found-code`） |
| 仕様を書いた時間 | 約 20 分（15:58 に着手。調査込み） |
| 実装した時間 | 約 10 分（16:13 に #28 の承認を受けて着手し、16:23 に受入テスト・実装・CHANGELOG・tools/list の比較・archive を揃えた） |
| 人が判断した箇所 | (1) 最初の変更の対象（エージェントが提案し、人が「進めて」と指示）。(2) テスト用の差し替えの入口を実装に置くこと（proposal の「人が判断すること」。proposal の承認をもって design.md の案どおりに進めた）。(3) 版（未決。CHANGELOG は `[Unreleased]`）。(4) `approved`・`pr` の記入（#28） |
| 仕様と実装のずれ | 0 件 |
| エージェントが仕様に無い振る舞いを実装した件数 | 0 件。仕様の外の修正は、隣の `describe` の冒頭コメント（「隣のテストは先頭で return する」）を今の形に直したこと |
| 実装後に仕様を読み返した回数 | 0 回 |
| テスト | `npm test` 264 → 266 件。受入テスト 3 件（013 の 2 Scenario を 3 件で）。変更前の `src/` で 3 件とも落ち、変更後に 3 件とも通った。check:engines・check・typecheck・build・check:public-types は終了コード 0 |
| tools/list の比較 | 変更前（main）と変更後の `dist` を stdio で起動して比べた。7 ツールのうち差は `validate_conformance` の description だけで、変えた 1 文のほかは同じ |
| 手元で確かめること | veraPDF のある Mac で `npm test` を回し、「どこにも入っていない」のテストが `return` せずに通ること（tasks 3.2。作業環境には veraPDF が無い） |
| 維持の手間 | 仕様だけを変えた変更: 0 件 |

## 分かったこと（仕様 PR の時点）

1. **先頭で `return` するテストは、正本に ID を付けても空振りする。** 初版起こしでは期待値を変えない決まりなので、このテストにも 013 を付けた。`spec-ids check` は「テスト名に ID がある」ことしか見ないので、veraPDF のある環境で 013 の該当 Scenario が確かめられていなくても緑になる。
2. **返しうるエラーの `code` が説明に無いと、仕様にも書かれない。** 初版起こしは既存テストから要求を起こしたので、テストが `code` を見ていない `VERAPDF_NOT_FOUND` は正本に入らなかった。
3. **受入テストのうち 2 件は、振る舞いではなく入口の無さで落ちた。** 「どこにも入っていない」の 2 件は、変更前は `setWellKnownPathsForTesting` が無いので `TypeError` で落ちた。veraPDF の無い CI では、変更前から `VERAPDF_NOT_FOUND` を返していた。「直す前に落ちる」は、この変更では「確かめる手段が無かった」ことを示していて、「振る舞いが違った」ことは示していない。振る舞いが変わったと言えるのは、説明の 1 件だけ。
4. **2 段の PR の手間。** 人の往復は、仕様 PR の承認と実装 PR のマージの 2 回の見込み。1 PR 運用では、承認の後に archive の commit を足す往復が要ったが、2 段では仕様 PR の承認が先に済んでいるので、実装 PR の中で archive まで一度に入れられた。
