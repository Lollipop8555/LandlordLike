// 进行中对局的落盘与恢复。
//
// 存档只做一件事：把 `GameState` 原样摊平成 JSON，下次打开时把引用接回去。
// 两个要点：
//   · 符号/道具定义是共享对象（`SYMBOL_BY_ID`），存档里只留 id，恢复时查回
//     同一个实例，否则 `cells` 里存下来的旧 `def` 会和资产池里的新 `def` 分家；
//   · 随机数是闭包，存不了。这里记下 seed 与已抽样次数，恢复时用同一个
//     `mulberry32` 快进到同一位置，后续旋转才和刷新前连着。

import { ITEM_BY_ID, SYMBOL_BY_ID } from '../data';
import { visibleCells, type GameState } from '../engine';
import { mulberry32 } from '../rng';

const RUN_KEY = 'landlordlike.run.v1';

interface RunSnapshot {
  v: 1;
  seed: number;
  randCalls: number;
  savedAt: number;
  state: unknown;
}

type DefLike = { id?: unknown; value?: unknown; values?: unknown; rarity?: unknown };

function isDef(value: object): boolean {
  const rec = value as DefLike;
  return (
    typeof rec.id === 'string' &&
    typeof rec.value === 'number' &&
    'values' in rec &&
    'rarity' in rec
  );
}

function encode(value: unknown): unknown {
  if (value === null) return null;
  if (typeof value !== 'object') return typeof value === 'function' ? undefined : value;
  if (Array.isArray(value)) return value.map((item) => encode(item) ?? null);
  if (value instanceof Set || value instanceof Map) return undefined;
  const rec = value as Record<string, unknown>;
  if (isDef(value)) return { __def: rec.id as string };

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(rec)) {
    if (typeof item === 'function') continue;
    const encoded = encode(item);
    if (encoded !== undefined) out[key] = encoded;
  }
  return out;
}

function decode(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => decode(item));
  const rec = value as Record<string, unknown>;
  if (typeof rec.__def === 'string') {
    const def = SYMBOL_BY_ID.get(rec.__def) ?? ITEM_BY_ID.get(rec.__def);
    if (!def) throw new Error(`存档引用了不存在的定义：${rec.__def}`);
    return def;
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(rec)) out[key] = decode(item);
  return out;
}

export function saveRun(state: GameState): void {
  if (state.over || state.won) {
    clearRun();
    return;
  }
  try {
    const snapshot: RunSnapshot = {
      v: 1,
      seed: state.seed,
      randCalls: (state.rand as unknown as { calls?: number }).calls ?? 0,
      savedAt: Date.now(),
      state: encode(state),
    };
    localStorage.setItem(RUN_KEY, JSON.stringify(snapshot));
  } catch {
    /* 隐私模式/配额满：存不下就算了，不能因为存档失败打断对局 */
  }
}

export function loadRun(): GameState | null {
  try {
    const raw = localStorage.getItem(RUN_KEY);
    if (!raw) return null;
    const snap = JSON.parse(raw) as Partial<RunSnapshot>;
    if (snap.v !== 1 || !snap.state || typeof snap.seed !== 'number') return null;
    const state = decode(snap.state) as GameState;
    // 引用接回去：cells 必须是 reels 的投影，否则下一转会把布局打回原状
    state.cells = visibleCells(state.reels);
    // 旧存档补字段（这几项是生成/彩蛋机制接入后新增的）
    state.lastKills ??= [];
    state.lastSpawned ??= [];
    state.pendingStats ??= {};
    const rand = mulberry32(snap.seed);
    const calls = Math.max(0, Math.trunc(snap.randCalls ?? 0));
    for (let i = 0; i < calls; i += 1) rand();
    state.rand = rand;
    if (!state.reels || state.over || state.won) {
      clearRun();
      return null;
    }
    return state;
  } catch {
    clearRun();
    return null;
  }
}

export function hasRun(): boolean {
  try {
    return Boolean(localStorage.getItem(RUN_KEY));
  } catch {
    return false;
  }
}

export function clearRun(): void {
  try {
    localStorage.removeItem(RUN_KEY);
  } catch {
    /* 忽略：清不掉也不影响 */
  }
}
