# 来場者チェックインカウンター

このリポジトリは kojo が生成した Web アプリです（React UI + Hono API）。公開後の保守はこのリポジトリ単体で行う。

## アプリ概要と構成

イベント会場のスタッフが会場ごとの共有カウンターで来場者数を数える匿名アプリ。ルートで会場名を入れて作ると `#/r/<id>` の共有 URL が発行され、その URL を開いた端末だけが同じ会場名と同じ人数を見る。ログイン・氏名入力はない。人数は KV のキー数で算出し、単一キーの read-modify-write はしない（同時チェックインで増分が消えないため）。

| 領域 | 実装 |
|------|------|
| UI | `src/ui/App.tsx` がハッシュルーターと `<h1>`。`parseRoute(location.hash)` で `{kind:"home"} \| {kind:"room", id}`。`#/r/<id>` は `/^#\/r\/([^/?#]+)$/`。ID 形式の正否はサーバ（404）に一元化。`<Room key={route.id} roomId={route.id} />` で会場切替時に状態をリセット。ホーム（`Home.tsx`）は会場名フォーム（`data-testid="room-name-input"`、`maxLength={40}`）と作成（`data-testid="create"`）、エラー（`data-testid="create-error"`）、使い方・FAQ。会場（`Room.tsx`）は会場名（`data-testid="room-name"`）、人数（`data-testid="count"`、未取得は「—」）、全幅ボタン（`data-testid="checkin"`）、エラー（`data-testid="error"`）、共有 URL（`data-testid="share-url"`）とコピー（`data-testid="copy"` / `data-testid="copied"`）、未検出（`data-testid="notfound"`）。状態管理ライブラリは使わない。`useState` とリフトアップのみ。マウント時 `GET /api/rooms/<id>`、以後 3 秒ポーリング。表示は受信済み count の最大値（KV の結果整合性で古い値が返っても巻き戻さない）。404 ならポーリングを止め、人数・ボタン・共有 URL は描画しない。送信中もボタンは無効化せず、各クリックは独立した `POST` を並列に飛ばす。送信中は「送信中…」。作成 429 は「混み合っています。少し待ってから作成してください」、作成のその他失敗は「カウンターを作成できませんでした。もう一度お試しください」、空の会場名は「会場名を入力してください」。チェックイン 429 は「混み合っています。少し待ってから押してください」、その他は「チェックインできませんでした。もう一度お試しください」。失敗時は count を変えない。共有 URL は `${location.origin}/#/r/${id}`。コピー成功は「コピーしました」。未検出は「このカウンターは見つかりませんでした」。API 不達時も骨格（タイトル・フッター）は描画する |
| API | `src/worker/index.ts`。すべて JSON（HTML は返さない）。`GET /api/health`（KV 書込→読出、200 `{"ok":true}`。契約を壊さない）、`POST /api/rooms`（201 `{"id":string,"name":string}`。413 / 400 / 429 / 500 は `{"error":true}` で会場は作られない）、`GET /api/rooms/:id`（200 `{"id":string,"name":string,"count":number}`。形式不正・未存在は 404）、`POST /api/rooms/:id/checkin`（201 `{"count":number}`。404 / 413 / 400 / 429 では人数は増えない） |
| 永続化 | `c.env.KV` のみ。TTL なしのキーを消すと人数が減る。`r:<id>`（`{"name":<trim済み>,"createdAt":<ISO文字列>}`、TTL なし）、`c:<id>:<crypto.randomUUID()>`（値は打刻 ISO 文字列）、`rl:<ip>`（チェックイン、`{"start":<epoch ms>,"n":<count>}`、`expirationTtl: 60`）、`rlr:<ip>`（会場作成、同形、`expirationTtl: 120`）。人数は `list({ prefix: "c:<id>:" })` を cursor で全ページ走査してキー数を合算。ID は `crypto.randomUUID().slice(0, 8)`。`r:<id>` の存在を get-before-put し、衝突したら最大 3 回再生成、だめなら 500。IP は `CF-Connecting-IP`、無ければ `"unknown"` |
| 書込制限 | 会場作成のボディは `{"name": string}` のみ。256 バイト超は 413、未知フィールド・不正 JSON・空の会場名（trim 後 0 文字）・41 文字超（`[...name].length`）は 400。同一 IP は 60 秒間に 20 回まで成功、21 回目は 429。59999ms は同一窓、60000ms でリセット。処理順は「ボディ検証 → レートリミット → ID 生成」。チェックインのボディは空または `{}` のみ。256 バイト超は 413、未知フィールド・不正 JSON は 400。同一 IP は初回から 5 秒間に 20 回まで成功、21 回目は 429。4999ms は同一窓、5000ms でリセット。処理順は「ボディ検証 → 会場存在確認 → レートリミット」。`:id` が `/^[0-9a-f]{8}$/` 以外、または `r:<id>` が無ければ 404 でチェックインキーは作らない。`rl:` / `rlr:` は単一キーの read-modify-write のため、並行 POST では上限判定がやや甘くなる（簡易レートリミットとして許容） |
| テスト | API/ロジックは `tests/unit/*.test.ts`（フェイク KV を `app.request` の第 3 引数で注入。`tests/unit/fake-kv.ts` を `rooms.test.ts` と `checkin.test.ts` で共有）。ブラウザ挙動は `tests/app.spec.ts`。Playwright の `webServer` は `.wrangler/test-state` を消してから `wrangler dev` する（チェックインキーに TTL がなく、残留すると絶対値アサーションが壊れる）。雛形のスモークと health テストは削除しない。E2E は `fullyParallel` にせずファイル分割しない（ローカル wrangler は `CF-Connecting-IP` を送らず全リクエストが `"unknown"` の単一バケットを共有するため） |

