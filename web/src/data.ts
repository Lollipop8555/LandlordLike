// 数据入口：JSON 由 scripts/gen-data.mjs 从 ../data/*.csv 编译而来
import symbolsJson from './data/symbols.json';
import itemsJson from './data/items.json';
import essencesJson from './data/essences.json';
import finePrintJson from './data/finePrint.json';
import rentJson from './data/rent.json';
import rarityJson from './data/rarity.json';
import effectsJson from './data/effects.json';
import type { EffectRule, ItemDef, RentRow, Rarity, RarityRow, SymbolDef } from './types';

/** symbols.csv：168 个原生符号 */
const NATIVE_SYMBOLS = symbolsJson as SymbolDef[];
/** items.csv：114 个道具，与符号共用可放置物接口 */
export const ITEMS = itemsJson as ItemDef[];
export const ESSENCES = essencesJson as ItemDef[];
export const FINE_PRINT = finePrintJson as Array<{
  id: number;
  difficulty: number;
  reliantTypes: string[];
  reliantGroups: string[];
  values: number[];
}>;
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

/** Slot_Icon.gd / Item__Item.gd 的声明，由 analysis/lbal_*.py 解析 */
export const EFFECTS: EffectRule[] = [
  ...EFFECTS_NATIVE,
  ...ITEMS.flatMap((item) => item.effects),
  ...ESSENCES.flatMap((item) => item.effects),
].map((rule, i) => ({ ...rule, i }));

// 源码里多个符号共用同一段分支（`"snail", "turtle", "sloth", "magpie", ... :`），
// 解析后 symbol 记作 `a|b|c`；登记时必须展开，否则这些符号查不到自己的声明。
export const EFFECTS_BY_SYMBOL = new Map<string, EffectRule[]>();
for (const rule of EFFECTS) {
  for (const raw of rule.symbol.split('|')) {
    const id = raw.trim();
    if (!id || id === '<outside>') continue;
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

/** 每个稀有度档位下的候选符号 id */
export const SYMBOL_POOL: Record<Rarity, string[]> = {
  common: SHOP_SYMBOLS.filter((s) => s.rarity === 'common').map((s) => s.id),
  uncommon: SHOP_SYMBOLS.filter((s) => s.rarity === 'uncommon').map((s) => s.id),
  rare: SHOP_SYMBOLS.filter((s) => s.rarity === 'rare').map((s) => s.id),
  very_rare: SHOP_SYMBOLS.filter((s) => s.rarity === 'very_rare').map((s) => s.id),
};

/** 可进入商店的道具（rarity 非空；空 rarity 的是精华与特殊道具） */
export const SHOP_ITEMS = ITEMS.filter((i) => i.rarity !== '');

/** 每个稀有度档位下的候选道具 id */
export const ITEM_POOL: Record<Rarity, string[]> = {
  common: SHOP_ITEMS.filter((i) => i.rarity === 'common').map((i) => i.id),
  uncommon: SHOP_ITEMS.filter((i) => i.rarity === 'uncommon').map((i) => i.id),
  rare: SHOP_ITEMS.filter((i) => i.rarity === 'rare').map((i) => i.id),
  very_rare: SHOP_ITEMS.filter((i) => i.rarity === 'very_rare').map((i) => i.id),
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
