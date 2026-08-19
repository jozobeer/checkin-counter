import { Hono } from "hono";

// workers-types 非依存方針（DOM lib と衝突するため）の最小 KV 型。使うメソッドだけ宣言する
export interface KvLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  list(opts?: { prefix?: string; cursor?: string; limit?: number }): Promise<{
    keys: { name: string }[];
    list_complete: boolean;
    cursor?: string;
  }>;
}

type RateWindow = { start: number; n: number };

const CHECKIN_PREFIX = "c:";
const RATE_WINDOW_MS = 5000;
const RATE_LIMIT = 20;
const MAX_BODY_BYTES = 256;

const app = new Hono<{ Bindings: { KV: KvLike } }>();

// 機械検証と監視が依存する。KV への書込→読出を実往復して 200 を返す。壊さないこと
app.get("/api/health", async (c) => {
  const stamp = String(Date.now());
  await c.env.KV.put("health", stamp, { expirationTtl: 60 });
  const read = await c.env.KV.get("health");
  return read === stamp ? c.json({ ok: true }) : c.json({ ok: false }, 500);
});

app.get("/api/count", async (c) => {
  const count = await countCheckins(c.env.KV);
  return c.json({ count });
});

app.post("/api/checkin", async (c) => {
  const invalid = await validateBody(c.req.raw);
  if (invalid) return c.json({ error: true }, invalid);

  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  const allowed = await checkRateLimit(c.env.KV, ip, Date.now());
  if (!allowed) return c.json({ error: true }, 429);

  await c.env.KV.put(`${CHECKIN_PREFIX}${crypto.randomUUID()}`, new Date().toISOString());
  const count = await countCheckins(c.env.KV);
  return c.json({ count }, 201);
});

export async function countCheckins(kv: KvLike): Promise<number> {
  let total = 0;
  let cursor: string | undefined;
  for (;;) {
    const page = await kv.list({ prefix: CHECKIN_PREFIX, cursor });
    total += page.keys.length;
    if (page.list_complete) return total;
    cursor = page.cursor;
    if (!cursor) return total;
  }
}

async function checkRateLimit(kv: KvLike, ip: string, now: number): Promise<boolean> {
  const key = `rl:${ip}`;
  const current = await readWindow(kv, key, now);
  if (current.n + 1 > RATE_LIMIT) return false;
  const next = { start: current.start, n: current.n + 1 };
  await kv.put(key, JSON.stringify(next), { expirationTtl: 60 });
  return true;
}

async function readWindow(kv: KvLike, key: string, now: number): Promise<RateWindow> {
  const raw = await kv.get(key);
  if (!raw) return { start: now, n: 0 };
  const parsed = parseWindow(raw);
  if (!parsed || now - parsed.start >= RATE_WINDOW_MS) return { start: now, n: 0 };
  return parsed;
}

function parseWindow(raw: string): RateWindow | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const start = (parsed as { start?: unknown }).start;
    const n = (parsed as { n?: unknown }).n;
    if (typeof start !== "number" || typeof n !== "number") return null;
    return { start, n };
  } catch {
    return null;
  }
}

async function validateBody(req: Request): Promise<400 | 413 | null> {
  const declared = req.headers.get("content-length");
  if (declared !== null && Number(declared) > MAX_BODY_BYTES) return 413;

  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) return 413;
  if (text.trim() === "") return null;
  return parseAllowedJson(text);
}

function parseAllowedJson(text: string): 400 | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return 400;
  }
  return isEmptyObject(parsed) ? null : 400;
}

function isEmptyObject(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
}

export default app;
