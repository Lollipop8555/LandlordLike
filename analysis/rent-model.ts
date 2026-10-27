// @ts-nocheck
/**
 * 租金—产出可行性验证（严格版）。
 *
 *   Part 1  租金/旋转表自洽：12 期、累计旋转、总租金
 *   Part 2  需求曲线：每期「每旋转需产出」，定位最陡区间
 *   Part 3  产出的数学上界：无道具模型下的稳态每旋转产出 S∞
 *   Part 4  可行性判定：累计可达上界 90 × S∞ 与 4,277 的比较
 *   Part 5  无尽外推：13 期以后的需求斜率，判断能否无限续命
 *   Part 6  floor 变体：rent.csv 六档楼层的差异是否影响结论
 *
 * 用法（仓库根目录）：
 *   npx esbuild analysis/rent-model.ts --bundle --platform=node --format=esm \
 *     --outfile=analysis/.build/rent-model.mjs --log-level=warning && node analysis/.build/rent-model.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

import { RENT_TABLE, SHOP_SYMBOLS, SYMBOLS, rentRowFor } from '../web/src/data';
import { buyFromShop, closeShop, createGame, spin } from '../web/src/engine';

let ROOT = process.cwd();
while (!fs.existsSync(path.join(ROOT, '.gitignore')) && ROOT !== path.dirname(ROOT)) {
  ROOT = path.dirname(ROOT);
}

let failed = 0;
function assert(name: string, ok: boolean, detail = ''): void {
  if (!ok) failed += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  — ${detail}` : ''}`);
}
const f = (n: number, d = 2): string => n.toFixed(d);

/* ── Part 1. 表自洽 ── */

console.log('\nPart 1  租金/旋转表');
const periods = RENT_TABLE.length;
const cum = RENT_TABLE.map((r) => r.spinsCumulative);
const spinsOf = (i: number): number => (i === 1 ? cum[0] : cum[i - 1] - cum[i - 2]);
const totalRent = RENT_TABLE.reduce((a, r) => a + r.rent, 0);
const totalSpins = cum[cum.length - 1];

assert('12 期', periods === 12, `${periods} 期`);
assert('payment 连续 1..12', RENT_TABLE.every((r, i) => r.payment === i + 1));
assert(`总租金 = ${totalRent}`, totalRent === 4277, String(totalRent));
assert(`总旋转 = ${totalSpins}`, totalSpins === 90, String(totalSpins));
assert(
  '累计旋转单调递增',
  cum.every((v, i) => i === 0 || v > cum[i - 1]),
  cum.join(' → '),
);
assert(
  '每期新增旋转 = 上一行 spinsGain',
  RENT_TABLE.every((r, i) => i === 0 || spinsOf(i + 1) === RENT_TABLE[i - 1].spinsGain),
);
assert(
  '每旋转平均需求 = 47.52',
  Math.abs(totalRent / totalSpins - 47.52) < 0.005,
  f(totalRent / totalSpins),
);

/* ── Part 2. 需求曲线 ── */

console.log('\nPart 2  逐期需求（每旋转需产出）');
const demand = RENT_TABLE.map((r, i) => r.rent / spinsOf(i + 1));
console.log('  期  租金  旋转  需求/旋转   环比');
RENT_TABLE.forEach((r, i) => {
  const d = demand[i];
  const ratio = i === 0 ? '—' : `×${f(d / demand[i - 1])}`;
  console.log(
    `  ${String(i + 1).padStart(2)}  ${String(r.rent).padStart(4)}  ${String(spinsOf(i + 1)).padStart(4)}  ${f(d).padStart(8)}   ${ratio}`,
  );
});
const peaks = demand
  .map((d, i) => ({ i: i + 1, d }))
  .sort((a, b) => b.d - a.d)
  .slice(0, 3);
assert('需求峰值在第 12 期', peaks[0].i === 12, `第 ${peaks[0].i} 期 ${f(peaks[0].d)}`);
assert('需求并非严格单调（第 11 期回撤）', demand[10] < demand[9], `${f(demand[9])} → ${f(demand[10])}`);
const maxStep = demand.reduce((m, d, i) => (i === 0 ? m : Math.max(m, d - demand[i - 1])), 0);
assert('最大单期增幅出现在第 9 期', Math.abs(demand[8] - demand[7] - maxStep) < 1e-9, `+${f(maxStep)}`);

