// 可注入种子的随机源：让每次实验都能复现（自检需要）
export type Random = () => number;

/** mulberry32：32 位种子，序列稳定，足够模拟用 */
export function mulberry32(seed: number): Random {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
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
