import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

// ========================= Types & Consts =========================
type Duration = 3 | 5 | 10 | 30 | 60;
type Phase = "idle" | "ready" | "active" | "finished";
type View = "game" | "rankings";
type RankEntry = { name: string; score: number; date: string };
const DURATIONS: Duration[] = [3, 5, 10, 30, 60];
const LS_KEY = (d: Duration) => `taprank_${d}`;

// haptics helper
const vibrate = (p: number | number[]) => ("vibrate" in navigator ? (navigator as any).vibrate(p) : undefined);

// ========================= WebAudio (beep / explosion) =========================
class SoundFX {
  ctx: AudioContext | null = null;
  master: GainNode | null = null;

  ensureCtx() {
    if (!this.ctx) {
      const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext;
      if (!Ctx) return null;
  this.ctx = new Ctx();
  if (!this.ctx) return null;
  this.master = this.ctx.createGain();
  this.master.gain.value = 0.7;
  this.master.connect(this.ctx.destination);
    }
    if (!this.ctx || !this.master) return null;
    return this.ctx;
  }

  async resume() {
    const ctx = this.ensureCtx();
    if (!ctx) return;
    if (ctx.state === "suspended") await ctx.resume();
  }

  // 短いビープ
  async beep(freq = 880, durationMs = 140) {
    const ctx = this.ensureCtx();
    if (!ctx || !this.master) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(freq, now);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.9, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, now + durationMs / 1000);
    osc.connect(gain);
    gain.connect(this.master);
    osc.start(now);
    osc.stop(now + durationMs / 1000 + 0.02);
  }

  // 爆発音: ノイズ + ローパス + エンベロープ
  async explosion(durationMs = 900) {
    const ctx = this.ensureCtx();
    if (!ctx || !this.master) return;

    const sampleRate = ctx.sampleRate;
    const length = Math.floor(sampleRate * (durationMs / 1000));
    const buffer = ctx.createBuffer(1, length, sampleRate);
    const data = buffer.getChannelData(0);

    for (let i = 0; i < length; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / length);
    }

    const src = ctx.createBufferSource();
    src.buffer = buffer;

    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(8000, ctx.currentTime);
    filter.frequency.exponentialRampToValueAtTime(400, ctx.currentTime + 0.6);

    const gain = ctx.createGain();
    const now = ctx.currentTime;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(1.0, now + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + durationMs / 1000);

    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);

    src.start();
    src.stop(now + durationMs / 1000 + 0.1);
  }
}

const sfx = new SoundFX();

// === Remote API (Google Apps Script) ===
const API_URL = "https://script.google.com/macros/s/AKfycbzhOfj1e-b9F22m4NGfE8UC9OoFEeG7jky0eRRzK66J/dev";
const USE_REMOTE = true; // 共有ランキングを利用