/* ── Part 3. 产出上界：满池稳态 ── */

console.log('\nPart 3  无道具模型下的稳态每旋转产出 S∞');

/** 无视金币直接吃卡，把池子喂到 25，再测后半段的每旋转产出 */
function steadyPerSpin(seed: number): { series: number[]; pool: number } {
  const g = createGame(seed);
  g.spinsLeft = 260; // 足够把池子从 5 喂到 25 并留出观测窗口
  const series: number[] = [];
  let guard = 0;
  while (g.spinsLeft > 0 && guard++ < 400) {
    spin(g);
    series.push(g.lastSpinOutput);
    if (g.shopOpen) {
      while (g.shop.length > 0) {
        let best = 0;
        for (let i = 1; i < g.shop.length; i += 1) {
          if (g.shop[i].def.value > g.shop[best].def.value) best = i;
        }
        if (!buyFromShop(g, best)) break;
      }
      closeShop(g);
    }
  }
  return { series, pool: g.pool.length };
}

const SEEDS = 60;
const runs = Array.from({ length: SEEDS }, (_, i) => steadyPerSpin(7100 + i));
const tail = runs.map((r) => {
  const t = r.series.slice(-64);
  return t.reduce((a, b) => a + b, 0) / t.length;
});
const steady = tail.reduce((a, b) => a + b, 0) / tail.length;
const maxTail = Math.max(...tail);
const minTail = Math.min(...tail);

const values = SYMBOLS.map((s) => s.value).filter((v) => v > 0);
const avgValue = values.reduce((a, b) => a + b, 0) / values.length;
const maxValue = Math.max(...values);
const shopValues = SHOP_SYMBOLS.map((s) => s.value);
const avgShopValue = shopValues.reduce((a, b) => a + b, 0) / shopValues.length;
const maxShopValue = Math.max(...shopValues);

console.log(`  样本 ${SEEDS} 局 · 池 ${runs[0].pool}/25 · 稳态 ${f(steady)}（${f(minTail)}–${f(maxTail)}）`);
console.log(`  全表 ${SYMBOLS.length} 个符号：均值 ${f(avgValue)} · 最大 ${maxValue}`);
console.log(
  `  商店池 ${SHOP_SYMBOLS.length} 个：均值 ${f(avgShopValue)} · 最大 ${maxShopValue} → 满盘期望 ${f(20 * avgShopValue)}`,
);
console.log(`  绝对单旋转上界（20 格 × 最大 ${maxShopValue}）= ${20 * maxShopValue}`);

assert('池可被喂满到 25', runs.every((r) => r.pool === 25), `${runs[0].pool}`);
assert('每旋转产出有限', Number.isFinite(steady) && steady > 0, f(steady));
assert(
  `稳态不超过绝对上界 ${20 * maxShopValue}`,
  maxTail <= 20 * maxShopValue,
  `${f(maxTail)} ≤ ${20 * maxShopValue}`,
);
assert(
  '稳态显著低于满盘期望（说明声明效果未补足乘数）',
  steady < 20 * avgShopValue,
  `${f(steady)} < ${f(20 * avgShopValue)}`,
);

/* ── Part 4. 可行性判定 ── */

console.log('\nPart 4  12 期可行性');
const need = totalRent / totalSpins;
const reachMean = 90 * steady; // 全程按均值稳态结算
const reachMax = 90 * maxTail; // 全程按最幸运样本的稳态结算（更宽松的上界）

console.log(`  需要平均 ${f(need)} 金币/旋转（第 12 期瞬时 ${f(demand[11])}）`);
console.log(`  均值口径累计上界 = 90 × ${f(steady)} = ${f(reachMean)}（${f(reachMean / totalRent, 3)} × 租金）`);
console.log(`  乐观口径累计上界 = 90 × ${f(maxTail)} = ${f(reachMax)}（${f(reachMax / totalRent, 3)} × 租金）`);

const absoluteUpper = 90 * 20 * maxShopValue; // 池内全是最高值符号的理论极限
console.log(`  绝对上限 = 90 × 20 × ${maxShopValue} = ${absoluteUpper}（结构上可行）`);

