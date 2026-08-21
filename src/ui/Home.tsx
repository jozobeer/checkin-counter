import { useState, type FormEvent } from "react";

const EMPTY_MESSAGE = "会場名を入力してください";
const BUSY_MESSAGE = "混み合っています。少し待ってから作成してください";
const FAIL_MESSAGE = "カウンターを作成できませんでした。もう一度お試しください";

function parseRoomId(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const id = (data as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

export function Home() {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [inFlight, setInFlight] = useState(false);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError(EMPTY_MESSAGE);
      return;
    }
    if (inFlight) return;
    setError(null);
    setInFlight(true);
    try {
      const res = await fetch("/api/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });
      if (res.status === 429) {
        setError(BUSY_MESSAGE);
        return;
      }
      if (!res.ok) {
        setError(FAIL_MESSAGE);
        return;
      }
      const id = parseRoomId(await res.json());
      if (!id) {
        setError(FAIL_MESSAGE);
        return;
      }
      location.hash = "#/r/" + id;
    } catch {
      setError(FAIL_MESSAGE);
    } finally {
      setInFlight(false);
    }
  };

  return (
    <>
      <form className="room-form" onSubmit={(event) => void create(event)}>
        <label className="room-label">
          会場名
          <input
            type="text"
            name="name"
            maxLength={40}
            value={name}
            onChange={(event) => setName(event.target.value)}
            data-testid="room-name-input"
            autoComplete="off"
          />
        </label>
        <button type="submit" className="checkin" data-testid="create">
          作成
        </button>
      </form>
      <p className="error" data-testid="create-error">
        {error ?? ""}
      </p>
      <div className="guide">
        <section aria-labelledby="how-to-heading">
          <h2 id="how-to-heading">使い方</h2>
          <ol>
            <li>会場名を入れてカウンターを作ります。</li>
            <li>表示された共有 URL を、スタッフの端末で開きます。</li>
            <li>「チェックイン」を押すと、その会場の人数が 1 増えます。ログインや氏名の入力はありません。</li>
          </ol>
        </section>
        <section aria-labelledby="faq-heading">
          <h2 id="faq-heading">FAQ</h2>
          <dl>
            <dt>他のイベントの人数は見えませんか？</dt>
            <dd>見えません。共有 URL を知っている端末だけが、同じ会場の人数を見ます。</dd>
            <dt>「混み合っています」と出たら？</dt>
            <dd>同じ回線から短時間に操作しすぎています。少し待ってからもう一度試してください。このときは人数は増えていません。</dd>
            <dt>数字がすぐ変わらないことがありますか？</dt>
            <dd>他の端末への反映が遅れることがあります。増えた分が消えることはありません。</dd>
          </dl>
        </section>
      </div>
    </>
  );
}
