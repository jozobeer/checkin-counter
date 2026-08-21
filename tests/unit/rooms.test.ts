import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../src/worker/index";
import { env } from "./fake-kv";

async function createRoom(bindings: ReturnType<typeof env>, name = "会場A") {
  return app.request(
    "/api/rooms",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    },
    bindings,
  );
}

async function roomKeyCount(kv: ReturnType<typeof env>["KV"]): Promise<number> {
  const listed = await kv.list({ prefix: "r:" });
  return listed.keys.length;
}

describe("POST /api/rooms", () => {
  it("201 で {id, name} を返し、id は 8 桁 16 進、name は trim 済み", async () => {
    const res = await createRoom(env(), "  夏祭り  ");
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; name: string };
    expect(body.id).toMatch(/^[0-9a-f]{8}$/);
    expect(body.name).toBe("夏祭り");
  });
});

describe("GET /api/rooms/:id", () => {
  it("作成直後は {id, name, count: 0} を返す", async () => {
    const bindings = env();
    const created = await createRoom(bindings, "本祭");
    const { id, name } = (await created.json()) as { id: string; name: string };

    const res = await app.request(`/api/rooms/${id}`, {}, bindings);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id, name, count: 0 });
  });

  it(":id が形式不正なら 404", async () => {
    const bindings = env();
    const z = await app.request("/api/rooms/zzzzzzzz", {}, bindings);
    expect(z.status).toBe(404);
    const short = await app.request("/api/rooms/0123456", {}, bindings);
    expect(short.status).toBe(404);
  });
});

describe("POST /api/rooms/:id/checkin", () => {
  it("存在しない会場へは 404 で c: 配下にキーを作らない", async () => {
    const bindings = env();
    const res = await app.request("/api/rooms/abcd1234/checkin", { method: "POST" }, bindings);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: true });
    const listed = await bindings.KV.list({ prefix: "c:" });
    expect(listed.keys).toEqual([]);
  });
});

describe("POST /api/rooms の保護", () => {
  it("257 バイトのボディは 413 で会場は作られない", async () => {
    const bindings = env();
    const res = await app.request("/api/rooms", { method: "POST", body: "x".repeat(257) }, bindings);
    expect(res.status).toBe(413);
    expect(await roomKeyCount(bindings.KV)).toBe(0);
  });

  it("未知フィールドの JSON は 400 で会場は作られない", async () => {
    const bindings = env();
    const res = await app.request(
      "/api/rooms",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "x", extra: 1 }),
      },
      bindings,
    );
    expect(res.status).toBe(400);
    expect(await roomKeyCount(bindings.KV)).toBe(0);
  });

  it("不正な JSON は 400 で会場は作られない", async () => {
    const bindings = env();
    const res = await app.request(
      "/api/rooms",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{not json" },
      bindings,
    );
    expect(res.status).toBe(400);
    expect(await roomKeyCount(bindings.KV)).toBe(0);
  });

  it("空の会場名は 400 で会場は作られない", async () => {
    const bindings = env();
    const res = await app.request(
      "/api/rooms",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "   " }),
      },
      bindings,
    );
    expect(res.status).toBe(400);
    expect(await roomKeyCount(bindings.KV)).toBe(0);
  });

  it("41 文字の会場名は 400 で会場は作られない", async () => {
    const bindings = env();
    const res = await app.request(
      "/api/rooms",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "あ".repeat(41) }),
      },
      bindings,
    );
    expect(res.status).toBe(400);
    expect(await roomKeyCount(bindings.KV)).toBe(0);
  });
});

describe("POST /api/rooms のレートリミット", () => {
  const start = 1_700_000_000_000;

  beforeEach(() => {
    vi.useFakeTimers({ now: start, toFake: ["Date"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("同一 IP は 60 秒窓で 20 回まで成功し 21 回目は 429", async () => {
    const bindings = env();
    for (let i = 0; i < 20; i++) {
      const res = await createRoom(bindings, `会場${i}`);
      expect(res.status).toBe(201);
    }
    const denied = await createRoom(bindings, "会場21");
    expect(denied.status).toBe(429);
    expect(await roomKeyCount(bindings.KV)).toBe(20);
  });

  it("59999ms 経過時点の 21 回目は 429、60000ms で窓が明けて 201", async () => {
    const bindings = env();
    for (let i = 0; i < 20; i++) {
      expect((await createRoom(bindings, `会場${i}`)).status).toBe(201);
    }

    vi.setSystemTime(start + 59999);
    const stillDenied = await createRoom(bindings, "まだ拒否");
    expect(stillDenied.status).toBe(429);
    expect(await roomKeyCount(bindings.KV)).toBe(20);

    vi.setSystemTime(start + 60000);
    const allowed = await createRoom(bindings, "再開");
    expect(allowed.status).toBe(201);
    expect(await roomKeyCount(bindings.KV)).toBe(21);
  });
});

describe("POST /api/rooms の ID 衝突", () => {
  it("get が常に衝突するとき 3 回再生成のうえ 500", async () => {
    const kv = {
      get: async () => "x",
      put: async () => {},
      list: async () => ({ keys: [] as { name: string }[], list_complete: true, cursor: undefined }),
    };
    const res = await createRoom({ KV: kv }, "衝突会場");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: true });
  });
});
