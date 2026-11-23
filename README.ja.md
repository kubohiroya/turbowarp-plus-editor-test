# TurboWarp Plus Editor Test

[English](README.md)

TurboWarp Plus Editor の作品の中に [TurboWarp-Test](https://github.com/kubohiroya/turbowarp-test) のブロックで書いたテストを実行する。テストは1件ごとに、専用の VM へ作品の写しを読み込み直してから動くので、編集中の作品・取り消しの履歴・選んでいるスプライトには触れず、どのテストもほかのテストが残した状態を見ない。結果はテストごとに、失敗した確かめるブロックと一緒に返し、CI 向けに JUnit XML にもする。VM は構造的な型で受け取り、VM・GUI・React・Dockview を import しない。

設計: [turbowarp-plus-editor#774](https://github.com/kubohiroya/turbowarp-plus-editor/issues/774)

## 入口

| import | 内容 |
| --- | --- |
| `@kubohiroya/turbowarp-plus-editor-test/test-discovery` | `discoverTests(project)`。`project.json` の中のテストを `<ターゲット>/<ブロックID>` で指し、ターゲットごとの「テストの前に」ハットと、それが2つ以上あるターゲットを返す |
| `@kubohiroya/turbowarp-plus-editor-test/test-runner` | `runTests({vm, project, only, frameLimit, signal, onTestStart, onTestEnd})`。テストを実行して結果を返す |
| `@kubohiroya/turbowarp-plus-editor-test/test-run-view` | `createTestRunView(options)`。テスト実行画面（素の DOM）。`testRunMenuItem(locale, open)` はワークベンチの実行画面▼メニュー（`menuItems`）に足す項目、`testRunPanelRequest(options)` はワークベンチの `getDocumentWorkspace(vm).open()` で開く一時的なタブ |
| `@kubohiroya/turbowarp-plus-editor-test/test-frame` | テストを別の文書（iframe）で動かす。枠の中の `serveTestFrame(options)`、エディター側の `connectTestFrame(frame, options)`、同じページの VM で動かす `vmRunner(vm)` |
| `@kubohiroya/turbowarp-plus-editor-test/junit` | `toJUnitXml(report)`。スプライト・ステージごとに suite、テストごとに case |
| `@kubohiroya/turbowarp-plus-editor-test` | 上のすべてと、拡張との約束の定数 |

## テストの動き方

1. 作品の写しを VM に読み込み、コンパイラーを切る。拡張の待機ブロックが条件をフレームごとに確かめ直せるのは、インタープリターだけだから。
2. テストのスプライト・ステージに「テストの前に」ハットがあれば、そのスクリプトを最後まで動かす。
3. テストのスクリプトを、`runtime._step()` 1回を1フレームとして、終わるか `frameLimit`（既定 3000）フレームに達するまで動かす。
4. この2つのスクリプトが出した記録を集め、すべてのスレッドを止める。

確かめるブロックが1つも失敗せずにスクリプトが終われば**成功**、失敗があれば**失敗**、フレームを使い切れば**時間切れ**、動かせなければ**エラー**（「テストの前に」が2つある、ブロックが例外を投げた）。緑の旗は押さない。

## テスト実行画面

専用の実行画面、作品のテスト、その結果を表示する。「すべて実行」と各テストの「実行」で始め、「止める」で止める。失敗した確かめるブロックは、比べた値を示し、「ブロックを表示」でエディターにそのブロックを表示するようホストに頼む。時間切れや動かせなかったテストは、その理由を示す。開いた時点でテストを一覧にし、テスト用の VM は実行を始めるときに作る。文言は `locale` に従い、日本語か英語にする。

ホストは、実行を始めるときに編集中の作品の写しを返す `getProject()`、テストを動かすものを作って実行画面を `stage` に置く `createRunner(stage)`、任意で `showBlock(target, blockId)` を渡す。同じページに使える VM があるホストは、代わりに `createVm(stage)` を渡せる。

## 別の文書でテストを動かす

拡張ローダーはページ全体の central dispatch を自分の VM のために使うので、1つのページで拡張を読み込める VM は1つだけで、エディターではそれがエディターの VM になる。そこでエディターは、テストを別の文書（iframe）で動かす。枠の中では VM と拡張ホストを作って `serveTestFrame({window, origin, getVm, prepare})` を呼び、エディターは枠を画面の `stage` に置いて、`connectTestFrame(frame, {origin, context})` をランナーとして渡す。実行のたびに作品・選んだテスト・`context()`（エディターが読み込んでいる拡張コードの SHA-256 など）を送り、枠の `prepare(context, vm)` が実行前にそれを適用するので、枠はそのコードだけを動かす。どちらの側も、ほかの窓や origin からのメッセージは無視する。

## ホストが用意するもの

- ランナーだけが動かす VM。フレームループは止めておく（`vm.start()` を呼ばない）。編集中の VM は使わない。
- その VM に読み込んだ TurboWarp-Test 拡張。
- 作品。編集画面のブロックに失敗の印を出すなら、`editorVm.toJSON(undefined, {allowOptimization: false})` を渡す。TurboWarp の既定の保存はブロックIDを付け直すので、記録のIDが編集画面のブロックと合わなくなる。アセットを取り直さずに済むよう、編集画面の storage をテスト用の VM にもつなぐ。

フレームは runtime の1歩で、壁時計の時間ではない。見た目の変化がないループは、TurboWarp と同じく1フレームに何回も回ることがあるので、フレームは拡張の待機ブロックで数える。

## 検証

`npm test` でビルドし、単体テストを実行する。`npm run test:browser` は、Editor が固定する VM（`@kubohiroya/turbowarp-plus-editor-test-runtime`）でランナーをヘッドレスの Chromium で動かす。CI でも両方を実行する。

## ライセンス

MPL-2.0
