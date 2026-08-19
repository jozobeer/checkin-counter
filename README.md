# 来場者チェックインカウンター

イベント会場のスタッフが端末の「チェックイン」ボタンを押すと、共有人数が 1 増える匿名カウンターです。別のブラウザで開いても同じ数字が見え、3 秒ごとにサーバから取り直します。ログイン・氏名入力はなく、入力欄もありません。人数は Cloudflare Workers KV に 1 チェックイン = 1 キーで追記し、キー数を数えて出します。

画面は見出し、大きな人数（未取得時は「—」）、全幅ボタン、エラー表示です。送信中もボタンは無効にせず「送信中…」だけ出します。同一 IP は 5 秒あたり 20 回まで成功し、21 回目は「混み合っています。少し待ってから押してください」と出て人数は増えません。API に届かない（`file://`）ときもタイトルとフッターは描画されます。

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
