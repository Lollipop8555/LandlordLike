// 数据入口：JSON 由 scripts/gen-data.mjs 从 ../data/*.csv 编译而来
import symbolsJson from './data/symbols.json';
import itemsJson from './data/items.json';
import essencesJson from './data/essences.json';
import finePrintJson from './data/finePrint.json';
import rentJson from './data/rent.json';
import rarityJson from './data/rarity.json';
import effectsJson from './data/effects.json';
import itemFinePrintJson from './data/itemFinePrint.json';
import type { EffectRule, ItemDef, RentRow, Rarity, RarityRow, SymbolDef } from './types';
import { isItemUnimplemented, UNIMPLEMENTED_SYMBOLS } from './unimplemented';

/** symbols.csv：168 个原生符号 */
const NATIVE_SYMBOLS = symbolsJson as SymbolDef[];
/** items.csv：114 个道具，与符号共用可放置物接口 */
export const ITEMS = itemsJson as ItemDef[];
export const ESSENCES = essencesJson as ItemDef[];
/** fine_print.csv：37 条细则的静态定义（Landlord__Landlord.gd 的 fine_print_database） */
const FINE_PRINT_RAW = finePrintJson as Array<{
  id: number;
  difficulty: number;
  reliantTypes: string[];
  reliantGroups: string[];
  values: number[];
}>;
export const FINE_PRINT = FINE_PRINT_RAW;
export const RENT_TABLE = rentJson as RentRow[];
export const RARITY_TABLE = rarityJson as { symbol: RarityRow[]; item: RarityRow[] };
/**
 * 可放置物 = 原生符号 + 道具。
 * 原作里两者共用同一套格子与结算管线（Item__Item.gd 与 Slot_Icon.gd 接口同形：
 * 都有 values / grid_position / add_effect / symbol_check），因此这里合并成一张表。
 */
/** symbols.csv 原生符号表（168） */
export const SYMBOLS: SymbolDef[] = NATIVE_SYMBOLS;

/**
 * 可放置物全集 = 符号 + 道具。
 * 道具不占棋盘格，放不进池，但名字、图标、稀有度、values 与符号同构，
 * 因此统一在这张表里做 id → def 的解析（Item__Item.gd 与 Slot_Icon.gd 接口同形）。
 */
export const PLACEABLES: SymbolDef[] = [
  ...NATIVE_SYMBOLS,
  ...(ITEMS as unknown as SymbolDef[]),
  ...(ESSENCES as unknown as SymbolDef[]),
];

/** 原生符号（不含道具），供只需要符号表的分析脚本使用 */
export const NATIVE_SYMBOL_TABLE = NATIVE_SYMBOLS;

/** Slot_Icon.gd 的声明（effects.csv 原样，未展开 `a|b|c`） */
export const EFFECTS_NATIVE: EffectRule[] = effectsJson as EffectRule[];

/**
 * 兜底：源码里按「持有化肥精华 / 化肥 / 堆肥」分档的 if/elif
 * （Slot_Icon__Slot_Icon.gd 的 seed、Item__Item.gd 的 watering_can）解析后是
 * 几条只差 min_rarity、靠 when:item:* 互斥的声明。门控正常时这里一条都不会删；
 * 只有当抽取丢了门控、几条声明真的会同时命中时才折叠成不带 min_rarity 的通用档，
 * 免得「最高档永远先命中」。发现被删就说明 lbal_gates 的解析回归了。
 */
function dropTierVariants(rules: EffectRule[]): EffectRule[] {
  const keyOf = (rule: EffectRule): string =>
    [
      rule.symbol,
      rule.kind,
      rule.vtc,
      JSON.stringify(rule.comparisons),
      JSON.stringify(rule.diff),
      rule.flags
        .filter((f) => !f.startsWith('min_rarity:') && f !== 'consumes_item')
        .sort()
        .join(';'),
    ].join('|');
  const plainKeys = new Set(
    rules.filter((r) => !r.flags.some((f) => f.startsWith('min_rarity:'))).map(keyOf),
  );
  return rules.filter(
    (r) => !r.flags.some((f) => f.startsWith('min_rarity:')) || !plainKeys.has(keyOf(r)),
  );
}

/**
 * Item__Item.gd 的 `<outside>` 块（:1836-1863）：按细则号修正「道具自身 value」的模板。
 * 它不属于任何一个道具，单独成表，由 ITEM_FINE_PRINT_RULES 取用。
 */
const ITEM_FINE_PRINT_RAW = itemFinePrintJson as EffectRule[];