// 这个静态模型不模拟「买到道具之后的成长」，所以达不到 12 期租金是正常的；
// 它只负责说明：只靠基础值 + 符号自身成长撑不到最后。真正能不能通关由引擎基线断言。
assert(
  '静态模型（不计道具成长）达不到 12 期租金',
  reachMax < totalRent,
  `${f(reachMax)} < 4277`,
);
assert(
  '但结构上并非不可能（绝对上限 > 总租金）',
  absoluteUpper > totalRent,
  `${absoluteUpper} > 4277`,
);
const gapFactor = totalRent / reachMax;
const compound = Math.pow(gapFactor, 1 / 11);
console.log(`  → 缺口 ×${f(gapFactor, 2)}（对样本最大值）／×${f(totalRent / reachMean, 2)}（对均值）`);
console.log(`  → 折合 11 次付租需要 ×${f(compound, 3)}/期的复利增益，或把稳态从 ${f(steady)} 提到 ${f(need)}`);

/* 缺口随时间放大：前期可达、后期不可达的交叉点 */
let cross = 0;
let acc = 0;
let accReach = 0;
for (let i = 0; i < 12; i += 1) {
  acc += RENT_TABLE[i].rent;
  accReach += spinsOf(i + 1) * steady;
  if (cross === 0 && accReach < acc) cross = i + 1;
}
assert('存在明确的失守期', cross > 0, `第 ${cross} 期起累计产出低于累计租金`);

/* ── Part 5. 无尽外推 ── */

console.log('\nPart 5  13 期以后（rentRowFor 线性外推）');
console.log('  期  租金  旋转  需求/旋转');
for (let n = 13; n <= 20; n += 1) {
  const row = rentRowFor(n);
  const d = row.rent / row.spinsGain;
  console.log(`  ${String(n).padStart(2)}  ${String(row.rent).padStart(5)}  ${String(row.spinsGain).padStart(4)}  ${f(d).padStart(8)}`);
}
const endlessDemand13 = rentRowFor(13).rent / rentRowFor(13).spinsGain;
assert(
  '第 13 期需求高于稳态产出',
  endlessDemand13 > steady,
  `${f(endlessDemand13)} > ${f(steady)}`,
);
assert(
  '无尽模式需求随期线性增长（每期 +50/旋转）',
  Math.abs(rentRowFor(14).rent / 10 - rentRowFor(13).rent / 10 - 50) < 1e-9,
);
const perPeriodGain = 50;
console.log(`  每期需求 +${perPeriodGain}，而旋转固定 ${rentRowFor(13).spinsGain} 次 → 需要产出随时间持续增长`);

/* ── Part 6. floor 变体 ── */

console.log('\nPart 6  六档楼层的租金差异');
const rentCsv = fs
  .readFileSync(path.join(ROOT, 'data', 'rent.csv'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .slice(1)
  .map((line) => line.split(','));
const cols = ['floor_1', 'floor_2', 'floor_3_5', 'floor_6_7', 'floor_8_13', 'floor_14plus'];
const diffs: Array<{ period: number; spread: number }> = [];
for (const row of rentCsv) {
  const period = Number(row[0]);
  const vals = row.slice(2).map(Number);
  const spread = Math.max(...vals) - Math.min(...vals);
  if (spread > 0) diffs.push({ period, spread });
}
console.log(
  `  存在楼层差异的期：${diffs.map((d) => `第 ${d.period} 期 ±${d.spread}`).join(' · ') || '无'}`,
);
assert('楼层差异只出现在第 7–11 期', diffs.every((d) => d.period >= 7 && d.period <= 11));
assert('每处差异恰为 25', diffs.every((d) => d.spread === 25));
const maxRent14 = Number(rentCsv.at(-1).at(-1));
assert('最高楼层第 13 期租金 1000', maxRent14 === 1000, String(maxRent14));

const floor1 = rentCsv.slice(0, 12).map((r) => Number(r[2]));
const floorMax = rentCsv.slice(0, 12).map((r) => Math.max(...r.slice(2).map(Number)));
const offset = floorMax.reduce((a, v, i) => a + (v - floor1[i]), 0);
console.log(`  → 最高楼层相对 floor 1 的 12 期总租金偏移 = +${offset}（${f((offset / totalRent) * 100)}%）`);
assert('楼层偏移不改变可行性结论', offset < 0.05 * totalRent, `+${offset} < ${f(0.05 * totalRent)}`);

/* ── 汇总 ── */

console.log(`\n${failed === 0 ? 'PASS' : `FAIL (${failed})`}`);
process.exitCode = failed === 0 ? 0 : 1;
