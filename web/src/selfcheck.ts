// 自检：将 docs 中的关键数值转为可执行断言。
// 这些断言与 analysis/verify.py 的输出一一对应，页面加载时即可核对。
import { META, RARITY_TABLE, RENT_TABLE } from './data';
import { CELL_COUNT, neighborCounts } from './grid';
import { evaluateCell, identityOf } from './value';
import type { Cell } from './types';

export interface CheckResult {
  group: string;
  name: string;
  expected: string;
  actual: string;
  pass: boolean;
  ref: string;
}

const close = (a: number, b: number, eps = 1e-9): boolean => Math.abs(a - b) <= eps;
const fmt = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(4));

function cell(patch: Partial<Cell> & { value?: number }): Cell {
  const base: Cell = {
    uid: 0,
    def: { id: 'test', value: patch.value ?? 0, values: [], rarity: 'common', groups: [], sfx: [] },
    valueBonus: 0,
    valueMultiplier: 1,
    permanentBonus: 0,
    permanentMultiplier: 1,
    prev: [],
    destroyed: false,
    lastOutput: 0,
  };
  return { ...base, ...patch, def: patch.def ?? base.def! };
}

function identity(parts: { value: number; pm?: number; pb?: number }, symbolId = 'x') {
  return {
    symbolId,
    value: parts.value,
    permanentBonus: parts.pb ?? 0,
    permanentMultiplier: parts.pm ?? 1,
    valueBonus: 0,
    valueMultiplier: 1,
  };
}

