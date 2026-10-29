// 数值管线：严格实现 Slot_Icon__Slot_Icon.gd:1080 get_value() / :988 get_non_flat_value()
//
//   base  = value + Σ value_bonus + permanent_bonus
//   raw   = base × Π value_multiplier × permanent_multiplier
//   final = round(raw) + Σ_prev round(raw_prev) + flat_value_bonus
//
// 三条原版规约（都在 get_value 里）：
//   · raw < 0 时不吃乘数，只取 base（§4.2）
//   · drained 为真直接返回 0（:1081，hex_of_draining 的汲取）
//   · wildcarded 且处于结算期时，base 改用 flat_value_bonus（:1095-1096）
//     —— 万能牌不产出自己的值，而是复制相邻格「固定加值」的水平
import type { Cell, PrevIdentity } from './types';

export interface IdentityBreakdown {
  symbolId: string;
  /** 是否为历史身份 */
  historical: boolean;
  base: number;
  raw: number;
  /** 乘数是否被跳过（负值保护） */
  multiplierSkipped: boolean;
  /** 是否因 drained 归零 */
  drained: boolean;
  final: number;
}

export interface CellBreakdown {
  parts: IdentityBreakdown[];
  final: number;
  /** 若按「负值参与乘算」的错误模型会得到多少——用于对照实验 */
  wrongIfNegativeMultiplied: number;
}

/**
 * @param historical 历史身份（prev_data）走同一套公式，但不吃 drained/wildcarded
 *                   —— 原版 `get_value` 的这两个分支只看当前格的状态。
 * @param trueFinalValue 是否处于「正式结算」阶段（reels.true_final_value）。
 *                   原版只在 `counting_effects` 之后为 true，那时万能牌才切换取值来源；
 *                   计算中间值时不切换，避免自引用。
 */
function evaluateIdentity(
  identity: PrevIdentity,
  historical: boolean,
  drained = false,
  wildcarded = false,
  trueFinalValue = false,
): IdentityBreakdown {
  // drained：原版 get_value 的第一行 `if drained: return 0`
  if (drained && !historical) {
    return { symbolId: identity.symbolId, historical, base: 0, raw: 0, multiplierSkipped: false, drained: true, final: 0 };
  }

  // 万能牌在结算期把 base 整体换成 flat_value_bonus（:1095-1096）：
  //   `if wildcarded and reels.true_final_value: v_str = "flat_value_bonus"`
  // 换成之后是「用自己的固定加值顶替」，不再额外叠加 tail。
  const wcActive = wildcarded && trueFinalValue && !historical;
  let base = identity.value + identity.valueBonus + identity.permanentBonus;
  if (wcActive) base = identity.flatValueBonus ?? 0;

  const raw = base * identity.valueMultiplier * identity.permanentMultiplier;
  const multiplierSkipped = raw < 0;
  const rounded = Math.round(multiplierSkipped ? base : raw);
  // 非万能牌：flat_value_bonus 于乘算之后无条件加回
  //   （get_non_prev_value 的 `... + int(self[fvb_str])`）
  // 历史身份不参与：原版 prev_data 快照里的 fvb 只在被复制时记录，不重复计分。
  const tail = historical || wcActive ? 0 : (identity.flatValueBonus ?? 0);
  const final = rounded + tail;

  return { symbolId: identity.symbolId, historical, base, raw, multiplierSkipped, drained: false, final };
}

export function identityOf(cell: Cell): PrevIdentity {
  return {
    symbolId: cell.def?.id ?? 'empty',
    value: cell.def?.value ?? 0,
    permanentBonus: cell.permanentBonus,
    permanentMultiplier: cell.permanentMultiplier,
    valueBonus: cell.valueBonus,
    valueMultiplier: cell.valueMultiplier,
    flatValueBonus: cell.flatValueBonus ?? 0,
  };
}

/** 单格结算：当前身份 + 历史身份链 */
export function evaluateCell(cell: Cell): CellBreakdown {
  const identity = identityOf(cell);
  const current = evaluateIdentity(
    identity,
    false,
    cell.drained ?? false,
    cell.wildcarded ?? false,
    true,
  );
  const parts = [
    current,
    ...cell.prev.map((p) => evaluateIdentity(p, true)),
  ];
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
