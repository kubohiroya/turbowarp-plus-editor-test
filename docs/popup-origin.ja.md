# 別ウィンドウのテスト実行とEditorのorigin

追跡: [Security Dialog #106](https://github.com/kubohiroya/turbowarp-extension-security-dialog/issues/106)のDesktop固定・TypeScript開発ループ統合で発見。所有リポジトリのIssue作成案は公開承認時に提示する。ブランチ: `fix/frame/editor-popup-origin`、base: `d13768c`。

Editorがテスト実行ビューを別ウィンドウへ開くと、そのURLは`about:blank`、`location.origin`は`null`となる。そこから作る実行frameはEditorと同じoriginで配信される。`createTestRunEditor`がビューのdocumentから通信originを取ると、正しいframeのreadyメッセージを受理できず、結果がpendingのままになる。

frameのURLと通信originは、どちらもホストが供給するEditorのdocumentから取る。ビューのDOMは引き続き表示先のdocumentで作る。`test-frame.ts`のorigin・送信元の一致判定は変更しない。

受け入れ基準:

- `about:blank`の別ウィンドウで、Editor originの正しいframeとのhandshakeからrunを開始できる。
- 異なるoriginまたは異なる送信元のreadyではrunを開始しない。
- 同じ文書内のタブ、保存済み世代の実行、取消・破棄、結果のビルド帰属の既存検証を維持する。
- `npm test`と通常のヘッドレス`npm run test:browser`が成功する。

回帰テストは修正前の「正しいreadyでもrunが始まらない」を確認してから修正を検証する。別documentのDOMはJSDOMで作り、実Desktop rendererでのpopup／frameのorigin観測と区別する。Electronの実ウィンドウ・OS入力の結果とは扱わない。

切り戻しは本修正のrevertと、採用後のEditor依存・Desktop renderer固定を直前の検証済み版へ戻す方法で行う。別ウィンドウのテスト実行は再び不具合の対象となるため、切り戻し中は同じdocument内の実行ビューを使う。作品や開発フォルダは変更しない。

2026-11-28 JST start: 公開済みtest 0.4.1とEditor `96d1564`を使うDesktopでpendingを再現。popupのoriginは`null`、frameは`http://localhost:41015`だった。公開版・製品への反映は別の承認対象とする。