async function remoteLoadRank(duration: Duration): Promise<RankEntry[]> {
  if (!USE_REMOTE) return [];
  try {
    const res = await fetch(`${API_URL}?duration=${duration}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as RankEntry[];
    return Array.isArray(data) ? data.slice(0, 5) : [];
  } catch (e) {
    console.warn("remoteLoadRank failed:", e);
    return [];
  }
}

async function remotePostScore(duration: Duration, name: string, score: number): Promise<boolean> {
  if (!USE_REMOTE) return true;
  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ duration, name, score, date: new Date().toISOString() }),
    });
    if (!res.ok) {
      console.warn("remotePostScore failed: HTTP", res.status);
      return false;
    }
    return true;
  } catch (e) {
    console.warn("remotePostScore failed:", e);
    return false;
  }
}

// ========================= Helpers =========================
function loadRank(duration: Duration): RankEntry[] {
  try {
    const raw = localStorage.getItem(LS_KEY(duration));
    if (!raw) return [];
    const arr = JSON.parse(raw) as RankEntry[];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function saveRank(duration: Duration, entries: RankEntry[]) {
  localStorage.setItem(LS_KEY(duration), JSON.stringify(entries.slice(0, 5)));
}

function clearRankStorage(duration: Duration) {
  try {
    // remove → 直後に空配列を書き戻して同フレームの読み出し差異を封じる
    localStorage.removeItem(LS_KEY(duration));
    localStorage.setItem(LS_KEY(duration), JSON.stringify([]));
  } catch {}
}

function qualifies(entries: RankEntry[], score: number): boolean {
  if (entries.length < 5) return true;
  const min = entries[entries.length - 1]?.score ?? -Infinity;
  return score > min;
}

// ========================= UI =========================
export default function App() {
  const [duration, setDuration] = useState<Duration>(10);
  const [phase, setPhase] = useState<Phase>("idle");
  const [view, setView] = useState<View>("game");
  const [remaining, setRemaining] = useState<number>(10);
  const [count, setCount] = useState<number>(0);
  const [ranksByDuration, setRanksByDuration] = useState<Record<Duration, RankEntry[]>>(() => {
    const init: any = {};
    DURATIONS.forEach((d) => (init[d] = loadRank(d)));
    return init as Record<Duration, RankEntry[]>;
  });
  const readyTimerRef = useRef<number | null>(null);
  const activeTimerRef = useRef<number | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [showNameDialog, setShowNameDialog] = useState(false);
  const [tempName, setTempName] = useState("");
  const lastPointerIdRef = useRef<number | null>(null);

  // 計測中は選択不可
  const selectNone = phase === "active" ? "select-none" : "";

  // ジェスチャ抑制
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handler = (e: Event) => {
      if (phase === "active") e.preventDefault();
    };
    el.addEventListener("touchmove", handler, { passive: false });
    el.addEventListener("gesturestart" as any, handler);
    return () => {
      el.removeEventListener("touchmove", handler);
      el.removeEventListener("gesturestart" as any, handler);
    };
  }, [phase]);

  const stopTimers = useCallback(() => {
    if (readyTimerRef.current) window.clearInterval(readyTimerRef.current);
    if (activeTimerRef.current) window.clearInterval(activeTimerRef.current);
    readyTimerRef.current = null;
    activeTimerRef.current = null;
  }, []);

  const reset = useCallback(() => {
    stopTimers();
    setPhase("idle");
    setCount(0);
    setRemaining(duration);
    setView("game");
  }, [duration, stopTimers]);

  // 長押しでのみリセット有効化（0.6秒）
  const resetHoldTimerRef = useRef<number | null>(null);
  const beginResetHold = useCallback(() => {
    if (resetHoldTimerRef.current) window.clearTimeout(resetHoldTimerRef.current);
    resetHoldTimerRef.current = window.setTimeout(() => {
      reset();
    }, 600);
  }, [reset]);
  const cancelResetHold = useCallback(() => {
    if (resetHoldTimerRef.current) {
      window.clearTimeout(resetHoldTimerRef.current);
      resetHoldTimerRef.current = null;
    }
  }, []);

  const start = useCallback(async () => {
    await sfx.resume();
    stopTimers();
    setCount(0);
    setView("game");

    // --- 開始前カウントダウン（高い音） ---
    setPhase("ready");
    let pre = 3;
    setRemaining(pre);
    sfx.beep(1200, 120); // 最初の3
    vibrate(20);

    readyTimerRef.current = window.setInterval(() => {
      pre -= 1;
      if (pre > 0) {
        setRemaining(pre);
        sfx.beep(1200, 120); // 2, 1 も同音程で
        vibrate(20);
      } else {
        // --- 本計測開始 ---
        if (readyTimerRef.current) window.clearInterval(readyTimerRef.current);
        setPhase("active");
        setRemaining(duration);

        let left = duration;
        activeTimerRef.current = window.setInterval(() => {
          left -= 1;
          setRemaining(left);

          // 終了3,2,1 は低い音
          if (left <= 3 && left > 0) {
            sfx.beep(880, 140);
            vibrate(30);
          }

          if (left <= 0) {
            stopTimers();
            setPhase("finished");
            sfx.explosion(900);
            vibrate([50, 50, 50]);

            const entries = [...(ranksByDuration[duration] ?? [])];
            const qualified = qualifies(entries, count);
            if (qualified) {
              setShowNameDialog(true);
            } else {
              setView("rankings");
            }
          }
        }, 1000);
      }
    }, 1000);
  }, [duration, ranksByDuration, count, stopTimers]);

  // 画面全体でカウント
  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (phase !== "active") return;
    if (lastPointerIdRef.current === e.pointerId) return;
    lastPointerIdRef.current = e.pointerId;
    setCount((c) => c + 1);
    vibrate(10);
  }, [phase]);

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    if (lastPointerIdRef.current === e.pointerId) {
      lastPointerIdRef.current = null;
    }
  }, []);

  const saveName = useCallback(async () => {
    const name = tempName.trim() || "名無し";

    if (USE_REMOTE) {
      const success = await remotePostScore(duration, name, count);
      if (!success) {
        alert("ランキングの登録に失敗しました。ネットワーク接続を確認してください。");
        return;
      }
      // サーバーが処理を完了するまで少し待つ
      await new Promise(resolve => setTimeout(resolve, 500));
      const latest = await remoteLoadRank(duration);
      setRanksByDuration((prev) => ({ ...prev, [duration]: latest }));
    } else {
      const list = [...(ranksByDuration[duration] ?? [])];
      list.push({ name, score: count, date: new Date().toISOString() });
      list.sort((a, b) => b.score - a.score || a.date.localeCompare(b.date));
      const top5 = list.slice(0, 5);
      setRanksByDuration((prev) => ({ ...prev, [duration]: top5 }));
      saveRank(duration, top5);
    }

    setShowNameDialog(false);
    setTempName("");
    setView("rankings");
  }, [tempName, count, duration, ranksByDuration]);

  // ランキングのリセット（選択中の時間のみ）
  const clearRank = useCallback(() => {
    if (!confirm(`${duration}秒のランキングをリセットします。よろしいですか？`)) return;
    if (USE_REMOTE) {
      alert("共有ランキングのリセットは未対応です。スプレッドシートから削除してください。(※要望があればAPI側にclear機能を追加できます)");
      return;
    }
    clearRankStorage(duration);
    const fresh = loadRank(duration); // should be []
    setRanksByDuration((prev) => ({ ...prev, [duration]: fresh }));
  }, [duration]);

  // idle/ready のときは remaining を duration に同期
  useEffect(() => {
    if (phase === "idle" || phase === "ready") setRemaining(duration);
  }, [duration, phase]);

  // ランキング画面を開いた/時間を切り替えた時に共有ランキングを取得
  useEffect(() => {
    if (!USE_REMOTE) return;
    if (view === "rankings") {
      remoteLoadRank(duration).then((list) => {
        setRanksByDuration((prev) => ({ ...prev, [duration]: list }));
      });
    }
  }, [view, duration]);

  // ヘッダーテキスト & 現在のランキング配列
  const headerText = useMemo(() => {
    switch (phase) {
      case "idle":
        return view === "rankings" ? "ランキング" : "タップ計測";
      case "ready":
        return `まもなく開始 (${remaining})`;
      case "active":
        return `計測中 残り${remaining}s`;
      case "finished":
        return view === "rankings" ? "ランキング" : "終了！";
    }
  }, [phase, remaining, view]);

  const ranking = ranksByDuration[duration] ?? [];

  return (
    <div
      ref={containerRef}
      className={`min-h-screen w-full bg-slate-900 text-white flex flex-col items-center ${selectNone}`}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onContextMenu={(e) => e.preventDefault()}
      style={{ touchAction: "manipulation" }}
    >
      {/* Top Bar */}
      <div className="w-full max-w-3xl px-4 py-4 flex items-center justify-between">
        <h1 className="text-2xl font-bold">{headerText}</h1>
        <div className="flex items-center gap-2">
          <select
            value={duration}
            disabled={phase === "ready" || phase === "active"}
            onChange={(e) => setDuration(parseInt(e.target.value, 10) as Duration)}
            className="bg-slate-800 px-3 py-2 rounded-xl border border-slate-700"
          >
            {DURATIONS.map((d) => (
              <option key={d} value={d}>{d}秒</option>
            ))}
          </select>

          {view === "game" ? (
            phase === "idle" || phase === "finished" ? (
              <button
                onClick={start}
                className="px-4 py-2 rounded-2xl bg-emerald-500 hover:bg-emerald-400 active:scale-95 transition"
              >開始</button>
            ) : (
              <button
                onMouseDown={beginResetHold}
                onTouchStart={beginResetHold}
                onMouseUp={cancelResetHold}
                onMouseLeave={cancelResetHold}
                onTouchEnd={cancelResetHold}
                className="px-4 py-2 rounded-2xl bg-slate-700 hover:bg-slate-600 active:scale-95 transition"
              >リセット（長押し）</button>
            )
          ) : (
            <button
              onClick={() => setView("game")}
              className="px-4 py-2 rounded-2xl bg-slate-700 hover:bg-slate-600"
            >戻る</button>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="w-full max-w-3xl px-4 pb-8">
        {view === "game" ? (
          <>
            {/* Counter Panel */}
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-1 p-4 bg-slate-800 rounded-2xl shadow">
                <div className="text-sm text-slate-400">残り時間</div>
                <div className="text-4xl font-bold">{phase === "ready" ? `${remaining}` : phase === "active" ? `${remaining}` : `${duration}`}</div>
              </div>
              <div className="col-span-2 p-4 bg-slate-800 rounded-2xl shadow flex flex-col items-center justify-center">
                <div className="text-sm text-slate-400">タップ回数</div>
                <div className="text-7xl font-extrabold tracking-wider">{count}</div>
                <div className="mt-2 text-xs text-slate-400">（計測中は画面のどこを触ってもカウント）</div>
              </div>
            </div>

            {/* Tappable big area */}
            <div className={`mt-4 rounded-3xl border-2 ${phase === "active" ? "border-emerald-500" : "border-slate-700"} p-6 text-center select-none`}>
              {phase === "idle" && <p className="text-slate-300">開始を押すと「3,2,1」の高音ビープ後に計測開始します。</p>}
              {phase === "ready" && <p className="text-lg">準備… {remaining}</p>}
              {phase === "active" && <p className="text-lg">いまタップするとカウントされます！</p>}
              {phase === "finished" && (
                <div className="flex flex-col items-center gap-2">
                  <p className="text-lg">おつかれさま！ スコア：<span className="font-bold">{count}</span></p>
                  <button onClick={() => setView("rankings")} className="px-4 py-2 rounded-xl bg-amber-500 hover:bg-amber-400">この時間のランキングを見る</button>
                </div>
              )}
            </div>

            {/* Quick switch */}
            <div className="mt-3 flex flex-wrap gap-2">
              {DURATIONS.map((d) => (
                <button key={d} onClick={() => setDuration(d)} disabled={phase === "ready" || phase === "active"} className={`px-3 py-1 rounded-full border ${d === duration ? "bg-emerald-600 border-emerald-500" : "bg-slate-800 border-slate-700 hover:bg-slate-700"}`}>
                  {d}s
                </button>
              ))}
              {phase !== "active" && (
                <button onClick={() => setView("rankings")} className="ml-auto px-3 py-1 rounded-full bg-slate-700 hover:bg-slate-600">ランキングへ</button>
              )}
            </div>
          </>
        ) : (
          <>
            {/* Rankings Page */}
            <div className="p-4 bg-slate-800 rounded-2xl">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-xl font-bold">ランキング（{duration}秒・上位5位）</h2>
                <button onClick={clearRank} className="text-xs bg-slate-700 px-3 py-1 rounded-xl hover:bg-slate-600">リセット</button>
              </div>
              {ranking.length === 0 ? (
                <div className="text-slate-400 text-sm">まだ記録がありません。トップ5に入ると名前を登録できます。</div>
              ) : (
                <ol className="space-y-2">
                  {ranking.map((r, i) => (
                    <li key={`${r.name}-${r.date}`} className="flex items-center justify-between bg-slate-900 px-4 py-2 rounded-xl">
                      <div className="flex items-center gap-3">
                        <span className="text-sm text-slate-400 w-6">{i + 1}位</span>
                        <span className="font-semibold">{r.name}</span>
                      </div>
                      <div className="font-mono">{r.score}</div>
                    </li>
                  ))}
                </ol>
              )}
            </div>

            {/* Tabs for durations in ranking page */}
            <div className="mt-3 flex flex-wrap gap-2">
              {DURATIONS.map((d) => (
                <button key={d} onClick={() => setDuration(d)} className={`px-3 py-1 rounded-full border ${d === duration ? "bg-amber-600 border-amber-500" : "bg-slate-800 border-slate-700 hover:bg-slate-700"}`}>
                  {d}s
                </button>
              ))}
              <button onClick={() => setView("game")} className="ml-auto px-3 py-1 rounded-full bg-slate-700 hover:bg-slate-600">計測へ戻る</button>
            </div>
          </>
        )}
      </div>

      {/* Name dialog */}
      {showNameDialog && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4" onPointerDown={(e)=>e.stopPropagation()}>
          <div className="w-full max-w-md bg-slate-800 rounded-2xl p-6 border border-slate-700">
            <h3 className="text-lg font-bold mb-2">トップ5入り！お名前を入力</h3>
            <input
              autoFocus
              value={tempName}
              onChange={(e) => setTempName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && saveName()}
              placeholder="例: まと"
              className="w-full px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 mb-3"
            />
            <div className="flex gap-2 justify-end">
              <button onClick={() => { setShowNameDialog(false); setTempName(""); setView("rankings"); }} className="px-4 py-2 rounded-xl bg-slate-700 hover:bg-slate-600">スキップ</button>
              <button onClick={saveName} className="px-4 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400">登録</button>
            </div>
          </div>
        </div>
      )}

      <footer className="opacity-60 text-xs py-6">開始前は高音ビープで3→2→1、終了3秒前からは低音ビープ、0で爆発音。計測中はuser-select無効＆全画面タップでカウント。</footer>
    </div>
  );
}

// ========================= Lightweight Self Tests =========================
(function runSelfTests() {
  try {
    const few: RankEntry[] = [
      { name: "A", score: 10, date: "2020-01-01" },
      { name: "B", score: 9, date: "2020-01-02" },
    ];
    console.assert(qualifies(few, 1) === true, "qualifies(): <5 entries should accept");

    const five: RankEntry[] = [
      { name: "A", score: 10, date: "2020-01-01" },
      { name: "B", score: 9, date: "2020-01-02" },
      { name: "C", score: 8, date: "2020-01-03" },
      { name: "D", score: 7, date: "2020-01-04" },
      { name: "E", score: 6, date: "2020-01-05" },
    ];
    console.assert(qualifies(five, 7) === true, "qualifies(): 7 > min 6");
    console.assert(qualifies(five, 6) === false, "qualifies(): must be strictly greater than min");

    // save/load roundtrip & trimming validation
    const testDur: Duration = 3;
    const before = loadRank(testDur);
    saveRank(testDur, [
      { name: "X", score: 1, date: "2022-01-01" },
      { name: "Y", score: 2, date: "2022-01-02" },
      { name: "Z", score: 3, date: "2022-01-03" },
      { name: "W", score: 4, date: "2022-01-04" },
      { name: "V", score: 5, date: "2022-01-05" },
      { name: "U", score: 6, date: "2022-01-06" },
    ]);
    const after = loadRank(testDur);
    console.assert(after.length === 5, "saveRank(): should trim to top 5");

    // clear storage test (removeItem + overwrite empty)
    clearRankStorage(testDur);
    const cleared = loadRank(testDur);
    console.assert(cleared.length === 0, "clearRankStorage(): should result in []");

    // invalid JSON handling
    localStorage.setItem(LS_KEY(testDur), "not-json");
    const invalid = loadRank(testDur);
    console.assert(Array.isArray(invalid) && invalid.length === 0, "loadRank(): invalid JSON should yield []");

    // restore
    saveRank(testDur, before);
  } catch (e) {
    console.warn("Self tests encountered an error (safe to ignore in production):", e);
  }
})();
