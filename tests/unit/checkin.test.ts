import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app, { countCheckins } from "../../src/worker/index";

function fakeKv() {
  const store = new Map<string, string>();
  return {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => {
      store.set(k, v);
    },
    list: async (opts?: { prefix?: string; cursor?: string; limit?: number }) => {
      const prefix = opts?.prefix ?? "";
      const limit = opts?.limit ?? 1000;
      const names = [...store.keys()].filter((name) => name.startsWith(prefix)).sort();
      const start = opts?.cursor ? Number(opts.cursor) : 0;
      const page = names.slice(start, start + limit);
      const next = start + page.length;
      const list_complete = next >= names.length;
      return {
        keys: page.map((name) => ({ name })),
        list_complete,
        cursor: list_complete ? undefined : String(next),
      };
    },
  };
}

function env() {
  return { KV: fakeKv() };
}

describe("GET /api/count", () => {
  it("チェックインが無いとき count 0 を返す", async () => {
    const res = await app.request("/api/count", {}, env());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ count: 0 });
  });
});

describe("POST /api/checkin", () => {
  it("空ボディで 201 と加算後の count を返す", async () => {
    const bindings = env();
    const res = await app.request("/api/checkin", { method: "POST" }, bindings);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ count: 1 });
  });

  it("{} でも 201 を返す", async () => {
    const res = await app.request(
      "/api/checkin",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
      env(),
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ count: 1 });
  });

  it("10 並列でも増分が失われず count が 10 になる", async () => {
    const bindings = env();
    const posts = Array.from({ length: 10 }, () =>
      app.request("/api/checkin", { method: "POST" }, bindings),
    );
    const results = await Promise.all(posts);
    expect(results.map((r) => r.status)).toEqual(Array(10).fill(201));

    const counted = await app.request("/api/count", {}, bindings);
    expect(counted.status).toBe(200);
    expect(await counted.json()).toEqual({ count: 10 });
  });
});

describe("countCheckins のページング", () => {
  it("1000 件超を cursor で全件数え、c: 以外は除外する", async () => {
    const kv = fakeKv();
    for (let i = 0; i < 1001; i++) {
      await kv.put(`c:${String(i).padStart(4, "0")}`, "t");
    }
    await kv.put("health", "x");
    await kv.put("rl:1.1.1.1", '{"start":0,"n":1}');
    expect(await countCheckins(kv)).toBe(1001);
  });
});

describe("POST /api/checkin の保護", () => {
  it("257 バイトのボディは 413 で人数は増えない", async () => {
    const bindings = env();
    const res = await app.request(
      "/api/checkin",
      { method: "POST", body: "x".repeat(257) },
      bindings,
    );
    expect(res.status).toBe(413);
    const counted = await app.request("/api/count", {}, bindings);
    expect(await counted.json()).toEqual({ count: 0 });
  });

  it("未知フィールドの JSON は 400 で人数は増えない", async () => {
    const bindings = env();
    const res = await app.request(
      "/api/checkin",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "x" }),
      },
      bindings,
    );
    expect(res.status).toBe(400);
    const counted = await app.request("/api/count", {}, bindings);
    expect(await counted.json()).toEqual({ count: 0 });
  });

  it("不正な JSON は 400 で人数は増えない", async () => {
    const bindings = env();
    const res = await app.request(
      "/api/checkin",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{not json" },
      bindings,
    );
    expect(res.status).toBe(400);
    const counted = await app.request("/api/count", {}, bindings);
    expect(await counted.json()).toEqual({ count: 0 });
  });
});

describe("POST /api/checkin のレートリミット", () => {
  const start = 1_700_000_000_000;

  beforeEach(() => {
    vi.useFakeTimers({ now: start, toFake: ["Date"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function post(bindings: ReturnType<typeof env>) {
    return app.request("/api/checkin", { method: "POST" }, bindings);
  }

  it("同一 IP は 5 秒窓で 20 回まで成功し 21 回目は 429", async () => {
    const bindings = env();
    for (let i = 0; i < 20; i++) {
      const res = await post(bindings);
      expect(res.status).toBe(201);
    }
    const denied = await post(bindings);
    expect(denied.status).toBe(429);
    const counted = await app.request("/api/count", {}, bindings);
    expect(await counted.json()).toEqual({ count: 20 });
  });

  it("4999ms 経過時点の 21 回目は 429、5000ms で窓が明けて 201", async () => {
    const bindings = env();
    for (let i = 0; i < 20; i++) {
      expect((await post(bindings)).status).toBe(201);
    }

    vi.setSystemTime(start + 4999);
    const stillDenied = await post(bindings);
    expect(stillDenied.status).toBe(429);
    expect(await (await app.request("/api/count", {}, bindings)).json()).toEqual({ count: 20 });

    vi.setSystemTime(start + 5000);
    const allowed = await post(bindings);
    expect(allowed.status).toBe(201);
    expect(await allowed.json()).toEqual({ count: 21 });
  });
});
