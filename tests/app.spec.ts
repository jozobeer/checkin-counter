import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test, type Page } from "@playwright/test";

// 雛形スモーク。builder は受け入れ条件ごとの機能テストをこのファイルに追記する（雛形は削除しない）
test("ページがロードできてページエラーがない", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto("/");
  await expect(page.locator("body")).toBeVisible();
  expect(errors).toEqual([]);
});

test("GET /api/health が 200 で ok:true を返す", async ({ request }) => {
  const res = await request.get("/api/health");
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});

async function visibleCount(page: Page): Promise<number> {
  const loc = page.getByTestId("count");
  await expect(loc).not.toHaveText("—");
  return Number(await loc.innerText());
}

async function createRoom(page: Page, name: string) {
  await page.goto("/");
  await page.getByTestId("room-name-input").fill(name);
  await page.getByTestId("create").click();
  await expect(page).toHaveURL(/#\/r\/[0-9a-f]{8}$/);
}

test("AC1: ルートには会場名フォームだけがあり人数とチェックインボタンは無い", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("room-name-input")).toBeVisible();
  await expect(page.getByTestId("create")).toBeVisible();
  await expect(page.getByTestId("count")).toHaveCount(0);
  await expect(page.getByTestId("checkin")).toHaveCount(0);
});

test("AC2: 会場を作ると共有URLに遷移し画面上でコピーできる", async ({ browser }) => {
  const context = await browser.newContext({ permissions: ["clipboard-write"] });
  const page = await context.newPage();
  await createRoom(page, "夏祭り");
  const id = page.url().match(/#\/r\/([0-9a-f]{8})$/)![1];
  await expect(page.getByTestId("room-name")).toHaveText("夏祭り");
  const origin = new URL(page.url()).origin;
  await expect(page.getByTestId("share-url")).toHaveText(`${origin}/#/r/${id}`);
  await page.getByTestId("copy").click();
  await expect(page.getByTestId("copied")).toHaveText("コピーしました");
  await context.close();
});

test("AC3: 共有URLを別セッションで開くと同じ会場名と同じ人数が見える", async ({ browser }) => {
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();

  await createRoom(pageA, "本祭");
  await expect(pageA.getByTestId("room-name")).toHaveText("本祭");
  const startA = await visibleCount(pageA);

  await pageB.goto(pageA.url());
  await expect(pageB.getByTestId("room-name")).toHaveText("本祭");
  await expect(pageB.getByTestId("count")).toHaveText(String(startA));

  await pageA.getByTestId("checkin").click();
  await expect(pageA.getByTestId("count")).toHaveText(String(startA + 1));
  await expect(pageB.getByTestId("count")).toHaveText(String(startA + 1), { timeout: 10_000 });

  await contextA.close();
  await contextB.close();
});

test("AC4: 別々に作った2つのカウンターは互いに影響しない", async ({ page, context }) => {
  await createRoom(page, "会場X");
  await page.getByTestId("checkin").click();
  await expect(page.getByTestId("count")).toHaveText("1");

  const pageY = await context.newPage();
  await createRoom(pageY, "会場Y");
  await expect(pageY.getByTestId("count")).toHaveText("0");
  await new Promise((resolve) => setTimeout(resolve, 6500));
  await expect(pageY.getByTestId("count")).toHaveText("0");
  await expect(page.getByTestId("count")).toHaveText("1");
});

test("AC5: 存在しないIDの共有URLは見つからない旨を表示し人数を出さない", async ({ page }) => {
  await page.goto("/#/r/00000000");
  await expect(page.getByTestId("notfound")).toHaveText("このカウンターは見つかりませんでした");
  await expect(page.getByTestId("count")).toHaveCount(0);
  await expect(page.getByTestId("checkin")).toHaveCount(0);
});

test("同一IPは5秒間に20回まで成功し、21回目は拒否されて人数は増えない", async ({ page }) => {
  test.setTimeout(60_000);
  await new Promise((resolve) => setTimeout(resolve, 5100));

  await createRoom(page, "レート会場");
  const start = await visibleCount(page);

  for (let i = 0; i < 20; i++) {
    const wait = page.waitForResponse((res) => res.url().includes("/checkin") && res.request().method() === "POST");
    await page.getByTestId("checkin").click();
    await wait;
  }
  await expect(page.getByTestId("count")).toHaveText(String(start + 20));

  const wait21 = page.waitForResponse((res) => res.url().includes("/checkin") && res.request().method() === "POST");
  await page.getByTestId("checkin").click();
  await wait21;
  await expect(page.getByTestId("error")).toHaveText("混み合っています。少し待ってから押してください");
  await expect(page.getByTestId("count")).toHaveText(String(start + 20));

  await new Promise((resolve) => setTimeout(resolve, 5100));
  await page.getByTestId("checkin").click();
  await expect(page.getByTestId("count")).toHaveText(String(start + 21));
});

test("応答待ち中の連打が全部加算される", async ({ page }) => {
  await createRoom(page, "連打会場");
  const delayedStart = await visibleCount(page);
  let delayed = false;
  await page.route("**/api/rooms/**/checkin", async (route) => {
    if (route.request().method() === "POST" && !delayed) {
      delayed = true;
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    await route.continue();
  });

  await page.getByTestId("checkin").click();
  await page.getByTestId("checkin").click();
  await page.getByTestId("checkin").click();
  await expect(page.getByTestId("count")).toHaveText(String(delayedStart + 3), { timeout: 10_000 });
});

test("氏名・ログインなしでチェックインできる", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const checkinHeaders: Record<string, string>[] = [];
  page.on("request", (req) => {
    if (req.method() === "POST" && req.url().includes("/checkin")) {
      checkinHeaders.push(req.headers());
    }
  });

  await createRoom(page, "匿名会場");
  const start = await visibleCount(page);
  await page.getByTestId("checkin").click();
  await expect(page.getByTestId("count")).toHaveText(String(start + 1));

  expect(checkinHeaders.length).toBeGreaterThan(0);
  for (const headers of checkinHeaders) {
    expect(headers.cookie).toBeFalsy();
    expect(headers.authorization).toBeFalsy();
  }

  await context.close();
});

test("file:// でもタイトルとフッターが表示され pageerror がない", async ({ browser }) => {
  const html = pathToFileURL(path.resolve("public/index.html")).href;
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(html);
  await expect(page.locator("h1")).toHaveText("来場者チェックインカウンター");
  await expect(page.locator("footer a")).toHaveAttribute("href", "https://apps.jozo.beer");
  await expect(page.locator("footer a")).toHaveText("apps.jozo.beer");
  expect(errors).toEqual([]);
  await page.close();
});

function jsonLdNodes(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) {
    return data.filter((node): node is Record<string, unknown> => !!node && typeof node === "object");
  }
  if (!data || typeof data !== "object") return [];
  const obj = data as Record<string, unknown>;
  if (Array.isArray(obj["@graph"])) {
    return obj["@graph"].filter((node): node is Record<string, unknown> => !!node && typeof node === "object");
  }
  return [obj];
}

