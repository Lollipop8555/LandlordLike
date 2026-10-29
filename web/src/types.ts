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
  /**
   * flat_value_bonus：无视倍率的固定加值（Slot_Icon__Slot_Icon.gd:14）。
   * 在 `get_non_prev_value` 里于乘算之后无条件加回；
   * 万能牌（wildcarded）在结算期把 base 整体换成它（`:1095`）。
   */
  flatValueBonus?: number;
  /** wildcarded：万能牌，结算期改用 flat_value_bonus 作为 base */
  wildcarded?: boolean;
  /** drained：被汲取，产出归零（`:1081`） */
  drained?: boolean;
}

/**
 * 本局生效的一条细则（Landlord__Landlord.gd 的 fine_print）。
 * `values` 是细则自身的参数（数据见 data/fine_print.csv），
 * `dynamicIcon` 是细则指定的符号（Slot_Icon__Slot_Icon.gd:3697 的 fp.dynamic_icon）。
 */
export interface FinePrintState {
  num: number;
  name?: string;
  values: number[];
  dynamicIcon?: string;
}

/** Pop-up.rarity_bonuses：按稀有度修正的抽取权重（符号 / 道具两套） */
export interface RarityBonus {
  symbols: Partial<Record<Rarity, number>>;
  items: Partial<Record<Rarity, number>>;
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
  /**
   * tiles_to_add：这一转往空格里生成符号（源码 Slot_Icon.gd:1768-1870）。
   * 生成物与本盘其他符号一样参与本转结算，并留在棋盘上打后续期数。
   */
  spawn?: SpawnSpec[];
  /**
   * stat_to_change / stat_diff：落一条声明就累加一次彩蛋统计（Slot_Icon.gd:3719 摸狗、
   * 4029 扎罗夫杀人、4653/4655 酒精……）。这些计数是原版彩蛋成就的唯一依据，
   * 以前整段被丢弃，对应成就永远判不出来。
   */
  stats?: StatSpec[];
  flags: string[];
}

/** 一条彩蛋统计增量：`k` 对应 Stats 里的字段，`d` 是每次触发加多少 */
export interface StatSpec {
  key: string;
  diff?: EffectValue;
}

/** 一条生成声明：按 id（type）或按分组（group，可带稀有度下限）取符号 */
export interface SpawnSpec {
  type?: string;
  /** 分组名，如 gem / booze；运行时在同组符号里等概率抽 */
  group?: string;
  /** 分组抽取的稀有度下限（源码里来自 x_ray 道具，本仓库取无道具档） */
  minRarity?: string;
  /** 生成几个：字面量 1，或 {"$self_index":N} 取自身 values[N] */
  count?: EffectValue;
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
  /**
   * 本轮已应用过的道具声明（key = `道具 id#行号`）。
   * 道具声明现在跟着销毁迭代一起重跑（莫比乌斯环要等符号真的被摧毁），
   * 没有这层去重会每跑一遍就再加一次。
   */
  appliedItems?: Set<string>;
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
  /**
   * 三种代币的产出槽位（Slot_Icon__Slot_Icon.gd:27-41）。
   * `currency:reroll_token` 的声明写这里，而不是金币的 valueBonus。
   */
  rerollMultiplier?: number;
  removalMultiplier?: number;
  essenceMultiplier?: number;
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
  /** can_be_removed：能否被「移除代币」拿掉（细则 20/21/36 会关掉） */
  canBeRemoved?: boolean;
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
