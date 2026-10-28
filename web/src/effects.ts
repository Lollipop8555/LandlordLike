// add_effect 声明解释器。
//
// 语义：comparisons 描述条件，满足一次就对**自身**应用一次效果；为空表示无条件应用一次。
// 三类声明都在这里结算：符号自身、`*global*` 反向加成（拥有者条件 → 相邻格）、
// `*fineprint*` 细则模板（实例化后按当前细则求值）；道具侧细则见 heldItemValue。
import {
  EFFECTS,
  EFFECTS_BY_SYMBOL,
  FINE_PRINT_RULES,
  ITEM_BY_ID,
  ITEM_FINE_PRINT_RULES,
  REVERSE_RULES,
  DRAWABLE_SYMBOLS,
  SYMBOL_BY_ID,
  symbol,
} from './data';
import { COLS, neighborsOf } from './grid';
import { groupName, symbolName } from './names';
import { RARITY_LABEL, RARITY_ORDER } from './types';
import type {
  Cell,
  EffectComparison,
  EffectRule,
  EffectValue,
  FinePrintState,
  Rarity,
  RarityBonus,
  SymbolDef,
} from './types';

/* ── 属性槽位表：value_to_change 的全集 ──
 * Slot_Icon__Slot_Icon.gd 的 add_effect 可以写二十余个属性，这里逐个映射到 Cell 字段，
 * 全部落到真实槽位上，不留「只认字面量」的旁路。 */

const NUM_SLOTS: Record<string, keyof Cell> = {
  saved_value: 'savedValue',
  achievement_value: 'achievementValue',
  saved_achievement_value: 'savedAchievementValue',
  times_displayed: 'timesDisplayed',
  times_coins_given: 'timesCoinsGiven',
  essence_value: 'essenceValue',
  removal_value: 'removalValue',
  reroll_value: 'rerollValue',
  flat_value_bonus: 'flatValueBonus',
  grown_apples: 'grownApples',
  grown_strawberries: 'grownStrawberries',
  compost_heap_symbols_destroyed: 'compostHeapSymbolsDestroyed',
  destroy_counters: 'destroyCounters',
  item_count: 'itemCount',
  non_prev_final_value: 'nonPrevFinalValue',
};

const BOOL_SLOTS: Record<string, keyof Cell> = {
  symbol_trigger: 'symbolTrigger',
  removed: 'removed',
  wildcarded: 'wildcarded',
  drained: 'drained',
  tried_to_give_rand_eff: 'triedToGiveRandEff',
  hex_of_emptiness_trigger: 'hexOfEmptinessTrigger',
  hex_of_hoarding_trigger: 'hexOfHoardingTrigger',
};

const SUPPORTED_VTC = new Set([
  // value_to_change:"value" 直接改基础值；基础值跨轮保持，等价于永久加算（§4.1 base 项）
  'value',
  'value_bonus',
  'value_multiplier',
  'permanent_bonus',
  'permanent_multiplier',
  'permanent_bonuses',
  'bonus_values',
  'bonus_value_multipliers',
  'destroyed',
  'destroyed_or_removed_by',
  'type',
  'rarity',
  // rarity_database 的三档增量：cat / rabbit_fluff 等靠它提升商店稀有度
  'uncommon',
  'rare',
  'very_rare',
  'forced_rarities',
  'indestructible',
  'pointing_directions',
  ...Object.keys(NUM_SLOTS),
  ...Object.keys(BOOL_SLOTS),
]);

const NUM_PRED = new Set([
  'value',
  'saved_value',
  'achievement_value',
  'times_displayed',
  'times_coins_given',
  'item_count',
  'non_prev_final_value',
  'destroy_counters',
]);

const SUPPORTED_PRED = new Set([
  'type',
  'groups',
  'rarity',
  'destroyed',
  'adjacent_empty',
  'removed',
  'wildcarded',
  'drained',
  'indestructible',
  'symbol_trigger',
  'tried_to_give_rand_eff',
  'grid_position_x',
  'grid_position_y',
  'pointing_directions',
  'values',
  'value_bonus',
  'tbd',
  // counted_symbols 是 {counted_symbols:"cultist"} 形态的对象谓词
  'counted_symbols',
  // add_to_cond_effects 会把空条件改写成 {a:"dummy",b:true}（Item__Item.gd:1299）
  'dummy',
  ...NUM_PRED,
]);

/** 一条已经算好数量的生成请求（type 与 group 二选一） */
export interface ResolvedSpawn {
  type?: string;
  group?: string;
  minRarity?: string;
  count: number;
}

/** 求值上下文：表达式里可能引用道具栏计数、随机数与网格位置 */
export interface EvalCtx {
  rand?: () => number;
  /** 「按数值决定概率」的判定随机源（0–1），与 rand_range 表达式分开，避免扰动产出基线 */
  chanceRoll?: () => number;
  /** 道具栏里某道具的持有数（Item__Item.gd 的 items[i].item_count） */
  itemCount?: (id: string) => number;
  /** 场上某符号的个数（diff 里的 {"counted_symbols":"diamond"}） */
  count?: (id: string) => number;
  /** Pop-up / Items / Reels 上的全局槽位（compost_heap_symbols_destroyed 等） */
  globalSlot?: (key: string) => number | boolean | null;
  /**
   * tiles_to_add：把 count 个符号排进本转的空格队列。
   * 源码先塞进 reels.symbol_queue（Slot_Icon.gd:1868-1870），
   * 再在下一轮 update 时 add_tile 到随机空格（Main__Reels.gd:900-940）。
   */
  spawn?: (spec: ResolvedSpawn, owner: Cell) => void;
  /**
   * stat_to_change：把彩蛋统计（摸狗时长、兔子跳、酒精、斩首、扎罗夫杀人）
   * 交给调用方累加。引擎只负责记数，落盘与成就判定在外面做。
   */
  stat?: (key: string, amount: number) => void;
  /** 本格的网格坐标，供 grid_position_x / grid_position_y 使用 */
  position?: { x: number; y: number };
  /**
   * 发出这条声明的格子。源码里销毁会给受害者记一条 destroyed_or_removed_by
   * （Slot_Icon__Slot_Icon.gd 的 giver 分支），成就「猫喝到牛奶」「熊吃掉蜂蜜」靠它判定。
   */
  owner?: Cell;
  /** 相邻非空格数，供 $adj_count 使用 */
  adjacentCount?: number;
  /** 本局生效的细则（Landlord.fine_print），供 when:fp:N / when:fp_icon 门控使用 */
  finePrint?: FinePrintState[];
  /** 正在实例化的那条细则：`fp.values[i]` / `{"$fp":i}` 从它取值 */
  currentFinePrint?: FinePrintState;
  /** Pop-up.rarity_bonuses：稀有度权重修正（cat 的幸运猫在这里累乘） */
  rarityBonus?: RarityBonus;
  /** 声明带 consumes:<id> 时回调，由引擎把该道具从道具栏移除 */
  consume?: (id: string) => void;
}

/**
 * 声明的生效条件。
 * 源码里同一段分支常被 if/elif 拆成互斥的几条声明（洒水壶按持有化肥精华 / 化肥 /
 * 堆肥分档，reroll 在持有 reroll_essence 时不再自己摇骰子）。抽取时把这些
 * if 条件还原成 when:* 标志，否则几条声明会同时生效、最高档永远先命中。
 */
type GateKind =
  | 'item'
  | 'no_item'
  | 'any_item'
  | 'fp'
  | 'no_fp'
  | 'any_fp'
  | 'group'
  | 'no_group'
  | 'any_group'
  | 'flag'
  | 'no_flag'
  | 'fp_icon'
  | 'no_fp_icon'
  | 'never';
type Gate = { kind: GateKind; keys: string[] };

const GATE_RE =
  /^when:(item|no_item|any_item|fp|no_fp|any_fp|group|no_group|any_group|flag|no_flag|fp_icon|no_fp_icon|never)(?::(.*))?$/;

/** 只认抽取器还原出来的门控标志，其余标志一律忽略 */
export function gatesOf(rule: EffectRule): Gate[] {
  const out: Gate[] = [];
  for (const flag of rule.flags) {
    const m = GATE_RE.exec(flag);
    if (!m) continue;
    const keys = (m[2] ?? '').split(',').map((k) => k.trim()).filter((k) => k.length > 0);
    out.push({ kind: m[1] as GateKind, keys });
  }
  return out;
}

/**
 * 符号的分组归属：自身 groups ∪ 历史身份（prev_data）的 groups。
 * 对应 Slot_Icon__Slot_Icon.gd:3678 的 `t_groups = groups.duplicate(true)`。
 */
export function cellGroups(cell: Cell): string[] {
  const out = new Set<string>(cell.def?.groups ?? []);
  for (const p of cell.prev) {
    for (const g of SYMBOL_BY_ID.get(p.symbolId)?.groups ?? []) out.add(g);
  }
  return [...out];
}

function gateHolds(gate: Gate, ctx: EvalCtx, cell: Cell | null): boolean {
  const fps = ctx.finePrint ?? [];
  const fpOn = (id: string): boolean => fps.some((fp) => fp.num === Number(id));
  const held = (id: string): boolean => (ctx.itemCount?.(id) ?? 0) > 0;
  const groups = cell ? cellGroups(cell) : [];
  switch (gate.kind) {
    case 'never':
      // `if modded` 这类在原版永不成立的分支
      return false;
    case 'fp':
      return gate.keys.every(fpOn);
    case 'no_fp':
      return gate.keys.every((k) => !fpOn(k));
    case 'any_fp':
      return gate.keys.some(fpOn);
    case 'item':
      return gate.keys.every(held);
    case 'any_item':
      // 源码写成 `has_unmodded_item("a") or has_unmodded_item("b")`
      return gate.keys.some(held);
    case 'group':
      return gate.keys.every((k) => groups.includes(k));
    case 'no_group':
      return gate.keys.every((k) => !groups.includes(k));
    case 'any_group':
      return gate.keys.some((k) => groups.includes(k));
    case 'flag':
      // 原版恒假：demo（演示模式）/ modded（MOD 符号）/ inherit_effects（MOD 继承）
      return false;
    case 'no_flag':
      return true;
    case 'fp_icon':
    case 'no_fp_icon':
      // 细则是否指定了符号：实例化 *fineprint* 声明时已按当前细则过滤过
      return true;
    default:
      return gate.keys.every((k) => !held(k));
  }
}

/** 这条声明此刻是否满足生效条件（分组门控需要 cell 才能求值） */
export function ruleGatesOk(rule: EffectRule, ctx: EvalCtx = {}, cell: Cell | null = null): boolean {
  return gatesOf(rule).every((g) => gateHolds(g, ctx, cell));
}

/** item_to_destroy：结算后要移除的道具 */
export function consumeOf(rule: EffectRule): string[] {
  return rule.flags
    .filter((f) => f.startsWith('consumes:'))
    .map((f) => f.slice('consumes:'.length))
    .filter((id) => id.length > 0);
}

/**
 * 运行时全局变量。源码里这些是 Pop-up / Main 上的成员变量，
 * 未建模的一律取初值，保证表达式可求值而不是整条声明失效。
 */
const GLOBAL_VARS: Record<string, number> = {
  capsule_machine_multiplier: 1,
  symbols_destroyed_this_spin: 0,
  times_rent_paid: 0,
  coins: 0,
};

/** 把源码里的全局路径改写成求值器认识的形态 */
function normalizeExpr(raw: string): string {
  return (
    raw
      .replace(/\$\s*"\/root\/Main"\.tile_database\.([a-z0-9_]+)\.values\[(\d+)\]/g, '$1.values[$2]')
      .replace(/\$\s*"\/root\/Main[^"]*"\.[A-Za-z_][A-Za-z0-9_.]*/g, '0')
      .replace(/\$\s*"\/root\/Main[^"]*"/g, '0')
      // `items[item_types.find("lucky_cat")].item_count` → `lucky_cat.item_count`
      .replace(/items\[\s*item_types\.find\("([a-z0-9_]+)"\)\s*\]/g, '$1')
      // 道具栏数量的等价写法
      .replace(/item_types\.find\("([a-z0-9_]+)"\)/g, '"$1"')
  );
}

