// 组协同：本文件的所有规则都只从 data/symbols.csv 的 `groups` 字段推导，
// 不依赖源码里逐符号的 add_effect 声明（那部分在分析文档中是未完成项）。
//
// 可推导的三类语义：
//   1) `<组>likes`  —— 该符号喜欢相邻的 `<组>`，每个匹配邻格 +1
//   2) `eachother`  —— 与相邻的同组成员互相 +1
//   3) `scaler`     —— 每次旋转永久 +1（线性成长，不清空）
// 页面会明确标注这三条是「数据驱动推断」，与源码级结论分开呈现。
import { neighborsOf } from './grid';
import type { Cell } from './types';

export interface SynergyHit {
  to: number;
  from: number;
  amount: number;
  rule: 'likes' | 'eachother';
  group: string;
}

export interface SynergyReport {
  hits: SynergyHit[];
  /** 每格来自协同的加算合计 */
  bonusByCell: Map<number, number>;
  scalerCells: number[];
}

const LIKE_SUFFIX = 'likes';

export function applySynergies(cells: Cell[]): SynergyReport {
  const hits: SynergyHit[] = [];
  const bonusByCell = new Map<number, number>();

  // 临时加成每轮清空（§4.5），永久加成保留
  for (const cell of cells) {
    cell.valueBonus = 0;
    cell.valueMultiplier = 1;
  }

  cells.forEach((cell, i) => {
    if (!cell.def) return;
    const groups = cell.def.groups ?? [];
    const likeTargets = groups
      .filter((g) => g.endsWith(LIKE_SUFFIX) && g.length > LIKE_SUFFIX.length)
      .map((g) => g.slice(0, -LIKE_SUFFIX.length));
    const mutual = groups.includes('eachother');

    for (const j of neighborsOf(i)) {
      const other = cells[j];
      if (!other?.def) continue;
      const otherGroups = other.def.groups ?? [];
      if (!otherGroups.length) continue;

      // 1) likes：同一邻格只结算一次，避免多组重复叠加
      const liked = likeTargets.find((t) => otherGroups.includes(t));
      if (liked) {
        cell.valueBonus += 1;
        hits.push({ to: i, from: j, amount: 1, rule: 'likes', group: liked });
        bonusByCell.set(i, (bonusByCell.get(i) ?? 0) + 1);
        continue;
      }

      // 2) eachother：共享非元组标签即视为同类
      if (mutual) {
        const shared = groups.find((g) => g !== 'eachother' && otherGroups.includes(g));
        if (shared) {
          cell.valueBonus += 1;
          hits.push({ to: i, from: j, amount: 1, rule: 'eachother', group: shared });
          bonusByCell.set(i, (bonusByCell.get(i) ?? 0) + 1);
        }
      }
    }
  });

  const scalerCells: number[] = [];
  cells.forEach((cell, i) => {
    if (cell.def && (cell.def.groups ?? []).includes('scaler')) scalerCells.push(i);
  });

  return { hits, bonusByCell, scalerCells };
}

/** scaler 的线性成长：每次旋转永久 +1 */
export function growScalers(cells: Cell[], indices: readonly number[]): void {
  for (const i of indices) {
    const cell = cells[i];
    if (cell?.def) cell.permanentBonus += 1;
  }
}