既知の制限: 本番 KV の `list` は結果整合性のため、他端末への反映が遅れることがある。増分そのものは失われない。

## 技術スタック（不変）

- TypeScript / React 19（ReactCompiler有効。状態管理ライブラリ禁止、リフトアップとprops受け渡しのみ） / Hono / Vite + vite-plugin-singlefile / vitest + Playwright
- UI の正本は `index.html` と `src/ui/`。`public/index.html` は単一ファイルのビルド出力（直接編集しない）
- 配信: Cloudflare Workers（main=`src/worker/index.ts`、assets=`public/`、/api/* が Worker に落ちる）
- 保守時もこのスタックを維持すること。フレームワーク・ビルドツール・宣言外ライブラリの導入は禁止

## 品質不変条件

次を壊さないこと。変更後は `npm run verify` が通る状態を維持する。

- favicon は `index.html` の `<head>` に `<link rel="icon" href="data:image/svg+xml,...">` のインライン data URI（外部ファイル・外部 URL 不可）
- hub（apps.jozo.beer）へのフッターは `#root` の外に置く。リンク先 `https://apps.jozo.beer` とリンクテキスト `apps.jozo.beer` は変えない

```html
<footer style="margin-top:3rem;text-align:center;font-size:.8rem;opacity:.6">
  <a href="https://apps.jozo.beer" style="color:inherit">apps.jozo.beer</a>
</footer>
```

スタイル（リンク色を含む）はテーマに合わせて調整してよい。リンク色を変える場合は背景とのコントラストを確保する。

その他:

- `public/` は `npm run build` の出力なので直接編集しない
- README.md は削除しない
- apple-touch-icon / manifest / og-image / robots / sitemap は公開基盤が生成するため書かない
- 雛形のスモークテストと health テストは削除しない
- サーバ側の永続化は KV binding（`c.env.KV`）のみ。D1/DO・外部 API は使わない
- `GET /api/health` は KV 書込→読出の実往復で 200 と `{"ok":true}` を返し続ける（機械検証が依存）
- 匿名書込エンドポイントには入力サイズ上限・バリデーション・簡易レートリミットを維持する
- UI は API に到達できなくても骨格（タイトル・フッター）を描画する（視覚検証は `file://` で行われる）

## 保守の進め方

1. 変更前に受け入れ条件をテストにする（API/ロジックは `tests/unit/*.test.ts`、ブラウザ挙動は `tests/app.spec.ts`）
2. 実装する
3. `npm test` が通ることを確認する
4. `git commit` と `git push`
5. `npm run deploy`

## PLAN.md について

`PLAN.md` は初回実装時の計画であり歴史的文書である。現状の正は README.md とテスト（`tests/`）である。受け入れ条件の追加・変更はテストと README に反映する。PLAN とテストが食い違う場合はテストに従う。