/** 小型表达式求值器：只支持源码里出现过的语法子集，不用 eval */
function evalExpr(rawSrc: string, self: Cell, ctx: EvalCtx): number | null {
  const src = normalizeExpr(rawSrc);
  let i = 0;
  const s = src;
  const ws = (): void => {
    while (i < s.length && /\s/.test(s[i])) i += 1;
  };

  const readIdent = (): string => {
    const start = i;
    while (i < s.length && /[A-Za-z0-9_.]/.test(s[i])) i += 1;
    return s.slice(start, i);
  };

  const index = (): number | null => {
    ws();
    if (s[i] !== '[') return null;
    i += 1;
    const v = expr();
    ws();
    if (s[i] === ']') i += 1;
    return v;
  };

  function primary(): number | null {
    ws();
    if (i >= s.length) return null;
    const c = s[i];
    if (c === '(') {
      i += 1;
      const v = expr();
      ws();
      if (s[i] === ')') i += 1;
      return v;
    }
    if (c === '-') {
      i += 1;
      const v = unary();
      return v === null ? null : -v;
    }
    if (/[0-9]/.test(c)) {
      const start = i;
      while (i < s.length && /[0-9.]/.test(s[i])) i += 1;
      return Number(s.slice(start, i));
    }
    if (/[A-Za-z_]/.test(c)) {
      const name = readIdent();
      ws();
      if (s[i] === '(') {
        i += 1;
        const args: number[] = [];
        for (;;) {
          ws();
          if (s[i] === ')') {
            i += 1;
            break;
          }
          const v = expr();
          if (v === null) return null;
          args.push(v);
          ws();
          if (s[i] === ',') {
            i += 1;
            continue;
          }
          if (s[i] === ')') {
            i += 1;
            break;
          }
          return null;
        }
        switch (name) {
          case 'pow':
            return Math.pow(args[0] ?? 0, args[1] ?? 1);
          case 'floor':
            return Math.floor(args[0] ?? 0);
          case 'int':
            return Math.trunc(args[0] ?? 0);
          case 'abs':
            return Math.abs(args[0] ?? 0);
          case 'max':
            return Math.max(...args);
          case 'min':
            return Math.min(...args);
          case 'rand_range':
            return ctx.rand ? args[0] + ctx.rand() * ((args[1] ?? 0) - args[0]) : (args[0] + (args[1] ?? 0)) / 2;
          case 'randi_range':
            return Math.round(ctx.rand ? args[0] + ctx.rand() * ((args[1] ?? 0) - args[0]) : (args[0] + (args[1] ?? 0)) / 2);
          default:
            return null;
        }
      }
      // values[i] / fp.values[i] / <id>.values[i] / <id>.item_count
      const idx = index();
      if (name === 'values' || name === 'self.values') {
        return idx === null ? null : (self.def?.values[idx] ?? 0);
      }
      if (name === 'fp.values') {
        // 细则自身的参数；细则未激活时与原作起始状态一致，取 0
        return idx === null ? null : (ctx.currentFinePrint?.values[idx] ?? 0);
      }
      if (name.endsWith('.values')) {
        // 符号或道具的静态 values（`lucky_cat.values[0]` 读的是道具）
        const id = name.slice(0, -'.values'.length);
        const def = SYMBOL_BY_ID.get(id) ?? ITEM_BY_ID.get(id);
        return idx === null ? 0 : (def?.values[idx] ?? 0);
      }
      if (name === 'item_count') return self.itemCount ?? 0;
      if (name.endsWith('.item_count')) return ctx.itemCount?.(name.slice(0, -'.item_count'.length)) ?? 0;
      if (name === 'times_displayed') return self.timesDisplayed ?? 0;
      if (name === 'saved_value') return self.savedValue ?? 0;
      if (name === 'value') return self.def?.value ?? 0;
      return GLOBAL_VARS[name] ?? 0;
    }
    return null;
  }

  function unary(): number | null {
    ws();
    if (s[i] === '-') {
      i += 1;
      const v = unary();
      return v === null ? null : -v;
    }
    return primary();
  }

  function term(): number | null {
    let left = unary();
    if (left === null) return null;
    for (;;) {
      ws();
      const c = s[i];
      if (c !== '*' && c !== '/') break;
      i += 1;
      const right = unary();
      if (right === null) return null;
      left = c === '*' ? left * right : right === 0 ? left : left / right;
    }
    return left;
  }

  function expr(): number | null {
    let left = term();
    if (left === null) return null;
    for (;;) {
      ws();
      const c = s[i];
      if (c !== '+' && c !== '-') break;
      i += 1;
      const right = term();
      if (right === null) return null;
      left = c === '+' ? left + right : left - right;
    }
    return left;
  }

  const out = expr();
  ws();
  return i >= s.length ? out : out;
}

/** diff 求值：字面量直出，引用与表达式按源码语义求值 */
function evalValue(v: EffectValue, self: Cell, ctx: EvalCtx = {}): number | string | boolean | null {
  if (v === null) return null;
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const t = v.trim();
    // comparisons 里的 b 大多是符号/分组/稀有度的字面量名（"anchor"、"gem"、"rare"）。
    // 这类纯标识符不能丢给表达式解析器——它会把未知名字当 0，让 type 比较恒假。
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(t)) {
      if (t === 'true') return true;
      if (t === 'false') return false;
      return t;
    }
    // 其余是 `rand_range(0, 100)` / `values[0] * 2` 这类表达式
    const n = Number(t);
    if (t !== '' && Number.isFinite(n)) return n;
    const out = evalExpr(v, self, ctx);
    return out === null ? v : out;
  }
  const o = v as Record<string, unknown>;
  if ('$self_index' in o) return self.def?.values[Number(o.$self_index)] ?? 0;
  if ('$self_value' in o) return self.def?.value ?? 0;
  if ('$ref' in o) {
    const def = SYMBOL_BY_ID.get(String(o.$ref));
    return def?.values[Number(o.$index)] ?? 0;
  }
  if ('$ref_value' in o) {
    return SYMBOL_BY_ID.get(String(o.$ref_value))?.value ?? 0;
  }
  if ('$adj_count' in o) return ctx.adjacentCount ?? 0;
  if ('$fp' in o) return ctx.currentFinePrint?.values[Number(o.$fp)] ?? 0;
  // {"counted_symbols":"diamond"}：场上该符号的个数
  if ('counted_symbols' in o) return ctx.count?.(String(o.counted_symbols)) ?? 0;
  // {"forced_rarity":..., "or_better":...}：强制稀有度，取数组首项；缺失时按 0 处理
  if ('forced_rarity' in o) return 0;
  if ('$dyn' in o) return evalExpr(String(o.$dyn), self, ctx);
  return null;
}

/** 数值谓词：把 comp 的比较方向统一成「域值与 b 的关系」 */
function cmpNum(comp: EffectComparison, actual: number, b: number): boolean {
  if (comp.greater_than !== undefined) return actual > b;
  if (comp.less_than !== undefined) return actual < b;
  return actual === b;
}

/** 谓词名归一化：源码里 a 可能是 `{"counted_symbols": "cultist"}` 或 null + dynamic_a_key */
function predName(comp: EffectComparison): string {
  const a = comp.a as unknown;
  if (typeof a === 'string') return a;
  if (a === null || a === undefined) {
    const key = (comp as Record<string, unknown>).dynamic_a_key;
    return typeof key === 'string' ? key : 'dummy';
  }
  if (typeof a === 'object' && 'counted_symbols' in (a as object)) return 'counted_symbols';
  return String(a);
}

/** 按槽位名读格子属性：dynamic_a_key / dynamic_b_key / dynamic_diff_key 的值来源 */
function readSlot(cell: Cell, key: string): number | string | boolean | null {
  switch (key) {
    case 'value':
      return cell.def?.value ?? 0;
    case 'value_bonus':
      return cell.valueBonus;
    case 'value_multiplier':
      return cell.valueMultiplier;
    case 'permanent_bonus':
      return cell.permanentBonus;
    case 'permanent_multiplier':
      return cell.permanentMultiplier;
    case 'non_prev_final_value':
      return cell.nonPrevFinalValue ?? 0;
    case 'saved_value':
      return cell.savedValue ?? 0;
    case 'achievement_value':
      return cell.achievementValue ?? 0;
    case 'times_displayed':
      return cell.timesDisplayed ?? 0;
    case 'times_coins_given':
      return cell.timesCoinsGiven ?? 0;
    case 'item_count':
      return cell.itemCount ?? 0;
    case 'symbol_trigger':
      return cell.symbolTrigger ?? false;
    case 'destroyed':
      return cell.destroyed;
    default:
      return null;
  }
}

/** 谓词是否可执行：a 为 null 但带 dynamic_a_key 的读全局槽位，运行时总能求值 */
function isSupportedPred(c: EffectComparison): boolean {
  if (SUPPORTED_PRED.has(predName(c))) return true;
  return c.a === null && typeof (c as unknown as Record<string, unknown>).dynamic_a_key === 'string';
}

/**
 * 条件里的取值方是否指向「发声明的那一个」。
 * 源码用 `value_target_override: self` / `dynamic_a_target: self` 把读数从
 * 被作用的符号换成道具自己——莫比乌斯环的「50% 概率」与「已补回次数 < 7」
 * 都是它自己的参数，读成受害者符号的 values 就会变成别的数。
 */
function targetsSelf(spec: unknown): boolean {
  if (spec === 'self') return true;
  return typeof spec === 'object' && spec !== null && (spec as Record<string, unknown>).$dyn === 'self';
}

function matchOne(comp: EffectComparison, other: Cell, self: Cell, ctx: EvalCtx = {}): boolean {
  // b 为 null 时由 dynamic_b_key 指定「另一个符号的哪个槽位」，如 black_pepper 比较双方 value
  const raw = comp as unknown as Record<string, unknown>;
  const keyB = raw.dynamic_b_key;
  let b: number | string | boolean | null =
    comp.b === null && typeof keyB === 'string' ? readSlot(other, keyB) : evalValue(comp.b, self, ctx);
  if (typeof b === 'number') {
    if (typeof raw.dynamic_b_multiplier !== 'undefined' && raw.dynamic_b_multiplier !== null) {
      const mul = Number(evalValue(raw.dynamic_b_multiplier as EffectValue, self, ctx) ?? 1) || 1;
      b *= mul;
    }
    if (typeof raw.dynamic_b_divider !== 'undefined' && raw.dynamic_b_divider !== null) {
      const div = Number(evalValue(raw.dynamic_b_divider as EffectValue, self, ctx) ?? 1) || 1;
      b /= div;
    }
  }
  // a 为 null：谓词名由 dynamic_a_key 给出；目标在 Pop-up / Items 上时读全局槽位
  if (comp.a === null && typeof raw.dynamic_a_key === 'string') {
    if (b === null) return false;
    const key = raw.dynamic_a_key;
    // dynamic_a_target: self → 读发声明者自己的槽位（saved_value），不是受害者的
    const actual = targetsSelf(raw.dynamic_a_target)
      ? (readSlot(self, key) ?? 0)
      : (ctx.globalSlot?.(key) ?? readSlot(other, key) ?? 0);
    if (typeof actual === 'boolean') return actual === Boolean(b);
    return cmpNum(comp, Number(actual), Number(b));
  }

  const a = predName(comp);

  // 原版 rand 条件（Item__Item.gd:1582-1587）：b 是每格现抽的 rand_range(0,100)，
  // 值 ≥ 随机数时成立，也就是「数值越高越容易触发」。数据里 b 记作 "rand_num"，
  // 求值时按随机阈值处理，所以放在 b 是否为 null 的检查之前。
  if (raw.rand) {
    const threshold = (ctx.chanceRoll?.() ?? 0.5) * 100;
    // value_target_override: self → 概率取自道具自己的 values（莫比乌斯环 50%），
    // 而不是被摧毁的那个符号的数值。
    const source = targetsSelf(raw.value_target_override) ? self : other;
    if (a === 'values') {
      const slot = Number(comp.value_num ?? 0);
      return (source.def?.values[slot] ?? 0) + (source.valueBonus ?? 0) >= threshold;
    }
    if (a === 'value_bonus') return (source.valueBonus ?? 0) >= threshold;
    return false;
  }

  if (b === null) return false;

  if (NUM_PRED.has(a)) {
    if (typeof b !== 'number') return false;
    const actual =
      a === 'value'
        ? (other.def?.value ?? 0)
        : a === 'saved_value'
          ? (other.savedValue ?? 0)
          : a === 'achievement_value'
            ? (other.achievementValue ?? 0)
            : a === 'times_displayed'
              ? (other.timesDisplayed ?? 0)
              : a === 'times_coins_given'
                ? (other.timesCoinsGiven ?? 0)
                : a === 'item_count'
                  ? (other.itemCount ?? 0)
                  : a === 'non_prev_final_value'
                    ? (other.nonPrevFinalValue ?? 0)
                    : a === 'destroy_counters'
                      ? (other.destroyCounters ?? 0)
                      : 0;
    return cmpNum(comp, actual, b);
  }

  switch (a) {
    case 'value_bonus':
      return cmpNum(comp, other.valueBonus ?? 0, Number(b));
    case 'type':
      return other.def?.id === b;
    case 'groups':
      return (other.def?.groups ?? []).includes(String(b));
    case 'rarity': {
      const rarity = other.rarity ?? other.def?.rarity;
      return rarity === b;
    }
    case 'destroyed':
      return other.destroyed === Boolean(b);
    case 'removed':
      return (other.removed ?? false) === Boolean(b);
    case 'wildcarded':
      return (other.wildcarded ?? false) === Boolean(b);
    case 'drained':
      return (other.drained ?? false) === Boolean(b);
    case 'indestructible':
      return (other.indestructible ?? false) === Boolean(b);
    case 'symbol_trigger':
      return (other.symbolTrigger ?? false) === Boolean(b);
    case 'tried_to_give_rand_eff':
      return (other.triedToGiveRandEff ?? false) === Boolean(b);
    case 'tbd':
      // tbd = 已判定销毁、等本转结算结束才落地
      return (other.tbd ?? false) === Boolean(b);
    case 'adjacent_empty':
      return Boolean(b) === false;
    case 'grid_position_x':
      return (ctx.position?.x ?? 0) === Number(b);
    case 'grid_position_y':
      return (ctx.position?.y ?? 0) === Number(b);
    case 'pointing_directions':
      return (other.pointingDirections ?? []).length > 0 && Boolean(b);
    case 'values':
      // {a:"values", b:X, value_num:n}：取目标符号 values[n] 与 b 比较
      return cmpNum(comp, other.def?.values[Number(comp.value_num ?? 0)] ?? 0, Number(b));
    case 'counted_symbols': {
      const want = (comp.b as unknown as { counted_symbols?: unknown })?.counted_symbols;
      return typeof want === 'string' ? other.def?.id === want : false;
    }
    case 'dummy':
      return true;
    default:
      return false;
  }
}