/** Slot_Icon.gd / Item__Item.gd 的声明，由 analysis/lbal_*.py 解析 */
export const EFFECTS: EffectRule[] = dropTierVariants([
  ...EFFECTS_NATIVE,
  ...ITEMS.flatMap((item) => item.effects),
  ...ESSENCES.flatMap((item) => item.effects),
  ...ITEM_FINE_PRINT_RAW,
]).map((rule, i) => ({ ...rule, i }));

/**
 * 反向加成规则（Slot_Icon__Slot_Icon.gd:3680-3752，源码里以 `<outside>` 块写在符号分发之外）：
 * 触发条件挂在「拥有者」上 —— 源版是 `t_groups.has("doglikes")` 这类分组归属，
 * MOD 版是 `reverse_adjacent_symbol` 声明里的 `reverse_groups` / `reverse_type`；
 * 命中后把效果发给**相邻格**（`add_effect_to_symbol(neighbor)`）。
 */
export const GLOBAL_RULES: EffectRule[] = EFFECTS.filter((r) => r.symbol === '*global*');

export interface ReverseRule {
  rule: EffectRule;
  /** 拥有者需要属于这些分组之一（源码 `t_groups.has(x)`，含 prev_data 历史身份） */
  ownerGroups: string[];
  /** 拥有者必须是这些类型之一（MOD `reverse_type`） */
  ownerTypes: string[];
}

/**
 * 把 `*global*` 声明整理成反向加成表：
 * `when:group:/when:any_group:` 是拥有者条件，`reverse:type:` 是 MOD 的精确类型条件。
 * 两者都缺省时退化成「对所有格生效」，与原版 `*global*` 的全局语义一致。
 */
export const REVERSE_RULES: ReverseRule[] = GLOBAL_RULES.map((rule) => {
  const ownerGroups: string[] = [];
  const ownerTypes: string[] = [];
  for (const flag of rule.flags) {
    const g = /^when:(?:group|any_group):(.+)$/.exec(flag);
    if (g) ownerGroups.push(...g[1].split(',').map((s) => s.trim()).filter(Boolean));
    const t = /^reverse:type:(.+)$/.exec(flag);
    if (t) ownerTypes.push(...t[1].split(',').map((s) => s.trim()).filter(Boolean));
  }
  return { rule, ownerGroups, ownerTypes };
});

/**
 * 细则修正模板（Slot_Icon__Slot_Icon.gd:3696-3729）：
 * 带 `when:fp:N`，实例化时绑定当前细则，`fp.dynamic_icon` 替换成细则指定的符号。
 */
export const FINE_PRINT_RULES: EffectRule[] = EFFECTS.filter((r) => r.symbol === '*fineprint*');

/**
 * 细则对**道具**自身的修正（Item__Item.gd:1836-1863 的 `<outside>` 块）：
 * 同样是 `when:fp:N` 模板，但作用对象是持有物自己的 `value`，不参与符号分发。
 */
export const ITEM_FINE_PRINT_RULES: EffectRule[] = EFFECTS.filter((r) => r.symbol === '*itemfineprint*');

const fpGateNums = (rule: EffectRule): number[] => {
  const out: number[] = [];
  for (const flag of rule.flags) {
    const m = /^when:(?:fp|any_fp|no_fp):(.+)$/.exec(flag);
    if (!m) continue;
    for (const part of m[1].split(',')) {
      const n = Number(part.trim());
      if (Number.isFinite(n)) out.push(n);
    }
  }
  return out;
};

/** 细则定义 + 由规则反推的 `needsIcon`（源码里是判断 tr("fine_print_N") 是否含 <dynamic_） */
export interface FinePrintDef {
  id: number;
  difficulty: number;
  reliantTypes: string[];
  reliantGroups: string[];
  values: number[];
  /** 该细则会指定一个具体符号（fp.dynamic_icon） */
  needsIcon: boolean;
}

export const FINE_PRINTS: FinePrintDef[] = FINE_PRINT_RAW.map((fp) => {
  const rules = [...FINE_PRINT_RULES, ...ITEM_FINE_PRINT_RULES].filter((r) => fpGateNums(r).includes(fp.id));
  return {
    id: fp.id,
    difficulty: fp.difficulty,
    reliantTypes: fp.reliantTypes,
    reliantGroups: fp.reliantGroups,
    values: fp.values,
    needsIcon: rules.some((r) => r.flags.includes('when:fp_icon:any')),
  };
});

// 源码里多个符号共用同一段分支（`"snail", "turtle", "sloth", "magpie", ... :`），
// 解析后 symbol 记作 `a|b|c`；登记时必须展开，否则这些符号查不到自己的声明。
export const EFFECTS_BY_SYMBOL = new Map<string, EffectRule[]>();
for (const rule of EFFECTS) {
  for (const raw of rule.symbol.split('|')) {
    const id = raw.trim();
    if (!id || id === '<outside>' || id.startsWith('*')) continue;
    const list = EFFECTS_BY_SYMBOL.get(id);
    if (list) list.push(rule);
    else EFFECTS_BY_SYMBOL.set(id, [rule]);
  }
}

