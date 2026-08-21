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

const ROOM_ID_RE = /^[0-9a-f]{8}$/;
const ROOM_NAME_MAX = 40;
const RATE_LIMIT = 20;
const CHECKIN_WINDOW_MS = 5000;
const ROOM_WINDOW_MS = 60_000;
const CHECKIN_RATE_TTL = 60;
const ROOM_RATE_TTL = 120;
const MAX_BODY_BYTES = 256;
const ID_REGENERATIONS = 3;

const app = new Hono<{ Bindings: { KV: KvLike } }>();

// 機械検証と監視が依存する。KV への書込→読出を実往復して 200 を返す。壊さないこと
app.get("/api/health", async (c) => {
  const stamp = String(Date.now());
  await c.env.KV.put("health", stamp, { expirationTtl: 60 });
  const read = await c.env.KV.get("health");
  return read === stamp ? c.json({ ok: true }) : c.json({ ok: false }, 500);
});

app.post("/api/rooms", async (c) => {
  const parsed = await parseRoomBody(c.req.raw);
  if (parsed === 400 || parsed === 413) return c.json({ error: true }, parsed);

  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  const allowed = await checkRateLimit(c.env.KV, `rlr:${ip}`, Date.now(), ROOM_WINDOW_MS, RATE_LIMIT, ROOM_RATE_TTL);
  if (!allowed) return c.json({ error: true }, 429);

  const id = await allocateRoomId(c.env.KV);
  if (!id) return c.json({ error: true }, 500);

  await c.env.KV.put(`r:${id}`, JSON.stringify({ name: parsed.name, createdAt: new Date().toISOString() }));
  return c.json({ id, name: parsed.name }, 201);
});

app.get("/api/rooms/:id", async (c) => {
  const id = c.req.param("id");
  if (!ROOM_ID_RE.test(id)) return c.json({ error: true }, 404);

  const room = await readRoom(c.env.KV, id);
  if (!room) return c.json({ error: true }, 404);

  const count = await countCheckins(c.env.KV, id);
  return c.json({ id, name: room.name, count });
});

app.post("/api/rooms/:id/checkin", async (c) => {
  const invalid = await validateCheckinBody(c.req.raw);
  if (invalid) return c.json({ error: true }, invalid);

  const id = c.req.param("id");
  if (!ROOM_ID_RE.test(id)) return c.json({ error: true }, 404);
  if (!(await readRoom(c.env.KV, id))) return c.json({ error: true }, 404);

  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  const allowed = await checkRateLimit(c.env.KV, `rl:${ip}`, Date.now(), CHECKIN_WINDOW_MS, RATE_LIMIT, CHECKIN_RATE_TTL);
  if (!allowed) return c.json({ error: true }, 429);

  await c.env.KV.put(`c:${id}:${crypto.randomUUID()}`, new Date().toISOString());
  const count = await countCheckins(c.env.KV, id);
  return c.json({ count }, 201);
});

export async function countCheckins(kv: KvLike, roomId: string): Promise<number> {
  let total = 0;
  let cursor: string | undefined;
  for (;;) {
    const page = await kv.list({ prefix: `c:${roomId}:`, cursor });
    total += page.keys.length;
    if (page.list_complete) return total;
    cursor = page.cursor;
    if (!cursor) return total;
  }
}

async function allocateRoomId(kv: KvLike): Promise<string | null> {
  for (let n = 0; n <= ID_REGENERATIONS; n++) {
    const id = crypto.randomUUID().slice(0, 8);
    if (!(await kv.get(`r:${id}`))) return id;
  }
  return null;
}

async function readRoom(kv: KvLike, id: string): Promise<{ name: string } | null> {
  const raw = await kv.get(`r:${id}`);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const name = (parsed as { name?: unknown }).name;
    return typeof name === "string" ? { name } : null;
  } catch {
    return null;
  }
}

async function checkRateLimit(
  kv: KvLike,
  key: string,
  now: number,
  windowMs: number,
  limit: number,
  expirationTtl: number,
): Promise<boolean> {
  const current = await readWindow(kv, key, now, windowMs);
  if (current.n + 1 > limit) return false;
  const next = { start: current.start, n: current.n + 1 };
  await kv.put(key, JSON.stringify(next), { expirationTtl });
  return true;
}

async function readWindow(kv: KvLike, key: string, now: number, windowMs: number): Promise<RateWindow> {
  const raw = await kv.get(key);
  if (!raw) return { start: now, n: 0 };
  const parsed = parseWindow(raw);
  if (!parsed || now - parsed.start >= windowMs) return { start: now, n: 0 };
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

async function parseRoomBody(req: Request): Promise<{ name: string } | 400 | 413> {
  const text = await readBodyText(req);
  if (text === 413) return 413;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return 400;
  }
  return parseRoomName(parsed);
}

function parseRoomName(parsed: unknown): { name: string } | 400 {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return 400;
  const keys = Object.keys(parsed);
  if (keys.length !== 1 || keys[0] !== "name") return 400;
  const name = (parsed as { name: unknown }).name;
  if (typeof name !== "string") return 400;
  const trimmed = name.trim();
  const len = [...trimmed].length;
  if (len < 1 || len > ROOM_NAME_MAX) return 400;
  return { name: trimmed };
}

async function validateCheckinBody(req: Request): Promise<400 | 413 | null> {
  const text = await readBodyText(req);
  if (text === 413) return 413;
  if (text.trim() === "") return null;
  return parseEmptyJson(text);
}

async function readBodyText(req: Request): Promise<string | 413> {
  const declared = req.headers.get("content-length");
  if (declared !== null && Number(declared) > MAX_BODY_BYTES) return 413;
  const text = await req.text();
  return text.length > MAX_BODY_BYTES ? 413 : text;
}

function parseEmptyJson(text: string): 400 | null {
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
