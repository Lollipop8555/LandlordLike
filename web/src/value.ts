// 数值管线：严格实现 docs §4.1 / §4.2 / §4.3
//
//   base  = value + Σ value_bonus + permanent_bonus
//   raw   = base × Π value_multiplier × permanent_multiplier
//   final = round(raw) + Σ_prev round(raw_prev)
//
// raw < 0 时不吃乘数（§4.2），只取 base。
import type { Cell, PrevIdentity } from './types';

export interface IdentityBreakdown {
  symbolId: string;
  /** 是否为历史身份 */
  historical: boolean;
  base: number;
  raw: number;
  /** 乘数是否被跳过（负值保护） */
  multiplierSkipped: boolean;
  final: number;
}

export interface CellBreakdown {
  parts: IdentityBreakdown[];
  final: number;
  /** 若按「负值参与乘算」的错误模型会得到多少——用于对照实验 */
  wrongIfNegativeMultiplied: number;
}

function evaluateIdentity(identity: PrevIdentity, historical: boolean): IdentityBreakdown {
  const base = identity.value + identity.valueBonus + identity.permanentBonus;
  const raw = base * identity.valueMultiplier * identity.permanentMultiplier;
  const multiplierSkipped = raw < 0;
  const final = Math.round(multiplierSkipped ? base : raw);
  return {
    symbolId: identity.symbolId,
    historical,
    base,
    raw,
    multiplierSkipped,
    final,
  };
}

export function identityOf(cell: Cell): PrevIdentity {
  return {
    symbolId: cell.def?.id ?? 'empty',
    value: cell.def?.value ?? 0,
    permanentBonus: cell.permanentBonus,
    permanentMultiplier: cell.permanentMultiplier,
    valueBonus: cell.valueBonus,
    valueMultiplier: cell.valueMultiplier,
  };
}

/** 单格结算：当前身份 + 历史身份链 */
export function evaluateCell(cell: Cell): CellBreakdown {
  const current = evaluateIdentity(identityOf(cell), false);
  const parts = [current, ...cell.prev.map((p) => evaluateIdentity(p, true))];
  const final = parts.reduce((a, p) => a + p.final, 0);

  // 对照：如果不做负值保护，直接把 raw 四舍五入
  const wrongCurrent = Math.round(current.raw);
  const wrongIfNegativeMultiplied =
    wrongCurrent + parts.slice(1).reduce((a, p) => a + p.final, 0);

  return { parts, final, wrongIfNegativeMultiplied };
}

/** 全盘汇总 */
export function boardTotal(cells: readonly Cell[]): number {
  return cells.reduce((a, c) => a + (c.destroyed ? 0 : evaluateCell(c).final), 0);
}
