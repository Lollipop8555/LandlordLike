// 本地存档：统计与成就进度（对应原版的 Stats/存档模块）
// 只存玩家进度，不参与对局结算，读失败一律按新档处理。

import type { GameMode } from '../types';

export type { GameMode };

export interface Stats {
  /** 开局次数 */
  runs: number;
  /** 通关次数 */
  wins: number;
  /** 破产次数 */
  losses: number;
  /** 最远付租期数 */
  bestPayment: number;
  /** 单局最高累计产出 */
  bestEarned: number;
  /** 累计旋转次数 */
  totalSpins: number;
  /** 击败房东次数 */
  bosses: number;
  /** 累计购买次数 */
  buys: number;
}

export interface Profile {
  version: 1;
  stats: Stats;
  /** 成就 id → 解锁时间戳 */
  unlocked: Record<string, number>;
  lastMode: GameMode;
}

const KEY = 'landlordlike.profile.v1';

function emptyStats(): Stats {
  return { runs: 0, wins: 0, losses: 0, bestPayment: 0, bestEarned: 0, totalSpins: 0, bosses: 0, buys: 0 };
}

export function emptyProfile(): Profile {
  return { version: 1, stats: emptyStats(), unlocked: {}, lastMode: 'normal' };
}

export function loadProfile(): Profile {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return emptyProfile();
    const data = JSON.parse(raw) as Partial<Profile>;
    const base = emptyProfile();
    return {
      version: 1,
      stats: { ...base.stats, ...(data.stats ?? {}) },
      unlocked: data.unlocked ?? {},
      lastMode: data.lastMode ?? 'normal',
    };
  } catch {
    return emptyProfile();
  }
}

export function saveProfile(profile: Profile): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(profile));
  } catch {
    // 隐私模式下写入会失败，忽略即可，不影响对局
  }
}

export function resetProfile(): Profile {
  const next = emptyProfile();
  saveProfile(next);
  return next;
}

/** 记录一局结束 */
export function recordRun(
  profile: Profile,
  result: {
    won: boolean;
    bossWin: boolean;
    payment: number;
    earned: number;
    mode: GameMode;
    spins: number;
    buys: number;
  },
): void {
  const s = profile.stats;
  // 开局次数在 startRun 里累计（中途退出也算开过局），这里只记结果
  if (result.won) s.wins += 1;
  else if (result.mode !== 'sandbox') s.losses += 1;
  if (result.bossWin) s.bosses += 1;
  // 沙盒起步就是第 12 期、金币 999,999，记进最远付租/最高产出会盖掉普通模式的真实进度
  if (result.mode !== 'sandbox') {
    s.bestPayment = Math.max(s.bestPayment, result.payment);
    s.bestEarned = Math.max(s.bestEarned, result.earned);
  }
  s.totalSpins += result.spins;
  s.buys += result.buys;
  profile.lastMode = result.mode;
  saveProfile(profile);
}