export const SYMBOL_BY_ID = new Map(PLACEABLES.map((s) => [s.id, s]));

export function symbol(id: string): SymbolDef {
  const def = SYMBOL_BY_ID.get(id);
  if (!def) throw new Error(`未知符号: ${id}`);
  return def;
}

/** 可进入商店的符号（rarity 非空） */
export const SHOP_SYMBOLS = SYMBOLS.filter((s) => s.rarity !== '');

/**
 * 真正参与抽取的符号：把「行为还没还原」的那批剔掉（见 `unimplemented.ts`）。
 * 图鉴与牌库仍然展示它们，只是不会在商店/奖励里出现——抽到一张没有行为、
 * 甚至基础值为 0 的卡，比压根抽不到更伤害体验，也会污染平衡模拟的口径。
 */
export const DRAWABLE_SYMBOLS = SHOP_SYMBOLS.filter((s) => !UNIMPLEMENTED_SYMBOLS.has(s.id));

/** 每个稀有度档位下的候选符号 id */
export const SYMBOL_POOL: Record<Rarity, string[]> = {
  common: DRAWABLE_SYMBOLS.filter((s) => s.rarity === 'common').map((s) => s.id),
  uncommon: DRAWABLE_SYMBOLS.filter((s) => s.rarity === 'uncommon').map((s) => s.id),
  rare: DRAWABLE_SYMBOLS.filter((s) => s.rarity === 'rare').map((s) => s.id),
  very_rare: DRAWABLE_SYMBOLS.filter((s) => s.rarity === 'very_rare').map((s) => s.id),
};

/** 道具 / 精华按 id 索引：`lucky_cat.values[0]` 这类表达式要读道具的 values */
export const ITEM_BY_ID = new Map<string, ItemDef>();
for (const it of [...ITEMS, ...ESSENCES]) ITEM_BY_ID.set(it.id, it);

/** 可进入商店的道具（rarity 非空；空 rarity 的是精华与特殊道具） */
export const SHOP_ITEMS = ITEMS.filter((i) => i.rarity !== '');

/**
 * 真正参与抽取的道具：与 `DRAWABLE_SYMBOLS` 对称，把「行为还没还原」的那批剔掉。
 *
 * 之前只有符号侧做了剔除，道具侧漏了 —— 结果是 16 件登记在
 * `UNIMPLEMENTED_ITEMS` 里的道具（devils_deal / time_machine / popsicle …）
 * 依然会出现在商店里，买下来只是一件带数值的持有物，等于白花钱。
 */
export const DRAWABLE_ITEMS = SHOP_ITEMS.filter((i) => !isItemUnimplemented(i.id));

/** 每个稀有度档位下的候选道具 id */
export const ITEM_POOL: Record<Rarity, string[]> = {
  common: DRAWABLE_ITEMS.filter((i) => i.rarity === 'common').map((i) => i.id),
  uncommon: DRAWABLE_ITEMS.filter((i) => i.rarity === 'uncommon').map((i) => i.id),
  rare: DRAWABLE_ITEMS.filter((i) => i.rarity === 'rare').map((i) => i.id),
  very_rare: DRAWABLE_ITEMS.filter((i) => i.rarity === 'very_rare').map((i) => i.id),
};

/** 第 n 次付租时的租金行（1-based）；无尽模式按 §7.4 线性外推 */
export function rentRowFor(payment: number): RentRow {
  const row = RENT_TABLE.find((r) => r.payment === payment);
  if (row) return row;
  // §7.4：n > 12 → rent = 500 + (n - 12) * 500，spins 固定 +10
  return {
    payment,
    rent: 500 + (payment - 12) * 500,
    floorGate: null,
    spinsGain: 10,
    spinsCumulative: 90 + (payment - 12) * 10,
  };
}

/** 第 n 次付租后商店使用的概率（1-based，超出则冻结在最后一行） */
export function rarityRowFor(kind: 'symbol' | 'item', payment: number): RarityRow {
  const rows = RARITY_TABLE[kind];
  const idx = Math.min(Math.max(payment - 1, 0), rows.length - 1);
  return rows[idx];
}

export const META = {
  symbolCount: SYMBOLS.length,
  shopSymbolCount: SHOP_SYMBOLS.length,
  itemCount: ITEMS.length,
  essenceCount: ESSENCES.length,
  finePrintCount: FINE_PRINT.length,
  totalRent: RENT_TABLE.reduce((a, r) => a + r.rent, 0),
  totalSpins: RENT_TABLE.at(-1)?.spinsCumulative ?? 0,
};