function isWebApplication(node: Record<string, unknown>): boolean {
  const type = node["@type"];
  return type === "WebApplication" || (Array.isArray(type) && type.includes("WebApplication"));
}

test("SEO: meta description があり content が空でない", async ({ page }) => {
  await page.goto("/");
  const content = await page.locator('meta[name="description"]').getAttribute("content");
  expect(content?.trim()).toBeTruthy();
});

test("SEO: JSON-LD に WebApplication の必須フィールドがある", async ({ page }) => {
  await page.goto("/");
  const raw = await page.locator('script[type="application/ld+json"]').textContent();
  expect(raw?.trim()).toBeTruthy();
  const app = jsonLdNodes(JSON.parse(raw!)).find(isWebApplication);
  expect(app).toBeTruthy();
  expect(typeof app!.name).toBe("string");
  expect(String(app!.name).trim()).not.toBe("");
  expect(typeof app!.description).toBe("string");
  expect(String(app!.description).trim()).not.toBe("");
  expect(typeof app!.url).toBe("string");
  expect(String(app!.url).trim()).not.toBe("");
  expect(typeof app!.applicationCategory).toBe("string");
  expect(String(app!.applicationCategory).trim()).not.toBe("");
  const offers = app!.offers as { price?: unknown } | undefined;
  expect(offers?.price).toBe("0");
});

test("SEO: 使い方と FAQ の見出しが DOM にある", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "使い方" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "FAQ" })).toBeVisible();
});
