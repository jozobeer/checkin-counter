export function fakeKv() {
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

export function env() {
  return { KV: fakeKv() };
}
