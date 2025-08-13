import React, { useMemo, useEffect } from "react";
import { create } from "zustand";

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

function formatName(i) { return `P${String(i + 1).padStart(2, "0")}`; }

/*************************
 * Zustand store
 *************************/
const useMixerStore = create((set, get) => ({
  N: 24,
  R: 6,
  gPref: 4,
  allowFlex34: true,
  seed: 42,

  currentRound: 0,
  lockedRounds: [], // array of groups per round
  present: new Set(range(24)),

  setN: (val) => set((s) => ({ N: Math.max(2, val), present: new Set(range(Math.max(2, val))), lockedRounds: [], currentRound: 0 })),
  setR: (val) => set({ R: Math.max(1, val) }),
  setGPref: (val) => set({ gPref: val }),
  setAllowFlex34: (v) => set({ allowFlex34: v }),
  setSeed: (val) => set({ seed: val }),

  togglePresent: (i) => set((s) => {
    const p = new Set(s.present);
    if (p.has(i)) p.delete(i); else p.add(i);
    return { present: p };
  }),

  resetSchedule: () => set((s) => ({ lockedRounds: [], currentRound: 0, seed: s.seed + 1 })),

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

  const setN = useMixerStore((s) => s.setN);
  const setR = useMixerStore((s) => s.setR);
  const setGPref = useMixerStore((s) => s.setGPref);
  const setAllowFlex34 = useMixerStore((s) => s.setAllowFlex34);
  const setSeed = useMixerStore((s) => s.setSeed);
  const togglePresent = useMixerStore((s) => s.togglePresent);
  const resetSchedule = useMixerStore((s) => s.resetSchedule);
  const lockNextRound = useMixerStore((s) => s.lockNextRound);

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

  const baseC = C; // for repeat badges on preview rows

  function groupRepeatCount(G, base) {
    let s = 0; for (const [a, b] of combinations(G)) s += base[Math.min(a, b)][Math.max(a, b)] > 0 ? 1 : 0; return s;
  }

  const tableRounds = useMemo(() => {
    return [
      ...lockedRounds.map((groups) => ({ groups, locked: true })),
      ...upcoming.map((groups) => ({ groups, locked: false })),
    ].slice(0, R);
  }, [lockedRounds, upcoming, R]);

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <div className="max-w-7xl mx-auto p-6 space-y-6">
        <h1 className="text-2xl font-semibold">Networking Mixer Scheduler — Zustand</h1>
        <p className="text-sm text-gray-600">État global géré par Zustand. Groupes préférés de 4 avec option 3–4 flexible pour gérer retards/départs. Planification anti-doublons avec ajustement local, verrouillage round par round.</p>

        {/* Controls */}
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
          <div className="bg-white p-4 rounded-2xl shadow">
            <label className="block text-sm font-medium">Participants (N)</label>
            <input type="number" className="mt-1 w-full border rounded-xl px-3 py-2" value={N} min={2} onChange={(e) => setN(parseInt(e.target.value || "0", 10))} />
          </div>
          <div className="bg-white p-4 rounded-2xl shadow">
            <label className="block text-sm font-medium">Rounds (R)</label>
            <input type="number" className="mt-1 w-full border rounded-xl px-3 py-2" value={R} min={1} onChange={(e) => setR(parseInt(e.target.value || "0", 10))} />
          </div>
          <div className="bg-white p-4 rounded-2xl shadow">
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
          <div className="bg-white p-4 rounded-2xl shadow">
            <label className="block text-sm font-medium">Seed (aléa reproductible)</label>
            <input type="number" className="mt-1 w-full border rounded-xl px-3 py-2" value={seed} onChange={(e) => setSeed(parseInt(e.target.value || "0", 10))} />
          </div>
          <div className="bg-white p-4 rounded-2xl shadow flex items-end gap-3">
            <button className="px-4 py-2 rounded-xl bg-gray-900 text-white hover:bg-gray-800" onClick={resetSchedule}>Réinitialiser</button>
            <button className="px-4 py-2 rounded-xl bg-indigo-600 text-white hover:bg-indigo-500" onClick={lockNextRound}>Verrouiller le prochain round</button>
          </div>
        </div>

        {/* Presence */}
        <div className="bg-white p-4 rounded-2xl shadow">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-medium">Présents au round #{lockedRounds.length + 1}</h2>
            <div className="text-sm text-gray-500">Coche/décoche pour retards/départs (n'affecte que le <em>prochain</em> round).</div>
          </div>
          <div className="mt-3 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-2">
            {range(N).map((i) => (
              <label key={i} className={`flex items-center gap-2 px-3 py-2 rounded-xl border ${present.has(i) ? "bg-green-50 border-green-300" : "bg-gray-50"}`}>
                <input type="checkbox" checked={present.has(i)} onChange={() => togglePresent(i)} />
                <span className="text-sm">{formatName(i)}</span>
              </label>
            ))}
          </div>
        </div>

        {/* Rounds table */}
        <div className="bg-white p-4 rounded-2xl shadow">
          <h2 className="text-lg font-medium mb-3">Planning (mise à jour en temps réel)</h2>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left text-gray-600">
                  <th className="py-2 pr-4">Round</th>
                  <th className="py-2">Groupes</th>
                </tr>
              </thead>
              <tbody>
                {tableRounds.map((row, rIdx) => (
                  <tr key={rIdx} className="border-t">
                    <td className="py-3 pr-4 align-top font-medium">{rIdx + 1}{rIdx < lockedRounds.length ? " ✅" : rIdx === lockedRounds.length ? " (prochain)" : ""}</td>
                    <td className="py-3">
                      <div className="flex flex-wrap gap-2">
                        {row.groups.map((G, gi) => {
                          const repeats = groupRepeatCount(G, baseC);
                          return (
                            <div key={gi} className="rounded-xl border px-3 py-2 bg-gray-50">
                              <div className="flex items-center gap-2">
                                <span className="text-xs font-semibold text-gray-500">G{gi + 1}</span>
                                <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-800">{repeats} répétitions</span>
                              </div>
                              <div className="mt-1 flex flex-wrap gap-1">
                                {G.map((p) => (
                                  <span key={p} className="text-xs px-2 py-0.5 rounded-lg bg-white border">{formatName(p)}</span>
                                ))}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-gray-500 mt-3">La puce « répétitions » compte les paires qui se sont déjà vues dans les rounds verrouillés.</p>
        </div>

        <div className="text-xs text-gray-500">
          <ul className="list-disc pl-5 space-y-1">
            <li>Zustand centralise l'état (paramètres, présence, historique).</li>
            <li>« Verrouiller » ajoute le prochain round au planning et met à jour les co-rencontres.</li>
            <li>Change la seed pour recomposer une variante avec les mêmes paramètres.</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
