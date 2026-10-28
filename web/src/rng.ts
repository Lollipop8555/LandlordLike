// 可注入种子的随机源：让每次实验都能复现（自检需要）
export type Random = () => number;

/**
 * 带抽样计数的随机源。
 * `calls` 用来做对局存档：随机数本身是闭包存不进 JSON，但「同一个 seed 抽了
 * 多少次」足以复原出同一串数（恢复时快进同样次数即可）。
 */
export interface CountedRandom extends Random {
  calls: number;
}

/** mulberry32：32 位种子，序列稳定，足够模拟用 */
export function mulberry32(seed: number): CountedRandom {
  let a = seed >>> 0;
  const next = (() => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    next.calls += 1;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }) as CountedRandom;
  next.calls = 0;
  return next;
}

export function pick<T>(rand: Random, list: readonly T[]): T {
  return list[Math.floor(rand() * list.length)];
}

/** Fisher–Yates 原地洗牌 */
export function shuffle<T>(rand: Random, list: T[]): T[] {
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}
