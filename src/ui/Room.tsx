import { useEffect, useState } from "react";

const POLL_MS = 3000;
const BUSY_MESSAGE = "混み合っています。少し待ってから押してください";
const FAIL_MESSAGE = "チェックインできませんでした。もう一度お試しください";
const NOTFOUND_MESSAGE = "このカウンターは見つかりませんでした";
const COPIED_MESSAGE = "コピーしました";
const COPY_FAIL_MESSAGE = "コピーできませんでした。URL を選択してコピーしてください";

function parseRoom(data: unknown): { name: string; count: number } | null {
  if (typeof data !== "object" || data === null) return null;
  const name = (data as { name?: unknown }).name;
  const count = (data as { count?: unknown }).count;
  if (typeof name !== "string") return null;
  if (typeof count !== "number" || !Number.isFinite(count)) return null;
  return { name, count };
}

function parseCount(data: unknown): number | null {
  if (typeof data !== "object" || data === null) return null;
  const count = (data as { count?: unknown }).count;
  return typeof count === "number" && Number.isFinite(count) ? count : null;
}

function takeLatest(prev: number | null, next: number): number {
  return prev === null ? next : Math.max(prev, next);
}

export function Room({ roomId }: { roomId: string }) {
  const [name, setName] = useState("");
  const [count, setCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inFlight, setInFlight] = useState(0);
  const [notFound, setNotFound] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const shareUrl = `${location.origin}/#/r/${roomId}`;

  useEffect(() => {
    let cancelled = false;
    let stopped = false;

    const pull = async () => {
      try {
        const res = await fetch(`/api/rooms/${encodeURIComponent(roomId)}`);
        if (cancelled) return;
        if (res.status === 404) {
          setNotFound(true);
          stopped = true;
          return;
        }
        if (!res.ok) return;
        const parsed = parseRoom(await res.json());
        if (cancelled || parsed === null) return;
        setName(parsed.name);
        setCount((prev) => takeLatest(prev, parsed.count));
      } catch {
        // file:// や API 停止でも UI 骨格は描画し続ける。404 とは混同しない
      }
    };

    void pull();
    const id = setInterval(() => {
      if (stopped) {
        clearInterval(id);
        return;
      }
      void pull();
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [roomId]);

  const checkin = async () => {
    setError(null);
    setInFlight((n) => n + 1);
    try {
      const res = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/checkin`, { method: "POST" });
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

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(COPIED_MESSAGE);
    } catch {
      setCopied(COPY_FAIL_MESSAGE);
    }
  };

  if (notFound) {
    return (
      <p className="error" data-testid="notfound">
        {NOTFOUND_MESSAGE}
      </p>
    );
  }

  return (
    <>
      <p className="room-name" data-testid="room-name">
        {name}
      </p>
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
      <div className="share">
        <p className="share-url" data-testid="share-url">
          {shareUrl}
        </p>
        <button type="button" className="copy" data-testid="copy" onClick={() => void copy()}>
          コピー
        </button>
        <p className="copied" data-testid="copied">
          {copied ?? ""}
        </p>
      </div>
    </>
  );
}
