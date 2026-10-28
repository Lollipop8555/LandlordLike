// 自检：将 docs 中的关键数值转为可执行断言。
// 这些断言与 analysis/verify.py 的输出一一对应，页面加载时即可核对。
import { EFFECTS, ESSENCES, ITEMS, META, RARITY_TABLE, RENT_TABLE, SYMBOL_BY_ID } from './data';
import { describeRule } from './effects';
import { essenceLines } from './essence-notes';
import { hasItemDesc, itemDesc } from './item-notes';
import {
  bossFightMail2,
  bossMail,
  chiliEssenceMail,
  comradeMail,
  endingMail,
  finePrintMail,
  gameOverMail,
  introMail,
  inventoryMail,
  removalTipMail,
  rentDueMail,
  rentIncreaseMail,
  winMail,
  type Mail,
} from './mail';
import { ACHIEVEMENTS } from './progress/achievements';
import { TUTORIAL_STEPS } from './screens';
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

  // ── 道具说明覆盖：114 件道具都要有「条件 + 效果」文案，且不能残留占位符 ──
  const missing = ITEMS.filter((it) => !hasItemDesc(it.id)).map((it) => it.id);
  add('文案', '每件道具都有说明', '0 件缺失', missing.length === 0 ? '0 件缺失' : missing.join(','),
    missing.length === 0, 'item-notes');
  // 文案由 values 插值，漏改会露出 undefined / NaN
  const broken = ITEMS.filter((it) => {
    const d = itemDesc(it.id);
    if (!d) return false;
    const all = [d.summary, d.gap ?? '', ...d.lines.flatMap((l) => [l.when, l.effect])].join(' ');
    return /undefined|NaN|null/.test(all);
  }).map((it) => it.id);
  add('文案', '没有插值残留（undefined/NaN）', '0 件', broken.length === 0 ? '0 件' : broken.join(','),
    broken.length === 0, 'item-notes');

  // ── 声明文案的语法约束：这几条是历史回归点，逐条守住 ──
  const allRules: string[] = [];
  for (const rule of EFFECTS) {
    const def = SYMBOL_BY_ID.get(rule.symbol);
    const text = describeRule(rule, def ? { id: def.id, values: def.values ?? [] } : undefined);
    if (text) allRules.push(text);
  }
  for (const e of ESSENCES) allRules.push(...essenceLines(e.id));

  // 道具文案单独扫（它们不走 describeRule）
  const allItems: string[] = [];
  for (const item of ITEMS) {
    const d = itemDesc(item.id);
    if (!d) continue;
    allItems.push(d.summary, d.gap ?? '', ...d.lines.flatMap((l) => [l.when, l.effect]));
  }

  /** 每个缺陷模式配一个可读的名字，报错时直接说明踩了哪条 */
  const GRAMMAR: Array<[string, RegExp]> = [
    ['重复前置条件（「X时，X时，」）', /时，[^，]{1,30}时，/],
    ['同一句重复主语「本符号」', /本符号[^，]{0,20}本符号/],
    ['数值后直接拼运算符（「数值 + 每…」）', /(数值|倍率|加成|额外数值|额外倍率) \+ /],
    ['未翻译的执行期占位符', /Current Type|current_type|undefined|NaN/],
    ['口语化的「打不碎」', /打不碎/],
    ['数量缺失的「若干」', /生成若干/],
    ['双重动词「改为变成」', /改为变成/],
    ['缺量词的「相邻格」', /相邻格(?!数)/],
    ['中英文之间缺空格', /[\u4e00-\u9fff][A-Za-z]|[A-Za-z][\u4e00-\u9fff]/],
    ['开发者用语（未接线 / TODO 式措辞）', /未接线|未实现|未还原|模型缺口|待补|TBD/],
  ];
  for (const [name, re] of GRAMMAR) {
    const hits = [...allRules, ...allItems].filter((t) => re.test(t));
    add('文案', `声明文案：${name}`, '0 条', hits.length === 0 ? '0 条' : hits.slice(0, 3).join(' / '),
      hits.length === 0, 'effects.ts');
  }

  // ── 玩家可见文案的语调约束 ──
  // 分两类：
  //   1) 交互提示（道具说明、信件、引导、HUD、toast）——要求书面、中性，不带调侃；
  //   2) 成就名称与描述——允许带趣味，只禁止失礼与冒犯性表述。
  const playerText: string[] = [...allItems];

  // 成就单独归一类：只查礼貌，不查口语
  const achievementText: string[] = [];
  for (const a of ACHIEVEMENTS) achievementText.push(a.name, a.desc);

  // 信件：正文按段落拆开，逐段检查
  const mailSamples: Mail[] = [
    comradeMail(1, true, 3),
    comradeMail(5, false, 9),
    rentDueMail({ period: 3, rent: 100, coins: 40, essenceTokens: 2, removalCost: 3, turn: 12 }),
    chiliEssenceMail(2, 1),
    removalTipMail(3, 4),
    rentIncreaseMail({ period: 2, nextRent: 100, spinsGain: 6, endless: false, turn: 8 }),
    introMail('normal', 0),
    introMail('endless', 0),
    introMail('sandbox', 0),
    endingMail({ rent: 777, totalEarned: 5000, turn: 90 }),
    bossMail(750, 90),
    bossFightMail2(750, 91),
    finePrintMail({ num: 12, values: [3], turn: 20 }),
    winMail({ period: 12, rent: 777, totalEarned: 6000, turn: 90 }),
    inventoryMail(5),
    gameOverMail({ period: 4, rent: 150, coins: 20, turn: 30 }),
  ];
  for (const m of mailSamples) {
    playerText.push(m.subject, ...m.body.split('\n\n'));
  }

  // 引导三步
  for (const step of TUTORIAL_STEPS) {
    playerText.push(step.title, step.lead, ...step.points);
  }

  /** 交互提示里的口语 / 调侃 / 江湖气，出现在玩家文本里就算不合格 */
  const COLLOQUIAL: Array<[string, RegExp]> = [
    ['「攒够 / 攒满」', /攒够|攒满/],
    ['「吃掉」', /吃掉/],
    ['「补一批」', /补一批/],
    ['「拆得」', /拆得/],
    ['「打碎」', /打碎/],
    ['「狠 / 滚 / 扫地出门」', /越狠|滚出去|扫地出门/],
    ['「份子钱 / 家当 / 破规则」', /份子钱|这点家当|那些破规则/],
    ['「撸 / 逗」', /撸狗|逗兔子/],
    ['感叹号与语气词（「吧 / 啊 / 呢」）', /[！!]|吧。|啊。|呢。/],
  ];
  for (const [name, re] of COLLOQUIAL) {
    const hits = playerText.filter((t) => re.test(t));
    add('文案', `交互提示不用口语：${name}`, '0 条',
      hits.length === 0 ? '0 条' : hits.slice(0, 2).join(' / '), hits.length === 0, '文案层');
  }

  // 成就允许幽默，但不得出现贬损、驱赶、辱骂一类表述。
  // 「滚」要排除重叠与成语式用法（财源滚滚、滚滚而来、滚烫），
  // 因此要求前后一个字都不是「滚」，才视为独立的驱赶语气。
  const RUDE: Array<[string, RegExp]> = [
    ['贬损或驱赶类表述', /(?<!滚)滚(?!滚|烫)|赶出去|扫地出门|蠢货|垃圾|废物|白痴/],
  ];
  for (const [name, re] of RUDE) {
    const hits = achievementText.filter((t) => re.test(t));
    add('文案', `成就不使用失礼表述：${name}`, '0 条',
      hits.length === 0 ? '0 条' : hits.slice(0, 2).join(' / '), hits.length === 0, 'achievements.ts');
  }

  return out;
}

export function summarize(results: readonly CheckResult[]): { pass: number; total: number } {
  return { pass: results.filter((r) => r.pass).length, total: results.length };
}