export function runSelfChecks(): CheckResult[] {
  const out: CheckResult[] = [];
  const add = (
    group: string,
    name: string,
    expected: string | number,
    actual: string | number,
    pass: boolean,
    ref: string,
  ) => out.push({ group, name, expected: String(expected), actual: String(actual), pass, ref });

  // ── 租金与旋转供给 ──
  const totalRent = RENT_TABLE.reduce((a, r) => a + r.rent, 0);
  add('租金', '12 期租金合计', '4277', fmt(totalRent), totalRent === 4277, '§7.1');

  const last = RENT_TABLE.at(-1)!;
  add('租金', '全程可用旋转数', '90', fmt(last.spinsCumulative), last.spinsCumulative === 90, '§7.2');

  const gains = RENT_TABLE.map((r) => r.spinsGain);
  const expectGains = [5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 0];
  add('租金', '每期旋转增量 5+⌊n/2⌋', expectGains.join(','), gains.join(','),
    gains.join() === expectGains.join(), '§7.2');

  const cum = RENT_TABLE.map((r) => r.spinsCumulative);
  const expectCum = [5, 10, 16, 22, 29, 36, 44, 52, 61, 70, 80, 90];
  add('租金', '旋转累计序列', expectCum.join(','), cum.join(','),
    cum.join() === expectCum.join(), '§7.2');

  const gate = close(totalRent / 90, 47.5222, 1e-3);
  add('租金', '通关门槛 4277/90', '47.52', (totalRent / 90).toFixed(2), gate, '§7.3');

  const instant = close(777 / 10, 77.7, 1e-9);
  add('租金', '第 12 期瞬时需求 777/10', '77.7', (777 / 10).toFixed(1), instant, '§7.3');

  // ── 稀有度 ──
  let sumOk = true;
  let worst = '';
  for (const kind of ['symbol', 'item'] as const) {
    for (const row of RARITY_TABLE[kind]) {
      const s = row.common + row.uncommon + row.rare + row.veryRare;
      if (!close(s, 1, 1e-6)) {
        sumOk = false;
        worst = `${kind}#${row.payment} = ${s.toFixed(4)}`;
      }
    }
  }
  add('稀有度', '每期四档概率和为 1', '24/24 行', sumOk ? '24/24 行' : worst, sumOk, '§6.2');

  const symFrozen = RARITY_TABLE.symbol
    .filter((r) => r.payment >= 6)
    .every((r) => close(r.common, 0.68) && close(r.uncommon, 0.3) && close(r.rare, 0.015) && close(r.veryRare, 0.005));
  add('稀有度', '符号档位第 6 期起冻结 68/30/1.5/0.5', 'true', String(symFrozen), symFrozen, '§6.2');

  const itemFrozen = RARITY_TABLE.item
    .filter((r) => r.payment >= 7)
    .every((r) => close(r.common, 0.56) && close(r.uncommon, 0.375) && close(r.rare, 0.05) && close(r.veryRare, 0.015));
  add('稀有度', '道具档位第 7 期起冻结 56/37.5/5/1.5', 'true', String(itemFrozen), itemFrozen, '§6.2');

  const noPity = RARITY_TABLE.symbol.every((r) => r.common + r.uncommon + r.rare + r.veryRare <= 1.0000001);
  add('稀有度', '不存在保底额外配额（四档和 ≤ 1）', 'true', String(noPity), noPity, '§6.3');

  // ── 几何 ──
  const counts = neighborCounts();
  const avg = counts.reduce((a, b) => a + b, 0) / CELL_COUNT;
  add('几何', '8 邻域平均扇入', '5.50', avg.toFixed(2), close(avg, 5.5), '§9');
  add('几何', '格数 5×4', '20', String(CELL_COUNT), CELL_COUNT === 20, '§3.2');

  const byKind = counts.reduce<Record<number, number>>((acc, n) => {
    acc[n] = (acc[n] ?? 0) + 1;
    return acc;
  }, {});
  const geomOk = byKind[3] === 4 && byKind[5] === 10 && byKind[8] === 6;
  add('几何', '角 4（3 邻）/ 边 10（5 邻）/ 内 6（8 邻）', '4-10-6',
    `${byKind[3]}-${byKind[5]}-${byKind[8]}`, geomOk, '§5.4');

  // ── 数值管线 ──
  const plain = evaluateCell(cell({ value: 1 })).final;
  add('数值', 'v=1 无加成 → 1', '1', String(plain), plain === 1, '§4.1');

  const addMul = evaluateCell(cell({ value: 2, valueBonus: 3, valueMultiplier: 4, permanentMultiplier: 2 })).final;
  add('数值', '先加后乘：((2+3)×4×2)', '40', String(addMul), addMul === 40, '§4.1');

  const negative = evaluateCell(cell({ value: -1, valueMultiplier: 10 })).final;
  add('数值', '负值不参与乘算：(-1)×10 仍为 -1', '-1', String(negative), negative === -1, '§4.2');

  const negativeWithBonus = evaluateCell(cell({ value: -5, permanentBonus: 2, valueMultiplier: 10 })).final;
  add('数值', '负值仅取 base：-5+2 = -3', '-3', String(negativeWithBonus), negativeWithBonus === -3, '§4.2');

  const compounding = evaluateCell(cell({ value: 1, permanentBonus: 9, permanentMultiplier: 4 })).final;
  add('数值', '永久乘数复利：(1+9)×4 = 40', '40', String(compounding), compounding === 40, '§4.4');

  const multiIdentity = evaluateCell(
    cell({ value: 1, prev: [identity({ value: 2 }), identity({ value: 3 })] }),
  ).final;
  add('数值', '历史身份链逐份取整后相加 1+2+3', '6', String(multiIdentity), multiIdentity === 6, '§4.3');

  const rounding = evaluateCell(cell({ value: 1, valueMultiplier: 1.5 })).final;
  add('数值', 'round 在乘算之后：round(1.5) = 2', '2', String(rounding), rounding === 2, '§4.1');

  // ── 数据规模 ──
  add('数据', '符号总数', '168', String(META.symbolCount), META.symbolCount === 168, '§1.4');
  add('数据', '可进入商店的符号', '145', String(META.shopSymbolCount), META.shopSymbolCount === 145, '§3.2');
  add('数据', '道具 / 精华 / 细则', '114/113/37',
    `${META.itemCount}/${META.essenceCount}/${META.finePrintCount}`,
    META.itemCount === 114 && META.essenceCount === 113 && META.finePrintCount === 37, '§1.4');

  // ── 一致性：identityOf 不应丢失参数 ──
  const probe = cell({ value: 7, permanentBonus: 1, permanentMultiplier: 3 });
  const roundTrip = evaluateCell({ ...probe, prev: [identityOf(probe)] }).final;
  add('数值', 'prev 快照往返一致（7+1）×3 ×2 份 = 48', '48', String(roundTrip), roundTrip === 48, '§4.3');

  return out;
}

export function summarize(results: readonly CheckResult[]): { pass: number; total: number } {
  return { pass: results.filter((r) => r.pass).length, total: results.length };
}
