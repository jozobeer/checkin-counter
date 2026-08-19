# 来場者チェックインカウンター

## 1. 概要

イベント会場のスタッフが各自の端末でチェックインボタンを押すと、サーバー上の共有カウンターが 1 増え、どの端末で開いても同じ現在人数が表示される匿名の共有カウンターアプリ。React UI（`src/ui/`）から `POST /api/checkin` を叩き、Hono API（`src/worker/index.ts`）がチェックイン 1 件を KV に 1 キーとして追記（append-only）する。人数は KV の該当キーを数えて算出するため、複数端末からの同時チェックインでも増分が失われない。ログイン・氏名入力は一切なく、ページを開けば誰でも押せる。

## 2. 意図（明示）

複数のスタッフが別々の入口や端末からチェックインを担当するイベントで、個人アカウントなしに「今何人入場したか」をスタッフ全員がリアルタイムで同じ数字として把握したい場面で使う。

## 3. 受け入れ条件

- [ ] AC1: チェックインボタンを押すと共有カウンターが 1 増え、別ブラウザセッション（別 context）で開いた画面にも増加後の同じ数値が表示される
- [ ] AC2: 3 つの別セッションから同時にチェックインしても増分が失われず、画面の表示値がちょうど +3 になる。1 端末で応答待ち中に追加クリックした分もすべて加算される
- [ ] AC3: 氏名・アカウント・ログイン操作なしに、初回訪問の新規セッションからそのままチェックインでき、増加後の値が画面に表示される
- [ ] AC4: 匿名書込 `POST /api/checkin` が保護されている。同一 IP からの上限は「初回リクエストから 5 秒間に 20 回」で、20 回目は成功・21 回目は拒否（HTTP 429）され画面の値は増えない。5 秒経過後は再び成功する。ボディは 256 バイト超を 413、未知フィールドを含む JSON を 400 で拒否し、いずれも人数は増えない
- [ ] AC5: API に到達できない状態（`file://` で開いたビルド出力）でも、タイトル「来場者チェックインカウンター」とフッターリンク `apps.jozo.beer` が描画される

## 4. 実装方針

### API（`src/worker/index.ts`、Hono）

| エンドポイント | 応答 | 内容 |
| --- | --- | --- |
| `GET /api/health` | `{"ok":true}` | 既存のまま維持（変更しない） |
| `GET /api/count` | `{"count":number}` | 現在人数を返す |
| `POST /api/checkin` | 201 `{"count":number}` | チェックイン 1 件を追記し、加算後の人数を返す |

KV キー設計（`c.env.KV` のみ使用）:

- `c:<crypto.randomUUID()>` — チェックイン 1 件。値は打刻の ISO 文字列。**TTL なし**（消えると人数が減るため）
- `rl:<ip>` — レートリミット状態 `{"start":<epoch ms>,"n":<count>}`、`expirationTtl: 60`

主要関数:

- `countCheckins(kv)` — `kv.list({ prefix: "c:" })` を `cursor` で全ページ走査し、`keys.length` を合算して返す
- `checkRateLimit(kv, ip, now)` — `rl:<ip>` を読み、`now - start >= 5000` なら `{start: now, n: 1}` にリセットして許可。窓内なら `n + 1 <= 20` で許可、超過で拒否。判定境界は **4999ms 経過は同一窓（21 回目は拒否）／ 5000ms 経過でリセット（許可）**
- `validateBody(req)` — `Content-Length > 256` は 413。ボディ空・`{}` のみ許可し、未知フィールドを含む、または JSON として不正なら 400

設計上の判断:

- **単一キーの read-modify-write は使わない。** KV に CAS がないため、並行チェックインで lost update が原理的に起きる。1 チェックイン = 1 キーの append-only にすることで AC2 を構造的に保証する
- IP は `CF-Connecting-IP` ヘッダ、無ければ `"unknown"` にフォールバック
- 想定規模は数千件まで。`list` は 1 ページ 1000 件のため cursor ページングを実装する
- 既知の制限: 本番の KV `list` は結果整合性のため、他端末の反映が数十秒遅れる可能性がある。増分そのものは失われない
- 既知の制限: `rl:<ip>` だけは単一キーの read-modify-write のため、並行リクエスト時に上限判定がやや甘くなる。制約の「簡易レートリミット」として許容する

### UI（`src/ui/App.tsx` ほか `src/ui/`、React 19 / ReactCompiler）

レイアウトは縦 1 カラム中央寄せ。上から順に、タイトル → 現在人数の大きな数値（`data-testid="count"`）→ 全幅のチェックインボタン（`data-testid="checkin"`）→ エラー表示領域（`data-testid="error"`）。フッターは `index.html` の `#root` 外にある既存マークアップをそのまま使う。

