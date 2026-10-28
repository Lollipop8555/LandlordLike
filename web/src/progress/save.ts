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
  /**
   * 彩蛋统计：原版 Stats.gd 里那批「跟玩法无关、只喂成就」的计数器。
   * 单位沿用原版（摸狗是小时、酒精是加仑、兔毛是磅），阈值才和原版成就能对上。
   */
  petDogHours: number;
  rabbitHops: number;
  rabbitFluff: number;
  alcoholGallons: number;
  /** 断头台处决的亿万富翁数 */
  guillotined: number;
  /** 玩家自己被处决的次数 */
  executions: number;
  /** 扎罗夫将军杀的人 */
  zaroffKills: number;
}

/**
 * 原版统计名 → 存档字段。声明里的 `stat_to_change` 用的是源码原名，
 * 这里做一层映射，避免把 GDScript 命名漏进存档与 UI。
 */
export const STAT_KEYS: Record<string, keyof Stats> = {
  time_spent_petting_dog: 'petDogHours',
  rabbit_hops: 'rabbitHops',
  rabbit_fluff_shed: 'rabbitFluff',
  alcohol_consumed: 'alcoholGallons',
  billionaires_guillotined: 'guillotined',
  times_executed: 'executions',
  humans_murdered_by_general_zaroff: 'zaroffKills',
};

export interface Profile {
  version: 1;
  stats: Stats;
  /** 成就 id → 解锁时间戳 */
  unlocked: Record<string, number>;
  lastMode: GameMode;
  /**
   * 已通关的最高层（0 = 还没打赢过第 1 层）。
   * 可选的层数是 `min(MAX_FLOOR, topFloor + 1)`：打赢第 N 层才放行第 N+1 层，
   * 和原版"逐层解锁"一致；否则一上来就能选第 20 层，难度曲线形同虚设。
   */
  topFloor: number;
  /**
   * 是否看过首次引导。看过就不再自动弹（HUD 里的 ❓ 随时能重看），
   * 否则每次开局都盖一层弹窗，老玩家会被反复打断。
   */
  tutorialDone: boolean;
}

const KEY = 'landlordlike.profile.v1';

function emptyStats(): Stats {
  return {
    runs: 0,
    wins: 0,
    losses: 0,
    bestPayment: 0,
    bestEarned: 0,
    totalSpins: 0,
    bosses: 0,
    buys: 0,
    petDogHours: 0,
    rabbitHops: 0,
    rabbitFluff: 0,
    alcoholGallons: 0,
    guillotined: 0,
    executions: 0,
    zaroffKills: 0,
  };
}

export function emptyProfile(): Profile {
  return {
    version: 1,
    stats: emptyStats(),
    unlocked: {},
    lastMode: 'normal',
    topFloor: 0,
    tutorialDone: false,
  };
}

export function loadProfile(): Profile {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return emptyProfile();
    const data = JSON.parse(raw) as Partial<Profile>;
    const base = emptyProfile();
    const stats = { ...base.stats, ...(data.stats ?? {}) };
    return {
      version: 1,
      stats,
      unlocked: data.unlocked ?? {},
      lastMode: data.lastMode ?? 'normal',
      // 老存档没有 topFloor：给已有胜场的老玩家留一层，别让他们被一条新规则挡在门外
      topFloor: typeof data.topFloor === 'number' ? data.topFloor : stats.wins > 0 ? 1 : 0,
      // 已经开过局的老档不再弹引导：他们显然不需要被教怎么转
      tutorialDone: typeof data.tutorialDone === 'boolean' ? data.tutorialDone : stats.runs > 0,
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
    /** 本局所在楼层，用于逐层解锁 */
    floor: number;
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
  // 打赢第 N 层 → 放行第 N+1 层；沙盒/无尽通关不推进（不是常规难度曲线）
  if (result.won && result.mode === 'normal') {
    profile.topFloor = Math.max(profile.topFloor, result.floor);
  }
  profile.lastMode = result.mode;
  saveProfile(profile);
}
