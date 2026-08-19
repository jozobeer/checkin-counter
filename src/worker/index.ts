import { Hono } from "hono";

// workers-types 非依存方針（DOM lib と衝突するため）の最小 KV 型。使うメソッドだけ宣言する
export interface KvLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
}

const app = new Hono<{ Bindings: { KV: KvLike } }>();

// 機械検証と監視が依存する。KV への書込→読出を実往復して 200 を返す。壊さないこと
app.get("/api/health", async (c) => {
  const stamp = String(Date.now());
  await c.env.KV.put("health", stamp, { expirationTtl: 60 });
  const read = await c.env.KV.get("health");
  return read === stamp ? c.json({ ok: true }) : c.json({ ok: false }, 500);
});

export default app;