- 状態は `App` の `useState` のみ。`count: number | null`、`error: string | null`
- 起動時に `GET /api/count`、以後 3 秒間隔でポーリングして共有値を追従する
- **表示値は受信済み count の最大値を採る。** append-only でカウントは単調増加するため、KV の結果整合性で古い値が返っても巻き戻さない
- **送信中もボタンを無効化しない。** 各クリックは独立した `POST` を並列に飛ばし、すべて加算される（現場の連打に耐える）。送信中は補助的なインジケータのみ表示する
- 429 は「混み合っています。少し待ってから押してください」、その他のエラーは汎用文言を `data-testid="error"` に表示。失敗時は count を変更しない
- API 不達時も `count` は「—」等のプレースホルダを出し、骨格（タイトル・ボタン・フッター）は必ず描画する

### 型・ビルド

- `KvLike` に `list(opts): Promise<{ keys: {name:string}[]; list_complete: boolean; cursor?: string }>` を追加する（テンプレの「使うメソッドだけ宣言する」方針を踏襲）

### テスト実行環境（builder が対応）

`wrangler dev` は KV 状態をディスクに永続化する。チェックインキーは TTL なしのため、2 回目以降の `npm test` で残留し絶対値アサーションが壊れる。`playwright.config.ts` の `webServer.command` を、専用 state ディレクトリを削除してから起動する形（`rm -rf .wrangler/test-state && npx wrangler dev --port 8787 --persist-to .wrangler/test-state`）に変更し、各実行を人数 0 から開始させる。この挙動は実装時に実測で確認する。

## 5. テスト計画

全テストが `127.0.0.1` を共有しレートリミット窓を共有するため、**AC4 のテスト冒頭で 5.1 秒待機**して前テストの窓を確実に閉じる。`page.clock` は使わず、サーバ側の時刻に依存する厳密境界（4999ms / 5000ms）は vitest の `vi.useFakeTimers()` で検証し、ブラウザテストは実挙動（20 → 21 → 窓明け再許可）を担当する。

AC4 の 20 回クリックは各回 `page.waitForResponse` で `POST /api/checkin` の応答を待って逐次化する。`rl:<ip>` は単一キーの read-modify-write のため、並行 POST は同じ `n` を読んで undercount し、21 回目の 429 判定が不安定になる。逐次でも 1 回 ~80ms・合計 ~2 秒で 5 秒窓に収まる。表示値の検証は 20 回完了後の `count` = `C+20` で行う（`toHaveText` 待ちで逐次化するとポーリング粒度の分だけ窓を溢れる）。

| AC | テスト | 検証内容 |
| --- | --- | --- |
| AC1 | `tests/app.spec.ts` | context A と context B で同一ページを開く。両方の `count` が同値 `C` であることを確認 → A でボタンを 1 回クリック → A の `count` が `C+1` になることを待つ → B をリロードせずポーリング反映で `count` が `C+1` になることを `expect().toHaveText()` で検証する |
| AC2 | `tests/app.spec.ts` | ① 3 つの独立した context を開き、`Promise.all` で 3 つのクリックを同時発火 → いずれかの画面の `count` が開始値 `C` に対しちょうど `C+3` になることを検証。② `page.route` で最初の `POST /api/checkin` の応答を 1.5 秒遅延させ、応答待ちの間に同じ端末で追加 2 クリック → 最終的に `count` が `C+3` になることを検証（処理中の追加操作も全件加算） |
| AC3 | `tests/app.spec.ts` | クリーンな新規 context（Cookie・localStorage なし）でページを開く。ログインフォーム・氏名入力欄が存在しないことを確認（`input`, `form` が 0 件）→ そのままボタンをクリック → `count` が `C+1` になることを検証。加えて `POST /api/checkin` の送信ヘッダに Cookie・Authorization が含まれないことを `page.on("request")` で確認 |
| AC4 | `tests/app.spec.ts` + `tests/unit/checkin.test.ts` | **ブラウザ**: 5.1 秒待機して窓をリセット → 5 秒窓内に 20 回クリックし `count` が `C+20` になることを検証 → 21 回目をクリックし、`data-testid="error"` に混雑メッセージが出て `count` が `C+20` のままであることを検証 → 5.1 秒待機後にクリックし `count` が `C+21` になることを検証。**ユニット**: `vi.useFakeTimers()` で、窓開始から 4999ms 時点の 21 回目は 429・人数不変、5000ms 時点は 201 を返すことを検証。あわせて 257 バイトのボディで 413、`{"name":"x"}` で 400 を返し、いずれも `GET /api/count` が増えないことを検証 |
| AC5 | `tests/app.spec.ts` | `npm run build` 済みの `public/index.html` を `file://` で開く（API 到達不可）。`h1` に「来場者チェックインカウンター」、フッターに `apps.jozo.beer` へのリンクが表示され、`pageerror` が発生しないことを検証 |

補助ユニットテスト:

- `countCheckins` が 1000 件超で cursor ページングして全件を数えること
- `POST /api/checkin` を `Promise.all` で 10 並列に投げ、`GET /api/count` がちょうど 10 になること（AC2 のサーバ側裏付け）
