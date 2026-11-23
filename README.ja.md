# TurboWarp Plus Editor Test

[English](README.md)

TurboWarp Plus Editor の作品の中に [TurboWarp-Test](https://github.com/kubohiroya/turbowarp-test) のブロックで書いたテストを実行する。テストは1件ごとに、専用の VM へ作品の写しを読み込み直してから動くので、編集中の作品・取り消しの履歴・選んでいるスプライトには触れず、どのテストもほかのテストが残した状態を見ない。結果はテストごとに、失敗した確かめるブロックと一緒に返し、CI 向けに JUnit XML にもする。VM は構造的な型で受け取り、VM・GUI・React・Dockview を import しない。

設計: [turbowarp-plus-editor#774](https://github.com/kubohiroya/turbowarp-plus-editor/issues/774)

## 入口

| import | 内容 |
| --- | --- |
| `@kubohiroya/turbowarp-plus-editor-test/test-discovery` | `discoverTests(project)`。`project.json` の中のテストを `<ターゲット>/<ブロックID>` で指し、ターゲットごとの「テストの前に」ハットと、それが2つ以上あるターゲットを返す |
| `@kubohiroya/turbowarp-plus-editor-test/test-runner` | `runTests({vm, project, only, frameLimit, signal, onTestStart, onTestEnd})`。テストを実行して結果を返す |
| `@kubohiroya/turbowarp-plus-editor-test/junit` | `toJUnitXml(report)`。スプライト・ステージごとに suite、テストごとに case |
| `@kubohiroya/turbowarp-plus-editor-test` | 上のすべてと、拡張との約束の定数 |

## テストの動き方

1. 作品の写しを VM に読み込み、コンパイラーを切る。拡張の待機ブロックが条件をフレームごとに確かめ直せるのは、インタープリターだけだから。
2. テストのスプライト・ステージに「テストの前に」ハットがあれば、そのスクリプトを最後まで動かす。
3. テストのスクリプトを、`runtime._step()` 1回を1フレームとして、終わるか `frameLimit`（既定 3000）フレームに達するまで動かす。
4. この2つのスクリプトが出した記録を集め、すべてのスレッドを止める。

確かめるブロックが1つも失敗せずにスクリプトが終われば**成功**、失敗があれば**失敗**、フレームを使い切れば**時間切れ**、動かせなければ**エラー**（「テストの前に」が2つある、ブロックが例外を投げた）。緑の旗は押さない。

## ホストが用意するもの

- ランナーだけが動かす VM。フレームループは止めておく（`vm.start()` を呼ばない）。編集中の VM は使わない。
- その VM に読み込んだ TurboWarp-Test 拡張。
- 作品。編集画面のブロックに失敗の印を出すなら、`editorVm.toJSON(undefined, {allowOptimization: false})` を渡す。TurboWarp の既定の保存はブロックIDを付け直すので、記録のIDが編集画面のブロックと合わなくなる。アセットを取り直さずに済むよう、編集画面の storage をテスト用の VM にもつなぐ。

フレームは runtime の1歩で、壁時計の時間ではない。見た目の変化がないループは、TurboWarp と同じく1フレームに何回も回ることがあるので、フレームは拡張の待機ブロックで数える。

## 検証

`npm test` でビルドし、単体テストを実行する。`npm run test:browser` は、Editor が固定する VM（`@kubohiroya/turbowarp-plus-editor-test-runtime`）でランナーをヘッドレスの Chromium で動かす。CI でも両方を実行する。

## ライセンス

MPL-2.0