/** bonus_value_num：本条声明写进 value_bonus_arr / value_multiplier_arr 的哪个下标 */
function slotOf(rule: EffectRule, self: Cell, ctx: EvalCtx): number | null {
  const raw = rule.flags.find((f) => f.startsWith('slot:'))?.slice('slot:'.length);
  if (!raw) return null;
  try {
    const n = Number(evalValue(JSON.parse(raw) as EffectValue, self, ctx));
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

function applyTo(cell: Cell, rule: EffectRule, diff: number | string | boolean, ctx: EvalCtx = {}): void {
  const n = Number(diff);
  const num = Number.isFinite(n) ? n : 0;

  switch (rule.vtc) {
    case 'value':
      // value_to_change:"value" 改的是符号基础值。声明每轮重新收集、重新求值（§4.5），
      // 因此写进本轮临时加算，不能写 permanentBonus —— 否则同样的声明会跨轮累加。
      if (rule.flags.includes('overwrite')) cell.valueBonus = num;
      else cell.valueBonus += num;
      return;
    case 'value_bonus':
      cell.valueBonus += num;
      return;
    case 'value_multiplier':
      cell.valueMultiplier *= num || 1;
      return;
    case 'permanent_bonus':
    case 'permanent_bonuses':
      cell.permanentBonus += num;
      return;
    case 'permanent_multiplier':
      cell.permanentMultiplier *= num || 1;
      return;
    case 'flat_value_bonus':
      cell.flatValueBonus = (cell.flatValueBonus ?? 0) + num;
      return;
    case 'bonus_values': {
      // bonus_value_num 指定槽位（chicken_coop 两条声明只差下标）；缺省则追加
      const arr = [...(cell.bonusValues ?? [])];
      const slot = slotOf(rule, cell, ctx);
      if (slot === null) arr.push(num);
      else {
        while (arr.length <= slot) arr.push(0);
        arr[slot] = rule.flags.includes('overwrite') ? num : arr[slot] + num;
      }
      cell.bonusValues = arr;
      return;
    }
    case 'bonus_value_multipliers': {
      const arr = [...(cell.bonusValueMultipliers ?? [])];
      const slot = slotOf(rule, cell, ctx);
      const val = num || 1;
      if (slot === null) arr.push(val);
      else {
        while (arr.length <= slot) arr.push(1);
        arr[slot] = rule.flags.includes('overwrite') ? val : arr[slot] * val;
      }
      cell.bonusValueMultipliers = arr;
      return;
    }
    case 'destroyed':
      // 不可破坏的符号挡下销毁（Slot_Icon__Slot_Icon.gd:3222-3229 会补 indestructible=false 条件）。
      // 先打 tbd 标记：本转照常计分，结算走完才落地成 destroyed 并从池中移除
      // （Slot_Icon__Slot_Icon.gd:2394-2405），这样「被摧毁后 value_bonus」的分支才有机会触发。
      if (diff === true && !cell.indestructible && cell.def && !cell.destroyed) {
        cell.tbd = true;
        // 记下凶手（同类声明重复触发时不覆盖第一条），供成就与「被谁摧毁后…」分支使用。
        // 自己摧毁自己不算「被谁摧毁」，否则 destroyed_or_removed_by 会退化成自指。
        if (!cell.destroyedOrRemovedBy && ctx.owner && ctx.owner !== cell) {
          cell.destroyedOrRemovedBy = ctx.owner.def?.id ?? '';
        }
      }
      return;
    case 'destroyed_or_removed_by':
      cell.destroyedOrRemovedBy = String(diff);
      return;
    case 'removed':
      // 「移除」和「摧毁」是两条路：移除不打 tbd、不进摧毁计数，但同样要标记一下，
      // 让被移除符号自己的 {removed:true} 声明还能结算（牡蛎掉珍珠、
      // 沙币/水母/河豚的移除加成），结算完再从棋盘上抹掉。
      if (diff === true && !cell.removed && cell.canBeRemoved !== false && cell.def && cell.def.id !== 'empty') {
        cell.removed = true;
        if (!cell.destroyedOrRemovedBy && ctx.owner && ctx.owner !== cell) {
          cell.destroyedOrRemovedBy = ctx.owner.def?.id ?? '';
        }
      }
      return;
    case 'type': {
      // 变形目标可以是字面量，也可以是「从 group 里按 min_rarity 随机选一个」
      // （Slot_Icon__Slot_Icon.gd 的 seed → plant 分支：diff 为空、靠 group + min_rarity 决定）
      let target: string | null = typeof diff === 'string' && SYMBOL_BY_ID.has(diff) ? diff : null;
      const group = rule.flags.find((f) => f.startsWith('group:'))?.slice('group:'.length);
      if (!target && typeof group === 'string') {
        const minRaw = rule.flags.find((f) => f.startsWith('min_rarity:'))?.slice('min_rarity:'.length);
        const minIdx = minRaw ? RARITY_ORDER.indexOf(minRaw as Rarity) : 0;
        // 变形目标同样不能落到「行为未还原」的符号上，否则种子会种出一张白板
        const pool = DRAWABLE_SYMBOLS.filter(
          (s) => s.groups.includes(group) && RARITY_ORDER.indexOf(s.rarity as Rarity) >= minIdx,
        );
        if (pool.length) {
          const roll = ctx.chanceRoll?.() ?? ctx.rand?.() ?? 0.5;
          target = pool[Math.floor(roll * pool.length)].id;
        }
      }
      // 已判定摧毁的格子不再变形，否则清理时按 id 回池会找不到对应条目
      if (!target || cell.destroyed || cell.tbd) return;
      const old = cell.def;
      if (old) {
        cell.prev.push({
          symbolId: old.id,
          value: old.value,
          permanentBonus: cell.permanentBonus,
          permanentMultiplier: cell.permanentMultiplier,
          valueBonus: cell.valueBonus,
          valueMultiplier: cell.valueMultiplier,
        });
      }
      cell.def = symbol(target);
      return;
    }
    case 'rarity':
      cell.rarity = String(diff);
      return;
    case 'uncommon':
    case 'rare':
    case 'very_rare': {
      // raritymod：改的是 Pop-up.rarity_bonuses（该稀有度的出现权重），不是符号自身槽位
      if (rule.flags.includes('raritymod') && ctx.rarityBonus) {
        const bucket = rule.flags.includes('item_target') ? ctx.rarityBonus.items : ctx.rarityBonus.symbols;
        const key = rule.vtc as Rarity;
        const cur = bucket[key] ?? (rule.flags.includes('multiply') ? 1 : 0);
        bucket[key] = rule.flags.includes('multiply') ? cur * (num || 1) : cur + num;
        return;
      }
      const mod = cell.rarityMod ?? {};
      mod[rule.vtc] = (mod[rule.vtc] ?? 0) + num;
      cell.rarityMod = mod;
      return;
    }
    case 'forced_rarities':
      cell.forcedRarities = [...(cell.forcedRarities ?? []), String(diff)];
      return;
    case 'pointing_directions':
      cell.pointingDirections = [...(cell.pointingDirections ?? []), num];
      return;
    case 'indestructible':
      cell.indestructible = Boolean(diff);
      return;
    default: {
      const numSlot = NUM_SLOTS[rule.vtc];
      if (numSlot) {
        const cur = Number((cell as unknown as Record<string, unknown>)[numSlot as string] ?? 0);
        (cell as unknown as Record<string, unknown>)[numSlot as string] = rule.flags.includes('overwrite') ? num : cur + num;
        return;
      }
      const boolSlot = BOOL_SLOTS[rule.vtc];
      if (boolSlot) {
        (cell as unknown as Record<string, unknown>)[boolSlot as string] = Boolean(diff);
      }
    }
  }
}

export interface EffectRun {
  applied: number;
  skipped: number;
}

export type RuleStatus =
  | 'executable'
  | 'gated'
  | 'unsupported_vtc'
  | 'unsupported_pred'
  | 'dynamic'
  | 'noop';

export const RULE_STATUS_LABEL: Record<RuleStatus, string> = {
  executable: '结算生效',
  gated: '细则门控 · 未激活不结算',
  unsupported_vtc: '属性未参与结算',
  unsupported_pred: '条件未参与判定',
  dynamic: '按运行时求值',
  noop: '判定分支 · 不产生数值',
};

/** 一条声明在本引擎里处于什么状态（拆解面板与解释器共用同一判定） */
export function ruleStatus(rule: EffectRule): RuleStatus {
  // tiles_to_add 类声明不设属性、只生成符号（Slot_Icon.gd:1768-1870）
  const spawnOnly = !rule.vtc && rule.diff === null && (rule.spawn?.length ?? 0) > 0;
  // 源码里的默认分支/占位分支：既不设属性也不给值、也不生成，本身不产生任何操作
  if (!rule.vtc && rule.diff === null && !spawnOnly) return 'noop';
  if (rule.flags.some((f) => f.startsWith('gated:'))) return 'gated';
  if (!spawnOnly && !SUPPORTED_VTC.has(rule.vtc)) return 'unsupported_vtc';
  if (rule.comparisons.some((c) => !isSupportedPred(c))) return 'unsupported_pred';
  if (spawnOnly) return 'executable';
  // diff 为 null 但声明带 group/min_rarity 时，效果是「从该分组随机变形成稀有度达标的符号」，
  // 不需要 diff 也能执行（Slot_Icon__Slot_Icon.gd 的 seed → plant 分支）。
  if (rule.diff === null) {
    // group：从分组里随机选变形目标；diffkey：按目标符号的槽位值 × 系数
    return rule.flags.some((f) => f.startsWith('group:') || f.startsWith('diffkey:')) ? 'executable' : 'dynamic';
  }
  if (evalValue(rule.diff, { def: null } as unknown as Cell) === null) return 'dynamic';
  return 'executable';
}

/**
 * 条件判定上下文：
 *   `add_effect(c)` 由目标自身调用，comparisons 用目标自己的邻居逐一比对
 *   （Slot_Icon__Slot_Icon.gd:3140-3160 登记，3330+ 逐个邻格条件检查）。
 * 返回「是否存在一个满足全部条件的邻居」。
 */
/**
 * 源码在 add_effect 入口统一补条件（Slot_Icon__Slot_Icon.gd:3212-3229）：
 *  · 声明里没有 type/groups 比较时，前置补「与自己同类」——同类对子加成的主要来源
 *  · value_to_change 为 destroyed 时，前置补「目标不可破坏 = false」
 * 例外（无比较、from_item、unconditional、特定 giver）按源码跳过。
 */
function fpGateHolds(gate: Gate, fp: FinePrintState): boolean {
  switch (gate.kind) {
    case 'fp':
      return gate.keys.every((k) => Number(k) === fp.num);
    case 'no_fp':
      return gate.keys.every((k) => Number(k) !== fp.num);
    case 'any_fp':
      return gate.keys.some((k) => Number(k) === fp.num);
    default:
      return true;
  }
}

/**
 * 把 `*fineprint*` 模板绑定到一条具体细则上（Slot_Icon__Slot_Icon.gd:3696-3729）。
 * `fp.dynamic_icon` 在源码里是运行时值，这里替换成该细则抽到的符号；
 * `fp.values[i]` 交给 EvalCtx.currentFinePrint 求值。
 */
function instantiateFinePrint(rule: EffectRule, fp: FinePrintState): EffectRule {
  const subst = (v: EffectValue): EffectValue => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
    const o = v as Record<string, unknown>;
    if (typeof o.$fp === 'number') return { $dyn: String(fp.values[o.$fp] ?? 0) };
    if (typeof o.$dyn === 'string') {
      const expr = o.$dyn.replace(/fp\.values\[(\d+)\]/g, (_, k: string) => String(fp.values[Number(k)] ?? 0));
      return { $dyn: expr };
    }
    return v;
  };
  const comparisons = rule.comparisons.map((c) => {
    const b = c.b as unknown;
    if (b && typeof b === 'object' && !Array.isArray(b) && (b as Record<string, unknown>).$dyn === 'fp.dynamic_icon') {
      return { ...c, b: fp.dynamicIcon ?? '' } as EffectComparison;
    }
    return { ...c, b: subst(c.b) as EffectComparison['b'] };
  });
  return { ...rule, comparisons, diff: subst(rule.diff as EffectValue), i: (rule.i ?? 0) * 1000 + fp.num };
}

/** 当前生效细则展开出的声明；细则未生效时为空 */
function finePrintRulesFor(ctx: EvalCtx): EffectRule[] {
  const fps = ctx.finePrint ?? [];
  if (fps.length === 0) return [];
  const out: EffectRule[] = [];
  for (const rule of FINE_PRINT_RULES) {
    const gates = gatesOf(rule);
    const wantsIcon = gates.some((g) => g.kind === 'fp_icon');
    const rejectsIcon = gates.some((g) => g.kind === 'no_fp_icon');
    for (const fp of fps) {
      if (!gates.every((g) => fpGateHolds(g, fp))) continue;
      // `if fp.dynamic_icon != null ... else ...` 两个分支互斥
      if (wantsIcon && !fp.dynamicIcon) continue;
      if (rejectsIcon && fp.dynamicIcon) continue;
      out.push(instantiateFinePrint(rule, fp));
    }
  }
  return out;
}

/** 道具侧的细则模板：与符号侧同构，但作用对象是持有物自身 */
function itemFinePrintRulesFor(ctx: EvalCtx): EffectRule[] {
  const fps = ctx.finePrint ?? [];
  if (fps.length === 0) return [];
  const out: EffectRule[] = [];
  for (const rule of ITEM_FINE_PRINT_RULES) {
    const gates = gatesOf(rule);
    const wantsIcon = gates.some((g) => g.kind === 'fp_icon');
    const rejectsIcon = gates.some((g) => g.kind === 'no_fp_icon');
    for (const fp of fps) {
      if (!gates.every((g) => fpGateHolds(g, fp))) continue;
      if (wantsIcon && !fp.dynamicIcon) continue;
      if (rejectsIcon && fp.dynamicIcon) continue;
      out.push(instantiateFinePrint(rule, fp));
    }
  }
  return out;
}

/**
 * 道具自身的价值（Item__Item.gd:1836-1863 的 `<outside>` 块）。
 * 道具不占格、不参与计分，这条只影响「按 value 折算」的道具行为（MOD 兑换）与面板展示，
 * 但必须算出来，不能像以前那样整块丢掉。
 */
export function heldItemValue(def: SymbolDef, count: number, ctx: EvalCtx = {}): number {
  const self = { def, itemCount: count } as unknown as Cell;
  let value = 0;
  for (const rule of itemFinePrintRulesFor(ctx)) {
    if (!rule.comparisons.every((c) => matchOne(c, self, self, ctx))) continue;
    const n = Number(evalValue(rule.diff, self, ctx) ?? 0);
    if (!Number.isFinite(n)) continue;
    if (MULTIPLY_VTC.has(rule.vtc)) value *= n;
    else value += n;
  }
  return value;
}

/**
 * 反向加成：拥有者命中分组归属（含 prev_data 历史身份）或 MOD 的 reverse_type 时，
 * 把声明发给相邻格。原版 `<outside>` 块（doglikes / beelikes / omelettestuff）
 * 与 MOD 的 `reverse_adjacent_symbol` 都走这条路径。
 */
function reverseRulesFor(cell: Cell): EffectRule[] {
  if (REVERSE_RULES.length === 0) return [];
  const groups = cellGroups(cell);
  const id = cell.def?.id ?? '';
  const out: EffectRule[] = [];
  for (const rr of REVERSE_RULES) {
    // 没有拥有者条件的声明保持原版「对所有格生效」
    if (rr.ownerGroups.length === 0 && rr.ownerTypes.length === 0) {
      out.push(rr.rule);
      continue;
    }
    if (rr.ownerTypes.includes(id) || rr.ownerGroups.some((g) => groups.includes(g))) out.push(rr.rule);
  }
  return out;
}

/**
 * 本转的邻域：细则 22 生效时去掉正上/正下，只留左右与四个斜向
 * （Slot_Icon__Slot_Icon.gd:1184-1191）。
 */
function neighborsFor(ctx: EvalCtx, index: number): number[] {
  const skipVertical = (ctx.finePrint ?? []).some((fp) => fp.num === 22);
  return neighborsOf(index, { skipVertical });
}

function withAutoComparisons(rule: EffectRule, self: Cell): EffectComparison[] {
  const comps = [...rule.comparisons];
  const hasTypeGroups = comps.some((c) => {
    const a = predName(c);
    return a === 'type' || a === 'groups';
  });
  const skipAuto =
    comps.length === 0 ||
    hasTypeGroups ||
    // *global* / *fineprint* 是通用规则，不绑定某个符号，不能自动补「同类型」
    rule.symbol.startsWith('*') ||
    rule.flags.includes('from_item') ||
    rule.flags.includes('unconditional') ||
    rule.flags.some((f) => f.startsWith('giver:hex_of_') || f.startsWith('giver:midas_bomb'));

  if (!skipAuto) comps.unshift({ a: 'type', b: self.def?.id ?? '', not_prev: true });
  if (rule.vtc === 'destroyed' && !comps.some((c) => predName(c) === 'indestructible')) {
    comps.unshift({ a: 'indestructible', b: false });
  }
  return comps;
}

/**
 * 单轮遍历 20 格，按声明顺序执行。
 *
 * 目标语义来自两处源码：
 *   add_effect(eff)                        → reels.conditional_effects[自身]    （:3306-3310）
 *   add_effect_to_symbol(y, x, eff)        → displayed_icons[y][x].add_effect()（:1374-1381）
 * 后者（解析出的 `target:adjacent`）把效果挂到**相邻符号**身上，
 * 条件也在那个相邻符号的邻域里判定，而不是挂回发起者自己。
 */
export function applyEffects(
  cells: Cell[],
  ctx: EvalCtx = {},
  /**
   * 只结算这些下标（缺省=全场）。
   * 玩家主动移除时（removal_token / 道具吃符号）源码只跑被移除符号自己的声明，
   * 不重跑整盘，所以这里给一个作用域闸门，坐标仍然按完整 cells 计算。
   */
  only?: ReadonlySet<number>,
): EffectRun {
  let applied = 0;
  let skipped = 0;

  for (let i = 0; i < cells.length; i += 1) {
    if (only && !only.has(i)) continue;
    const cell = cells[i];
    // destroyed 的符号本转仍要跑自己的声明：源码里「被摧毁后 value_bonus」
    // 正是靠 destroyed=true 之后再判定一次才拿到奖励（Slot_Icon__Slot_Icon.gd:3165）。
    if (!cell.def) continue;
    const pos = positionOf(i);
    const local: EvalCtx = { ...ctx, position: pos, owner: cell };
    // 自身声明 + 反向加成（拥有者条件命中时发给相邻格）+ 当前细则带来的修正（*fineprint*）
    const rules = [
      ...(EFFECTS_BY_SYMBOL.get(cell.def.id) ?? []),
      ...reverseRulesFor(cell),
      ...finePrintRulesFor(local),
    ];
    for (const rule of rules) {
      const status = ruleStatus(rule);
      // 源码里有些声明只干一件事：条件成立就把 item_to_destroy 的精华用掉
      // （忍者与老鼠、晴空、鸡舍……）。它们没有 vtc / diff，但必须照样执行。
      const consumeOnly =
        status === 'noop' &&
        consumeOf(rule).length > 0 &&
        !rule.flags.some((f) => f.startsWith('gated:'));
      if (status !== 'executable' && !consumeOnly) {
        skipped += 1;
        continue;
      }
      if (!ruleGatesOk(rule, local, cell)) {
        skipped += 1;
        continue;
      }
      // dynamic_diff_*：diff 由「目标符号的某个槽位 × 系数」在运行时算出
      const diffKey = rule.flags.find((f) => f.startsWith('diffkey:'))?.slice('diffkey:'.length);
      const diffMulRaw = rule.flags.find((f) => f.startsWith('diffmul:'))?.slice('diffmul:'.length);
      const diffDivRaw = rule.flags.find((f) => f.startsWith('diffdiv:'))?.slice('diffdiv:'.length);
      const diffFor = (target: Cell): number | string | boolean | null => {
        if (diffKey) {
          const base = Number(readSlot(target, diffKey) ?? 0);
          let mul = 1;
          if (diffMulRaw) {
            try {
              mul = Number(evalValue(JSON.parse(diffMulRaw) as EffectValue, cell, local) ?? 1) || 1;
            } catch {
              mul = 1;
            }
          }
          let div = 1;
          if (diffDivRaw) {
            try {
              div = Number(evalValue(JSON.parse(diffDivRaw) as EffectValue, cell, local) ?? 1) || 1;
            } catch {
              div = 1;
            }
          }
          return (base * mul) / div;
        }
        return evalValue(rule.diff, cell, local);
      };

      // 源码入口统一补「同类」与「不可破坏」条件
      const comps = withAutoComparisons(rule, cell);

      // one_time：本条声明对同一个目标每轮只生效一次
      const once = rule.flags.includes('one_time');
      const hits = new Set<Cell>();
      // 同一转里会跑多轮（销毁落地后条件会变），已应用过的分支不再重复加分
      // （源码用 current_effect_hashes 去重）。
      const idx = rule.i;
      const remember = (target: Cell): void => {
        if (typeof idx !== 'number') return;
        (target.appliedRules ??= new Set()).add(idx);
      };
      // item_to_destroy：只要这条声明落地一次，就把指定道具消耗掉（每转一次）
      let consumed = false;
      const markApplied = (target: Cell): void => {
        remember(target);
        applied += 1;
        // 彩蛋统计跟着「声明落地」走：同一条声明在一轮里只记一次，
        // 所以摸狗、喝酒这些计数不会因为多轮迭代被重复累加。
        for (const s of rule.stats ?? []) {
          const raw = s.diff === undefined ? 1 : evalValue(s.diff, target, ctx);
          const n = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
          if (n !== 0) ctx.stat?.(s.key, n);
        }
        if (consumed) return;
        const eat = consumeOf(rule);
        if (eat.length === 0) return;
        consumed = true;
        for (const id of eat) ctx.consume?.(id);
      };
      /**
       * tiles_to_add：条件满足就把生成物排进本转队列。
       * 数量来自自身 values[N]（urn / tomb / pinata 的 N），字面量声明返回 1。
       * 返回 true 表示这条声明只干生成这件事，不产生数值。
       */
      const fireSpawn = (owner: Cell): boolean => {
        const specs = rule.spawn ?? [];
        if (specs.length === 0) return false;
        for (const spec of specs) {
          const raw = spec.count === undefined ? 1 : evalValue(spec.count, owner, ctx);
          const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.trunc(raw) : 0;
          if (n <= 0) continue;
          ctx.spawn?.({ type: spec.type, group: spec.group, minRarity: spec.minRarity, count: n }, owner);
        }
        return true;
      };
      if (typeof idx === 'number' && cell.appliedRules?.has(idx)) continue;

      // 纯消耗声明：条件（相对相邻符号，或相对自己）一旦满足就扣一件道具
      if (consumeOnly) {
        const onNeighbor = rule.flags.includes('target:adjacent');
        const spots = onNeighbor ? neighborsFor(ctx, i) : [i];
        for (const j of spots) {
          const target = cells[j];
          if (!target.def) continue;
          const targetCtx: EvalCtx = { ...ctx, position: positionOf(j) };
          if (!comps.every((c) => matchOne(c, target, onNeighbor ? cell : target, targetCtx))) continue;
          markApplied(target);
          break;
        }
        continue;
      }

      // add_to_cond_effects：声明挂到「满足 conditions 的目标符号」身上，
      // 走全局 cond_effects_to_add 队列（Item__Item.gd:1274-1298），不是相邻挂载。
      // 因此作用域是全场：每个匹配的符号各应用一次。
      if (rule.kind === 'cond') {
        for (let t = 0; t < cells.length; t += 1) {
          const target = cells[t];
          if (target === cell || !target.def || target.destroyed) continue;
          if (!comps.every((c) => matchOne(c, target, cell, { ...local, position: positionOf(t) }))) continue;
          const d = diffFor(target);
          // 变形声明（洒水壶把种子变成植物）没有 diff，目标由 group/min_rarity 选
          if (d === null && rule.vtc !== 'type') continue;
          applyTo(target, rule, (d ?? 0) as number | string | boolean, local);
          markApplied(target);
        }
        continue;
      }

      if (rule.flags.includes('target:adjacent')) {
        for (const j of neighborsFor(ctx, i)) {
          const target = cells[j];
          if (!target.def || target.destroyed) continue;
          // 条件挂在被作用的那个相邻符号身上（Slot_Icon__Slot_Icon.gd:3364-3369），
          // 不是挂回发起者的邻域——坐标要换成目标的坐标再做判定。
          const targetCtx: EvalCtx = { ...ctx, position: positionOf(j) };
          if (!comps.every((c) => matchOne(c, target, cell, targetCtx))) continue;
          if (once && hits.has(target)) continue;
          const d = diffFor(target);
          if (d === null && rule.vtc !== 'type') continue;
          applyTo(target, rule, (d ?? 0) as number | string | boolean, targetCtx);
          hits.add(target);
          markApplied(target);
        }
        continue;
      }

      // target:self：字典仍挂在相邻符号上（条件在那个邻居身上判定，被摧毁的也算），
      // 只有数值落回发起者自己。bounty_hunter「吃掉相邻小偷后自己 +契约价值」、
      // dwarf「矿工被毁后自己 +价值」都是这个形状。
      if (rule.flags.includes('target:self')) {
        for (const j of neighborsFor(ctx, i)) {
          const near = cells[j];
          if (!near.def) continue;
          const nearCtx: EvalCtx = { ...ctx, position: positionOf(j) };
          if (!comps.every((c) => matchOne(c, near, cell, nearCtx))) continue;
          if (once && hits.has(near)) continue;
          const d = diffFor(near);
          if (d === null && rule.vtc !== 'type') continue;
          applyTo(cell, rule, (d ?? 0) as number | string | boolean, local);
          hits.add(near);
          markApplied(cell);
        }
        continue;
      }

      if (comps.length === 0) {
        const d = diffFor(cell);
        const spawned = fireSpawn(cell);
        // diff 缺失但带 group 的声明（seed → plant 随机变形）走 applyTo 内部选靶
        if (d === null && rule.vtc !== 'type') {
          if (spawned) markApplied(cell);
          else skipped += 1;
          continue;
        }
        applyTo(cell, rule, (d ?? 0) as number | string | boolean, local);
        markApplied(cell);
        continue;
      }

      // 其余 add_effect 的条件都相对「自己」判定（Slot_Icon__Slot_Icon.gd:3336-3422：
      // target 缺省就是 self），相邻只在源码显式走 add_effect_to_symbol 时才成立。
      // 之前按「邻居必须匹配」实现，导致同类型/同类加成几乎全部被跳过、每转只剩基础值。
      if (!comps.every((c) => matchOne(c, cell, cell, local))) continue;
      if (once && hits.has(cell)) continue;
      {
        const d = diffFor(cell);
        // 蜂巢按 values[0]=10 的概率生蜜、陶罐被毁后生灵魂，都在这一支
        const spawned = fireSpawn(cell);
        // 变形声明（seed → plant）没有 diff，目标由 applyTo 里的 group/min_rarity 选
        if (d === null && rule.vtc !== 'type') {
          if (spawned) markApplied(cell);
          continue;
        }
        applyTo(cell, rule, (d ?? 0) as number | string | boolean, local);
        hits.add(cell);
        markApplied(cell);
      }
    }
  }

  return { applied, skipped };
}

/** 格子索引 → 网格坐标（grid.ts 的索引是先列后行还是先行后列，用 COLS 统一推导） */
function positionOf(index: number): { x: number; y: number } {
  return { x: index % COLS, y: Math.floor(index / COLS) };
}

/** 覆盖率：多少条声明能直接结算，多少条需要门控或运行时求值 */
export interface EffectCoverage {
  total: number;
  /** 有实际操作的声明数（total − 空分支） */
  effective: number;
  executable: number;
  gated: number;
  dynamic: number;
  noop: number;
  unsupportedVtc: Array<[string, number]>;
  unsupportedPred: Array<[string, number]>;
  symbols: number;
}

export function effectCoverage(): EffectCoverage {
  let executable = 0;
  let gated = 0;
  let dynamic = 0;
  let noop = 0;
  const vtc = new Map<string, number>();
  const pred = new Map<string, number>();

  for (const rule of EFFECTS) {
    const status = ruleStatus(rule);
    if (status === 'executable') {
      executable += 1;
      continue;
    }
    if (status === 'noop') {
      noop += 1;
      continue;
    }
    if (status === 'gated') {
      gated += 1;
      continue;
    }
    if (status === 'dynamic') {
      dynamic += 1;
      continue;
    }
    if (status === 'unsupported_vtc') {
      vtc.set(rule.vtc || '<空>', (vtc.get(rule.vtc || '<空>') ?? 0) + 1);
      continue;
    }
    const badPred = rule.comparisons.find((c) => !isSupportedPred(c));
    const k = badPred ? predName(badPred) : '<无>';
    pred.set(k, (pred.get(k) ?? 0) + 1);
  }

  return {
    total: EFFECTS.length,
    effective: EFFECTS.length - noop,
    executable,
    gated,
    dynamic,
    noop,
    unsupportedVtc: [...vtc.entries()].sort((a, b) => b[1] - a[1]),
    unsupportedPred: [...pred.entries()].sort((a, b) => b[1] - a[1]),
    symbols: new Set(EFFECTS.map((r) => r.symbol)).size,
  };
}

/**
 * 反向索引：哪些符号的声明把这个道具当作前置条件（when:item:X / no_item:X）。
 *
 * 道具详情面板已改用 `item-notes.ts` 的专用文案（「条件 + 效果」两列），
 * 不再需要把别的符号的句子拼进来；这里保留给分析脚本与自查使用。
 */
export function itemGateNotes(id: string): Array<{ owner: string; text: string }> {
  const out: Array<{ owner: string; text: string }> = [];
  const seen = new Set<string>();
  for (const rule of EFFECTS) {
    if (rule.symbol === id) continue;
    const hit = gatesOf(rule).some(
      (g) => (g.kind === 'item' || g.kind === 'no_item') && g.keys.includes(id),
    );
    if (!hit) continue;
    const text = describeRule(rule);
    if (!text) continue;
    const key = `${rule.symbol}|${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ owner: rule.symbol, text });
  }
  // 同一 owner 的连续多档稀有度上调合并成一条（幸运猫：罕见 / 稀有 / 极稀有）
  const TIER = /^(.*稀有度提到)「(.+)」$/;
  const merged: Array<{ owner: string; text: string }> = [];
  for (const note of out) {
    const m = TIER.exec(note.text);
    const prev = merged[merged.length - 1];
    const pm = prev && prev.owner === note.owner ? TIER.exec(prev.text) : null;
    if (m && pm) {
      merged[merged.length - 1] = { owner: prev.owner, text: `${pm[1]}「${pm[2]} / ${m[2]}」` };
      continue;
    }
    merged.push(note);
  }
  return merged;
}

export function rulesOf(id: string): EffectRule[] {
  return EFFECTS_BY_SYMBOL.get(id) ?? [];
}

export interface SymbolCoverage {
  id: string;
  total: number;
  executable: number;
}

/** 逐符号的声明还原情况：哪些符号一个声明都没还原 */
export function symbolCoverage(): SymbolCoverage[] {
  const map = new Map<string, SymbolCoverage>();
  for (const rule of EFFECTS) {
    const row = map.get(rule.symbol) ?? { id: rule.symbol, total: 0, executable: 0 };
    row.total += 1;
    if (ruleStatus(rule) === 'executable') row.executable += 1;
    map.set(rule.symbol, row);
  }
  return [...map.values()].sort((a, b) => a.executable - b.executable || b.total - a.total);
}

/** 道具栏项：与 engine.HeldItem 同构，避免 effects ↔ engine 循环依赖 */
export interface ItemHolder {
  def: SymbolDef;
  count: number;
  /** 道具自身的 value 槽位（Item__Item.gd 的 `value`），细则 17 会按持有数量扣减 */
  value?: number;
  /** saved_value：跨轮累计（莫比乌斯环记「已经补回几次」，达到上限就停手） */
  savedValue?: number;
}

const MULTIPLY_VTC = new Set(['value_multiplier', 'permanent_multiplier']);

/** 道具栏里某个道具的总数量，供 when:item:X 门控使用 */
function countOf(items: ItemHolder[], id: string): number {
  return items.reduce((n, it) => n + (it.def?.id === id ? it.count : 0), 0);
}

/**
 * 道具的全局效果。
 * Items__Items.add_cond_effects() 把每条声明的 comparisons 收进 cond_effects_to_add，
 * 每轮结算再挂到满足条件的符号上（Item__Item.gd:1265-1298）。
 * 道具不占格、自身不结算，所以这里只执行 kind:"cond" 的声明。
 * 同类道具叠加时 diff 按 item_count 放大（源码闭包里做 effect.diff *= item_count），
 * 倍率类按幂放大，避免线性和把 ×2 ×2 算成 +2。
 */
/**
 * 道具侧的生成声明：把占位符解成具体符号再交给引擎。
 * `current_type` 指「刚刚被摧毁的那个符号」，莫比乌斯环据此把它原样补回棋盘。
 */
function fireItemSpawn(rule: EffectRule, victim: Cell, holder: Cell, ctx: EvalCtx): void {
  if (!ctx.spawn) return;
  for (const spec of rule.spawn ?? []) {
    const type = spec.type === 'current_type' ? victim.def?.id : spec.type;
    const amount = evalValue(spec.count as EffectValue, holder);
    const count = Math.max(0, Math.round(Number(amount ?? 1)));
    for (let i = 0; i < count; i += 1) ctx.spawn({ ...spec, type, count: 1 }, holder);
  }
}

export function applyItemEffects(
  items: ItemHolder[],
  cells: Cell[],
  ctx: EvalCtx = {},
): { applied: number; skipped: number; consumed: string[] } {
  let applied = 0;
  let skipped = 0;
  /** item_to_destroy：声明落地后要移除的道具，由引擎统一扣掉 */
  const consumed: string[] = [];
  if (items.length === 0) return { applied, skipped, consumed };

  for (const held of items) {
    if (!held.def || held.count <= 0) continue;
    // item_count 读叠层数（祭坛每层产一个灵魂）；saved_value 是跨轮累计（莫比乌斯环）
    const holder = { def: held.def, itemCount: held.count, savedValue: held.savedValue ?? 0 } as Cell;
    for (const rule of EFFECTS_BY_SYMBOL.get(held.def.id) ?? []) {
      if (rule.kind !== 'cond') continue;
      // 源码用 if/elif 按「持有别的道具 / 细则」分档，条件不成立的分支不结算
      if (!ruleGatesOk(rule, { ...ctx, itemCount: (id) => countOf(items, id) })) {
        skipped += 1;
        continue;
      }
      // 纯生成声明（祭坛→灵魂、煎锅→煎蛋）：没有 value_to_change，条件成立就往空格塞符号。
      // 这类声明以前被 SUPPORTED_VTC 挡掉，数据里存在但从不生效。
      const spawnOnly = !rule.vtc && rule.diff === null && (rule.spawn?.length ?? 0) > 0;
      if (!spawnOnly && !SUPPORTED_VTC.has(rule.vtc)) {
        skipped += 1;
        continue;
      }
      if (rule.comparisons.some((c) => !isSupportedPred(c))) {
        skipped += 1;
        continue;
      }
      const base = spawnOnly ? 0 : evalValue(rule.diff, holder);
      // 变形声明（洒水壶）没有 diff，目标由 group/min_rarity 选
      if (!spawnOnly && base === null && rule.vtc !== 'type') {
        skipped += 1;
        continue;
      }
      const n = Number(base ?? 0);
      const diff = MULTIPLY_VTC.has(rule.vtc)
        ? Math.pow(n, held.count)
        : rule.flags.includes('multiply')
          ? n
          : n * held.count;

      // bonus_value_num 里的 `$self_index` 指道具自己的 values，先把槽位算实
      let useRule = rule;
      if (rule.flags.some((f) => f.startsWith('slot:'))) {
        const slot = slotOf(rule, holder, ctx);
        if (slot !== null) {
          useRule = { ...rule, flags: rule.flags.map((f) => (f.startsWith('slot:') ? `slot:${slot}` : f)) };
        }
      }

      let hit = 0;
      for (const target of cells) {
        if (!target.def) continue;
        // 生成声明要等的正是「刚被摧毁的那个符号」（莫比乌斯环、祭坛），
        // 其余声明照旧只作用于活着的格子
        if (target.destroyed && !spawnOnly) continue;
        if (!rule.comparisons.every((c) => matchOne(c, target, holder, ctx))) continue;
        // 同一转里销毁会迭代多轮，道具声明也跟着重跑，没有这层去重会重复加成
        const memo = (target.appliedItems ??= new Set<string>());
        const key = `${held.def.id}#${rule.line}`;
        if (memo.has(key)) continue;
        memo.add(key);
        if (spawnOnly) fireItemSpawn(rule, target, holder, ctx);
        else applyTo(target, useRule, diff, ctx);
        hit += 1;
      }
      if (hit > 0) {
        applied += hit;
        // item_to_add_saved_value：这条声明成立时给指定道具攒一次（莫比乌斯环的上限计数）
        for (const flag of rule.flags) {
          if (!flag.startsWith('savedadd:')) continue;
          const id = flag.slice('savedadd:'.length);
          for (const it of items) {
            if (it.def.id === id) it.savedValue = (it.savedValue ?? 0) + 1;
          }
        }
        for (const id of consumeOf(rule)) {
          if (!consumed.includes(id)) consumed.push(id);
        }
      } else skipped += 1;
    }
    // 细则对道具自身 value 的修正（Item__Item.gd 的 <outside> 块）
    const selfValue = heldItemValue(held.def, held.count, { ...ctx, itemCount: (id) => countOf(items, id) });
    if (selfValue !== 0) held.value = selfValue;
    else delete held.value;
  }
  return { applied, skipped, consumed };
}

