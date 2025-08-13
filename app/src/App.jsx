import React, { useMemo, useEffect, useState, useRef, useLayoutEffect } from "react";
import { create } from "zustand";
import { CheckCircle, Undo2, Settings2, ChevronDown, ChevronUp, History } from "lucide-react";

/*************************
 * Utility helpers
 *************************/
function range(n) { return Array.from({ length: n }, (_, i) => i); }
function combinations(arr) {
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    for (let j = i + 1; j < arr.length; j++) out.push([arr[i], arr[j]]);
  }
  return out;
}
function shuffle(array, rng) {
  const a = array.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function mulberry32(a) {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/*************************
 * Core scheduling
 *************************/
function buildRound({ N, presentSet, gPref, allowFlex34, C, rng }) {
  const U = Array.from(presentSet);
  if (U.length === 0) return [];
  const gMin = allowFlex34 ? 3 : gPref;
  const gMax = allowFlex34 ? 4 : gPref;

  const groupScore = (G) => {
    let s = 0;
    for (let i = 0; i < G.length; i++) {
      for (let j = i + 1; j < G.length; j++) {
        const a = Math.min(G[i], G[j]);
        const b = Math.max(G[i], G[j]);
        s += C[a][b];
      }
    }
    return s;
  };
  const constrainedScore = (x) => {
    let s = 0;
    for (let y = 0; y < N; y++) if (y !== x) s += C[Math.min(x, y)][Math.max(x, y)];
    return s;
  };

  let pool = shuffle(U, mulberry32(Math.floor(rng() * 1e9)));
  pool.sort((a, b) => constrainedScore(b) - constrainedScore(a));

  const groups = [];
  const used = new Set();

  function buildAround(p) {
    const remaining = pool.filter((x) => !used.has(x) && x !== p);
    if (remaining.length === 0) return null;

    const tries = Math.min(12, remaining.length);
    const candidates = shuffle(remaining, mulberry32(Math.floor(rng() * 1e9))).slice(0, tries);

    let best = null;
    for (const c of candidates) {
      let G = [p, c];
      let rest = remaining.filter((x) => x !== c);
      while (G.length < gMin && rest.length > 0) {
        let next = null;
        let nextScore = Infinity;
        for (const x of rest) {
          const s = G.reduce((acc, y) => acc + C[Math.min(x, y)][Math.max(x, y)], 0);
          if (s < nextScore) { nextScore = s; next = x; }
        }
        if (next == null) break;
        G.push(next);
        rest = rest.filter((x) => x !== next);
      }
      while (allowFlex34 && G.length < gMax && rest.length > 0) {
        let candidate = null;
        let delta = Infinity;
        for (const x of rest) {
          const inc = G.reduce((acc, y) => acc + C[Math.min(x, y)][Math.max(x, y)], 0);
          if (inc < delta) { delta = inc; candidate = x; }
        }
        if (candidate == null) break;
        const avgBefore = groupScore(G) / (G.length * (G.length - 1) / 2 || 1);
        const avgAfter = (groupScore(G) + delta) / ((G.length + 1) * G.length / 2);
        if (avgAfter <= avgBefore + 0.1) {
          G.push(candidate);
          rest = rest.filter((x) => x !== candidate);
        } else break;
      }
      if (G.length >= gMin && G.length <= gMax) {
        const sc = groupScore(G);
        if (!best || sc < best.sc) best = { G, sc };
      }
    }
    return best ? best.G : null;
  }

  for (const p of pool) {
    if (used.has(p)) continue;
    const G = buildAround(p);
    if (!G) continue;
    G.forEach((x) => used.add(x));
    groups.push(G);
  }

  const leftovers = pool.filter((x) => !used.has(x));
  if (leftovers.length > 0) {
    for (const x of leftovers) {
      let bestIdx = -1;
      let bestDelta = Infinity;
      groups.forEach((G, idx) => {
        if (G.length < gMax) {
          const inc = G.reduce((acc, y) => acc + C[Math.min(x, y)][Math.max(x, y)], 0);
          if (inc < bestDelta) { bestDelta = inc; bestIdx = idx; }
        }
      });
      if (bestIdx >= 0) { groups[bestIdx] = groups[bestIdx].concat([x]); used.add(x); }
    }
    // Rebalance if we still have leftovers that could not be placed because all groups are at gMax
    const remaining = pool.filter((x) => !used.has(x));
    if (remaining.length > 0) {
      // Try to move members out of 4-sized groups (or > gMin) to reach at least gMin for leftovers
      let temp = remaining.slice();
      const adjustableIdxs = () => groups
        .map((G, idx) => ({ G, idx }))
        .filter(({ G }) => G.length > gMin)
        .map(({ idx }) => idx);

      while (temp.length < gMin && adjustableIdxs().length > 0) {
        // Choose a group to take from: the one where removing someone hurts least (largest contribution removed)
        let chosenGroup = -1;
        let chosenMember = -1;
        let bestGain = -Infinity;
        adjustableIdxs().forEach((idx) => {
          const G = groups[idx];
          G.forEach((x, pos) => {
            const contrib = G.reduce((acc, y, j) => j === pos ? acc : acc + C[Math.min(x, y)][Math.max(x, y)], 0);
            if (contrib > bestGain) { bestGain = contrib; chosenGroup = idx; chosenMember = pos; }
          });
        });
        if (chosenGroup >= 0 && chosenMember >= 0) {
          const x = groups[chosenGroup][chosenMember];
          groups[chosenGroup] = groups[chosenGroup].filter((_, i) => i !== chosenMember);
          temp.push(x);
        } else break;
      }
      if (temp.length >= gMin && temp.length <= gMax) {
        // Form a new group with the rebalanced leftovers
        groups.push(temp);
        temp.forEach((x) => used.add(x));
      }
    }
  }

  let improved = true, guard = 0;
  const totalScore = (A, B) => {
    const gs = (G) => {
      let s = 0; for (const [a, b] of combinations(G)) s += C[Math.min(a, b)][Math.max(a, b)]; return s;
    };
    return gs(A) + gs(B);
  };
  while (improved && guard < 64) {
    improved = false; guard++;
    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        const A = groups[i], B = groups[j];
        for (let ai = 0; ai < A.length; ai++) {
          for (let bi = 0; bi < B.length; bi++) {
            const A2 = A.slice(), B2 = B.slice();
            const a = A2[ai], b = B2[bi];
            A2[ai] = b; B2[bi] = a;
            if (
              A2.length >= (allowFlex34 ? 3 : gPref) && A2.length <= (allowFlex34 ? 4 : gPref) &&
              B2.length >= (allowFlex34 ? 3 : gPref) && B2.length <= (allowFlex34 ? 4 : gPref) &&
              totalScore(A, B) > totalScore(A2, B2)
            ) { groups[i] = A2; groups[j] = B2; improved = true; }
          }
        }
      }
    }
  }

  return groups;
}

