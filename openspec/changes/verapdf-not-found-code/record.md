# record: verapdf-not-found-code

PDF family の OpenSpec + spec-ids 導入（pdf-agent-stack `docs/specs/31`）の Phase 2、pdf-verify-mcp の 1 件目の記録です。書式は計画 §8 です。時刻は JST です。仕様 PR の時点の記録で、実装 PR で書き足します。

| 項目 | 記録 |
| --- | --- |
| 版 | OpenSpec 1.14.1 / spec-ids 0.5.0 / pdf-verify-mcp 0.32.0 → 次の版（人が決める。patch の 0.32.1 を提案）/ Claude（claude.ai、モデル claude-opus-5-5）/ 2026-11-02 |
| きっかけ | 初版起こし（`spec-init/validate-conformance`、#26 → 出し直しの PR でマージ）の途中で、`engine: "verapdf"` の既存テスト 1 件が veraPDF のある環境で先頭の `return` に入り、何も確かめないことに気づいた。調べると、そのテストが守るはずの `VERAPDF_NOT_FOUND` は `tools/list` の説明にも正本にも書かれていなかった |
| PR の切り方 | 2 段（計画 §10-3 の層 3）。この仕様 PR（`spec/verapdf-not-found-code`）→ 実装 PR（`fix/verapdf-not-found-code`） |
| 仕様を書いた時間 | 約 20 分（15:58 に着手。調査込み） |
| 人が判断した箇所 | (1) 最初の変更の対象（エージェントが提案し、人が「進めて」と指示）。(2) 版と、テスト用の差し替えの入口を実装に置くこと（proposal の「人が判断すること」。未決）。(3) `approved`・`pr` の記入 |
| 仕様と実装のずれ | （実装 PR で書く） |
| エージェントが仕様に無い振る舞いを実装した件数 | （実装 PR で書く） |
| 実装後に仕様を読み返した回数 | （実装 PR で書く） |
| 維持の手間 | 仕様だけを変えた変更: 0 件 |

## 分かったこと（仕様 PR の時点）

1. **先頭で `return` するテストは、正本に ID を付けても空振りする。** 初版起こしでは期待値を変えない決まりなので、このテストにも 013 を付けた。`spec-ids check` は「テスト名に ID がある」ことしか見ないので、veraPDF のある環境で 013 の該当 Scenario が確かめられていなくても緑になる。
2. **返しうるエラーの `code` が説明に無いと、仕様にも書かれない。** 初版起こしは既存テストから要求を起こしたので、テストが `code` を見ていない `VERAPDF_NOT_FOUND` は正本に入らなかった。