/* ── 面向玩家的人话描述 ──
 * 详情面板只回答两件事：什么情况下、发生什么。
 * 内部字段名（成就值、显示次数）、源码文件名、行号一律不出现。 */

type Owner = { id: string; values: number[] };

/** 纯记账、不改变面板数值的属性：不单独成句 */
const SILENT_VTC = new Set([
  '',
  'achievement_value',
  'saved_achievement_value',
  'times_displayed',
  'times_coins_given',
  'destroyed_or_removed_by',
  'forced_rarities',
  'pointing_directions',
  'hex_of_emptiness_trigger',
  'hex_of_hoarding_trigger',
]);

/** 这几个 value_to_change 表示「把稀有度改成某档」，diff 恒为真 */
const RARITY_KEYS = new Set(['common', 'uncommon', 'rare', 'very_rare']);

function numText(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2)));
}

function ownerNum(owner: Owner | undefined, i: number): number | null {
  const v = owner?.values?.[i];
  return typeof v === 'number' ? v : null;
}

/** 把常见表达式翻译成人话；翻不出来就说「随局面变化」，不冒充字面量 */
function dynText(expr: string, owner?: Owner): string {
  const at = (i: string | number): number | null => ownerNum(owner, Number(i));
  // 化石计数：声明里写成 Pop-up 的 fossil_diff，按「每块化石」表述
  if (/fossil_diff/.test(expr)) {
    const fm = expr.match(/values\[(\d+)\]/);
    const n = fm ? at(fm[1]) : null;
    return n === null ? '每块化石就加一次' : `每块化石 +${numText(n)}`;
  }
  const e = normalizeExpr(expr).trim();
  let m: RegExpMatchArray | null;
  // 细则实例化后 `fp.values[i]` 已换成字面量，直接出数字，别再当成未知表达式
  if (/^-?\d+(?:\.\d+)?$/.test(e)) return numText(Number(e));
  // 道具侧：每持有一个就扣一次
  if ((m = e.match(/^(-?\d+(?:\.\d+)?) \* item_count$/))) {
    const n = Number(m[1]);
    return `每持有一个就 ${n >= 0 ? '+' : ''}${numText(n)}`;
  }
  if ((m = e.match(/^times_displayed \* values\[(\d+)\]$/))) {
    const n = at(m[1]);
    return n === null ? '每出现一次就加一次' : `每出现一次 +${numText(n)}`;
  }
  if ((m = e.match(/^floor\(rand_range\(values\[(\d+)\], values\[(\d+)\] \+ 1\)\)$/))) {
    const lo = at(m[1]);
    const hi = at(m[2]);
    return lo === null || hi === null ? '随机值' : `${numText(lo)}–${numText(hi)} 随机`;
  }
  if (/^rand_range\(0, 100\)$/.test(e)) return '0–100 随机';
  if ((m = e.match(/^values\[(\d+)\] \/ 100\.0$/))) {
    const n = at(m[1]);
    return n === null ? '数值的百分之一' : `${numText(n / 100)}`;
  }
  // 「每持有一个某道具就加 N」：values[i] * 道具.item_count / 某符号.values[i] * 道具.item_count
  if ((m = e.match(/^(?:values\[(\d+)\]|([a-z0-9_]+)\.values\[(\d+)\]) \* ([a-z0-9_]+)\.item_count$/))) {
    const n = m[1] ? at(m[1]) : SYMBOL_BY_ID.get(m[2])?.values[Number(m[3])] ?? null;
    return n === null ? `每持有一个${symbolName(m[4])}就加一次` : `每持有一个${symbolName(m[4])} +${numText(n)}`;
  }
  if ((m = e.match(/^([a-z0-9_]+)\.values\[(\d+)\] \* items\[item_types\.find\("([a-z0-9_]+)"\)\]\.item_count$/))) {
    const n = SYMBOL_BY_ID.get(m[1])?.values[Number(m[2])] ?? null;
    return n === null ? `每持有一个${symbolName(m[3])}就加一次` : `每持有一个${symbolName(m[3])} +${numText(n)}`;
  }
  // 「每持有一个某道具，倍率再乘一次」：pow(X.values[i], X.item_count)
  if ((m = e.match(/^pow\(([a-z0-9_]+)\.values\[(\d+)\], [a-z0-9_]+\.item_count\)$/))) {
    const base = SYMBOL_BY_ID.get(m[1])?.values[Number(m[2])] ?? null;
    return base === null ? `每持有一个${symbolName(m[1])}就再乘一次` : `每持有一个${symbolName(m[1])}就 ×${numText(base)}`;
  }
  if ((m = e.match(/^pow\(items\[item_types\.find\("([a-z0-9_]+)"\)\]\.values\[(\d+)\], items\[/))) {
    const base = SYMBOL_BY_ID.get(m[1])?.values[Number(m[2])] ?? null;
    return base === null ? `每持有一个${symbolName(m[1])}就再乘一次` : `每持有一个${symbolName(m[1])}就 ×${numText(base)}`;
  }
  // 胶囊机倍率：pow(values[0], capsule_machine_multiplier) / int(values[0] * capsule_machine_multiplier)
  if (/capsule_machine_multiplier/.test(e)) return '按胶囊机倍率放大';
  // 自计数器放大：saved_value * values[0]
  if ((m = e.match(/^saved_value \* values\[(\d+)\]$/))) {
    const n = at(m[1]);
    return n === null ? '每点积累加一次' : `每点积累 +${numText(n)}`;
  }
  // 反向倍率：1 + (1 - values[0])
  if ((m = e.match(/^1\.0 \+ \(1\.0 - values\[(\d+)\]\)$/))) {
    const n = at(m[1]);
    return n === null ? '随局面变化' : numText(1 + (1 - n));
  }
  // 细则相关：未激活时按 0 处理，只说明来源
  if (/^-?fp\.values\[\d+\]/.test(e)) return '细则加成';
  // 骰子区间随机：floor(rand_range(d3.values[0], d3.values[1] + 1))
  if ((m = e.match(/^floor\(rand_range\(([a-z0-9_]+)\.values\[(\d+)\], [a-z0-9_]+\.values\[(\d+)\] \+ 1\)\)$/))) {
    const def = SYMBOL_BY_ID.get(m[1]);
    const lo = def?.values[Number(m[2])];
    const hi = def?.values[Number(m[3])];
    return lo === undefined || hi === undefined ? '随机值' : `${numText(lo)}–${numText(hi)} 随机`;
  }
  // 按场上某符号的个数放大
  if ((m = e.match(/^(?:values\[(\d+)\]|([a-z0-9_]+)\.values\[(\d+)\]) \* reels\.counted_symbols\["([a-z0-9_]+)"\]$/))) {
    const n = m[1] ? at(m[1]) : SYMBOL_BY_ID.get(m[2])?.values[Number(m[3])] ?? null;
    return n === null ? `每场上有一个${symbolName(m[4])}就加一次` : `每场上有一个${symbolName(m[4])} +${numText(n)}`;
  }
  if ((m = e.match(/counted_symbols\["([a-z0-9_]+)"\]/))) return `每有一个${symbolName(m[1])}就加一次`;
  if ((m = e.match(/^int\(values\[(\d+)\]\)$/))) {
    const n = at(m[1]);
    return n === null ? '本符号数值（面板值）' : String(Math.floor(n));
  }
  if ((m = e.match(/^values\[(\d+)\] - 1$/))) {
    const n = at(m[1]);
    return n === null ? '本符号数值（面板值）减一' : numText(n - 1);
  }
  if ((m = e.match(/^values\[(\d+)\] \+ 1$/))) {
    const n = at(m[1]);
    return n === null ? '本符号数值（面板值）加一' : numText(n + 1);
  }
  if ((m = e.match(/^-values\[(\d+)\]$/))) {
    const n = at(m[1]);
    return n === null ? '自身面板数值的相反数' : numText(-n);
  }
  if ((m = e.match(/^values\[(\d+)\]$/))) {
    const n = at(m[1]);
    return n === null ? '本符号数值（面板值）' : numText(n);
  }
  // 引用另一个符号的面板数值：d3.values[1]
  if ((m = e.match(/^([a-z0-9_]+)\.values\[(\d+)\]$/))) {
    const n = SYMBOL_BY_ID.get(m[1])?.values[Number(m[2])];
    return n === undefined ? `${symbolName(m[1])} 的数值` : numText(n);
  }
  return '随局面变化';
}

/** 声明里的值：字面量直出，引用尽量解析成具体数字 */
function fmtValue(v: EffectValue, owner?: Owner): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? '' : '';
  if (typeof v === 'number') return numText(v);
  // "rand_num" 是 rand_range(0,100) 占位，不能当符号名渲染成 "Rand Num"
  if (v === 'rand_num') return '随机数';
  if (typeof v === 'string') return symbolName(v);
  const o = v as Record<string, unknown>;
  if ('$dyn' in o) return dynText(String(o.$dyn), owner);
  if ('$ref' in o) return '对方的数值';
  if ('$ref_value' in o) return `${symbolName(String(o.$ref_value))} 的数值`;
  if ('$self_index' in o) {
    const n = ownerNum(owner, Number(o.$self_index));
    return n === null ? '本符号数值（面板值）' : numText(n);
  }
  if ('$self_value' in o) return '本符号的数值';
  if ('$adj_count' in o) return '相邻格数';
  if ('$fp' in o) return '细则数值';
  if ('counted_symbols' in o) {
    const k = o.counted_symbols as unknown;
    // 具体符号名优先（{\"counted_symbols\":\"cultist\"}），动态类型退回泛称
    return typeof k === 'string' ? `场上${symbolName(k)}数` : '场上同类符号数';
  }
  return '随局面变化';
}

interface Cond {
  typeName?: string;
  /** 分组名，如 dwarflikes → 亲矮人 */
  groupLabel?: string;
  destroyed?: boolean;
  /** 条件里含随机判定：说得出概率的走 chance，说不出的只标「有概率」 */
  luck: boolean;
  /** 按数值决定概率的随机条件：数字是百分比，null 表示数值未知 */
  chance?: number | null;
  extras: string[];
  /** 条件里除了「相邻有 X」没有别的内容 */
  onlyType: boolean;
}

/** 把 comparisons 读成「类型 + 状态 + 附加条件」，内部字段不出现 */
function readCond(rule: EffectRule, owner?: Owner, adjacent = false): Cond {
  const out: Cond = { extras: [], onlyType: true, luck: false };
  for (const cmp of rule.comparisons) {
    // a 可能是 {"counted_symbols":"cultist"} 这类对象谓词，先归一到谓词名；
    // null + dynamic_a_key 的写法描述期无从称呼，跳过（执行期照常生效）
    const a = cmp.a as unknown;
    const key =
      typeof a === 'string'
        ? a
        : typeof a === 'object' && a !== null && 'counted_symbols' in a
          ? 'counted_symbols'
          : '';
    if (!key) continue;
    if (key === 'type') {
      // 作用在邻格时，类型条件说的是邻居（螃蟹看旁边的螃蟹）；
      // 作用在自己时，写自己是「本符号」自身的状态，不当作邻居条件。
      if (typeof cmp.b === 'string' && (adjacent || cmp.b !== owner?.id)) out.typeName = symbolName(cmp.b);
      continue;
    }
    if (key === 'groups' && typeof cmp.b === 'string') {
      out.groupLabel = groupName(cmp.b);
      continue;
    }
    // 场上某符号的个数达到阈值（邪教徒、钻石、西瓜、忍者这类「同类聚集」判定）
    if (key === 'counted_symbols') {
      const who = (a as { counted_symbols?: unknown }).counted_symbols;
      const label = typeof who === 'string' ? symbolName(who) : '同类符号';
      const n = fmtValue(cmp.b as EffectValue, owner);
      out.onlyType = false;
      // 阈值可能来自表达式（红宝石/祖母绿是「自身面板值」），
      // 直接嵌进「场上有 N 个以上」会变成「场上有 自身面板值 个以上」
      const numeric = isNumeric(n);
      const qty = numeric ? `${n} 个` : n;
      const cmpText = (): string => {
        if (!numeric) return `场上${label}数量达到 ${n}`;
        if (cmp.greater_than !== undefined) return n === '0' ? `场上有${label}` : `场上有超过 ${qty}${label}`;
        if (cmp.greater_than_eq) return `场上有 ${qty}以上${label}`;
        if (cmp.less_than !== undefined) return `场上不到 ${qty}${label}`;
        if (cmp.less_than_eq) return `场上至多 ${qty}${label}`;
        return `场上正好 ${qty}${label}`;
      };
      out.extras.push(cmpText());
      continue;
    }
    // tbd 是「已判定要摧毁、等本转走完」的内部标记，玩家不需要看到
    if (key === 'tbd') continue;
    out.onlyType = false;
    if (key === 'destroyed') {
      out.destroyed = cmp.b === true;
      continue;
    }
    if (key === 'rarity' && typeof cmp.b === 'string') {
      // 细则块等自作用声明里，稀有度条件说的是本符号自己
      out.extras.push(`${adjacent ? '相邻是' : '本符号是'}${RARITY_LABEL[cmp.b as Rarity] ?? cmp.b}符号`);
      continue;
    }
    if (key === 'adjacent_empty') {
      out.extras.push('周围有空位');
      continue;
    }
    if (key === 'removed') {
      out.extras.push(cmp.b ? '已被移除' : '还留在场上');
      continue;
    }
    if (key === 'wildcarded') {
      out.extras.push('是万能符号');
      continue;
    }
    if (key === 'drained') {
      out.extras.push('被吸干过');
      continue;
    }
    if (key === 'indestructible') {
      out.extras.push(cmp.b ? '不可被摧毁' : '可以被摧毁');
      continue;
    }
    // 随机阈值（rand:true）：源码判定是「值 ≥ rand_range(0,100)」，
    // 成立概率就是数值本身（种子 25 → 25%），直接说几成
    if ((cmp as unknown as Record<string, unknown>).rand) {
      const n = ownerNum(owner, Number(cmp.value_num ?? 0));
      out.chance = n === null ? null : Math.max(0, Math.min(100, n));
      continue;
    }
    // 随机表达式属于运气判定，不把数值门槛摊给玩家看；
    // 非随机的动态表达式（数值、出现次数之类）继续往下走，避免被说成「有概率」
    if (cmp.b && typeof cmp.b === 'object' && '$dyn' in (cmp.b as Record<string, unknown>)) {
      const expr = String((cmp.b as Record<string, unknown>).$dyn);
      if (/rand/i.test(expr)) {
        out.luck = true;
        continue;
      }
    }
    if (key === 'values' || key === 'value' || key === 'value_bonus') {
      // 比较运算符两侧留空格，和中英混排的其余文案保持一致
      out.extras.push(`数值 ${opText(cmp)} ${fmtValue(cmp.b, owner)}`);
      continue;
    }
    if (key === 'times_displayed') {
      // 阈值是动态表达式（还要扣时间机器差值）时，别把公式摊给玩家
      out.extras.push(
        cmp.b && typeof cmp.b === 'object'
          ? '出现次数攒够'
          : `已出现 ${opText(cmp)} ${fmtValue(cmp.b, owner)} 次`,
      );
      continue;
    }
    if (key === 'times_coins_given') {
      out.extras.push(
        cmp.b && typeof cmp.b === 'object'
          ? '给币次数攒够'
          : `已给币 ${opText(cmp)} ${fmtValue(cmp.b, owner)} 次`,
      );
      continue;
    }
    if (key === 'saved_value') {
      // 结尾留空格：这句后面可能直接接「且…」（「已积累 ≥ 5 且可以被摧毁」），
      // 不留空格会把数字和汉字黏在一起
      out.extras.push(`已积累 ${opText(cmp)} ${fmtValue(cmp.b, owner)} `);
      continue;
    }
    if (key === 'symbol_trigger') {
      out.extras.push('被其他符号触发过');
      continue;
    }
    // grid_position_x/y：站在哪一列属于内部布局，玩家侧不展示
  }
  return out;
}

function opText(cmp: EffectComparison): string {
  if (cmp.greater_than !== undefined) return '>';
  if (cmp.less_than !== undefined) return '<';
  if (cmp.greater_than_eq) return '≥';
  if (cmp.less_than_eq) return '≤';
  return '=';
}

/** 动作型属性：句子用「摧毁 / 变成」这类动词，不接数值 */
const VERB_VTC = new Set(['destroyed', 'removed', 'wildcarded', 'type', 'drained', 'indestructible']);

/**
 * 需要「改为」系词的状态型属性。
 * 只收「形容词式」的效果文案：不可被摧毁 / 被吸干。
 * `type` / `wildcarded` 的文案自带动词（变成钻石 / 变成万能符号），再加会得到「改为变成」。
 */
const STATE_VTC = new Set(['indestructible', 'drained']);

/** 数值写法：负数原样带符号，整句（每出现一次 +2）不加号，其余补 + */
function amountText(d: string): string {
  if (/^[+\-]/.test(d) || /^[^0-9.]/.test(d)) return d;
  return `+${d}`;
}

/** d 是不是能直接运算的纯数字（允许带正负号） */
function isNumeric(d: string): boolean {
  return /^[-+]?\d/.test(d);
}

/**
 * 「按某个频率递增」的描述，如 `每持有一个扎罗夫契约 +20`、`每出现一次 +4`。
 * 它不是数值，直接拼到「数值 +」后面会断成
 * 「数值 + 每持有一个扎罗夫契约 +20」，读不出是「每层递增」。
 * 这里把它拆成「每次的量」+「计次单位」，统一改写成「数值 +20（每个扎罗夫契约）」。
 */
interface Rate {
  /** 计次单位：每个扎罗夫契约 / 每次出现 / 每点积累 */
  per: string;
  /** 每次的量，已带运算符：+20 / ×3 */
  amount: string;
}

const RATE_PATTERNS: Array<{
  re: RegExp;
  per: (m: RegExpMatchArray) => string;
  amount: (m: RegExpMatchArray) => string;
}> = [
  // 每持有一个X就加一次 / 每持有一个X就 ×3 / 每持有一个X +20
  { re: /^每持有一个(.+?)\s*就\s*加一次$/, per: (m) => `每个${m[1]}`, amount: () => '+1' },
  { re: /^每持有一个(.+?)\s*就\s*([+\-×][\d.]+)$/, per: (m) => `每个${m[1]}`, amount: (m) => m[2] },
  { re: /^每持有一个(.+?)\s+([+\-][\d.]+)$/, per: (m) => `每个${m[1]}`, amount: (m) => m[2] },
  // 每有一个X就加一次 / 每场上有一个X +N
  { re: /^每有一个(.+?)\s*就加一次$/, per: (m) => `每个${m[1]}`, amount: () => '+1' },
  { re: /^每场上有一个(.+?)\s*就加一次$/, per: (m) => `每个${m[1]}`, amount: () => '+1' },
  { re: /^每场上有一个(.+?)\s+([+\-][\d.]+)$/, per: (m) => `每个${m[1]}`, amount: (m) => m[2] },
  // 每出现一次 +N
  { re: /^每出现一次\s*就加一次$/, per: () => '每次出现', amount: () => '+1' },
  { re: /^每出现一次\s+([+\-][\d.]+)$/, per: () => '每次出现', amount: (m) => m[1] },
  // 每点积累 +N
  { re: /^每点积累\s*加一次$/, per: () => '每点积累', amount: () => '+1' },
  { re: /^每点积累\s+([+\-][\d.]+)$/, per: () => '每点积累', amount: (m) => m[1] },
  // 每块化石 +N
  { re: /^每块化石\s*就加一次$/, per: () => '每块化石', amount: () => '+1' },
  { re: /^每块化石\s+([+\-][\d.]+)$/, per: () => '每块化石', amount: (m) => m[1] },
  // 每持有一个就 +N（没有点名是哪件道具）
  { re: /^每持有一个就\s*([+\-][\d.]+)$/, per: () => '每持有一层', amount: (m) => m[1] },
];

function parseRate(d: string): Rate | null {
  for (const p of RATE_PATTERNS) {
    const m = p.re.exec(d);
    if (m) return { per: p.per(m), amount: p.amount(m) };
  }
  return null;
}

/**
 * 描述型数值来源 → 能直接读的动词短语。
 * 「数值 + 对方的数值」要玩家自己断句，一律改成「数值增加对方的数值」。
 */
const VALUE_SOURCE: Array<{ re: RegExp; phrase: (m: RegExpMatchArray) => string }> = [
  // 句子的主语已经是本符号，再写「本符号数值等于本符号的面板值」会重复主语。
  // 统一收成「变为自身 X」，由调用方决定前面接不接主语。
  { re: /^本符号数值（面板值）$/, phrase: () => '变为自身面板值' },
  { re: /^本符号的数值$/, phrase: () => '变为自身当前值' },
  { re: /^本符号数值$/, phrase: () => '变为自身当前值' },
  { re: /^对方的数值$/, phrase: () => '增加对方的数值' },
  { re: /^细则加成$/, phrase: () => '增加细则给出的数值' },
  { re: /^随机数$/, phrase: () => '增加 0–100 的随机值' },
  { re: /^相邻格数$/, phrase: () => '增加相邻格数' },
  { re: /^随局面变化$/, phrase: () => '随局面变化' },
];

/** 给数值补一个单位；递增描述改写成「数值 +20（每个 X）」 */
function unitText(unit: string, d: string): string {
  const rate = parseRate(d);
  if (rate) return `${unit} ${rate.amount}（${rate.per}）`;
  const a = amountText(d);
  if (/^[0-9+\-]/.test(a)) return `${unit} ${a}`;
  for (const src of VALUE_SOURCE) {
    const m = src.re.exec(d);
    if (m) return `${unit}${src.phrase(m)}`;
  }
  // 递增描述（「每块化石 +1」）：把它放到「（每…）」里，主语仍是本符号
  const rateLike = parseRate(`每${d.replace(/^每/, '')}`);
  if (rateLike && /^每/.test(d)) return `${unit}${rateLike.amount}（${rateLike.per}）`;
  // 其余量词型来源也走「增加…」，不再产出「数值 + 什么」的半截话
  return `${unit}增加${d}`;
}

/** 倍率写法：数字直接乘，递增描述改写成「倍率 ×3（每个 X）」，其余用「乘以」避开半截话 */
function timesText(unit: string, d: string): string {
  const rate = parseRate(d);
  if (rate) return `${unit} ${rate.amount}（${rate.per}）`;
  if (isNumeric(d)) return `${unit} ×${d}`;
  // 「乘以按胶囊机倍率放大」是双重介词，改写成「按…放大」
  if (/^按/.test(d)) return `${unit}${d}`;
  return `${unit}乘以${d}`;
}

/** 计数型数值加成：diff 直接就是「场上某符号的个数」 */
const COUNTED_BONUS_VTC = new Set(['value_bonus', 'value', 'bonus_values']);

function countedBonusOwner(rule: EffectRule): string | null {
  if (!COUNTED_BONUS_VTC.has(rule.vtc)) return null;
  if (rule.flags.includes('overwrite')) return null;
  const d = rule.diff as unknown;
  if (!d || typeof d !== 'object') return null;
  const k = (d as { counted_symbols?: unknown }).counted_symbols;
  return typeof k === 'string' ? k : null;
}

/** 效果本身，返回「值型」或「动作型」两种句块 */
function effectText(rule: EffectRule, owner?: Owner): string {
  const vtc = rule.vtc;
  // 稀有度上调本身没有数值，写成句子而不是留空：幸运猫这类道具全靠它起作用
  if (RARITY_KEYS.has(vtc)) return `稀有度提到「${RARITY_LABEL[vtc as Rarity] ?? vtc}」`;
  if (vtc === 'type') {
    if (typeof rule.diff === 'string') return `变成${symbolName(rule.diff)}`;
    // diff 为空时靠 flags 从某个组里按稀有度随机挑（种子长成植物的写法）
    const group = rule.flags.find((f) => f.startsWith('group:'))?.slice('group:'.length);
    const minRaw = rule.flags.find((f) => f.startsWith('min_rarity:'))?.slice('min_rarity:'.length);
    if (group) {
      const base = `变成随机的${groupName(group)}`;
      if (!minRaw) return base;
      const label = RARITY_LABEL[minRaw as Rarity] ?? minRaw;
      // 顶档没有「至少」可言，直接写稀有度
      return RARITY_ORDER.indexOf(minRaw as Rarity) === RARITY_ORDER.length - 1
        ? `${base}（${label}）`
        : `${base}（至少${label}）`;
    }
    return '变回原样';
  }
  if (vtc === 'destroyed') return rule.diff === false ? '不再被摧毁' : '摧毁';
  if (vtc === 'removed') return '移除';
  if (vtc === 'wildcarded') return '变成万能符号';
  if (vtc === 'drained') return '被吸干';
  // 「打不碎」是口语；统一用机制名「不可被摧毁」
  if (vtc === 'indestructible') return '不可被摧毁';

  // diff 由「被作用符号的某个槽位 × 系数」在运行时算出（矮人吃了亲矮人拿它的数值）
  if (rule.diff === null && rule.flags.some((f) => f.startsWith('diffkey:'))) {
    const key = rule.flags.find((f) => f.startsWith('diffkey:'))!.slice('diffkey:'.length);
    const SLOT: Record<string, string> = {
      value: '数值',
      non_prev_final_value: '数值',
      saved_value: '积累',
      bonus_values: '额外数值',
      value_multiplier: '本轮倍率',
      permanent_multiplier: '永久倍率',
      item_value: '数值',
    };
    const what = `被摧毁符号的${SLOT[key] ?? '对应数值'}`;
    switch (vtc) {
      case 'value':
        return `数值变为${what}`;
      case 'value_multiplier':
        return `本轮倍率按${what}提升`;
      case 'permanent_multiplier':
        return `永久倍率按${what}提升`;
      default:
        return `数值增加${what}`;
    }
  }

  const d = fmtValue(rule.diff, owner);
  /**
   * overwrite 是「直接改成某个值」，不是加减。
   * 但这里的 d 可能是描述型来源（「本符号数值（面板值）」），
   * 直接拼会得到「数值变为 本符号数值（面板值）」——同一句里两个主语。
   */
  const overwriteText = (): string => {
    const src = VALUE_SOURCE.find((s) => s.re.test(d));
    if (src) return `数值${src.phrase(d.match(src.re)!)}`;
    // 递增描述（诡秘之兽「每块化石 +1」）走与加法相同的量词映射，空格也保持一致
    const rate = parseRate(d);
    if (rate) return `数值 ${rate.amount}（${rate.per}）`;
    return `数值变为 ${d}`;
  };
  switch (vtc) {
    case 'value':
      if (!d) return '数值改变';
      return rule.flags.includes('overwrite') ? overwriteText() : unitText('数值', d);
    case 'flat_value_bonus':
      return d ? unitText('固定', d) : '固定加成';
    case 'value_bonus':
      if (!d) return '数值上升';
      return rule.flags.includes('overwrite') ? overwriteText() : unitText('数值', d);
    case 'permanent_bonus':
      return d ? unitText('永久', d) : '永久上升';
    case 'permanent_bonuses': {
      // {type|groups, bonus|multiplier}：给一整类符号挂永久加成（精华消耗时结算）。
      // 以前这里落到 default 返回空串，42 条精华的收益因此完全看不见。
      const spec = (rule.diff ?? {}) as Record<string, unknown>;
      const who =
        typeof spec.groups === 'string'
          ? `${groupName(spec.groups)}符号`
          : typeof spec.type === 'string'
            ? symbolName(spec.type)
            : '符号';
      const mul = fmtValue(spec.multiplier as EffectValue, owner);
      // ×1 等于没改，说「×1」只会让人以为有增益
      if (mul && Number(mul) !== 1) return `所有${who}的永久倍率 ×${mul}`;
      const add = fmtValue(spec.bonus as EffectValue, owner);
      return add ? `所有${who}数值 +${add}` : `所有${who}永久提升`;
    }
    case 'value_multiplier':
      return d ? timesText('本轮倍率', d) : '本轮倍率上升';
    case 'permanent_multiplier':
      return d ? timesText('永久倍率', d) : '永久倍率上升';
    case 'bonus_values':
      return d ? unitText('额外数值', d) : '额外数值上升';
    case 'bonus_value_multipliers':
      return d ? timesText('额外倍率', d) : '额外倍率上升';
    case 'saved_value':
      if (!d) return '开始积累';
      // 攒满之后清零重来（信用卡）
      if (rule.flags.includes('overwrite') && /^0(\.0+)?$/.test(d)) return '积累清零';
      return unitText('积累', d);
    case 'grown_apples':
      return d ? unitText('苹果成长', d) : '苹果成长';
    case 'grown_strawberries':
      return d ? unitText('草莓成长', d) : '草莓成长';
    case 'removal_value':
      return d ? unitText('移除代币', d) : '移除代币上升';
    case 'reroll_value':
      return d ? unitText('重摇次数', d) : '重摇次数上升';
    case 'essence_value':
      return d ? unitText('精华', d) : '精华上升';
    default:
      return '';
  }
}

/** 生效条件写成前提；细则开关属于整局规则，玩家看不到，不进句子 */
function gateText(rule: EffectRule): string {
  const holds: string[] = [];
  const lacks: string[] = [];
  const anyHolds: string[] = [];
  for (const gate of gatesOf(rule)) {
    if (gate.kind === 'item') holds.push(...gate.keys.map((k) => symbolName(k)));
    else if (gate.kind === 'no_item') lacks.push(...gate.keys.map((k) => symbolName(k)));
    else if (gate.kind === 'any_item') anyHolds.push(gate.keys.map((k) => symbolName(k)).join('或'));
  }
  const parts: string[] = [];
  // 道具名之间用「和」：外层还要与「本符号被摧毁」等前提并列，
  // 内部若也用顿号会读成「没持有A、B、给币次数攒够」，分不清哪些是道具名。
  if (holds.length > 0) parts.push(`持有${holds.join('和')}`);
  if (anyHolds.length > 0) parts.push(`持有${anyHolds.join('和')}`);
  if (lacks.length > 0) parts.push(`没持有${lacks.join('和')}`);
  return parts.join('且');
}

/** item_to_destroy：句末补一句「消耗什么」 */
function consumeText(rule: EffectRule): string {
  const ids = consumeOf(rule);
  return ids.length > 0 ? `（消耗${ids.map((id) => symbolName(id)).join('、')}）` : '';
}

/**
 * 把一条声明渲染成玩家能读懂的一句话；返回空串表示这条不值得展示。
 *
 * 一条声明可能同时有「持有物门控」和「符号自身状态」两层前提，
 * 外层若各自补一个「时」会断成
 * 「持有扎罗夫契约时，本符号被摧毁时，数值 +20」——玩家要自己判断层级。
 * 这里把两层前提合成一句，只保留一个「时」。
 */
/**
 * 中英文之间补一个空格（中文排版惯例）。
 * 符号名里含拉丁字母时（「X 光机」「第五张 A」）会紧贴住「时」「和」这类汉字，
 * 在句子里读起来像半个词。统一在出口补，避免每个拼接点各写一遍。
 */
function spaceCJK(text: string): string {
  return text
    .replace(/([A-Za-z0-9\]])([\u4e00-\u9fff])/g, '$1 $2')
    .replace(/([\u4e00-\u9fff])([A-Za-z0-9\[])/g, '$1 $2');
}

export function describeRule(rule: EffectRule, owner?: Owner): string {
  const body = describeRuleBody(rule, owner);
  // tiles_to_add 的语义是「往棋盘里塞一个新符号」，和数值改动可以同时存在
  // （蜂巢值 +1 的同时产蜜），所以两条文案拼在一起，而不是互相覆盖。
  const spawn = spawnTextOf(rule);
  const core =
    body && spawn
      ? body.endsWith('，')
        ? `${body}${spawn}`
        : `${body}，并${spawn}`
      : body || spawn;
  if (!core) return '';
  const eat = consumeText(rule);
  const gate = gateText(rule);
  // body 以「…时，」开头说明它自己带了前置条件。两层各自补一个「时」会断成
  // 「持有扎罗夫契约时，本符号被摧毁时，…」，读者要自己判断层级；
  // 合并成一句、只保留句末一个「时」。
  // 用「，」分隔：门控内部已用「和」列道具名、「且」连接不同类型的前提，
  // 这里再用「，」才是清晰的三级层次（门控内 → 两层前提之间 → 效果）。
  const inner = /^(.*?)时，/.exec(core);
  const text =
    gate && inner
      ? `${gate}，${inner[1]}时，${core.slice(inner[0].length)}${eat}`
      : gate
        ? `${gate}时，${core}${eat}`
        : `${core}${eat}`;
  return spaceCJK(text);
}

/** 生成声明的文案：`生成 1 个蜂蜜` / `生成 2 个宝石类符号` */
function spawnTextOf(rule: EffectRule): string {
  if (!rule.spawn || rule.spawn.length === 0) return '';
  const parts = rule.spawn.map((spec) => {
    // current_type / prev_destroyed_symbol 是执行期占位符（「刚被摧毁的那个符号」），
    // 译名表里没有它们，直接交给 symbolName 会渲染成 "Current Type"
    const isPlaceholder = spec.type === 'prev_destroyed_symbol' || spec.type === 'current_type';
    const what = isPlaceholder
      ? '刚被摧毁的符号'
      : spec.type
        ? symbolName(spec.type)
        : spec.group
          ? `${groupName(spec.group)}符号`
          : '符号';
    // count 可能写成表达式（values[N] / item_count），具体数字要到执行期才知道。
    // 这种情况说明「数量」的来源，不要用「若干」——它会和「那个」这类限定词打架。
    if (typeof spec.count === 'number') {
      const noun = isPlaceholder ? '刚被摧毁的那个符号' : what;
      return `${spec.count} 个${noun}`;
    }
    const dyn = (spec.count as { $dyn?: string } | undefined)?.$dyn ?? '';
    if (/item_count/.test(dyn)) return `每个本道具 1 个${what}`;
    if (/\$self_index|values\[/.test(dyn)) return `若干${what}（数量取自本符号的面板值）`;
    return `1 个${what}`;
  });
  return `生成 ${parts.join('、')}`;
}

/** `*fineprint*` 伪符号的规则靠 fp 门控区分于普通符号规则 */
function isFinePrintRule(rule: EffectRule): boolean {
  return gatesOf(rule).some((g) => g.kind === 'fp' || g.kind === 'no_fp' || g.kind === 'any_fp');
}

/** 一条细则当前带来哪些修正（UI 展示用） */
export function describeFinePrint(fp: FinePrintState): string[] {
  const out: string[] = [];
  // 以下几条不走 add_effect 模板，源码直接写在 Slot_Icon.change_type / get_adjacent_icons /
  // Pop-up.add_cards 里，只能手写
  const icon = fp.dynamicIcon ? symbolName(fp.dynamicIcon) : '';
  if (fp.num === 10 && icon) out.push(`「${icon}」不会被摧毁（仍可被移除）`);
  if (fp.num === 20 && !fp.dynamicIcon) out.push('「金币」不会被摧毁，也不能被移除');
  if (fp.num === 21 && !fp.dynamicIcon) out.push('「蛋」不会被摧毁，也不能被移除');
  if (fp.num === 22) out.push('相邻只算左右与斜角，正上/正下不算');
  if (fp.num === 23) out.push(`稀有符号出现权重 ÷${fp.values[0] ?? 1}`);
  if (fp.num === 30) out.push(`商店候选数 ${Math.max(0, 3 - (fp.values[0] ?? 0))} 张`);
  if (fp.num === 36 && icon) out.push(`「${icon}」不会被摧毁，也不能被移除`);
  for (const rule of FINE_PRINT_RULES) {
    if (!isFinePrintRule(rule)) continue;
    // indestructible 的文案已由上面的手写分支给出，避免重复
    if (rule.vtc === 'indestructible') continue;
    if (!gatesOf(rule).every((g) => fpGateHolds(g, fp))) continue;
    const inst = instantiateFinePrint(rule, fp);
    if (inst.flags.includes('when:fp_icon:any') && !fp.dynamicIcon) continue;
    if (inst.flags.includes('when:no_fp_icon:any') && fp.dynamicIcon) continue;
    // 细则块是 add_effect（作用在符号自己身上），`type` 条件说的是「本符号就是它」，
    // 不能按邻居条件渲染成「相邻的 X 在场」。
    const subject = inst.comparisons.find((c) => c.a === 'type');
    const own = typeof subject?.b === 'string' ? symbolName(subject.b) : '';
    const rest = { ...inst, comparisons: inst.comparisons.filter((c) => c !== subject) };
    let text = describeRule({ ...rest, flags: rest.flags.filter((f) => !f.startsWith('when:fp')) });
    if (text && own) text = text.replace(/^本符号/, own).replace(/本符号/g, '它');
    if (text) out.push(text);
  }
  // 道具侧修正（Item__Item.gd 的 <outside> 块）：作用对象是持有物自身，单独表述
  for (const rule of ITEM_FINE_PRINT_RULES) {
    if (!isFinePrintRule(rule)) continue;
    if (!gatesOf(rule).every((g) => fpGateHolds(g, fp))) continue;
    const inst = instantiateFinePrint(rule, fp);
    if (inst.flags.includes('when:fp_icon:any') && !fp.dynamicIcon) continue;
    if (inst.flags.includes('when:no_fp_icon:any') && fp.dynamicIcon) continue;
    const icon = fp.dynamicIcon ? symbolName(fp.dynamicIcon) : '该道具';
    const dyn = (inst.diff as { $dyn?: string } | null)?.$dyn;
    const m = typeof dyn === 'string' ? /^(-?\d+(?:\.\d+)?) \* item_count$/.exec(dyn.trim()) : null;
    const per = m ? `每持有一个 ${Number(m[1]) >= 0 ? '+' : ''}${numText(Number(m[1]))}` : '随局面变化';
    out.push(`持有「${icon}」时，它自身的价值${per.replace('每持有一个 ', '每件 ')}`);
  }
  return out;
}

function describeRuleBody(rule: EffectRule, owner?: Owner): string {
  // 只有 tiles_to_add 的声明（煎锅：蛋被摧毁时生成煎蛋）：句子的后半截是「生成 X」，
  // 由 describeRule 拼，这里只负责条件前缀，并以逗号收尾。
  // 必须排在 SILENT_VTC 之前：空 vtc 在静默表里，否则整句会被当成无声明吞掉
  if (!rule.vtc && rule.diff === null && (rule.spawn?.length ?? 0) > 0) {
    const c = readCond(rule, owner, rule.flags.includes('target:adjacent'));
    const noun = c.typeName ?? (c.groupLabel ? `${c.groupLabel}符号` : '');
    const state = c.destroyed === undefined ? '' : c.destroyed ? '被摧毁的' : '完好的';
    // 门控由 describeRule 统一加在句首；这里再写一遍会渲染成
    // 「持有 X 光机时，持有 X 光机时，生成 1 个宝石符号」
    const pre = noun ? `每有一个${state}${noun}` : '';
    return pre ? `${pre}，` : '';
  }
  if (SILENT_VTC.has(rule.vtc)) return '';
  // 「数值 + 场上某符号个数」是计数型加成（邪教徒、钻石、西瓜），等价于每个 +1：
  // 写成「每有一个」比「+ 场上X数量」直白，也免得读者自己去做乘法
  const counted = countedBonusOwner(rule);
  if (counted) {
    const gate = gateText(rule);
    const line = `场上每有一个${symbolName(counted)}，本符号数值 +1`;
    return gate ? `${gate}时，${line}` : line;
  }
  const eff = effectText(rule, owner);
  if (!eff) return '';
  const adjacent = rule.flags.includes('target:adjacent');
  const c = readCond(rule, owner, adjacent);
  const isVerb = VERB_VTC.has(rule.vtc) || RARITY_KEYS.has(rule.vtc);

  // 邻居的称呼：显式类型 > 分组 > 泛称
  // 泛称要有量词：「摧毁相邻格」不成句，「摧毁相邻的符号」才是完整的宾语。
  const neighbor = c.typeName
    ? `相邻的${c.typeName}`
    : c.groupLabel
      ? `相邻的${c.groupLabel}符号`
      : '相邻的符号';

  // kind:"cond" 的声明挂在「满足条件的那个符号」身上（Item__Item.gd:1274-1298），
  // 效果落在它自己，不是发起者身上，所以措辞从「自己」换成那个符号。
  const onTarget =
    !adjacent && rule.kind === 'cond' && (c.typeName !== undefined || c.groupLabel !== undefined);
  const targetNoun = c.typeName ?? (c.groupLabel ? `${c.groupLabel}符号` : '目标');

  // 按数值决定的概率：源码判定是「值 ≥ 随机数」，概率就是数值本身；
  // 随机表达式条件（triggerchance 之类）说不清具体概率，只写「有概率」
  const odds =
    c.chance !== undefined
      ? c.chance === null
        ? '有概率'
        : `有 ${Math.round(c.chance)}% 概率`
      : c.luck
        ? '有概率'
        : '';

  if (adjacent) {
    if (rule.vtc === 'destroyed') return `摧毁${neighbor}`;
    if (rule.vtc === 'removed') return `移除${neighbor}`;
    // 状态型效果要先给出系词，否则「相邻的符号不可被摧毁」缺谓语
    const stateVerb = STATE_VTC.has(rule.vtc) ? `改为${eff}` : eff;
    // 没有任何条件：直接作用在每一格相邻符号上
    const bare = !c.typeName && !c.groupLabel && c.destroyed === undefined && !c.luck && c.extras.length === 0;
    if (bare) return isVerb ? `${neighbor}${stateVerb}` : `相邻符号${eff}`;
    if (isVerb) return `${neighbor}${stateVerb}`;
    // 条件里若还有别的限定，补在「每有一格」之后
    const rest = c.extras.join('、');
    return `每有一格${neighbor}${rest ? `（${rest}）` : ''}，${eff}`;
  }

  let cond = '';
  /** 前提只是「场上有 X」这一句，没有状态、次数之类的附加限定 */
  let plainCond = false;
  if (onTarget) {
    const state = c.destroyed === undefined ? '' : c.destroyed ? '被摧毁的' : '完好的';
    cond = `场上有${state}${targetNoun}`;
    plainCond = c.destroyed === undefined;
  } else if (c.typeName) cond = `相邻的${c.typeName}${c.destroyed === undefined ? '在场' : c.destroyed ? '被摧毁' : '完好'}`;
  else if (c.destroyed !== undefined) cond = c.destroyed ? '本符号被摧毁' : '本符号完好';
  const extras = c.extras;
  if (extras.length > 0) {
    // 附加前提都是必须同时成立的条件，用「且」连接。
    // 若前面已经有主条件，两者之间也用「且」而不是顿号——
    // 「场上有被摧毁的小偷、数值 < 1」读起来像并列名词，会误解成两个对象。
    const joined = extras.join('且');
    cond = cond ? `${cond}且${joined}` : joined;
    plainCond = false;
  }

  if (isVerb) {
    // 状态型效果（不可被摧毁 / 被吸干）是形容词短语，需要系词才成句：
    // 概率句用「让自己被吸干」，条件句用「自己改为不可被摧毁」。
    const stateAdj = STATE_VTC.has(rule.vtc);
    const selfVerb =
      rule.vtc === 'destroyed'
        ? '摧毁自己'
        : rule.vtc === 'removed'
          ? '移除自己'
          : stateAdj
            ? odds
              ? `自己被${eff.replace(/^被/, '')}`
              : `自己改为${eff}`
            : `自己${eff}`;
    // 概率句里主语已经是「这个符号」，再写「自己」就重复了
    const verb = odds ? selfVerb.replace(/^自己/, '') : selfVerb;
    if (onTarget) {
      // 主语已经是那个符号，「自己」要去掉
      const onIt = selfVerb.replace(/^自己/, '');
      const main =
        rule.vtc === 'destroyed'
          ? `摧毁${targetNoun}`
          : rule.vtc === 'removed'
            ? `移除${targetNoun}`
            : `${odds}让${targetNoun}${onIt}`;
      // 正文已经点名作用对象时，「场上有种子时」就是废话
      return cond && !(plainCond && main.includes(targetNoun)) ? `${cond}时，${main}` : main;
    }
    if (!cond) return `${odds}${verb}`;
    return odds ? `${cond}时，${odds}${verb}` : `${cond}时，${verb}`;
  }
  // 值型：条件在前，概率修饰主句的谓语（条件已在说本符号时不再重复主语）
  // kind=cond 是「对每个命中条件的符号各结算一次」，值型要写「每个 X」而不是「X」
  const each = onTarget && targetNoun !== '目标' ? '每个' : '';
  // 空位不是符号、自身没有数值，命中空位时加成只能落在本符号身上（柠檬）
  const onSelf = targetNoun === '空位';
  const subject = onTarget
    ? onSelf
      ? `${each}${targetNoun}，本符号${eff}`
      : `${each}${targetNoun}的${eff}`
    : cond.startsWith('本符号')
      ? eff
      : `本符号${eff}`;
  const main = odds ? `${odds}让${subject}` : subject;
  // 正文已经点名作用对象时，不再重复「场上有 X 时」
  if (onTarget && plainCond && main.includes(targetNoun)) return main;
  return cond ? `${cond}时，${main}` : main;
}
