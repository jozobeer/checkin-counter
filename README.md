# 来場者チェックインカウンター

イベント会場のスタッフが端末の「チェックイン」を押すと、共有人数が 1 増える匿名カウンターです。ログインも氏名入力もなく、入力欄もありません。別ブラウザで開いても同じ数字が見え、起動時と以後 3 秒ごとにサーバから取り直します。人数は Cloudflare Workers KV に 1 チェックイン = 1 キーで追記し、キー数を数えて出します。同時に押しても増分は消えません。画面の数字は受信済み count の最大値なので、古い応答で巻き戻りません。

画面は見出し、大きな人数（未取得時は「—」）、全幅ボタン、エラー表示です。送信中もボタンは押せるままで、各クリックが独立した `POST` になります。送信中は「送信中…」と出ます。同一 IP は初回から 5 秒間に 20 回まで成功し、21 回目は「混み合っています。少し待ってから押してください」と出て人数は増えません。API に届かない（`file://`）ときもタイトルとフッターは描画されます。

## 公開URL

https://checkin-counter.jozo.beer

## 開発

[kojo](https://github.com/jozobeer/kojo)（1日1アプリ自動生成基盤）により生成されたリポジトリです。

初回セットアップ: `npm install`（Playwright ブラウザ未取得の環境では `npx playwright install chromium`）

- `npm run dev` — wrangler dev でローカル起動（http://127.0.0.1:8787）
- `npm test` — build → typecheck → vitest（ユニット）→ Playwright（E2E）
- `npm run verify` — 不変条件チェック（favicon / apps.jozo.beer フッター / 単一ファイル出力）
- `npm run deploy` — ビルドして Cloudflare Workers へデプロイ

## 構成

- `index.html` + `src/ui/` — React UI の正本（`public/index.html` はビルド出力）
  - `App.tsx` — 人数表示・チェックイン・3 秒ポーリング。状態はここだけ
- `src/worker/index.ts` — Hono（`GET /api/health`・`GET /api/count`・`POST /api/checkin`。永続化は KV）
- `tests/unit/` — vitest ユニットテスト、`tests/app.spec.ts` — Playwright E2E
- `PLAN.md` — 初回実装時の計画（歴史的文書。現状の正は本 README とテスト）
