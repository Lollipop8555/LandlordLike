// add_effect 声明解释器。
//
// 语义：comparisons 描述「相邻符号」要满足的条件，满足一次就对**自身**应用一次效果；
// comparisons 为空表示无条件对自身应用一次。
// 只执行符号表与数据表能确定的部分；被 fine_print / items 门控的声明记入 unsupported，
// 由拆解面板如实展示，不做近似。
import { EFFECTS, EFFECTS_BY_SYMBOL, SHOP_SYMBOLS, SYMBOL_BY_ID, symbol } from './data';
import { COLS, neighborsOf } from './grid';
import { groupName, symbolName } from './names';
import { RARITY_LABEL, RARITY_ORDER } from './types';
import type { Cell, EffectComparison, EffectRule, EffectValue, Rarity, SymbolDef } from './types';

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

/** 求值上下文：表达式里可能引用道具栏计数、随机数与网格位置 */
export interface EvalCtx {
  rand?: () => number;
  /** 道具栏里某道具的持有数（Item__Item.gd 的 items[i].item_count） */
  itemCount?: (id: string) => number;
  /** 场上某符号的个数（diff 里的 {"counted_symbols":"diamond"}） */
  count?: (id: string) => number;
  /** Pop-up / Items / Reels 上的全局槽位（compost_heap_symbols_destroyed 等） */
  globalSlot?: (key: string) => number | boolean | null;
  /** 本格的网格坐标，供 grid_position_x / grid_position_y 使用 */
  position?: { x: number; y: number };
  /** 相邻非空格数，供 $adj_count 使用 */
  adjacentCount?: number;
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
  return raw
    .replace(/\$\s*"\/root\/Main"\.tile_database\.([a-z0-9_]+)\.values\[(\d+)\]/g, '$1.values[$2]')
    .replace(/\$\s*"\/root\/Main[^"]*"\.[A-Za-z_][A-Za-z0-9_.]*/g, '0')
    .replace(/\$\s*"\/root\/Main[^"]*"/g, '0');
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
        // fine_print 未激活时细则值为 0，与原作起始状态一致
        return 0;
      }
      if (name.endsWith('.values')) {
        const id = name.slice(0, -'.values'.length);
        return idx === null ? 0 : (SYMBOL_BY_ID.get(id)?.values[idx] ?? 0);
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
  if ('$fp' in o) return 0;
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
  if (b === null) return false;

  // a 为 null：谓词名由 dynamic_a_key 给出；目标在 Pop-up / Items 上时读全局槽位
  if (comp.a === null && typeof raw.dynamic_a_key === 'string') {
    const key = raw.dynamic_a_key;
    const actual = ctx.globalSlot?.(key) ?? readSlot(other, key) ?? 0;
    if (typeof actual === 'boolean') return actual === Boolean(b);
    return cmpNum(comp, Number(actual), Number(b));
  }

  const a = predName(comp);

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
    case 'bonus_values':
      cell.bonusValues = [...(cell.bonusValues ?? []), num];
      return;
    case 'bonus_value_multipliers':
      cell.bonusValueMultipliers = [...(cell.bonusValueMultipliers ?? []), num || 1];
      return;
    case 'destroyed':
      // 不可破坏的符号挡下销毁（Slot_Icon__Slot_Icon.gd:3222-3229 会补 indestructible=false 条件）。
      // 先打 tbd 标记：本转照常计分，结算走完才落地成 destroyed 并从池中移除
      // （Slot_Icon__Slot_Icon.gd:2394-2405），这样「被摧毁后 value_bonus」的分支才有机会触发。
      if (diff === true && !cell.indestructible && cell.def && !cell.destroyed) cell.tbd = true;
      return;
    case 'destroyed_or_removed_by':
      cell.destroyedOrRemovedBy = String(diff);
      return;
    case 'type': {
      // 变形目标可以是字面量，也可以是「从 group 里按 min_rarity 随机选一个」
      // （Slot_Icon__Slot_Icon.gd 的 seed → plant 分支：diff 为空、靠 group + min_rarity 决定）
      let target: string | null = typeof diff === 'string' && SYMBOL_BY_ID.has(diff) ? diff : null;
      const group = rule.flags.find((f) => f.startsWith('group:'))?.slice('group:'.length);
      if (!target && typeof group === 'string') {
        const minRaw = rule.flags.find((f) => f.startsWith('min_rarity:'))?.slice('min_rarity:'.length);
        const minIdx = minRaw ? RARITY_ORDER.indexOf(minRaw as Rarity) : 0;
        const pool = SHOP_SYMBOLS.filter(
          (s) => s.groups.includes(group) && RARITY_ORDER.indexOf(s.rarity as Rarity) >= minIdx,
        );
        if (pool.length) target = pool[Math.floor((ctx.rand?.() ?? 0.5) * pool.length)].id;
      }
      if (!target) return;
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
  // 源码里的默认分支/占位分支：既不设属性也不给值，本身不产生任何操作
  if (!rule.vtc && rule.diff === null) return 'noop';
  if (rule.flags.some((f) => f.startsWith('gated:'))) return 'gated';
  if (!SUPPORTED_VTC.has(rule.vtc)) return 'unsupported_vtc';
  if (rule.comparisons.some((c) => !isSupportedPred(c))) return 'unsupported_pred';
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
function withAutoComparisons(rule: EffectRule, self: Cell): EffectComparison[] {
  const comps = [...rule.comparisons];
  const hasTypeGroups = comps.some((c) => {
    const a = predName(c);
    return a === 'type' || a === 'groups';
  });
  const skipAuto =
    comps.length === 0 ||
    hasTypeGroups ||
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
export function applyEffects(cells: Cell[], ctx: EvalCtx = {}): EffectRun {
  let applied = 0;
  let skipped = 0;

  for (let i = 0; i < cells.length; i += 1) {
    const cell = cells[i];
    // destroyed 的符号本转仍要跑自己的声明：源码里「被摧毁后 value_bonus」
    // 正是靠 destroyed=true 之后再判定一次才拿到奖励（Slot_Icon__Slot_Icon.gd:3165）。
    if (!cell.def) continue;
    const pos = positionOf(i);
    const local: EvalCtx = { ...ctx, position: pos };
    const rules = EFFECTS_BY_SYMBOL.get(cell.def.id) ?? [];
    for (const rule of rules) {
      if (ruleStatus(rule) !== 'executable') {
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
      const markApplied = (target: Cell): void => {
        remember(target);
        applied += 1;
      };
      if (typeof idx === 'number' && cell.appliedRules?.has(idx)) continue;

      // add_to_cond_effects：声明挂到「满足 conditions 的目标符号」身上，
      // 走全局 cond_effects_to_add 队列（Item__Item.gd:1274-1298），不是相邻挂载。
      // 因此作用域是全场：每个匹配的符号各应用一次。
      if (rule.kind === 'cond') {
        for (let t = 0; t < cells.length; t += 1) {
          const target = cells[t];
          if (target === cell || !target.def || target.destroyed) continue;
          if (!comps.every((c) => matchOne(c, target, cell, { ...local, position: positionOf(t) }))) continue;
          const d = diffFor(target);
          if (d === null) continue;
          applyTo(target, rule, d, local);
          markApplied(target);
        }
        continue;
      }

      if (rule.flags.includes('target:adjacent')) {
        for (const j of neighborsOf(i)) {
          const target = cells[j];
          if (!target.def || target.destroyed) continue;
          // 条件挂在被作用的那个相邻符号身上（Slot_Icon__Slot_Icon.gd:3364-3369），
          // 不是挂回发起者的邻域——坐标要换成目标的坐标再做判定。
          const targetCtx: EvalCtx = { ...ctx, position: positionOf(j) };
          if (!comps.every((c) => matchOne(c, target, cell, targetCtx))) continue;
          if (once && hits.has(target)) continue;
          const d = diffFor(target);
          if (d === null) continue;
          applyTo(target, rule, d, targetCtx);
          hits.add(target);
          markApplied(target);
        }
        continue;
      }

      if (comps.length === 0) {
        const d = diffFor(cell);
        // diff 缺失但带 group 的声明（seed → plant 随机变形）走 applyTo 内部选靶
        if (d === null && rule.vtc !== 'type') {
          skipped += 1;
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
        if (d === null) continue;
        applyTo(cell, rule, d, local);
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

/** 符号的全部声明（拆解面板用） */
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
}

const MULTIPLY_VTC = new Set(['value_multiplier', 'permanent_multiplier']);

/**
 * 道具的全局效果。
 * Items__Items.add_cond_effects() 把每条声明的 comparisons 收进 cond_effects_to_add，
 * 每轮结算再挂到满足条件的符号上（Item__Item.gd:1265-1298）。
 * 道具不占格、自身不结算，所以这里只执行 kind:"cond" 的声明。
 * 同类道具叠加时 diff 按 item_count 放大（源码闭包里做 effect.diff *= item_count），
 * 倍率类按幂放大，避免线性和把 ×2 ×2 算成 +2。
 */
export function applyItemEffects(
  items: ItemHolder[],
  cells: Cell[],
): { applied: number; skipped: number } {
  let applied = 0;
  let skipped = 0;
  if (items.length === 0) return { applied, skipped };

  for (const held of items) {
    if (!held.def || held.count <= 0) continue;
    const holder = { def: held.def } as Cell;
    for (const rule of EFFECTS_BY_SYMBOL.get(held.def.id) ?? []) {
      if (rule.kind !== 'cond') continue;
      if (!SUPPORTED_VTC.has(rule.vtc)) {
        skipped += 1;
        continue;
      }
      if (rule.comparisons.some((c) => !SUPPORTED_PRED.has(c.a))) {
        skipped += 1;
        continue;
      }
      const base = evalValue(rule.diff, holder);
      if (base === null) {
        skipped += 1;
        continue;
      }
      const n = Number(base);
      const diff = MULTIPLY_VTC.has(rule.vtc)
        ? Math.pow(n, held.count)
        : rule.flags.includes('multiply')
          ? n
          : n * held.count;

      let hit = 0;
      for (const target of cells) {
        if (!target.def || target.destroyed) continue;
        if (!rule.comparisons.every((c) => matchOne(c, target, holder))) continue;
        applyTo(target, rule, diff);
        hit += 1;
      }
      if (hit > 0) applied += hit;
      else skipped += 1;
    }
  }
  return { applied, skipped };
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
  if (/counted_symbols\["([a-z0-9_]+)"\]/.test(e)) return '按场上的符号数量放大';
  if ((m = e.match(/^int\(values\[(\d+)\]\)$/))) {
    const n = at(m[1]);
    return n === null ? '面板数值' : String(Math.floor(n));
  }
  if ((m = e.match(/^values\[(\d+)\] - 1$/))) {
    const n = at(m[1]);
    return n === null ? '面板数值减一' : numText(n - 1);
  }
  if ((m = e.match(/^values\[(\d+)\] \+ 1$/))) {
    const n = at(m[1]);
    return n === null ? '面板数值加一' : numText(n + 1);
  }
  if ((m = e.match(/^-values\[(\d+)\]$/))) {
    const n = at(m[1]);
    return n === null ? '面板数值的负数' : numText(-n);
  }
  if ((m = e.match(/^values\[(\d+)\]$/))) {
    const n = at(m[1]);
    return n === null ? '面板数值' : numText(n);
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
  if (typeof v === 'string') return symbolName(v);
  const o = v as Record<string, unknown>;
  if ('$dyn' in o) return dynText(String(o.$dyn), owner);
  if ('$ref' in o) return '对方的数值';
  if ('$ref_value' in o) return `${symbolName(String(o.$ref_value))} 的数值`;
  if ('$self_index' in o) {
    const n = ownerNum(owner, Number(o.$self_index));
    return n === null ? '面板数值' : numText(n);
  }
  if ('$self_value' in o) return '本符号的数值';
  if ('$adj_count' in o) return '相邻格数';
  if ('$fp' in o) return '细则数值';
  if ('counted_symbols' in o) return '被统计的符号数';
  return '随局面变化';
}

interface Cond {
  typeName?: string;
  /** 分组名，如 dwarflikes → 亲矮人 */
  groupLabel?: string;
  destroyed?: boolean;
  /** 条件里含随机判定（看运气） */
  luck: boolean;
  extras: string[];
  /** 条件里除了「相邻有 X」没有别的内容 */
  onlyType: boolean;
}

/** 把 comparisons 读成「类型 + 状态 + 附加条件」，内部字段不出现 */
function readCond(rule: EffectRule, owner?: Owner, adjacent = false): Cond {
  const out: Cond = { extras: [], onlyType: true, luck: false };
  for (const cmp of rule.comparisons) {
    const key = typeof cmp.a === 'string' ? cmp.a : '';
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
    // tbd 是「已判定要摧毁、等本转走完」的内部标记，玩家不需要看到
    if (key === 'tbd') continue;
    out.onlyType = false;
    if (key === 'destroyed') {
      out.destroyed = cmp.b === true;
      continue;
    }
    if (key === 'rarity' && typeof cmp.b === 'string') {
      out.extras.push(`相邻是${RARITY_LABEL[cmp.b as Rarity] ?? cmp.b}符号`);
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
      out.extras.push(cmp.b ? '打不碎' : '能被打碎');
      continue;
    }
    // 随机阈值（rand_range）属于运气判定，不把数值门槛摊给玩家看
    if (cmp.b && typeof cmp.b === 'object' && '$dyn' in (cmp.b as Record<string, unknown>)) {
      out.luck = true;
      continue;
    }
    if (key === 'values' || key === 'value' || key === 'value_bonus') {
      out.extras.push(`数值${opText(cmp)}${fmtValue(cmp.b, owner)}`);
      continue;
    }
    if (key === 'times_displayed') {
      out.extras.push(`已出现${opText(cmp)}${fmtValue(cmp.b, owner)}次`);
      continue;
    }
    if (key === 'times_coins_given') {
      out.extras.push(`已给币${opText(cmp)}${fmtValue(cmp.b, owner)}次`);
      continue;
    }
    if (key === 'saved_value') {
      out.extras.push(`已积累${opText(cmp)}${fmtValue(cmp.b, owner)}`);
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

/** 数值写法：负数原样带符号，整句（每出现一次 +2）不加号，其余补 + */
function amountText(d: string): string {
  if (/^[+\-]/.test(d) || /^[^0-9.]/.test(d)) return d;
  return `+${d}`;
}

/** 给数值补一个单位；整句时不留空格（「数值每出现一次 +2」） */
function unitText(unit: string, d: string): string {
  const a = amountText(d);
  return /^[0-9+\-]/.test(a) ? `${unit} ${a}` : `${unit}${a}`;
}

/** 效果本身，返回「值型」或「动作型」两种句块 */
function effectText(rule: EffectRule, owner?: Owner): string {
  const vtc = rule.vtc;
  if (RARITY_KEYS.has(vtc)) return '';
  if (vtc === 'type') {
    return typeof rule.diff === 'string' ? `变成${symbolName(rule.diff)}` : '变回原样';
  }
  if (vtc === 'destroyed') return rule.diff === false ? '不再被摧毁' : '摧毁';
  if (vtc === 'removed') return '移除';
  if (vtc === 'wildcarded') return '变成万能符号';
  if (vtc === 'drained') return '被吸干';
  if (vtc === 'indestructible') return '打不碎';

  // diff 由「被作用符号的某个槽位 × 系数」在运行时算出（矮人吃了亲矮人拿它的数值）
  if (rule.diff === null && rule.flags.some((f) => f.startsWith('diffkey:'))) {
    const key = rule.flags.find((f) => f.startsWith('diffkey:'))!.slice('diffkey:'.length);
    const what = key === 'value' || key === 'non_prev_final_value' ? '被摧毁符号的数值' : '目标的相关数值';
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
  switch (vtc) {
    case 'value':
      if (!d) return '数值改变';
      // overwrite 是「直接改成这个数」，否则是在原值上加减
      return rule.flags.includes('overwrite') ? `数值变为 ${d}` : unitText('数值', d);
    case 'flat_value_bonus':
      return d ? unitText('固定', d) : '固定加成';
    case 'value_bonus':
      if (!d) return '数值上升';
      // overwrite 表示直接把数值换成这个数（重摇精华这类）
      return rule.flags.includes('overwrite') ? `数值变为 ${d}` : unitText('数值', d);
    case 'permanent_bonus':
      return d ? unitText('永久', d) : '永久上升';
    case 'value_multiplier':
      return d ? `本轮倍率 ×${d}` : '本轮倍率上升';
    case 'permanent_multiplier':
      return d ? `永久倍率 ×${d}` : '永久倍率上升';
    case 'bonus_values':
      return d ? unitText('额外数值', d) : '额外数值上升';
    case 'bonus_value_multipliers':
      return d ? `额外倍率 ×${d}` : '额外倍率上升';
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

/** 把一条声明渲染成玩家能读懂的一句话；返回空串表示这条不值得展示 */
export function describeRule(rule: EffectRule, owner?: Owner): string {
  if (SILENT_VTC.has(rule.vtc)) return '';
  const eff = effectText(rule, owner);
  if (!eff) return '';
  const adjacent = rule.flags.includes('target:adjacent');
  const c = readCond(rule, owner, adjacent);
  const isVerb = VERB_VTC.has(rule.vtc) || RARITY_KEYS.has(rule.vtc);

  // 邻居的称呼：显式类型 > 分组 > 泛称
  const neighbor = c.typeName
    ? `相邻的${c.typeName}`
    : c.groupLabel
      ? `相邻的${c.groupLabel}符号`
      : '相邻格';

  // 条件只有「看运气」：整句写成一个概率事件
  const luckOnly = c.luck && !c.typeName && !c.groupLabel && c.destroyed === undefined && c.extras.length === 0;

  if (adjacent) {
    if (rule.vtc === 'destroyed') return `摧毁${neighbor}`;
    if (rule.vtc === 'removed') return `移除${neighbor}`;
    // 没有任何条件：直接作用在每一格相邻符号上
    const bare = !c.typeName && !c.groupLabel && c.destroyed === undefined && !c.luck && c.extras.length === 0;
    if (bare) return isVerb ? `${neighbor}${eff}` : `相邻符号${eff}`;
    if (isVerb) return `${neighbor}${eff}`;
    // 条件里若还有别的限定，补在「每有一格」之后
    const rest = c.extras.join('、');
    return `每有一格${neighbor}${rest ? `（${rest}）` : ''}，${eff}`;
  }

  if (luckOnly) return isVerb ? `有概率${eff}` : `看运气：${eff}`;

  let cond = '';
  if (c.typeName) cond = `相邻的${c.typeName}${c.destroyed === undefined ? '在场' : c.destroyed ? '被摧毁' : '完好'}`;
  else if (c.destroyed !== undefined) cond = c.destroyed ? '本符号被摧毁' : '本符号完好';
  const extras = c.luck ? [...c.extras, '看运气'] : c.extras;
  if (extras.length > 0) cond = cond ? `${cond}、${extras.join('、')}` : extras.join('、');

  if (isVerb) {
    const verb = rule.vtc === 'destroyed' ? '摧毁自己' : rule.vtc === 'removed' ? '移除自己' : `自己${eff}`;
    return cond ? `${cond}时，${verb}` : verb;
  }
  // 条件已经在说「本符号」，效果句里不再重复主语
  const subject = cond.startsWith('本符号') ? eff : `本符号${eff}`;
  return cond ? `${cond}时，${subject}` : subject;
}