function defaultName(i) { return `P${String(i + 1).padStart(2, "0")}`; }

function loadPersistedState() {
  try {
    const raw = localStorage.getItem("mixerState");
    if (!raw) return null;
    const d = JSON.parse(raw);
    const N = typeof d.N === "number" ? Math.max(2, d.N) : 24;
    return {
      N,
      R: typeof d.R === "number" ? Math.max(1, d.R) : 6,
      gPref: d.gPref === 3 || d.gPref === 4 ? d.gPref : 4,
      allowFlex34: typeof d.allowFlex34 === "boolean" ? d.allowFlex34 : true,
      seed: typeof d.seed === "number" ? d.seed : 42,
      currentRound: typeof d.currentRound === "number" ? Math.max(0, d.currentRound) : 0,
      lockedRounds: Array.isArray(d.lockedRounds) ? d.lockedRounds : [],
      present: new Set(Array.isArray(d.present) ? d.present : range(N)),
      names: Array.isArray(d.names)
        ? Array.from({ length: N }, (_, i) => {
            const v = d.names[i];
            const trimmed = typeof v === "string" ? v.trim() : "";
            return trimmed && trimmed !== defaultName(i) ? trimmed : "";
          })
        : Array.from({ length: N }, () => ""),
    };
  } catch (_) { return null; }
}

function SettingsPanel({ show, children }) {
  const ref = useRef(null);
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    if (!ref.current) return;
    const el = ref.current;
    if (show) {
      // measure expanded height
      const prev = el.style.maxHeight;
      el.style.maxHeight = 'none';
      const h = el.scrollHeight;
      el.style.maxHeight = prev;
      requestAnimationFrame(() => {
        setHeight(h);
      });
    } else {
      setHeight(0);
    }
  }, [show, children]);
  return (
    <div
      ref={ref}
      style={{ maxHeight: show ? height : 0, overflow: 'hidden', transition: 'max-height 200ms ease' }}
      aria-hidden={!show}
    >
      {children}
    </div>
  );
}

