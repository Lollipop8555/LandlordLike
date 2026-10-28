// 领域模型：与 docs 中的术语保持一致

export type Rarity = 'common' | 'uncommon' | 'rare' | 'very_rare';

/** 游戏模式：普通 12 期 / 无尽 / 沙盒 */
export type GameMode = 'normal' | 'endless' | 'sandbox';

export const MODE_LABEL: Record<GameMode, string> = {
  normal: '普通',
  endless: '无尽',
  sandbox: '沙盒',
};

export const RARITY_ORDER: Rarity[] = ['common', 'uncommon', 'rare', 'very_rare'];

export const RARITY_LABEL: Record<Rarity, string> = {
  common: '普通',
  uncommon: '罕见',
  rare: '稀有',
  very_rare: '极稀有',
};

export interface SymbolDef {
  id: string;
  /** 基础产出（§4.1 的 value） */
  value: number;
  /** 符号自身的效果参数，含义随符号而定 */
  values: number[];
  /** 空串表示不进入商店池 */
  rarity: string;
  groups: string[];
  sfx: string[];
}

/** 道具：与符号共用可放置物接口，基础 value 为 0，产出全部来自 effects */
export interface ItemDef {
  id: string;
  value: number;
  values: number[];
  /** 空串表示不进入商店池 */
  rarity: string;
  groups: string[];
  sfx: string[];
  kind: 'item';
  effects: EffectRule[];
}

export interface RentRow {
  payment: number;
  rent: number;
  floorGate: { floor: number; bonus: number } | null;
  spinsGain: number;
  spinsCumulative: number;
}

export interface RarityRow {
  payment: number;
  kind: string;
  common: number;
  uncommon: number;
  rare: number;
  veryRare: number;
}

/** 历史身份快照（§4.3 prev_data） */
export interface PrevIdentity {
  symbolId: string;
  value: number;
  permanentBonus: number;
  permanentMultiplier: number;
  valueBonus: number;
  valueMultiplier: number;
}

/** add_effect 的 diff 值：字面量，或需要求值的引用 */
export type EffectValue =
  | number
  | string
  | boolean
  | null
  | { $ref: string; $index: number }
  | { $ref_value: string }
  | { $self_index: number }
  | { $self_value: true }
  | { $adj_count: boolean }
  | { $fp: number }
  | { $dyn: string };

export interface EffectComparison {
  a: string;
  b: EffectValue;
  greater_than?: EffectValue;
  less_than?: EffectValue;
  [key: string]: unknown;
}

/** 一条 add_effect / add_to_cond_effects 声明 */
export interface EffectRule {
  i: number;
  symbol: string;
  /** 所属 match 分支行号 */
  branchLine: number;
  /** 声明所在行号 */
  line: number;
  comparisons: EffectComparison[];
  vtc: string;
  diff: EffectValue;
  /**
   * self：add_effect，作用于自己（Slot_Icon.gd / Item__Item.gd 同名接口）
   * cond：add_to_cond_effects，挂到满足 comparisons 的目标符号上（Item__Item.gd:1274）
   */
  kind?: 'self' | 'cond';
  flags: string[];
}

export interface Cell {
  /** 稳定 id，用于 UI diff */
  uid: number;
  /** null = 空格（empty） */
  def: SymbolDef | null;
  /** 本轮加算（结算后清空） */
  valueBonus: number;
  /** 本轮乘算（结算后清空） */
  valueMultiplier: number;
  /** 永久加算 */
  permanentBonus: number;
  /** 永久乘算，只增不减 */
  permanentMultiplier: number;
  /** 复制/变形留下的历史身份，各自独立计价 */
  prev: PrevIdentity[];
  /** 本轮被销毁（销毁后本转照常计分，转完从池中移除） */
  destroyed: boolean;
  /** 已判定要销毁、等本轮结算走完再落地（Slot_Icon__Slot_Icon.gd:2400 的 tbd） */
  tbd?: boolean;
  /** 本轮已应用过的声明下标，多轮迭代时避免同一分支重复加分 */
  appliedRules?: Set<number>;
  /** 上一轮结算的产出，用于展示 */
  lastOutput: number;

  /* ── add_effect 可写的其余槽位（Slot_Icon__Slot_Icon.gd 的 value_to_change 全集） ── */

  /** saved_value：跨轮累积的自计数器（成长型符号） */
  savedValue?: number;
  /** achievement_value：本局累计成就值 */
  achievementValue?: number;
  /** saved_achievement_value：跨轮结算过的成就值 */
  savedAchievementValue?: number;
  /** times_displayed：被洗到可视区的次数 */
  timesDisplayed?: number;
  /** times_coins_given：给出金币的次数 */
  timesCoinsGiven?: number;
  /** symbol_trigger：本符号是否已触发 */
  symbolTrigger?: boolean;
  /** removed：本轮被移除（不同于销毁） */
  removed?: boolean;
  /** destroyed_or_removed_by：摧毁/移除它的符号 id */
  destroyedOrRemovedBy?: string;
  /** wildcarded：被万能牌同化 */
  wildcarded?: boolean;
  /** drained：被汲取 */
  drained?: boolean;
  /** essence_value：销毁后产出的精华值 */
  essenceValue?: number;
  /** removal_value：移除时产出 */
  removalValue?: number;
  /** reroll_value：重摇消耗 */
  rerollValue?: number;
  /** pointing_directions：指向数组（箭头类） */
  pointingDirections?: number[];
  /** grown_apples / grown_strawberries：植物生长计数 */
  grownApples?: number;
  grownStrawberries?: number;
  /** flat_value_bonus：无视倍率的固定加值 */
  flatValueBonus?: number;
  /** tried_to_give_rand_eff：随机效果去重标记 */
  triedToGiveRandEff?: boolean;
  /** hex_of_emptiness_trigger / hex_of_hoarding_trigger：诅咒触发标记 */
  hexOfEmptinessTrigger?: boolean;
  hexOfHoardingTrigger?: boolean;
  /** compost_heap_symbols_destroyed：堆肥已吞符号数 */
  compostHeapSymbolsDestroyed?: number;
  /** destroy_counters：剩余摧毁次数（一次性符号） */
  destroyCounters?: number;
  /** indestructible：不可被摧毁 */
  indestructible?: boolean;
  /** item_count：符号自身记录的道具计数（lucky_seven 类） */
  itemCount?: number;
  /** rarity：符号本体的稀有度覆盖 */
  rarity?: string;
  /** uncommon / rare / very_rare：各档稀有度的增量 */
  rarityMod?: { uncommon?: number; rare?: number; very_rare?: number };
  /** forced_rarities：强制稀有度列表 */
  forcedRarities?: string[];
  /** bonus_values / bonus_value_multipliers：全局加值与倍率列表 */
  bonusValues?: number[];
  bonusValueMultipliers?: number[];
  /** non_prev_final_value：上一轮非历史身份的结算值 */
  nonPrevFinalValue?: number;
}
