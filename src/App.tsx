// App.tsx
import React, { useEffect, useMemo, useRef, useState } from "react";

export default function JengaTimer() {
  const [numPlayers, setNumPlayers] = useState(2);
  const [timePerTurn, setTimePerTurn] = useState(10);
  const [currentPlayer, setCurrentPlayer] = useState(0);
  const [running, setRunning] = useState(false);
  const [gameOver, setGameOver] = useState(false);
  const [started, setStarted] = useState(false);
  const [flash, setFlash] = useState(false);

  // ★ 追加: 色選択モード＆背景色
  const [colorMode, setColorMode] = useState(false);
  const [bgColor, setBgColor] = useState<string | undefined>(undefined);
  const colorPool = useRef<string[]>([
    "red",
    "blue",
    "brown",
    "green",
    "yellow",
    "orange",
  ]);

  const deadlineRef = useRef<number | null>(null);
  const [remainingMs, setRemainingMs] = useState(0);
  const [playerNames, setPlayerNames] = useState([
    "Player 1",
    "Player 2",
    "Player 3",
    "Player 4",
  ]);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const [audioPrimed, setAudioPrimed] = useState(false);
  const audioLockRef = useRef(false);
  const lastSecondRef = useRef<number | null>(null);

  const ceilSecs = (ms: number) => Math.max(0, Math.ceil(ms / 1000));
  const nextIdx = (p: number, n: number) => (p + 1) % n;
  const remainingSec = useMemo(() => ceilSecs(remainingMs), [remainingMs]);

  // ★ 追加: ランダム色選択
  const pickRandomColor = () => {
    const arr = colorPool.current;
    const idx = Math.floor(Math.random() * arr.length);
    return arr[idx];
    // Reactのinline styleで背景色を安全に指定できます。:contentReference[oaicite:1]{index=1}
  };

  const ensureAudioPrimed = () => {
    if (audioPrimed) return;
    try {
      const AudioCtx =
        window.AudioContext || (window as any).webkitAudioContext;
      const ctx = new AudioCtx();
      audioCtxRef.current = ctx;
      const silent = ctx.createBuffer(1, 1, ctx.sampleRate);
      const src = ctx.createBufferSource();
      src.buffer = silent;
      src.connect(ctx.destination);
      src.start();
      ctx
        .resume()
        .then(() => setAudioPrimed(true))
        .catch(() => {});
    } catch (_) {}
  };

  const resumeIfNeeded = async () => {
    const ctx = audioCtxRef.current;
    if (!ctx) return;
    if (ctx.state === "suspended") {
      try {
        await ctx.resume();
      } catch (_) {}
    }
  };

  const playBeep = async () => {
    const ctx = audioCtxRef.current;
    if (!ctx) return;
    await resumeIfNeeded();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.12);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.14);
  };

  const playExplosion = async () => {
    const ctx = audioCtxRef.current;
    if (!ctx) return;
    if (audioLockRef.current) return;
    audioLockRef.current = true;
    setTimeout(() => {
      audioLockRef.current = false;
    }, 300);
    await resumeIfNeeded();
    const duration = 1.1;
    const buffer = ctx.createBuffer(
      1,
      Math.floor(ctx.sampleRate * duration),
      ctx.sampleRate
    );
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(2200, ctx.currentTime);
    filter.frequency.exponentialRampToValueAtTime(
      200,
      ctx.currentTime + duration
    );
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.9, ctx.currentTime + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
    src.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);
    src.start();
  };

  useEffect(() => {
    const onVisible = () => {
      resumeIfNeeded();
    };
    window.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      window.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, []);

  useEffect(() => {
    if (!running || gameOver) return;
    const tick = () => {
      const now = performance.now();
      if (deadlineRef.current == null) return;
      const left = deadlineRef.current - now;
      setRemainingMs(Math.max(0, left));
      const sec = ceilSecs(left);
      if (sec !== lastSecondRef.current) {
        lastSecondRef.current = sec;
        if (sec <= 5 && sec > 0 && audioPrimed) {
          try {
            playBeep();
          } catch (_) {}
        }
      }
      if (left <= 0) {
        setRunning(false);
        setGameOver(true);
        if (navigator.vibrate) {
          try {
            navigator.vibrate(800);
          } catch (_) {}
        }
        if (audioPrimed) {
          try {
            playExplosion();
          } catch (_) {}
        }
      }
    };
    const id = setInterval(tick, 100);
    tick();
    return () => clearInterval(id);
  }, [running, gameOver, audioPrimed]);

  const triggerFlash = () => {
    setFlash(true);
    setTimeout(() => setFlash(false), 150);
  };

  const startGame = () => {
    ensureAudioPrimed();
    setStarted(true);
    setGameOver(false);
    setRunning(true);
    setCurrentPlayer(0);
    // ★ 初回手番の色適用
    if (colorMode) setBgColor(pickRandomColor());
    const now = performance.now();
    deadlineRef.current = now + timePerTurn * 1000;
    setRemainingMs(timePerTurn * 1000);
    lastSecondRef.current = timePerTurn;
  };

  const finishTurn = () => {
    if (!running || gameOver) return;
    triggerFlash();
    if (navigator.vibrate) {
      try {
        navigator.vibrate([30, 50, 30]);
      } catch (_) {}
    }
    setCurrentPlayer((p) => {
      const next = nextIdx(p, numPlayers);
      const now = performance.now();
      deadlineRef.current = now + timePerTurn * 1000;
      setRemainingMs(timePerTurn * 1000);
      lastSecondRef.current = timePerTurn;
      // ★ 手番切替時の色適用
      if (colorMode) setBgColor(pickRandomColor());
      return next;
    });
  };

  const resetAll = () => {
    setRunning(false);
    setGameOver(false);
    setStarted(false);
    setCurrentPlayer(0);
    deadlineRef.current = null;
    setRemainingMs(0);
    lastSecondRef.current = null;
    // ★ リセットで背景も戻す
    setBgColor(undefined);
  };

  const handleRootClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (
      (e.target as HTMLElement).closest("#resetButton") ||
      (e.target as HTMLElement).closest("#startButton") ||
      (e.target as HTMLElement).closest("#colorModeToggle")
    )
      return; // ★ トグル操作はターン進行しない
    ensureAudioPrimed();
    if (started && running && !gameOver) finishTurn();
  };

  const resetHoldRef = useRef<{ timer: any; held: boolean }>({
    timer: null,
    held: false,
  });
  const onResetDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    const t = setTimeout(() => {
      resetHoldRef.current.held = true;
      resetAll();
    }, 800);
    resetHoldRef.current = { timer: t, held: false };
  };
  const onResetUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    const { timer, held } = resetHoldRef.current || {};
    if (timer) clearTimeout(timer);
    resetHoldRef.current = { timer: null, held: false };
    if (!held) {
      if (started && running && !gameOver) finishTurn();
    }
  };

  return (
    <div
      className={`min-h-screen flex items-center justify-center p-6 ${
        flash ? "bg-yellow-100" : "bg-slate-50"
      } text-slate-900 transition-colors duration-150`}
      style={colorMode && !flash ? { backgroundColor: bgColor } : undefined} // ★ inline背景
      onClick={handleRootClick}
      onTouchStart={() => {
        ensureAudioPrimed();
        resumeIfNeeded();
      }}
      onMouseDown={() => {
        ensureAudioPrimed();
        resumeIfNeeded();
      }}
    >
      <div className="w-full max-w-xl">
        <div className="mb-4 text-center">
          <h1 className="text-2xl font-bold tracking-tight">
            Jenga Turn Timer
          </h1>
        </div>

        {/* ★ 追加: 色選択モードトグル（ゲーム中も表示） */}
        <div
          id="colorModeToggle"
          className="mb-4 flex items-center justify-center gap-3"
          onClick={(e) => e.stopPropagation()}
        >
          <label className="inline-flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={colorMode}
              onChange={(e) => {
                setColorMode(e.target.checked);
                // ON にした瞬間、進行中なら即反映
                if (e.target.checked) setBgColor(pickRandomColor());
                else setBgColor(undefined);
              }}
              className="h-5 w-5"
            />
            <span className="text-sm font-medium">色選択モード</span>
          </label>
        </div>

        {!started && (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
              <div className="bg-white rounded-2xl shadow p-4">
                <label className="block text-sm font-medium mb-2">
                  プレイヤー人数
                </label>
                <select
                  className="w-full rounded-xl border px-3 py-3 text-lg"
                  value={numPlayers}
                  onChange={(e) => setNumPlayers(Number(e.target.value))}
                >
                  {[2, 3, 4].map((n) => (
                    <option key={n} value={n}>
                      {n} 人
                    </option>
                  ))}
                </select>
              </div>

              <div className="bg-white rounded-2xl shadow p-4">
                <label className="block text-sm font-medium mb-2">
                  持ち時間（秒）
                </label>
                <select
                  className="w-full rounded-xl border px-3 py-3 text-lg"
                  value={timePerTurn}
                  onChange={(e) => setTimePerTurn(Number(e.target.value))}
                >
                  {[5, 6, 7, 8, 9, 10, 15, 20, 25, 30].map((s) => (
                    <option key={s} value={s}>
                      {s} 秒
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="flex items-center gap-4 justify-center">
              <button
                id="startButton"
                onClick={(e) => {
                  e.stopPropagation();
                  startGame();
                }}
                className="px-8 py-5 text-xl rounded-2xl shadow bg-emerald-600 text-white w-full sm:w-auto"
              >
                Start
              </button>
            </div>
          </>
        )}

        {started && (
          <div className="flex items-center gap-4 justify-center mb-4">
            <button
              id="resetButton"
              onPointerDown={onResetDown}
              onPointerUp={onResetUp}
              onClick={(e) => e.stopPropagation()}
              className="px-8 py-5 text-xl rounded-2xl shadow bg-slate-200 text-slate-800 w-full sm:w-auto"
            >
              Reset
            </button>
          </div>
        )}

        <div className="bg-white rounded-2xl shadow p-4 mb-4">
          <div className="flex flex-col items-center">
            {Array.from({ length: numPlayers }).map((_, i) => (
              <input
                key={i}
                type="text"
                className={`text-lg font-bold mb-2 text-center border rounded-lg px-3 py-2 ${
                  i === currentPlayer && started && !gameOver
                    ? "bg-emerald-100"
                    : "bg-slate-100"
                } ${started ? "pointer-events-none" : ""}`}
                value={playerNames[i]}
                onChange={(e) => {
                  const newNames = [...playerNames];
                  newNames[i] = e.target.value;
                  setPlayerNames(newNames);
                }}
                disabled={started}
              />
            ))}
          </div>
          <div className="text-center mt-2 text-2xl font-bold">
            {started && !gameOver
              ? `${playerNames[currentPlayer]} の番`
              : "待機中"}
          </div>
        </div>

        <div className="bg-white rounded-2xl shadow p-6 mb-4 text-center">
          {gameOver ? (
            <div className="text-4xl font-black text-rose-600">Game over</div>
          ) : started ? (
            <div className="text-6xl font-black tabular-nums">
              {remainingSec}
              <span className="text-2xl ml-1">s</span>
            </div>
          ) : (
            <div className="text-slate-400">Startを押すと開始します</div>
          )}
        </div>
      </div>
    </div>
  );
}