/*************************
 * Zustand store
 *************************/
const initial = loadPersistedState();

const useMixerStore = create((set, get) => ({
  N: initial?.N ?? 24,
  R: initial?.R ?? 6,
  gPref: initial?.gPref ?? 4,
  allowFlex34: initial?.allowFlex34 ?? true,
  seed: initial?.seed ?? 42,

  currentRound: initial?.currentRound ?? 0,
  lockedRounds: initial?.lockedRounds ?? [], // array of groups per round
  present: initial?.present ?? new Set(range(initial?.N ?? 24)),
  names: initial?.names ?? Array.from({ length: initial?.N ?? 24 }, () => ""),
  highlighted: null,

  setN: (val) => set((s) => {
    const requested = Math.max(2, val);
    const hasLocked = s.lockedRounds.length > 0;
    const newN = hasLocked ? Math.max(s.N, requested) : requested;
    const newNames = Array.from({ length: newN }, (_, i) => (s.names && i < s.names.length ? s.names[i] : ""));
    let newPresent;
    if (hasLocked) {
      // Keep existing present, add newcomers as present by default
      newPresent = new Set(Array.from(s.present).filter((i) => i < newN));
      for (let i = s.N; i < newN; i++) newPresent.add(i);
    } else {
      newPresent = new Set(range(newN));
    }
    return {
      N: newN,
      present: newPresent,
      lockedRounds: hasLocked ? s.lockedRounds : [],
      currentRound: hasLocked ? s.currentRound : 0,
      names: newNames,
    };
  }),
  setR: (val) => set((s) => {
    const requested = Math.max(1, val);
    const minR = Math.max(1, s.lockedRounds.length);
    return { R: Math.max(minR, requested) };
  }),
  setGPref: (val) => set({ gPref: val }),
  setAllowFlex34: (v) => set({ allowFlex34: v }),
  setSeed: (val) => set({ seed: val }),
  setName: (i, val) => set((s) => {
    const next = s.names.slice();
    const trimmed = (val ?? "").trim();
    next[i] = trimmed;
    return { names: next };
  }),
  setHighlighted: (i) => set({ highlighted: i }),

  togglePresent: (i) => set((s) => {
    const p = new Set(s.present);
    if (p.has(i)) p.delete(i); else p.add(i);
    return { present: p };
  }),

  // Réinitialise tous les paramètres aux valeurs par défaut (y compris le seed)
  resetSchedule: () => set(() => ({
    N: 24,
    R: 6,
    gPref: 4,
    allowFlex34: true,
    seed: 42,
    lockedRounds: [],
    currentRound: 0,
    present: new Set(range(24)),
    names: Array.from({ length: 24 }, () => ""),
  })),

  unlockLastRound: () => set((s) => ({
    lockedRounds: s.lockedRounds.slice(0, -1),
    currentRound: Math.max(0, s.currentRound - 1),
  })),

  lockNextRound: () => {
    const s = get();
    // Build C from locked rounds
    const C = Array.from({ length: s.N }, () => Array(s.N).fill(0));
    for (const round of s.lockedRounds) {
      for (const G of round) for (const [a, b] of combinations(G)) C[Math.min(a, b)][Math.max(a, b)] += 1;
    }
    const rng = mulberry32(s.seed);
    const next = buildRound({ N: s.N, presentSet: s.present, gPref: s.gPref, allowFlex34: s.allowFlex34, C, rng });
    set({ lockedRounds: [...s.lockedRounds, next], currentRound: Math.min(s.currentRound + 1, s.R - 1) });
  },
}));

/*************************
 * App component
 *************************/
