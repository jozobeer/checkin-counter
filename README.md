# 来場者チェックインカウンター

イベント会場のスタッフが、会場ごとの共有カウンターで来場者数を数える匿名アプリです。ルートで会場名を入れてカウンターを作ると `#/r/<id>` の共有 URL が発行され、その URL を開いた端末だけが同じ会場名と同じ人数を見ます。ログインも氏名入力もありません。人数は Cloudflare Workers KV に 1 チェックイン = 1 キーで追記し、キー数を数えて出します。同時に押しても増分は消えません。画面の数字は受信済み count の最大値なので、古い応答で巻き戻りません。

ホームは会場名の入力フォームです。作成後の画面は会場名、大きな人数（未取得時は「—」）、全幅ボタン、共有 URL とコピー、エラー表示です。送信中もボタンは押せるままで、各クリックが独立した `POST` になります。送信中は「送信中…」と出ます。同一 IP のチェックインは初回から 5 秒間に 20 回まで成功し、21 回目は「混み合っています。少し待ってから押してください」と出て人数は増えません。存在しない ID を開くと「このカウンターは見つかりませんでした」と出ます。API に届かない（`file://`）ときもタイトルとフッターは描画されます。ホームのボタンの下に使い方と FAQ があります。

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
  - `App.tsx` — ハッシュルーター（`/` と `#/r/<id>`）
  - `Home.tsx` — 会場名フォームと作成
  - `Room.tsx` — 人数表示・チェックイン・3 秒ポーリング・共有 URL
- `src/worker/index.ts` — Hono（`GET /api/health`・`POST /api/rooms`・`GET /api/rooms/:id`・`POST /api/rooms/:id/checkin`。永続化は KV）
- `tests/unit/` — vitest ユニットテスト、`tests/app.spec.ts` — Playwright E2E
- `PLAN.md` — 初回実装時の計画（歴史的文書。現状の正は本 README とテスト）
