import { useEffect, useState } from "react";
import "./app.css";

const POLL_MS = 3000;
const BUSY_MESSAGE = "混み合っています。少し待ってから押してください";
const FAIL_MESSAGE = "チェックインできませんでした。もう一度お試しください";

function parseCount(data: unknown): number | null {
  if (typeof data !== "object" || data === null) return null;
  const count = (data as { count?: unknown }).count;
  return typeof count === "number" && Number.isFinite(count) ? count : null;
}

function takeLatest(prev: number | null, next: number): number {
  return prev === null ? next : Math.max(prev, next);
}

export function App() {
  const [count, setCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inFlight, setInFlight] = useState(0);

  useEffect(() => {
    let cancelled = false;

    const pull = async () => {
      try {
        const res = await fetch("/api/count");
        if (!res.ok) return;
        const next = parseCount(await res.json());
        if (cancelled || next === null) return;
        setCount((prev) => takeLatest(prev, next));
      } catch {
        // file:// や API 停止でも UI 骨格は描画し続ける
      }
    };

    void pull();
    const id = setInterval(() => void pull(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const checkin = async () => {
    setError(null);
    setInFlight((n) => n + 1);
    try {
      const res = await fetch("/api/checkin", { method: "POST" });
      if (res.status === 429) {
        setError(BUSY_MESSAGE);
        return;
      }
      if (!res.ok) {
        setError(FAIL_MESSAGE);
        return;
      }
      const next = parseCount(await res.json());
      if (next === null) {
        setError(FAIL_MESSAGE);
        return;
      }
      setCount((prev) => takeLatest(prev, next));
    } catch {
      setError(FAIL_MESSAGE);
    } finally {
      setInFlight((n) => n - 1);
    }
  };

  return (
    <main className="wrap">
      <h1>来場者チェックインカウンター</h1>
      <p className="count" data-testid="count">
        {count === null ? "—" : String(count)}
      </p>
      <button type="button" className="checkin" data-testid="checkin" onClick={() => void checkin()}>
        チェックイン
      </button>
      <p className="pending">{inFlight > 0 ? "送信中…" : ""}</p>
      <p className="error" data-testid="error">
        {error ?? ""}
      </p>
    </main>
  );
}