export default function App() {
  const N = useMixerStore((s) => s.N);
  const R = useMixerStore((s) => s.R);
  const gPref = useMixerStore((s) => s.gPref);
  const allowFlex34 = useMixerStore((s) => s.allowFlex34);
  const seed = useMixerStore((s) => s.seed);
  const currentRound = useMixerStore((s) => s.currentRound);
  const lockedRounds = useMixerStore((s) => s.lockedRounds);
  const present = useMixerStore((s) => s.present);
  const names = useMixerStore((s) => s.names);
  const highlighted = useMixerStore((s) => s.highlighted);

  const setN = useMixerStore((s) => s.setN);
  const setR = useMixerStore((s) => s.setR);
  const setGPref = useMixerStore((s) => s.setGPref);
  const setAllowFlex34 = useMixerStore((s) => s.setAllowFlex34);
  const setSeed = useMixerStore((s) => s.setSeed);
  const togglePresent = useMixerStore((s) => s.togglePresent);
  const resetSchedule = useMixerStore((s) => s.resetSchedule);
  const lockNextRound = useMixerStore((s) => s.lockNextRound);
  const unlockLastRound = useMixerStore((s) => s.unlockLastRound);
  const setName = useMixerStore((s) => s.setName);
  const setHighlighted = useMixerStore((s) => s.setHighlighted);

  const [showSettings, setShowSettings] = useState(false);
  const [nField, setNField] = useState(String(N));
  const [rField, setRField] = useState(String(R));

  useEffect(() => { setNField(String(N)); }, [N]);
  useEffect(() => { setRField(String(R)); }, [R]);

  const commitN = () => {
    const v = parseInt(nField, 10);
    if (!Number.isNaN(v)) setN(v);
  };
  const commitR = () => {
    const v = parseInt(rField, 10);
    if (!Number.isNaN(v)) setR(v);
  };

  const isConfigIncomplete = (nField ?? "").trim() === "" || (rField ?? "").trim() === "";

  const changeN = (delta) => {
    const baseStr = (nField ?? "").trim();
    const base = baseStr === "" ? N : parseInt(baseStr, 10);
    const safeBase = Number.isNaN(base) ? N : base;
    const next = Math.max(2, safeBase + delta);
    // If we have locked rounds, only allow increases via +/-
    if (lockedRounds.length > 0 && next < N) return;
    setN(next);
    setNField(String(next));
  };

  const changeR = (delta) => {
    const baseStr = (rField ?? "").trim();
    const base = baseStr === "" ? R : parseInt(baseStr, 10);
    const safeBase = Number.isNaN(base) ? R : base;
    const next = Math.max(1, safeBase + delta);
    if (lockedRounds.length > 0 && next < R) return;
    setR(next);
    setRField(String(next));
  };

  // Persist to localStorage on any relevant change
  useEffect(() => {
    const unsubscribe = useMixerStore.subscribe((s) => {
      const snapshot = {
        N: s.N,
        R: s.R,
        gPref: s.gPref,
        allowFlex34: s.allowFlex34,
        seed: s.seed,
        currentRound: s.currentRound,
        lockedRounds: s.lockedRounds,
        present: Array.from(s.present),
        names: s.names,
      };
      try { localStorage.setItem("mixerState", JSON.stringify(snapshot)); } catch (_) {}
    });
    return unsubscribe;
  }, []);

  // Rebuild co-meet matrix from locked rounds
  const C = useMemo(() => {
    const M = Array.from({ length: N }, () => Array(N).fill(0));
    for (const round of lockedRounds) {
      for (const G of round) for (const [a, b] of combinations(G)) M[Math.min(a, b)][Math.max(a, b)] += 1;
    }
    return M;
  }, [N, lockedRounds]);

  // Ensure present never references indexes >= N
  useEffect(() => {
    const invalid = [...present].some((i) => i >= N);
    if (invalid) useMixerStore.setState({ present: new Set(range(N)) });
  }, [N, present]);

  // Build upcoming previews (next round using current presence; future rounds assume all present)
  const upcoming = useMemo(() => {
    const rounds = [];
    const Cwork = C.map((row) => row.slice());
    const rng = mulberry32(seed);

    const presentNext = new Set(present);
    const G0 = buildRound({ N, presentSet: presentNext, gPref, allowFlex34, C: Cwork, rng });
    rounds.push(G0);
    for (const [a, b] of G0.flatMap((G) => combinations(G))) Cwork[Math.min(a, b)][Math.max(a, b)] += 1;

    for (let r = currentRound + 1; r < R; r++) {
      const allPresent = new Set(range(N));
      const Gr = buildRound({ N, presentSet: allPresent, gPref, allowFlex34, C: Cwork, rng });
      rounds.push(Gr);
      for (const [a, b] of Gr.flatMap((G) => combinations(G))) Cwork[Math.min(a, b)][Math.max(a, b)] += 1;
    }
    return rounds;
  }, [N, R, gPref, allowFlex34, C, present, seed, currentRound]);

  const baseC = C; // legacy reference; per-row bases computed below

  function groupRepeatCount(G, base) {
    let s = 0; for (const [a, b] of combinations(G)) s += base[Math.min(a, b)][Math.max(a, b)] > 0 ? 1 : 0; return s;
  }

  const tableRounds = useMemo(() => {
    const rows = [];
    // Base matrix built incrementally from locked rounds up to each row
    const base = Array.from({ length: N }, () => Array(N).fill(0));
    for (const groups of lockedRounds) {
      rows.push({ groups, locked: true, base: base.map((row) => row.slice()) });
      for (const G of groups) for (const [a, b] of combinations(G)) base[Math.min(a, b)][Math.max(a, b)] += 1;
    }
    // For previews, also incrementally update base so later previews compare against earlier previews
    for (const groups of upcoming) {
      rows.push({ groups, locked: false, base: base.map((row) => row.slice()) });
      for (const G of groups) for (const [a, b] of combinations(G)) base[Math.min(a, b)][Math.max(a, b)] += 1;
    }
    return rows.slice(0, R);
  }, [N, lockedRounds, upcoming, R]);

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <div className="max-w-7xl mx-auto p-6 space-y-6">
        <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-center sm:justify-start sm:gap-4">
          <a href="https://www.meetup.com/entrep-ensemble-lille/" target="_blank" rel="noopener noreferrer" className="shrink-0 order-1 sm:order-1">
            <img
              src="/logo-entrep-ensemble.png"
              alt="Entrep Ensemble"
              className="h-12 sm:h-14 md:h-16 w-auto rounded-xl ring-2 ring-red-400/30 hover:ring-red-500/60 shadow-sm hover:shadow-md transition cursor-pointer"
            />
          </a>
          <h1 className="text-2xl font-semibold text-center sm:text-left order-2 sm:order-2">Networking Mixer Scheduler - Projet d'Entrep Ensemble</h1>
        </div>
        <p className="text-sm text-gray-600">Groupes préférés de 4 avec option 3–4 flexible pour gérer retards/départs. Planification anti-doublons avec ajustement local, verrouillage round par round.</p>

        {/* Controls */}
        <div className="bg-white rounded-2xl shadow">
          <div
            className={`flex items-center justify-between px-4 py-3 cursor-pointer select-none ${showSettings ? "border-b" : "border-b-0"}`}
            onClick={() => setShowSettings((v) => !v)}
            aria-expanded={showSettings}
            aria-controls="settings-panel"
            role="button"
          >
            <div className="flex items-center gap-2">
              <Settings2 className="w-4 h-4" />
              <span className="text-sm font-medium">Réglages</span>
            </div>
            <button
              className="p-1 rounded-md hover:bg-gray-100"
              onClick={(e) => { e.stopPropagation(); setShowSettings((v) => !v); }}
              aria-label="Basculer les réglages"
            >
              {showSettings ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </button>
          </div>
          {/* Animated collapse */}
          <SettingsPanel show={showSettings}>
            <div id="settings-panel" className="p-4 grid md:grid-cols-2 lg:grid-cols-3 gap-4">
            <div className="">
              <label className="block text-sm font-medium">Participants (N)</label>
              <div className="mt-1 flex items-stretch gap-2">
                <button
                  className="px-3 rounded-lg border bg-gray-50 hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed"
                  onClick={() => changeN(-1)}
                  aria-label="Décrémenter N"
                  disabled={lockedRounds.length > 0}
                  title={lockedRounds.length > 0 ? "Impossible de réduire après validation" : undefined}
                >−</button>
                {lockedRounds.length > 0 ? (
                  <input
                    type="number"
                    className="w-full border rounded-xl px-3 py-2 pointer-events-none bg-white"
                    value={String(N)}
                    min={2}
                    readOnly
                    aria-readonly="true"
                  />
                ) : (
                  <input
                    type="number"
                    className="w-full border rounded-xl px-3 py-2"
                    value={nField}
                    min={2}
                    placeholder=""
                    onChange={(e) => setNField(e.target.value)}
                    onBlur={commitN}
                    onKeyDown={(e) => { if (e.key === 'Enter') commitN(); }}
                  />
                )}
                <button className="px-3 rounded-lg border bg-gray-50 hover:bg-gray-100" onClick={() => changeN(1)} aria-label="Incrémenter N">+</button>
              </div>
            </div>
            <div className="">
              <label className="block text-sm font-medium">Rounds (R)</label>
              <div className="mt-1 flex items-stretch gap-2">
                <button
                  className="px-3 rounded-lg border bg-gray-50 hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed"
                  onClick={() => changeR(-1)}
                  aria-label="Décrémenter R"
                  disabled={lockedRounds.length > 0}
                  title={lockedRounds.length > 0 ? "Impossible de réduire après validation" : undefined}
                >−</button>
                {lockedRounds.length > 0 ? (
                  <input
                    type="number"
                    className="w-full border rounded-xl px-3 py-2 pointer-events-none bg-white"
                    value={String(R)}
                    min={1}
                    readOnly
                    aria-readonly="true"
                  />
                ) : (
                  <input
                    type="number"
                    className="w-full border rounded-xl px-3 py-2"
                    value={rField}
                    min={1}
                    placeholder=""
                    onChange={(e) => setRField(e.target.value)}
                    onBlur={commitR}
                    onKeyDown={(e) => { if (e.key === 'Enter') commitR(); }}
                  />
                )}
                <button className="px-3 rounded-lg border bg-gray-50 hover:bg-gray-100" onClick={() => changeR(1)} aria-label="Incrémenter R">+</button>
              </div>
            </div>
            <div className="">
            <label className="block text-sm font-medium">Taille préférée des groupes</label>
            <select className="mt-1 w-full border rounded-xl px-3 py-2" value={gPref} onChange={(e) => setGPref(parseInt(e.target.value, 10))}>
              <option value={3}>3</option>
              <option value={4}>4</option>
            </select>
            <label className="mt-3 flex items-center gap-2 text-sm">
              <input type="checkbox" checked={allowFlex34} onChange={(e) => setAllowFlex34(e.target.checked)} />
              Autoriser 3–4 (flex pour imprévus)
            </label>
            </div>
            <div className="">
              <label className="block text-sm font-medium">Seed (aléa reproductible)</label>
              <div className="mt-1 flex items-stretch gap-2">
                <button className="px-3 rounded-lg border bg-gray-50 hover:bg-gray-100" onClick={() => setSeed(Math.max(0, (seed ?? 0) - 1))} aria-label="Décrémenter seed">−</button>
                <input type="number" className="w-full border rounded-xl px-3 py-2" value={seed} onChange={(e) => setSeed(parseInt(e.target.value || "0", 10))} />
                <button className="px-3 rounded-lg border bg-gray-50 hover:bg-gray-100" onClick={() => setSeed((seed ?? 0) + 1)} aria-label="Incrémenter seed">+</button>
              </div>
            </div>
            <div className="flex items-end gap-3">
              <button
                className="px-4 py-2 rounded-xl bg-gray-900 text-white hover:bg-gray-800"
                onClick={() => {
                  const confirmed = window.confirm(
                    "Cette action va réinitialiser complètement l'application: paramètres (N, R, tailles), présences, rounds et noms seront remis par défaut, et la seed sera réinitialisée. Confirmer ?"
                  );
                  if (confirmed) {
                    try { localStorage.removeItem("mixerState"); } catch (_) {}
                    resetSchedule();
                    window.location.reload();
                  }
                }}
              >
                Réinitialiser
              </button>
            </div>
            </div>
          </SettingsPanel>
        </div>

        {/* Presence */}
        <div className="bg-white p-4 rounded-2xl shadow">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-medium">Présents au round #{lockedRounds.length + 1}</h2>
            <div className="text-sm text-gray-500">Coche/décoche pour retards/départs (n'affecte que le <em>prochain</em> round).</div>
          </div>
          <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2">
            {range(N).map((i) => (
              <div
                key={i}
                className={`flex items-center gap-2 px-3 py-2 rounded-xl border cursor-pointer ${present.has(i) ? "bg-green-50 border-green-300" : "bg-gray-50"} ${highlighted != null ? (highlighted === i ? 'ring-2 ring-indigo-400' : 'opacity-50') : ''}`}
                onClick={() => setHighlighted(highlighted === i ? null : i)}
              >
                <input type="checkbox" checked={present.has(i)} onChange={() => togglePresent(i)} onClick={(e) => e.stopPropagation()} />
                <span className="text-xs font-medium text-gray-600 shrink-0">{defaultName(i)}</span>
                <input
                  type="text"
                  className="text-sm flex-1 min-w-0 bg-transparent outline-none"
                  value={names[i] ?? ""}
                  onChange={(e) => { setName(i, e.target.value); setHighlighted(i); }}
                  onFocus={() => setHighlighted(i)}
                  onClick={(e) => { e.stopPropagation(); setHighlighted(i); }}
                  placeholder="Prénom (optionnel)"
                />
              </div>
            ))}
          </div>
        </div>

        {/* Rounds cards (mobile-first) */}
        <div className="space-y-4">
          {!isConfigIncomplete && tableRounds.map((row, rIdx) => (
            <div key={rIdx} className="rounded-2xl border bg-white p-4 shadow">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-2">
                  <h3 className="text-base font-medium">Round {rIdx + 1}</h3>
                  <span className="text-xs text-gray-500">{rIdx < lockedRounds.length ? "✅" : rIdx === lockedRounds.length ? "(prochain)" : ""}</span>
                </div>
                <div className="flex gap-2">
                  {rIdx === lockedRounds.length && (
                    <button
                      className="px-3 py-1.5 rounded-lg bg-emerald-600 text-white hover:bg-emerald-500 flex items-center gap-1.5"
                      onClick={lockNextRound}
                    >
                      <CheckCircle className="w-4 h-4" />
                      <span>Valider</span>
                    </button>
                  )}
                  {rIdx === lockedRounds.length - 1 && (
                    <button
                      className="px-3 py-1.5 rounded-lg bg-amber-600 text-white hover:bg-amber-500 flex items-center gap-1.5"
                      onClick={unlockLastRound}
                    >
                      <Undo2 className="w-4 h-4" />
                      <span>Revenir ici</span>
                    </button>
                  )}
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {row.groups.map((G, gi) => {
                  const repeats = groupRepeatCount(G, row.base);
                  return (
                    <div key={gi} className="rounded-xl border px-3 py-2 bg-gray-50">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-semibold text-gray-500">G{gi + 1}</span>
                        <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-800">{repeats} répétitions</span>
                      </div>
                      <div className="mt-1 grid grid-cols-1 sm:grid-cols-2 gap-1">
                        {G.map((p) => {
                          const custom = (names[p] ?? "").trim();
                          const label = custom ? `${defaultName(p)} · ${custom}` : defaultName(p);
                          const repeatPeers = G.filter((q) => q !== p && row.base[Math.min(p, q)][Math.max(p, q)] > 0);
                          const repeatCount = repeatPeers.length;
                          const title = repeatCount > 0 ? `Déjà vu avec: ${repeatPeers.map((q) => {
                            const c = (names[q] ?? "").trim();
                            return c ? `${defaultName(q)} · ${c}` : defaultName(q);
                          }).join(", ")}` : undefined;
                          const chipClass = repeatCount > 0
                            ? "text-xs px-2 py-1 rounded-lg bg-amber-50 border border-amber-300 text-amber-900 inline-flex flex-col items-start"
                            : "text-xs px-2 py-1 rounded-lg bg-white border inline-flex flex-col items-start";
                          return (
                            <button
                              key={p}
                              className={`${chipClass} w-full sm:w-auto ${highlighted === p ? 'ring-2 ring-indigo-400' : highlighted != null ? 'opacity-50' : ''}`}
                              title={title}
                              onClick={() => setHighlighted(highlighted === p ? null : p)}
                            >
                              <span className="inline-flex items-center gap-1.5">{label}</span>
                              {repeatCount > 0 && (
                                <span className="mt-1 inline-flex items-center gap-1.5 text-[10px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-800 border border-amber-200">
                                  <History className="w-3 h-3" />
                                  <span>{repeatCount} : {repeatPeers.map((q) => defaultName(q)).join(", ")}</span>
                                </span>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
          {isConfigIncomplete && (
            <div className="rounded-2xl border bg-white p-4 shadow text-sm text-gray-600">
              Complétez les champs N et R pour afficher le planning.
            </div>
          )}
        </div>
        <footer className="pt-4 text-center text-xs text-gray-500">
          Réalisé avec <span className="text-red-500">♥︎</span> par <a href="https://www.jzs.fr/" target="_blank" rel="noopener noreferrer" className="underline hover:text-gray-700">Jean Sordes</a>
        </footer>
      </div>
    </div>
  );
}
