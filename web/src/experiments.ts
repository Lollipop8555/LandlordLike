// 对照实验：把 docs 里几个"看起来只是措辞"的结论变成可测量的差异
import { CELL_COUNT } from './grid';
import { mulberry32, shuffle, type Random } from './rng';
import { rollRarity } from './engine';
import { RARITY_TABLE, RENT_TABLE } from './data';
import type { Rarity } from './types';

/** 洗牌模型下，池中某个特定符号出现在可视区的概率（理论值 P = 20/S） */
export function shuffleHitTheory(S: number): number {
  return Math.min(CELL_COUNT, S) / S;
}

/** 有放回抽取模型下的解析概率 1-(1-1/S)^20 */
export function drawHitTheory(S: number): number {
  return 1 - (1 - 1 / S) ** Math.min(CELL_COUNT, S);
}

/** 蒙特卡洛：洗牌模型的命中率 */
export function simulateShuffleHit(S: number, trials: number, rand: Random): number {
  const visible = Math.min(CELL_COUNT, S);
  let hit = 0;
  for (let t = 0; t < trials; t += 1) {
    const arr = Array.from({ length: S }, (_, i) => i);
    shuffle(rand, arr);
    for (let i = 0; i < visible; i += 1) {
      if (arr[i] === 0) {
        hit += 1;
        break;
      }
    }
  }
  return hit / trials;
}

/** 蒙特卡洛：有放回抽取模型的命中率 */
export function simulateDrawHit(S: number, trials: number, rand: Random): number {
  let hit = 0;
  for (let t = 0; t < trials; t += 1) {
    for (let i = 0; i < CELL_COUNT; i += 1) {
      if (Math.floor(rand() * S) === 0) {
        hit += 1;
        break;
      }
    }
  }
  return hit / trials;
}

export interface ShuffleVsDraw {
  S: number;
  shuffleTheory: number;
  shuffleMeasured: number;
  drawTheory: number;
  drawMeasured: number;
  /** 两者相差的绝对百分点 */
  gapPp: number;
}

export function compareShuffleVsDraw(S: number, trials: number, seed = 12345): ShuffleVsDraw {
  const rand = mulberry32(seed);
  const shuffleMeasured = simulateShuffleHit(S, trials, rand);
  const drawMeasured = simulateDrawHit(S, trials, rand);
  return {
    S,
    shuffleTheory: shuffleHitTheory(S),
    shuffleMeasured,
    drawTheory: drawHitTheory(S),
    drawMeasured,
    gapPp: Math.abs(shuffleHitTheory(S) - drawHitTheory(S)) * 100,
  };
}

export interface RarityObservation {
  rarity: Rarity;
  expected: number;
  measured: number;
  delta: number;
}

/** 按某一期的概率表抽样，检验实现与表一致 */
export function observeRarity(payment: number, trials = 60000, seed = 99): RarityObservation[] {
  const row = RARITY_TABLE.symbol[Math.min(payment - 1, RARITY_TABLE.symbol.length - 1)];
  const rand = mulberry32(seed);
  const counts: Record<Rarity, number> = { common: 0, uncommon: 0, rare: 0, very_rare: 0 };
  for (let i = 0; i < trials; i += 1) counts[rollRarity(rand, row)] += 1;
  const expected: Record<Rarity, number> = {
    common: row.common,
    uncommon: row.uncommon,
    rare: row.rare,
    very_rare: row.veryRare,
  };
  return (['very_rare', 'rare', 'uncommon', 'common'] as Rarity[]).map((r) => ({
    rarity: r,
    expected: expected[r],
    measured: counts[r] / trials,
    delta: counts[r] / trials - expected[r],
  }));
}

export interface RentStage {
  payment: number;
  rent: number;
  spins: number;
  needPerSpin: number;
  affordable: boolean;
}

/** 给定平均每 spin 产出，逐期检验能否付得起租金（余额结转，§7.6） */
export function simulateRentPath(avgPerSpin: number): { stages: RentStage[]; cleared: boolean } {
  let coins = 0;
  let spins = 5;
  const stages: RentStage[] = [];
  let cleared = true;
  for (const row of RENT_TABLE) {
    coins += avgPerSpin * spins;
    const affordable = coins >= row.rent;
    stages.push({
      payment: row.payment,
      rent: row.rent,
      spins,
      needPerSpin: row.rent / spins,
      affordable,
    });
    if (!affordable) cleared = false;
    coins -= row.rent;
    spins = row.spinsGain;
  }
  return { stages, cleared };
}

/** 通关所需的最低恒定产出：二分求解 */
export function breakEvenAvgPerSpin(): number {
  let lo = 0;
  let hi = 200;
  for (let i = 0; i < 60; i += 1) {
    const mid = (lo + hi) / 2;
    if (simulateRentPath(mid).cleared) hi = mid;
    else lo = mid;
  }
  return hi;
}
