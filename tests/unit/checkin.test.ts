import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app, { countCheckins } from "../../src/worker/index";
import { env, fakeKv } from "./fake-kv";

async function createRoom(bindings: ReturnType<typeof env>, name = "会場") {
  const res = await app.request(
    "/api/rooms",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    },
    bindings,
  );
  const body = (await res.json()) as { id: string };
  return body.id;
}

async function checkin(bindings: ReturnType<typeof env>, id: string, init?: RequestInit) {
  return app.request(`/api/rooms/${id}/checkin`, { method: "POST", ...init }, bindings);
}

describe("GET /api/rooms/:id", () => {
  it("会場作成直後の count は 0", async () => {
    const bindings = env();
    const id = await createRoom(bindings);
    const res = await app.request(`/api/rooms/${id}`, {}, bindings);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ count: 0 });
  });
});

describe("POST /api/rooms/:id/checkin", () => {
  it("空ボディで 201 と加算後の count を返す", async () => {
    const bindings = env();
    const id = await createRoom(bindings);
    const res = await checkin(bindings, id);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ count: 1 });
  });

  it("{} でも 201 を返す", async () => {
    const bindings = env();
    const id = await createRoom(bindings);
    const res = await checkin(bindings, id, {
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ count: 1 });
  });

  it("同一会場への 10 並列でも増分が失われず count が 10 になる", async () => {
    const bindings = env();
    const id = await createRoom(bindings);
    const posts = Array.from({ length: 10 }, () => checkin(bindings, id));
    const results = await Promise.all(posts);
    expect(results.map((r) => r.status)).toEqual(Array(10).fill(201));

    const counted = await app.request(`/api/rooms/${id}`, {}, bindings);
    expect(counted.status).toBe(200);
    expect(await counted.json()).toMatchObject({ count: 10 });
  });

  it("会場 A に 3 回、会場 B に 1 回チェックインするとそれぞれ独立して数える", async () => {
    const bindings = env();
    const idA = await createRoom(bindings, "会場A");
    const idB = await createRoom(bindings, "会場B");
    for (let i = 0; i < 3; i++) {
      expect((await checkin(bindings, idA)).status).toBe(201);
    }
    expect((await checkin(bindings, idB)).status).toBe(201);

    expect(await (await app.request(`/api/rooms/${idA}`, {}, bindings)).json()).toMatchObject({ count: 3 });
    expect(await (await app.request(`/api/rooms/${idB}`, {}, bindings)).json()).toMatchObject({ count: 1 });
  });
});

describe("countCheckins のページング", () => {
  it("1001 件を cursor で全件数え、他会場・r:・rl:・health を除外する", async () => {
    const kv = fakeKv();
    const roomId = "aabbccdd";
    for (let i = 0; i < 1001; i++) {
      await kv.put(`c:${roomId}:${String(i).padStart(4, "0")}`, "t");
    }
    await kv.put("c:ffffffff:0", "t");
    await kv.put("r:aabbccdd", '{"name":"x","createdAt":"t"}');
    await kv.put("rl:1.1.1.1", '{"start":0,"n":1}');
    await kv.put("health", "x");
    expect(await countCheckins(kv, roomId)).toBe(1001);
  });
});

describe("POST /api/rooms/:id/checkin の保護", () => {
  it("257 バイトのボディは 413 で人数は増えない", async () => {
    const bindings = env();
    const id = await createRoom(bindings);
    const res = await checkin(bindings, id, { body: "x".repeat(257) });
    expect(res.status).toBe(413);
    const counted = await app.request(`/api/rooms/${id}`, {}, bindings);
    expect(await counted.json()).toMatchObject({ count: 0 });
  });

  it("未知フィールドの JSON は 400 で人数は増えない", async () => {
    const bindings = env();
    const id = await createRoom(bindings);
    const res = await checkin(bindings, id, {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    });
    expect(res.status).toBe(400);
    const counted = await app.request(`/api/rooms/${id}`, {}, bindings);
    expect(await counted.json()).toMatchObject({ count: 0 });
  });

  it("不正な JSON は 400 で人数は増えない", async () => {
    const bindings = env();
    const id = await createRoom(bindings);
    const res = await checkin(bindings, id, {
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    const counted = await app.request(`/api/rooms/${id}`, {}, bindings);
    expect(await counted.json()).toMatchObject({ count: 0 });
  });
});

describe("POST /api/rooms/:id/checkin のレートリミット", () => {
  const start = 1_700_000_000_000;

  beforeEach(() => {
    vi.useFakeTimers({ now: start, toFake: ["Date"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("同一 IP は 5 秒窓で 20 回まで成功し 21 回目は 429", async () => {
    const bindings = env();
    const id = await createRoom(bindings);
    for (let i = 0; i < 20; i++) {
      const res = await checkin(bindings, id);
      expect(res.status).toBe(201);
    }
    const denied = await checkin(bindings, id);
    expect(denied.status).toBe(429);
    const counted = await app.request(`/api/rooms/${id}`, {}, bindings);
    expect(await counted.json()).toMatchObject({ count: 20 });
  });

  it("4999ms 経過時点の 21 回目は 429、5000ms で窓が明けて 201", async () => {
    const bindings = env();
    const id = await createRoom(bindings);
    for (let i = 0; i < 20; i++) {
      expect((await checkin(bindings, id)).status).toBe(201);
    }

    vi.setSystemTime(start + 4999);
    const stillDenied = await checkin(bindings, id);
    expect(stillDenied.status).toBe(429);
    expect(await (await app.request(`/api/rooms/${id}`, {}, bindings)).json()).toMatchObject({ count: 20 });

    vi.setSystemTime(start + 5000);
    const allowed = await checkin(bindings, id);
    expect(allowed.status).toBe(201);
    expect(await allowed.json()).toEqual({ count: 21 });
  });
});
