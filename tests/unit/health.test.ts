import { describe, expect, it } from "vitest";
import app from "../../src/worker/index";

function fakeKv() {
  const store = new Map<string, string>();
  return {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => {
      store.set(k, v);
    },
    list: async () => ({ keys: [] as { name: string }[], list_complete: true }),
  };
}

describe("GET /api/health", () => {
  it("KV 往復に成功すると 200 と ok:true を返す", async () => {
    const res = await app.request("/api/health", {}, { KV: fakeKv() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
