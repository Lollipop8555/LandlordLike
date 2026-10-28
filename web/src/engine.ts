// 对局状态机：按 analysis/luckll_scripts 反编译源码还原。
//
// 结构事实（每条都在页面上标注出处）：
//   - 棋盘 5 列 × 4 可视行，每列 5 个槽（max_icons），槽 0 在屏幕外  Main__Reels.gd:8-9 / Main__Main.gd:1237
//   - 旋转 = 把全部符号（含 empty）收进池、剔除多余空到 ≤25、洗牌、按列回填、
//     再用屏幕外非空与屏幕内空交换        Main__Reels.gd:368-428
//   - 开局每列一个基础符号                  Reel__Reel.gd:278-298
//   - 初始 1 金币、首期租金 25、5 次旋转     Main__Main.gd:1277 / 1286
//   - 付租后旋转数累加 5 + floor(paid/2)    Pop-up__Pop-up.gd:2882-2890
//   - 商店 3 选 1，稀有度按付租次数强制配比   Pop-up__Pop-up.gd:2657-2684, 1123-1193
//   - 稀有度概率表只用于商店抽卡，开局全 0     Main__Main.gd:1304
import {
  DRAWABLE_SYMBOLS,
  FINE_PRINTS,
  ITEM_POOL,
  SYMBOL_BY_ID,
  SYMBOL_POOL,
  rarityRowFor,
  rentRowFor,
  symbol,
} from './data';
import { CELL_COUNT, COLS as REELS_X, ROWS as REELS_Y, SLOTS_PER_REEL } from './grid';
import { applyEffects, applyItemEffects, type ResolvedSpawn } from './effects';
import {
  bossFightMail2,
  bossMail,
  chiliEssenceMail,
  comradeMail,
  comradeValues,
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
import { symbolName } from './names';
import { mulberry32, shuffle, type Random } from './rng';
import type { SynergyHit } from './synergy';
import { boardTotal, evaluateCell } from './value';
import { RARITY_ORDER } from './types';
import type { Cell, FinePrintState, GameMode, Rarity, RarityBonus, SymbolDef } from './types';

export { CELL_COUNT, REELS_X, REELS_Y, SLOTS_PER_REEL };

/** 房东之战：通关后与房东本人对打（原版 doing_boss_fight） */
export interface BossState {
  maxHp: number;
  hp: number;
  active: boolean;
}

/** 房东战的初始血量：普通 12 期通关后为 750（Landlord__Landlord.gd 的 max_hp） */
export const BOSS_HP = 750;

/** 原版三种可兑换货币（Main__Main.gd:1450 的 extra 三件套） */
export type TokenKind = 'reroll' | 'removal' | 'essence';

export const TOKEN_LABEL: Record<TokenKind, string> = {
  reroll: '重掷代币',
  removal: '移除代币',
  essence: '精华代币',
};

export const TOKEN_ICON: Record<TokenKind, string> = {
  reroll: '♻️',
  removal: '🗑️',
  essence: '💎',
};

/** 代币在商店里是独立卡牌（Card__Card.gd:343 对 token 类型单独分支） */
export function tokenDef(kind: TokenKind): SymbolDef {
  return {
    id: `${kind}_token`,
    value: 0,
    values: [],
    rarity: 'uncommon',
    groups: ['token'],
    sfx: [],
  };
}

export interface ShopCard {
  def: SymbolDef;
  rarity: Rarity;
  /** 非空表示这是一张代币卡，买到即 +1 代币 */
  token?: TokenKind;
}

/** 道具栏里的一项；同类道具可叠加，count 即 Item__Item.gd 的 item_count */
export interface HeldItem {
  def: SymbolDef;
  count: number;
  /** 细则 17 等对道具自身 value 的修正；0 时不写 */
  value?: number;
  /** Item.value 的累积部分：吃掉符号换来的价值（Reel.symbol_removal_effects） */
  itemValue?: number;
  /** saved_value：吃掉符号攒下的价值（egg_carton / fish_bowl 等） */
  savedValue?: number;
}

/** 道具 def 带 kind 字段（gen-data 写入），用于与符号区分 */
export function isItemDef(def: SymbolDef): boolean {
  return (def as unknown as { kind?: string }).kind === 'item';
}

export interface LogEntry {
  turn: number;
  kind: 'spin' | 'rent' | 'buy' | 'info';
  text: string;
}

export interface GameState {
  seed: number;
  rand: Random;
  /** 可视 20 格，行优先；由 reels 推导，供渲染与结算使用 */
  cells: Cell[];
  /** 5 列 × 槽；符号实例持久存在于此 */
  reels: Cell[][];
  /** 玩家拥有的非空符号（不含 empty），供 HUD 显示 */
  pool: SymbolDef[];
  /** 道具栏：不占棋盘格，效果作用于全场符号（Items__Items.gd:44-214） */
  items: HeldItem[];
  coins: number;
  spinsLeft: number;
  payment: number;
  /**
   * 楼层（Pop-up.current_floor）：开局在标题页选定，**一局内不变**。
   * 原版用它决定租金加成、房东血量、哑弹注入、细则难度门槛与同伴代币。
   */
  floor: number;
  /** 已付租次数（times_rent_paid） */
  rentPaid: number;
  totalSpins: number;
  totalEarned: number;
  /** 本期待付租区间内已累计的产出（付租后清零） */
  roundEarned: number;
  lastSpinOutput: number;
  shop: ShopCard[];
  shopOpen: boolean;
  /** 商店来源：spin = 每次旋转后的奖励；rent = 付租后的奖励 */
  shopSource: 'spin' | 'rent';
  log: LogEntry[];
  over: boolean;
  won: boolean;
  /** 当前模式 */
  mode: GameMode;
  /** 房东之战；未进入时为 null */
  boss: BossState | null;
  /** 本局购买次数（成就统计用） */
  buys: number;
  /** 本局累计摧毁的符号数 */
  destroyed: number;
  /** 上一转被摧毁的符号与「凶手」（cell.destroyedOrRemovedBy），成就判定用 */
  lastKills: Array<{ id: string; by?: string }>;
  /** 上一转 tiles_to_add 生成出来的符号 id（含重复） */
  lastSpawned: string[];
  /**
   * 本局累计的彩蛋统计（stat_to_change）：摸狗时长、兔子跳、酒精消耗、斩首次数……
   * 引擎只记数，结算后由前端并入存档的 profile.stats 并触发成就。
   */
  pendingStats: Record<string, number>;
  /** 三种代币：重掷 / 移除 / 精华（付租后未用的精华不结转，Main__Main.gd:1300） */
  rerollTokens: number;
  removalTokens: number;
  essenceTokens: number;
  /** 单次消耗量，可被道具声明改写（Pop-up__Pop-up.gd:2710） */
  rerollCost: number;
  removalCost: number;
  /** 最近一次旋转的协同明细，供界面展示 */
  lastHits: SynergyHit[];
  /** 最近一次旋转每个格子的最终产出 */
  lastFinals: number[];
  /** 房东信箱：局内信件，同类只保留最新一封（对应原版 emails 队列） */
  mails: Mail[];
  /** 本局生效的细则（Landlord.fine_print） */
  finePrints: FinePrintState[];
  /** 距下一条细则的伤害进度（Landlord.fine_print_counter） */
  finePrintCounter: number;
  /** 每累积这么多伤害获得一条细则（fine_print_threshhold） */
  finePrintThreshold: number;
  /** 稀有度出现权重（Pop-up.rarity_bonuses），每转由符号声明重算 */
  rarityBonus: RarityBonus;
  /**
   * 停盘后正在等玩家用换位装置选格子（原版 swap_prompt_1 挡在结算之前）。
   * true 时 resolveSpin 不会执行，UI 必须先 swapSymbols 或 skipSwap。
   */
  swapPending: boolean;
  /** 本转是否已经用掉换位装置（原版 sme_this_spin，每转重置） */
  swapUsed: boolean;
}

let uidCounter = 1;

export function createCell(def: SymbolDef | null): Cell {
  return {
    uid: uidCounter++,
    def,
    valueBonus: 0,
    valueMultiplier: 1,
    permanentBonus: 0,
    permanentMultiplier: 1,
    prev: [],
    destroyed: false,
    lastOutput: 0,
  };
}

/** 开局每列的基础符号（Reel__Reel.gd:278-298，floor=1 无 dud） */
const BASE_ICONS: Array<string | null> = ['coin', 'cherry', 'pearl', 'flower', 'cat'];

function emptyReels(): Cell[][] {
  return Array.from({ length: REELS_X }, () =>
    Array.from({ length: SLOTS_PER_REEL }, () => createCell(null)),
  );
}

/** 槽 0 在屏幕外，槽 1..4 为可视区；按行优先摊平成 20 格 */
export function visibleCells(reels: Cell[][]): Cell[] {
  const out: Cell[] = [];
  for (let y = 0; y < REELS_Y; y += 1) {
    for (let x = 0; x < REELS_X; x += 1) {
      out.push(reels[x][y + 1] ?? createCell(null));
    }
  }
  return out;
}

/**
 * 某楼层的第 `payment` 期租金（Pop-up__Pop-up.gd:2559-2604）。
 *
 * 基础表就是 floor 1 的数值；另有 5 处楼层加成，各自独立判定：
 *   第 7 期 floor≥2 · 第 8 期 floor≥3 · 第 9 期 floor≥18 · 第 10 期 floor≥6 · 第 11 期 floor≥8
 * 每处 +25。因此 1 / 2 / 3–5 / 6–7 / 8–13 / 14–17 / 18–20 是七个不同的档。
 */
export function rentFor(floor: number, payment: number): { rent: number; spinsGain: number; spinsCumulative: number } {
  const row = rentRowFor(payment);
  const gate = row.floorGate;
  return {
    rent: gate && floor >= gate.floor ? row.rent + gate.bonus : row.rent,
    spinsGain: row.spinsGain,
    spinsCumulative: row.spinsCumulative,
  };
}

/** 楼层上限（Pop-up.max_floor = 20）；本项目只开放到 20 层 */
export const MAX_FLOOR = 20;

export function createGame(seed = 20261027, mode: GameMode = 'normal', floor = 1): GameState {
  const rand = mulberry32(seed);
  const reels = emptyReels();
  BASE_ICONS.forEach((id, x) => {
    if (id) reels[x][1] = createCell(symbol(id));
  });

  // 沙盒：直接从第 12 期起，给一大笔金币和三种代币，用来自由试组合
  const sandbox = mode === 'sandbox';
  const startPaid = sandbox ? 11 : 0;
  const startCoins = sandbox ? 999999 : 1;
  const startSpins = 5;
  const chosenFloor = Math.min(MAX_FLOOR, Math.max(1, Math.trunc(floor)));
  const startRent = rentFor(chosenFloor, startPaid + 1);

  const state: GameState = {
    seed,
    rand,
    cells: visibleCells(reels),
    reels,
    pool: BASE_ICONS.filter((id): id is string => Boolean(id)).map((id) => symbol(id)),
    items: [],
    coins: startCoins,
    // 首期 5 次旋转（Main__Main.gd:1286 rent_values = [25, 5]）
    spinsLeft: startSpins,
    payment: startPaid,
    floor: chosenFloor,
    rentPaid: startPaid,
    totalSpins: 0,
    totalEarned: 0,
    roundEarned: 0,
    lastSpinOutput: 0,
    shop: [],
    shopOpen: false,
    shopSource: 'rent',
    log: [
      {
        turn: 0,
        kind: 'info',
        text: sandbox
          ? `沙盒模式（第 ${chosenFloor} 层）：从第 ${startPaid + 1} 期开始，金币 ${startCoins}，重掷 / 移除 / 精华各 3 枚，租金 ${startRent.rent}`
          : `新开局（第 ${chosenFloor} 层）：5 个基础符号，1 金币，5 次旋转，首期租金 ${startRent.rent}`,
      },
    ],
    over: false,
    won: false,
    mode,
    boss: null,
    buys: 0,
    destroyed: 0,
    lastKills: [],
    lastSpawned: [],
    pendingStats: {},
    // 沙盒给几枚代币，方便直接试重掷/移除/精华
    rerollTokens: sandbox ? 3 : 0,
    removalTokens: sandbox ? 3 : 0,
    essenceTokens: sandbox ? 3 : 0,
    rerollCost: 1,
    removalCost: 1,
    lastHits: [],
    lastFinals: new Array(CELL_COUNT).fill(0),
    mails: [],
    // 细则：开局无，受伤累积到阈值后逐条获得（Landlord__Landlord.gd:126-160）
    // 阈值 = floor(房东血量 / 10)，血量按楼层：750 / 1000 / 1500 → 75 / 100 / 150
    finePrints: [],
    finePrintCounter: 0,
    finePrintThreshold: Math.max(1, Math.floor(landlordMaxHp(chosenFloor) / 10)),
    rarityBonus: { symbols: {}, items: {} },
    swapPending: false,
    swapUsed: false,
  };
  // 开局一封房东来信（原版 intro），只提示、不阻塞操作
  addMail(state, introMail(mode, 0));
  // 沙盒直接给三条细则，方便观察细则修正的生效情况
  if (sandbox) {
    for (let i = 0; i < 3; i += 1) grantFinePrints(state, state.finePrintThreshold);
    refreshTileFlags(state);
  }
  return state;
}

/** 收信：同类信只保留最新一封，避免信箱被催租信刷屏 */
function addMail(state: GameState, next: Mail): void {
  const at = state.mails.findIndex((m) => m.kind === next.kind);
  if (at >= 0) state.mails.splice(at, 1);
  state.mails.unshift(next);
  if (state.mails.length > 12) state.mails.length = 12;
}

export function unreadMails(state: GameState): number {
  return state.mails.filter((m) => !m.read).length;
}

export function markMailRead(state: GameState, id: string): void {
  const hit = state.mails.find((m) => m.id === id);
  if (hit) hit.read = true;
}

export function markAllMailsRead(state: GameState): void {
  for (const m of state.mails) m.read = true;
}

/** 某类信件是否已经出现过（用来判断「首次」教学信） */
function hasMailKind(state: GameState, kind: Mail['kind']): boolean {
  return state.mails.some((m) => m.kind === kind);
}

/**
 * 旋转重排（Main__Reels.gd:368-428）：
 * 1. 全部槽位（含 empty）收进池；
 * 2. 空太多时剔除多余空，保证池 ≤ 25；
 * 3. 洗牌；
 * 4. 按列回填；
 * 5. 屏幕外的非空符号与屏幕内的空交换，尽量填满可视区。
 */
function shuffleTiles(state: GameState): void {
  let pool: Cell[] = [];
  for (const col of state.reels) pool.push(...col);

  const isBlank = (c: Cell) => !c.def;
  let blanks = pool.filter(isBlank).length;
  while (pool.length > SLOTS_PER_REEL * REELS_X && blanks > 0) {
    const idx = pool.findIndex(isBlank);
    if (idx < 0) break;
    pool.splice(idx, 1);
    blanks -= 1;
  }

  pool = shuffle(state.rand, pool);

  const next: Cell[][] = Array.from({ length: REELS_X }, () => []);
  pool.forEach((cell, i) => {
    next[i % REELS_X].push(cell);
  });
  for (const col of next) {
    while (col.length < SLOTS_PER_REEL) col.push(createCell(null));
  }

  // 屏幕外（槽 0）非空 ↔ 屏幕内空位
  for (const col of next) {
    for (let slot = 0; slot < col.length; slot += 1) {
      if (slot === 0 && col[slot].def) {
        const target = col.findIndex((c, k) => k > 0 && !c.def);
        if (target > 0) {
          const tmp = col[0];
          col[0] = col[target];
          col[target] = tmp;
        }
      } else if (slot > 0 && !col[slot].def && col[0].def) {
        const tmp = col[0];
        col[0] = col[slot];
        col[slot] = tmp;
      }
    }
  }

  state.reels = next;
}

/**
 * 把新符号放进随机空槽；无空槽时扩到某列末尾（add_tile 的语义）。
 * 源码优先挑**可视区**的空槽，可视区满了才回落到屏幕外
 * （Reel__Reel.gd:339-362），否则玩家会看到音效却找不到新符号。
 */
function placeSymbol(state: GameState, def: SymbolDef): boolean {
  const empties: Array<[number, number]> = [];
  const visibleEmpties: Array<[number, number]> = [];
  state.reels.forEach((col, x) =>
    col.forEach((cell, y) => {
      if (cell.def) return;
      empties.push([x, y]);
      if (y > 0) visibleEmpties.push([x, y]);
    }),
  );
  const spots = visibleEmpties.length > 0 ? visibleEmpties : empties;
  if (spots.length > 0) {
    const [x, y] = spots[Math.floor(state.rand() * spots.length)];
    state.reels[x][y] = createCell(def);
    return true;
  }
  // 可视区已满：仍可塞进屏幕外槽位，但每列上限 max_icons=5（Main__Main.gd:1237）
  const openCols = state.reels.reduce<number[]>((acc, col, x) => {
    if (col.length < SLOTS_PER_REEL) acc.push(x);
    return acc;
  }, []);
  if (openCols.length === 0) return false;
  const x = openCols[Math.floor(state.rand() * openCols.length)];
  state.reels[x].push(createCell(def));
  return true;
}

/**
 * 生成请求 → 具体符号（Pop-up__Pop-up.gd:1567-1614 / Slot_Icon__Slot_Icon.gd:1868-1870）。
 *   · type 直出（蜂巢→蜜、牛→奶、鸡→蛋、套娃→下一层…）；
 *   · group 在可抽取符号里按分组 + 稀有度下限随机（大矿石的 x_ray 三档靠 min_rarity 区分）；
 *   · prev_destroyed_symbol 把本转被摧毁的符号吐回来（时间胶囊），
 *     源码会排除时间胶囊自己与没有稀有度的符号（Pop-up__Pop-up.gd:1559-1570）。
 */
function resolveSpawn(state: GameState, spec: ResolvedSpawn, destroyed: string[]): SymbolDef | null {
  if (spec.type === 'prev_destroyed_symbol') {
    const pool = destroyed.filter((id) => {
      if (id === 'time_capsule') return false;
      return Boolean(SYMBOL_BY_ID.get(id)?.rarity);
    });
    if (pool.length === 0) return null;
    return symbol(pool[Math.floor(state.rand() * pool.length)]);
  }
  if (spec.type) return SYMBOL_BY_ID.has(spec.type) ? symbol(spec.type) : null;
  if (!spec.group) return null;
  const minIdx = spec.minRarity ? RARITY_ORDER.indexOf(spec.minRarity as Rarity) : 0;
  const group = spec.group;
  const pool = DRAWABLE_SYMBOLS.filter(
    (s) => s.groups.includes(group) && RARITY_ORDER.indexOf(s.rarity as Rarity) >= minIdx,
  );
  if (pool.length === 0) return null;
  return pool[Math.floor(state.rand() * pool.length)];
}

/**
 * 旋转：洗牌 → 结算 → 产出 → 符号奖励
 *
 * 符号奖励在**每次 spin 后**发放（Main__Reels.gd:1954-1968）：
 * 只要本期还有剩余旋转（rent_values[1] > 0）且本次确有产出，就开一次三选一。
 * 这就是第 1 期能拿 5→6→7→8→9 的原因，也是租金曲线能兑现的前提。
 */
/**
 * 难度注入（Main__Reels.gd:273-281）：楼层越往后，每隔固定次数旋转往池里塞一个 dud。
 * dud 值 0、无特效，只能靠「相邻/全局」类符号产生价值，用来压低池的命中质量。
 */
function injectDud(state: GameState): void {
  if (state.mode !== 'normal' || state.rentPaid >= 12) return;
  const every = state.floor >= 19 ? 15 : state.floor >= 14 ? 20 : state.floor >= 10 ? 25 : 0;
  if (every === 0) return;
  if (state.totalSpins === 0 || state.totalSpins % every !== 0) return;
  if (!placeSymbol(state, symbol('dud'))) return;
  state.pool.push(symbol('dud'));
  state.log.unshift({
    turn: state.totalSpins,
    kind: 'info',
    text: `难度注入：第 ${state.floor} 层，每 ${every} 次旋转塞入 1 个哑弹`,
  });
}

/** 符号可产出代币（reroll_value / removal_value / essence_value），旋转结算后统一入账 */
function collectExtraTokens(state: GameState): void {
  let reroll = 0;
  let removal = 0;
  let essence = 0;
  for (const cell of state.cells) {
    if (!cell.def) continue;
    reroll += Math.max(0, Math.round(cell.rerollValue ?? 0));
    removal += Math.max(0, Math.round(cell.removalValue ?? 0));
    essence += Math.max(0, Math.round(cell.essenceValue ?? 0));
  }
  if (reroll === 0 && removal === 0 && essence === 0) return;
  state.rerollTokens += reroll;
  state.removalTokens += removal;
  state.essenceTokens += essence;
  const parts: string[] = [];
  if (reroll) parts.push(`${TOKEN_ICON.reroll}×${reroll}`);
  if (removal) parts.push(`${TOKEN_ICON.removal}×${removal}`);
  if (essence) parts.push(`${TOKEN_ICON.essence}×${essence}`);
  state.log.unshift({
    turn: state.totalSpins,
    kind: 'spin',
    text: `旋转产出代币 ${parts.join(' ')}`,
  });
}

/**
 * 本转是否可以换位：持有 swapping_device 且这一转还没用过
 * （Pop-up__Pop-up.gd:2638，sme_this_spin 去重）。
 * 至少要盘上有两个符号才有得换。
 */
export function canSwapThisSpin(state: GameState): boolean {
  if (state.swapUsed) return false;
  if (!state.items.some((it) => it.def.id === 'swapping_device')) return false;
  return state.cells.filter((cell) => cell.def).length >= 2;
}

/** beginSpin 的结果：被拦下 / 直接结算 / 停下等玩家换位 */
export type SpinStart = 'blocked' | 'resolving' | 'awaiting-swap';

/**
 * 停盘：注入哑弹、洗牌、把 20 格投影到 `cells`，到此为止不结算。
 *
 * 原版转轴停下之后、`check_effects` 之前有一个可插入的窗口（Reel__Reel.gd:143
 * 调 `popup.spin_modifying_effects()`），换位装置就挂在这个窗口里：玩家先看到
 * 这一转抽到了什么，再决定要不要换两个符号的位置。所以这里只负责「停下」，
 * 结算交给 resolveSpin。
 */
export function beginSpin(state: GameState): SpinStart {
  if (state.over || state.won || state.spinsLeft <= 0) return 'blocked';
  if (state.shopOpen) return 'blocked';

  injectDud(state);
  shuffleTiles(state);
  state.cells = visibleCells(state.reels);
  state.swapUsed = false;
  state.swapPending = false;
  // 停盘时还没结算：先把数字摆成各自的面板值，否则上一转的产出会留在旧格子上
  state.lastFinals = state.cells.map((cell) => cell.def?.value ?? 0);
  state.lastHits = [];

  if (canSwapThisSpin(state)) {
    state.swapPending = true;
    return 'awaiting-swap';
  }
  return 'resolving';
}

/** 放弃这一转的换位机会（原版邮件里的 ✕，Pop-up__Pop-up.gd:3068-3075） */
export function skipSwap(state: GameState): void {
  if (!state.swapPending) return;
  state.swapUsed = true;
  state.swapPending = false;
}

/**
 * 用换位装置交换两格（含与空格互换，源码 `swap_icon_positions` 同样只换 type）。
 * 只在停盘窗口内可用，交换后这一转就不能再换。
 */
export function swapSymbols(
  state: GameState,
  from: number,
  to: number,
): { ok: boolean; message: string } {
  if (!state.swapPending) return { ok: false, message: '现在不能换位' };
  if (from === to) return { ok: false, message: '还是同一格' };
  if (!onBoard(from) || !onBoard(to)) return { ok: false, message: '只能在本层棋盘的可见格里移动' };
  const a = state.cells[from];
  const b = state.cells[to];
  if (!a || !b) return { ok: false, message: '格子已变动，请重试' };
  if (!a.def && !b.def) return { ok: false, message: '两格都是空的' };

  const ax = from % REELS_X;
  const ay = Math.floor(from / REELS_X) + 1;
  const bx = to % REELS_X;
  const by = Math.floor(to / REELS_X) + 1;
  state.reels[ax][ay] = b;
  state.reels[bx][by] = a;
  state.cells = visibleCells(state.reels);
  // 位置变了，停盘阶段摆的面板值也跟着换，免得数字留在旧格子上
  if (state.lastFinals.length > Math.max(from, to)) {
    const finals = state.lastFinals.slice();
    const tmp = finals[from];
    finals[from] = finals[to];
    finals[to] = tmp;
    state.lastFinals = finals;
  }
  state.swapUsed = true;
  state.swapPending = false;
  return { ok: true, message: '' };
}

/** 一次完整的旋转：停盘 → 结算（脚本与无换位装置时的快捷入口） */
export function spin(state: GameState): void {
  if (beginSpin(state) === 'blocked') return;
  skipSwap(state);
  resolveSpin(state);
}

/** 结算已经停下的这一转（道具全局效果 → 符号声明 → 收敛 → 落账） */
export function resolveSpin(state: GameState): void {
  if (state.over || state.won) return;
  // 还在等玩家换位：结算必须排在那个窗口之后
  if (state.swapPending) return;

  // 临时加成清零 → 道具全局效果 → 符号声明效果 → 结算（§4.5 / §5）
  // 道具先于符号：Items__Items.add_cond_effects() 把 effect 挂到目标符号，
  // 目标符号自身的 add_effect 随后在同一轮里叠加（Pop-up__Pop-up.gd:1180-1210）。
  for (const cell of state.cells) {
    cell.valueBonus = 0;
    cell.valueMultiplier = 1;
    cell.tbd = false;
    cell.destroyed = false;
    cell.removed = false;
    cell.appliedRules = new Set();
    // 道具声明也会随销毁迭代重跑（祭坛/莫比乌斯环要等符号真的被摧毁），一起去重
    cell.appliedItems = new Set();
  }
  // 细则 10/20/21/36 的「不可摧毁 / 不可移除」标记每转重算
  refreshTileFlags(state);
  // 变形声明（种子 → 随机植物、洒水壶升档）会改 cell.def，池里同一份符号也得跟着换，
  // 否则之后按 id 回池（销毁 / 移除）就找不到条目，池会比棋盘多出一个。
  const beforeTransform = new Map<Cell, string>();
  for (const cell of state.cells) {
    if (cell.def) beforeTransform.set(cell, cell.def.id);
  }

  // 道具声明的生效条件（when:item:X / when:no_item:X / 细则开关）要读道具栏，
  // item_to_destroy 也要真的扣道具，所以统一在这里给出上下文。
  // 源码用 items_destroyed_this_spin 兜底：同一转里同一个道具最多被消耗一次
  // （多条声明都写 item_to_destroy 时不会连扣）。
  const eatenThisSpin = new Set<string>();
  const eat = (id: string): void => {
    if (eatenThisSpin.has(id)) return;
    eatenThisSpin.add(id);
    consumeItem(state, id);
  };
  // 稀有度权重每转重算：cat 的幸运猫在这里累乘（Pop-up__Pop-up.gd:1570-1580）
  state.rarityBonus = { symbols: {}, items: {} };
  /** 本转被摧毁的符号（时间胶囊要把它们原样吐回来） */
  const destroyedIds: string[] = [];
  /** 本转的摧毁记录（受害者 + 凶手），写进 state.lastKills 供成就判定 */
  const kills: Array<{ id: string; by?: string }> = [];
  state.lastKills = kills;
  state.lastSpawned = [];
  /** tiles_to_add 的待落地队列：先排队，一轮迭代结束后统一 add_tile（Slot_Icon.gd:1868-1870） */
  const spawnQueue: ResolvedSpawn[] = [];
  /** 本转生成出来的符号，结算后写一条日志 */
  const spawnedIds: string[] = [];
  const effectCtx = {
    chanceRoll: state.rand,
    finePrint: state.finePrints,
    rarityBonus: state.rarityBonus,
    itemCount: (id: string): number =>
      state.items.reduce((n, it) => n + (it.def.id === id ? it.count : 0), 0),
    consume: eat,
    spawn: (spec: ResolvedSpawn): void => {
      if (spec.count > 0) spawnQueue.push(spec);
    },
    // 彩蛋统计（摸狗/喝酒/斩首）本局累加，结算后由前端并入存档
    stat: (key: string, amount: number): void => {
      state.pendingStats[key] = (state.pendingStats[key] ?? 0) + amount;
    },
  };

  // 道具声明放进结算循环里跑：祭坛要等 organism 符号真的被摧毁，
  // 莫比乌斯环也要等 box 组符号挂上 destroyed 才能补回棋盘。
  // 循环内的重复应用由 cell.appliedItems 去重。

  // 细则 23：稀有度出现权重整体除以 values[0]（Main__Reels.gd:1942-1948）
  const fp23 = state.finePrints.find((fp) => fp.num === 23);
  if (fp23 && fp23.values[0]) {
    for (const key of ['uncommon', 'rare', 'very_rare'] as const) {
      const cur = state.rarityBonus.symbols[key];
      if (cur) state.rarityBonus.symbols[key] = cur / fp23.values[0];
    }
  }

  // 销毁是「先挂 tbd、转完再落地」的两段式（Slot_Icon__Slot_Icon.gd:2394-2405）：
  // 落地后再跑一轮声明，被摧毁符号的「{destroyed:true} → value_bonus」才会结算。
  // 同一转最多迭代 6 轮，防止互相触发的声明来回打架（源码用 current_effect_hashes 收敛）。
  /**
   * 生成物落地：源码先把生成物排进 reels.symbol_queue，再在结算循环里逐个 add_tile
   * 到随机空格（Slot_Icon__Slot_Icon.gd:1868-1870 / Main__Reels.gd 的 update）。
   * 落地的新符号要重算可视格并参与后续轮次，否则蜂巢的蜜、牛的奶这一转完全不计分。
   */
  const drainSpawns = (): boolean => {
    let placed = false;
    while (spawnQueue.length > 0) {
      const spec = spawnQueue.shift() as ResolvedSpawn;
      for (let k = 0; k < spec.count; k += 1) {
        const def = resolveSpawn(state, spec, destroyedIds);
        if (!def || !placeSymbol(state, def)) continue;
        state.pool.push(def);
        spawnedIds.push(def.id);
        placed = true;
      }
    }
    if (!placed) return false;
    state.cells = visibleCells(state.reels);
    // 新符号也要吃到细则 10/20/21/36 的「不可摧毁 / 不可移除」标记
    refreshTileFlags(state);
    return true;
  };

  for (let pass = 0; pass < 6; pass += 1) {
    // 道具先于符号：道具声明把 effect 挂到目标符号，符号自身的 add_effect 随后叠加
    const itemRun = applyItemEffects(state.items, state.cells, effectCtx);
    for (const id of itemRun.consumed) eat(id);
    applyEffects(state.cells, effectCtx);
    const spawned = drainSpawns();
    const pending = state.cells.filter((c) => c.tbd && !c.destroyed);
    if (pending.length === 0) {
      // 刚生成的新符号可能还有声明要跑（鸡生蛋、蛋再触发），没有就收敛
      if (!spawned) break;
      continue;
    }
    for (const c of pending) {
      // 细则 10/36：dynamic icon 不可摧毁（Slot_Icon__Slot_Icon.gd:2388）
      if (c.indestructible) {
        c.tbd = false;
        continue;
      }
      c.destroyed = true;
      c.tbd = false;
      if (c.def) destroyedIds.push(c.def.id);
    }
  }

  state.lastSpawned = spawnedIds;
  if (spawnedIds.length > 0) {
    const tally = new Map<string, number>();
    for (const id of spawnedIds) tally.set(id, (tally.get(id) ?? 0) + 1);
    state.log.unshift({
      turn: state.totalSpins + 1,
      kind: 'spin',
      text: `生成 ${spawnedIds.length} 个符号：${[...tally.entries()]
        .map(([id, n]) => `${symbolName(id)}×${n}`)
        .join('、')}`,
    });
  }

  syncTransformedPool(state, beforeTransform);

  const output = boardTotal(state.cells);
  state.lastSpinOutput = output;
  state.lastHits = [];
  state.coins += output;
  state.totalEarned += output;
  state.roundEarned += output;
  state.spinsLeft -= 1;
  state.totalSpins += 1;

  state.lastFinals = state.cells.map((cell) => {
    cell.lastOutput = evaluateCell(cell).final;
    return cell.lastOutput;
  });

  collectExtraTokens(state);

  if (destroyedIds.length > 0) removeDestroyed(state);
  clearRemoved(state);

  // 道具吃符号（Reel.symbol_removal_effects）：结算之后、下发下一转之前处理
  applySymbolRemovalItems(state);

  state.log.unshift({
    turn: state.totalSpins,
    kind: 'spin',
    text: `#${state.totalSpins} 旋转产出 ${output}（池 ${
      state.reels.reduce((n, col) => n + col.filter((c) => c.def).length, 0)
    } 个符号）`,
  });

  // 房东之战：本回合赚到的金币同时打在房东身上（HP Sum.add_value，Main__Main.gd:1580-1590），
  // 掉血压进 fine_print_counter（Landlord.take_damage:126-160）
  if (state.boss?.active && output > 0) dealBossDamage(state, output);

  if (state.spinsLeft === 0) {
    state.log.unshift({
      turn: state.totalSpins,
      kind: 'info',
      text: state.boss?.active ? '旋转次数用尽，需付租（房东战）' : '旋转次数用尽，需付租',
    });
    if (!state.over && !state.won) {
      addMail(
        state,
        rentDueMail({
          period: state.rentPaid + 1,
          rent: rentFor(state.floor, state.rentPaid + 1).rent,
          coins: state.coins,
          essenceTokens: state.essenceTokens,
          removalCost: state.removalCost,
          turn: state.totalSpins,
        }),
      );
    }
  } else if (output > 0) {
    // 每次 spin 后的三选一；本期最后一次不给（源码 rent_values[1] > 0 才起卡）
    state.shop = drawShopByChance(state, state.rentPaid + 1, shopSize(state));
    state.shopSource = 'spin';
    state.shopOpen = true;
  }
  trimLog(state);
}

/**
 * 变形同步：格子的符号被效果改写后，把池里对应的那一份也换成新符号。
 * 池是「玩家拥有的全部符号」，棋盘只是其中上盘的一部分，所以不能在结算后按棋盘重建，
 * 只能按「变形前 id → 变形后 id」逐格换掉池里的那条记录（数量不变）。
 */
function syncTransformedPool(state: GameState, before: Map<Cell, string>): void {
  for (const [cell, was] of before) {
    const now = cell.def?.id;
    if (!now || now === was) continue;
    const at = state.pool.findIndex((def) => def.id === was);
    if (at >= 0) state.pool[at] = symbol(now);
  }
}

/**
 * 销毁落地：把本转标成 destroyed 的符号从槽位与玩家池里一起抹掉
 * （Main__Reels.gd:1000-1010 的 symbol_destroyed_during_spin 收尾）。
 * 被摧毁的符号本转已计过分，所以清理放在结算之后。
 */
function removeDestroyed(state: GameState): void {
  const removed: string[] = [];
  for (const col of state.reels) {
    for (let s = 0; s < col.length; s += 1) {
      const cell = col[s];
      if (!cell.destroyed || !cell.def) continue;
      removed.push(cell.def.id);
      // 凶手来自规则里的 destroyed_or_removed_by（猫喝奶、熊吃蜜这类成就靠它判定）
      state.lastKills.push({ id: cell.def.id, by: cell.destroyedOrRemovedBy });
      col[s] = createCell(null);
    }
  }
  state.destroyed += removed.length;
  if (removed.length === 0) return;

  // 池与棋盘一一对应：清掉几个格子就从池里减几个，避免两边对不上
  for (const id of removed) {
    const at = state.pool.findIndex((def) => def.id === id);
    if (at < 0) continue;
    state.pool.splice(at, 1);
  }
  state.log.unshift({
    turn: state.totalSpins,
    kind: 'info',
    text: `被摧毁 ${removed.length} 个符号：${removed.map((id) => symbolName(id)).join('、')}`,
  });

  state.cells = visibleCells(state.reels);
}

/**
 * 移除落地：本转被标 removed 的符号从槽位与玩家池里抹掉（Slot_Icon__Slot_Icon.gd:2448-2456）。
 *
 * 和摧毁的区别：不打 tbd、不计入 `state.destroyed`、不写 `lastKills`（移除不是击杀，
 * 相关成就是「被移除时掉珍珠」这类自身规则，靠标记后的下一轮迭代结算）。
 * 清理必须放在产出结算之后——原版被移除的符号本转照常计分。
 */
function clearRemoved(state: GameState): void {
  const gone: string[] = [];
  for (const col of state.reels) {
    for (let s = 0; s < col.length; s += 1) {
      const cell = col[s];
      if (!cell.removed || !cell.def) continue;
      gone.push(cell.def.id);
      col[s] = createCell(null);
    }
  }
  if (gone.length === 0) return;
  for (const id of gone) {
    const at = state.pool.findIndex((def) => def.id === id);
    if (at < 0) continue;
    state.pool.splice(at, 1);
  }
  state.log.unshift({
    turn: state.totalSpins,
    kind: 'info',
    text: `被移除 ${gone.length} 个符号：${gone.map((id) => symbolName(id)).join('、')}`,
  });
  state.cells = visibleCells(state.reels);
}

/** 付租：扣款 → 累加旋转 → 开商店（§7.1 / §7.2，Pop-up__Pop-up.gd:2882-2890） */
/** Landlord.possible_fine_print 从 4 起跳：1/2/3/5/6/7 是内部标记，不参与抽取 */
const BLOCKED_FINE_PRINTS = new Set([1, 2, 3, 5, 6, 7]);
/** 依赖项里的 `item_xxx` 指道具库，其余指符号库 */
const ITEM_REF_PREFIX = 'item_';

/**
 * 抽一条细则（Landlord__Landlord.gd:135-190 的 get_fine_print）。
 * 已拥有的不重复、floor < 15 时不出难度 1、依赖的类型/分组必须在场，
 * dynamic_icon 取「依赖项里数量最多的那个」；找不到图标就换一条再抽。
 */
function drawFinePrint(state: GameState): FinePrintState | null {
  const owned = new Set(state.finePrints.map((fp) => fp.num));
  const symbolCounts = new Map<string, number>();
  const symbolGroupTypes = new Map<string, Set<string>>();
  for (const cell of state.cells) {
    const def = cell.def;
    if (!def) continue;
    symbolCounts.set(def.id, (symbolCounts.get(def.id) ?? 0) + 1);
    for (const g of def.groups) {
      const set = symbolGroupTypes.get(g) ?? new Set<string>();
      set.add(def.id);
      symbolGroupTypes.set(g, set);
    }
  }
  const itemCounts = new Map<string, number>();
  const itemGroupTypes = new Map<string, Set<string>>();
  for (const held of state.items) {
    itemCounts.set(held.def.id, (itemCounts.get(held.def.id) ?? 0) + held.count);
    for (const g of held.def.groups) {
      const set = itemGroupTypes.get(g) ?? new Set<string>();
      set.add(held.def.id);
      itemGroupTypes.set(g, set);
    }
  }
  const isItemRef = (ref: string): boolean => ref.startsWith(ITEM_REF_PREFIX);
  const refId = (ref: string): string => (isItemRef(ref) ? ref.slice(ITEM_REF_PREFIX.length) : ref);
  const hasType = (ref: string): boolean => (isItemRef(ref) ? itemCounts : symbolCounts).has(refId(ref));
  const hasGroup = (ref: string): boolean =>
    (isItemRef(ref) ? itemGroupTypes : symbolGroupTypes).has(refId(ref));

  const pool = FINE_PRINTS.filter((fp) => {
    if (owned.has(fp.id) || BLOCKED_FINE_PRINTS.has(fp.id)) return false;
    if (fp.difficulty === 1 && state.floor < 15) return false;
    if (fp.reliantTypes.length > 0 && !fp.reliantTypes.some(hasType)) return false;
    if (fp.reliantGroups.length > 0 && !fp.reliantGroups.some(hasGroup)) return false;
    return true;
  });
  if (pool.length === 0) return null;

  // 原版按「依赖类型/分组里数量最多的符号」定 dynamic_icon；找不到就换一条细则再抽
  const iconPool = (def: (typeof FINE_PRINTS)[number]): string[] => {
    const counts = new Map<string, number>();
    if (def.reliantTypes.length > 0) {
      for (const ref of def.reliantTypes) {
        const id = refId(ref);
        const n = (isItemRef(ref) ? itemCounts : symbolCounts).get(id) ?? 0;
        if (n > 0) counts.set(id, n);
      }
    } else if (def.reliantGroups.length > 0) {
      for (const ref of def.reliantGroups) {
        const isItem = isItemRef(ref);
        const ids = (isItem ? itemGroupTypes : symbolGroupTypes).get(refId(ref));
        for (const id of ids ?? []) {
          counts.set(id, (isItem ? itemCounts : symbolCounts).get(id) ?? 0);
        }
      }
    } else {
      for (const [id, n] of symbolCounts) counts.set(id, n);
    }
    const max = Math.max(0, ...counts.values());
    if (max <= 0) return [];
    return [...counts].filter(([, n]) => n === max).map(([id]) => id);
  };

  for (let guard = 0; guard < pool.length; guard += 1) {
    const [def] = pool.splice(Math.floor(state.rand() * pool.length), 1);
    if (!def) break;
    let dynamicIcon: string | undefined;
    if (def.needsIcon) {
      const icons = iconPool(def);
      if (icons.length > 0) dynamicIcon = icons[Math.floor(state.rand() * icons.length)];
      else if (def.reliantTypes.length > 0) dynamicIcon = refId(def.reliantTypes[0]!);
      else if (def.reliantGroups.length > 0) {
        const ref = def.reliantGroups[0]!;
        dynamicIcon = [...((isItemRef(ref) ? itemGroupTypes : symbolGroupTypes).get(refId(ref)) ?? [])][0];
      }
      if (!dynamicIcon) continue;
    }
    return {
      num: def.id,
      name: `细则 ${def.id}`,
      values: [...def.values],
      dynamicIcon,
    };
  }
  return null;
}

/**
 * 细则里不经过 add_effect 模板的「格子标记」（源码直接写在 Slot_Icon.change_type / Main.add_tile 里）：
 *   10 → dynamicIcon 不可被摧毁（Slot_Icon__Slot_Icon.gd:456-462）
 *   20 → coin 不可被移除（:470-478）
 *   21 → egg 不可被移除（:479-486）
 *   36 → dynamicIcon 不可被摧毁且不可被移除（:463-469）
 * 每转先清空再按当前细则重算，对应源码在 change_type 里的重置。
 */
function refreshTileFlags(state: GameState): void {
  const f10 = state.finePrints.find((fp) => fp.num === 10)?.dynamicIcon;
  const f36 = state.finePrints.find((fp) => fp.num === 36)?.dynamicIcon;
  const noCoin = state.finePrints.some((fp) => fp.num === 20 && !fp.dynamicIcon);
  const noEgg = state.finePrints.some((fp) => fp.num === 21 && !fp.dynamicIcon);
  for (const col of state.reels) {
    for (const cell of col) {
      cell.indestructible = false;
      cell.canBeRemoved = true;
      const id = cell.def?.id;
      if (!id) continue;
      // dud 天生不可移除（Slot_Icon__Slot_Icon.gd:452-455）
      if (id === 'dud') {
        cell.canBeRemoved = false;
        continue;
      }
      if (f10 && id === f10) cell.indestructible = true;
      if (f36 && id === f36) {
        cell.indestructible = true;
        cell.canBeRemoved = false;
      }
      if (noCoin && id === 'coin') cell.canBeRemoved = false;
      if (noEgg && id === 'egg') cell.canBeRemoved = false;
    }
  }
}

/**
 * 部分道具会「吃掉」场上对应符号并累积价值（Reel__Reel.gd:172-300 的 symbol_removal_effects）：
 *   egg_carton / egg_carton_essence → egg（细则 21 生效时不吃）
 *   coin_on_a_string / _essence      → coin（细则 20 生效时不吃）
 *   lint_roller / _essence           → rabbit_fluff
 *   fish_bowl / _essence             → goldfish
 *   barrel_o_dwarves_essence         → dwarf
 * 被吃掉的符号从池里同步减一，道具按原版公式累加 value / saved_value。
 */
export function applySymbolRemovalItems(state: GameState): void {
  if (state.items.length === 0) return;
  const held = (id: string): HeldItem | undefined => state.items.find((it) => it.def.id === id);
  const fp20 = state.finePrints.some((fp) => fp.num === 20);
  const fp21 = state.finePrints.some((fp) => fp.num === 21);

  const groups: { items: string[]; symbol: string; blocked: boolean }[] = [
    { items: ['egg_carton', 'egg_carton_essence'], symbol: 'egg', blocked: fp21 },
    { items: ['coin_on_a_string', 'coin_on_a_string_essence'], symbol: 'coin', blocked: fp20 },
    { items: ['lint_roller', 'lint_roller_essence'], symbol: 'rabbit_fluff', blocked: false },
    { items: ['fish_bowl', 'fish_bowl_essence'], symbol: 'goldfish', blocked: false },
    { items: ['barrel_o_dwarves_essence'], symbol: 'dwarf', blocked: false },
  ];

  for (const group of groups) {
    if (group.blocked) continue;
    const owners = group.items
      .map(held)
      .filter((it): it is HeldItem => Boolean(it));
    if (owners.length === 0) continue;

    let eaten = 0;
    for (const col of state.reels) {
      for (const cell of col) {
        if (cell.def?.id !== group.symbol) continue;
        cell.def = null;
        eaten += 1;
      }
    }
    if (eaten === 0) continue;

    for (let k = 0; k < eaten; k += 1) {
      const at = state.pool.findIndex((def) => def.id === group.symbol);
      if (at >= 0) state.pool.splice(at, 1);
    }
    state.cells = visibleCells(state.reels);

    const name = symbolName(group.symbol);
    const parts: string[] = [];
    for (const it of owners) {
      const v = it.def.values ?? [];
      const count = it.count;
      switch (it.def.id) {
        case 'egg_carton': {
          const max = v[1] ?? 0;
          let saved = it.savedValue ?? 0;
          for (let k = 0; k < eaten; k += 1) if (saved < max) saved += v[0] ?? 0;
          it.savedValue = saved;
          break;
        }
        case 'egg_carton_essence':
          it.itemValue = (it.itemValue ?? 0) + (v[1] ?? 0) * count * eaten;
          it.savedValue = (it.savedValue ?? 0) + eaten;
          break;
        case 'coin_on_a_string':
        case 'coin_on_a_string_essence':
          it.itemValue = (it.itemValue ?? 0) + (v[1] ?? 0) * count * eaten;
          if (it.def.id === 'coin_on_a_string_essence') {
            it.savedValue = (it.savedValue ?? 0) + eaten;
          }
          break;
        case 'lint_roller':
          it.itemValue = (it.itemValue ?? 0) + (v[0] ?? 0) * count * eaten;
          break;
        case 'lint_roller_essence':
          it.itemValue = (it.itemValue ?? 0) + (v[1] ?? 0) * eaten;
          it.savedValue = (it.savedValue ?? 0) + eaten;
          break;
        case 'fish_bowl':
          it.savedValue = (it.savedValue ?? 0) + (v[0] ?? 0) * eaten;
          break;
        case 'fish_bowl_essence':
          it.itemValue = (it.itemValue ?? 0) + (v[1] ?? 0) * count * eaten;
          it.savedValue = (it.savedValue ?? 0) + eaten;
          break;
        case 'barrel_o_dwarves_essence':
          it.itemValue = (it.itemValue ?? 0) + (v[1] ?? 0) * count * eaten;
          it.savedValue = (it.savedValue ?? 0) + eaten;
          break;
        default:
          break;
      }
      parts.push(`${symbolName(it.def.id)} 吃下 ${eaten}`);
    }
    state.log.unshift({
      turn: state.totalSpins,
      kind: 'info',
      text: `${parts.join('，')} 个${name}`,
    });
  }
  trimLog(state);
}

/** 细则 30：候选符号数 3 - values[0]（Pop-up__Pop-up.gd:1180-1190） */
function shopSize(state: GameState): number {
  const fp30 = state.finePrints.find((fp) => fp.num === 30);
  return Math.max(0, 3 - (fp30?.values[0] ?? 0));
}

/**
 * 受伤累积到阈值就发细则（Landlord__Landlord.gd:126-160）：
 * 每跨过一次阈值发一条，floor ≥ 17 两条、≥ 20 三条。
 */
export function grantFinePrints(state: GameState, damage = 0): FinePrintState[] {
  if (damage > 0) state.finePrintCounter += damage;
  const gained: FinePrintState[] = [];
  // Landlord.take_damage(:157-172)：阈值始终是 floor(max_hp/10)，每跨一次就抽
  // total_fp 条（floor≥20 三条、≥17 两条、否则一条），然后扣掉一份阈值。
  let guard = 0;
  while (state.finePrintCounter >= state.finePrintThreshold && guard < 64) {
    guard += 1;
    state.finePrintCounter -= state.finePrintThreshold;
    const count = state.floor >= 20 ? 3 : state.floor >= 17 ? 2 : 1;
    for (let i = 0; i < count; i += 1) {
      const fp = drawFinePrint(state);
      if (!fp) break;
      state.finePrints.push(fp);
      gained.push(fp);
    }
  }
  for (const fp of gained) {
    state.log.unshift({
      turn: state.totalSpins,
      kind: 'info',
      text: `获得细则 ${fp.num}${fp.dynamicIcon ? `（${symbolName(fp.dynamicIcon)}）` : ''}`,
    });
    // 原版每拿一条细则就往信箱塞一封 fine_print 信（同类只留最新一封）
    addMail(
      state,
      finePrintMail({
        num: fp.num,
        name: fp.name,
        values: fp.values,
        dynamicIcon: fp.dynamicIcon,
        turn: state.totalSpins,
      }),
    );
  }
  return gained;
}

export function payRent(state: GameState): { ok: boolean; message: string } {
  if (state.over || state.won) return { ok: false, message: '已结束' };
  if (state.spinsLeft > 0) return { ok: false, message: '旋转次数尚未用尽' };

  const nextPayment = state.rentPaid + 1;
  // 租金 = 基础表 + 本楼层加成（Pop-up.update_rent_values 的 +25 分支）
  const row = rentFor(state.floor, nextPayment);
  // 房东战租金另起一套：500 + (期数 - 12) * 500，每期 10 次旋转
  // （Pop-up.update_rent_values 的 doing_boss_fight 分支）
  const inBoss = Boolean(state.boss?.active);
  const owed = inBoss ? bossRent(nextPayment) : row.rent;
  const spinsGain = inBoss ? 10 : row.spinsGain;
  if (state.coins < owed) {
    // 付不起即破产（Pop-up__Pop-up.gd:2830-2900 的 rent_due 分支没有「受伤」这回事，
    // 房东的血条只在房东之战里被玩家打）
    state.over = true;
    state.log.unshift({ turn: state.totalSpins, kind: 'rent', text: `付租失败：租金 ${owed}，持有 ${state.coins}` });
    addMail(
      state,
      gameOverMail({ period: nextPayment, rent: owed, coins: state.coins, turn: state.totalSpins }),
    );
    trimLog(state);
    return { ok: false, message: `租金 ${owed} 不足（持有 ${state.coins}）` };
  }

  state.coins -= owed;
  state.rentPaid = nextPayment;
  state.spinsLeft += spinsGain;
  state.roundEarned = 0;
  // 楼层是开局选定的，付租不再改它（Pop-up.current_floor 一局内不变）
  state.payment = nextPayment;

  // 付租时未花掉的精华在房东手里作废（Main__Main.gd:1300 essence_tokens = 0），
  // 重掷/移除代币则保留。
  state.essenceTokens = 0;

  // 付满 times_to_pay_rent 期后，原版会先看 Stats.bossfight_unlocked：
  // 解锁了就 add_event("boss_fight_1") 让房东亲自下场（Pop-up__Pop-up.gd:880-985），
  // 没解锁才走 ending。正常打到 12 期时 highest_unlocked_floor 必然 ≥ 9，所以这里必进房东战。
  // 无尽模式继续加租，永不结束；房东之战里同样按期付租（500 + (n-12)*500）。
  const periodsCleared = state.mode === 'normal' && nextPayment >= 12 && !state.boss?.active;
  if (periodsCleared) {
    // 原版邮件表里的 win（付清 12 期）与 ending（房东倒下）是两封，这里同样分开发
    addMail(
      state,
      winMail({
        period: nextPayment,
        rent: owed,
        totalEarned: state.totalEarned,
        turn: state.totalSpins,
      }),
    );
    startBossFight(state);
  }

  // 同伴援助（Pop-up__Pop-up.gd:2925-2945）：第 3 期第一次，之后每逢奇数期一次，
  // 数量随楼层递减——这就是 comrade_values 的楼层缩放，直接落到三种代币上。
  if (nextPayment === 3 || (nextPayment > 3 && nextPayment % 2 === 1)) {
    const gift = comradeValues(state.floor);
    state.rerollTokens += gift.reroll;
    state.removalTokens += gift.removal;
    state.essenceTokens += gift.essence;
    if (!hasMailKind(state, 'removal_token_prompt')) {
      addMail(state, removalTipMail(state.removalCost, state.totalSpins));
    }
    addMail(state, comradeMail(state.floor, nextPayment === 3, state.totalSpins));
  }

  // 每期付完都有一封「下一期涨租」的信（原版 rent_increase）
  const nextBoss = Boolean(state.boss?.active);
  const nextRow = rentFor(state.floor, nextPayment + 1);
  const nextRent = nextBoss ? bossRent(nextPayment + 1) : nextRow.rent;
  const nextSpins = nextBoss ? 10 : nextRow.spinsGain;
  addMail(
    state,
    rentIncreaseMail({
      period: nextPayment,
      nextRent,
      spinsGain: nextSpins,
      endless: state.mode === 'endless',
      turn: state.totalSpins,
    }),
  );

  state.log.unshift({
    turn: state.totalSpins,
    kind: 'rent',
    text: state.mode === 'endless'
      ? `付租 #${nextPayment}：-${owed}，+${spinsGain} 旋转（无尽模式，下一期租金 ${nextRent}）`
      : `付租 #${nextPayment}：-${owed}，+${spinsGain} 旋转（剩余 ${state.spinsLeft}）`,
  });

  // 通关后不再起卡，避免商店盖住结算页
  if (!state.won) {
    state.shop = drawShop(state, nextPayment, shopSize(state));
    state.shopSource = 'rent';
    state.shopOpen = true;
  }
  trimLog(state);

  return { ok: true, message: `已付第 ${nextPayment} 期租金 ${row.rent}` };
}

/**
 * 房东血量按层：≥13 层 1500、≥11 层 1000，否则 750
 * （Landlord__Landlord.gd:113-120 的 spawn()）。
 */
/** 房东血量按楼层（Main__Main.gd:1359）：≥13 层 1500、≥11 层 1000、其余 750 */
export function landlordMaxHp(floor: number): number {
  if (floor >= 13) return 1500;
  if (floor >= 11) return 1000;
  return BOSS_HP;
}

/** 房东战租金：500 + (期数 - 12) * 500（Pop-up.update_rent_values 的 doing_boss_fight 分支） */
export function bossRent(nextPayment: number): number {
  return 500 + Math.max(0, nextPayment - 12) * 500;
}

/** 进入房东之战：付满 12 期后由 payRent 直接调用（原版 boss_fight_1/2 两封信之后 spawn） */
export function startBossFight(state: GameState): void {
  if (state.boss?.active || state.over || state.won) return;
  const maxHp = landlordMaxHp(state.floor);
  state.boss = { maxHp, hp: maxHp, active: true };
  state.spinsLeft = Math.max(state.spinsLeft, 5);
  // 细则阈值跟着血条走：floor(max_hp / 10)（Landlord__Landlord.gd:126-160）
  state.finePrintThreshold = Math.max(1, Math.floor(maxHp / 10));
  addMail(state, bossMail(maxHp, state.totalSpins));
  addMail(state, bossFightMail2(maxHp, state.totalSpins));
  state.log.unshift({
    turn: state.totalSpins,
    kind: 'info',
    text: `房东之战开始：房东血量 ${maxHp}，每回合赚到的金币会同时打在房东身上`,
  });
  trimLog(state);
}

/**
 * 房东受伤：本回合收入就是伤害（HP Sum.add_value(coin_value)），
 * 同时压进 fine_print_counter（Landlord__Landlord.gd:126-172），
 * 血量归零即通关。
 */
export function dealBossDamage(state: GameState, damage: number): void {
  const boss = state.boss;
  if (!boss || !boss.active || damage <= 0) return;
  boss.hp = Math.max(0, boss.hp - damage);
  grantFinePrints(state, damage);
  refreshTileFlags(state);
  const dead = boss.hp <= 0;
  if (dead) {
    boss.active = false;
    state.won = true;
    // 结局页不要被商店盖住
    state.shopOpen = false;
    state.shop = [];
    // 房东倒下才是真结局（原版 boss 战打完才走 ending）
    addMail(
      state,
      endingMail({
        rent: rentFor(state.floor, Math.max(1, state.rentPaid)).rent,
        totalEarned: state.totalEarned,
        turn: state.totalSpins,
      }),
    );
  }
  state.log.unshift({
    turn: state.totalSpins,
    kind: 'rent',
    text: dead
      ? `本回合 ${damage} 伤害，房东倒下（${boss.maxHp}/${boss.maxHp}）`
      : `本回合 ${damage} 伤害 → 房东剩余 ${boss.hp}/${boss.maxHp}`,
  });
  trimLog(state);
}

/**
 * 商店重掷（Pop-up__Pop-up.gd:2760-2790）：花 rerollCost 个重掷代币重抽三张。
 * 与「跳过」不同，重掷保留本次奖励机会，只是换一批候选。
 */
export function rerollShop(state: GameState): { ok: boolean; message: string } {
  if (!state.shopOpen) return { ok: false, message: '商店未打开' };
  if (state.rerollTokens < state.rerollCost) {
    return { ok: false, message: `重掷代币不足（需要 ${state.rerollCost}）` };
  }
  state.rerollTokens -= state.rerollCost;
  const payment = state.shopSource === 'spin' ? state.rentPaid + 1 : state.payment;
  const count = shopSize(state);
  state.shop =
    state.shopSource === 'spin'
      ? drawShopByChance(state, payment, count)
      : drawShop(state, payment, count);
  state.log.unshift({
    turn: state.totalSpins,
    kind: 'buy',
    text: `重掷商店：-${state.rerollCost} 重掷代币（剩 ${state.rerollTokens}）`,
  });
  trimLog(state);
  return { ok: true, message: '已重掷' };
}

/**
 * 移除符号（removal_token：Pop-up__Pop-up.gd:2830 的 selected_node 流程）。
 * 只能移除棋盘上看得见的符号；扣 removalCost 个移除代币，池同步减一。
 */
export function removeSymbolAt(
  state: GameState,
  cellIndex: number,
): { ok: boolean; message: string } {
  if (state.over || state.won) return { ok: false, message: '已结束' };
  if (state.removalTokens < state.removalCost) {
    return { ok: false, message: `移除代币不足（需要 ${state.removalCost}）` };
  }
  const cell = state.cells[cellIndex];
  if (!cell?.def) return { ok: false, message: '这里没有符号' };
  // 细则 20/21/36 与 dud 会关掉 can_be_removed
  if (cell.canBeRemoved === false) return { ok: false, message: `${symbolName(cell.def.id)} 不能被移除` };
  const x = cellIndex % REELS_X;
  const y = Math.floor(cellIndex / REELS_X) + 1;
  const slot = state.reels[x]?.[y];
  if (!slot || slot.uid !== cell.uid) return { ok: false, message: '格子已变动，请重试' };

  const id = cell.def.id;
  // 先打 removed 标记、跑一遍这个符号自己的声明，再抹格。
  // 牡蛎「被移除时掉珍珠」（{removed:true,type:oyster} → tiles_to_add pearl）就是这条路径。
  cell.removed = true;
  const spawnedSpecs: ResolvedSpawn[] = [];
  applyEffects(
    state.cells,
    {
      chanceRoll: state.rand,
      finePrint: state.finePrints,
      rarityBonus: state.rarityBonus,
      itemCount: (itemId: string) =>
        state.items.reduce((n, it) => n + (it.def.id === itemId ? it.count : 0), 0),
      consume: (itemId: string) => consumeItem(state, itemId),
      spawn: (spec: ResolvedSpawn) => {
        spawnedSpecs.push(spec);
      },
    },
    // 只结算被移除的那一个符号：原版移除不重跑整盘
    new Set([cellIndex]),
  );

  state.reels[x][y] = createCell(null);
  const at = state.pool.findIndex((def) => def.id === id);
  if (at >= 0) state.pool.splice(at, 1);
  state.removalTokens -= state.removalCost;
  state.cells = visibleCells(state.reels);

  // 移除产生的符号补位到空格（珍珠落在随机空格上，与旋转时的生成同一套规则）
  const spawned: string[] = [];
  for (const spec of spawnedSpecs) {
    for (let k = 0; k < spec.count; k += 1) {
      const def = resolveSpawn(state, spec, []);
      if (!def || !placeSymbol(state, def)) continue;
      state.pool.push(def);
      spawned.push(def.id);
    }
  }
  if (spawned.length > 0) state.cells = visibleCells(state.reels);

  state.log.unshift({
    turn: state.totalSpins,
    kind: 'buy',
    text: `移除符号 ${symbolName(id)}：-${state.removalCost} 移除代币（剩 ${state.removalTokens}）${
      spawned.length > 0 ? `，掉落 ${spawned.map((s) => symbolName(s)).join('、')}` : ''
    }`,
  });
  trimLog(state);
  return { ok: true, message: `已移除 ${symbolName(id)}` };
}

/** 可视区索引是否合法（0..19，行优先） */
function onBoard(index: number): boolean {
  return Number.isInteger(index) && index >= 0 && index < CELL_COUNT;
}

// 注意：这里**不提供**自由重排棋盘的入口。原版没有任何拖拽符号的实现
// （脚本里没有 drag_and_drop / get_drag_data，输入层也只有 inspect /
// enable_disable_item / confirm_select / deny_cancel），位置干预的唯一手段
// 是 swapping_device 道具，见 swapSymbols：每转一次、只能动两个格子。
// 交换必须落到 `reels` 上：`cells` 只是 `reels` 的投影，下一轮旋转按 `reels`
// 洗牌，只改 `cells` 会在旋转时被打回原形。

/**
 * 精华升级（essence_token）：把道具换成它的精华版本（essences.csv 的 `id_essence`）。
 * 原版在付租后以「房东来信」逐张兑现，这里做成随时可用的即时升级。
 */
export function essenceUpgrade(state: GameState, itemId: string): { ok: boolean; message: string } {
  if (state.over || state.won) return { ok: false, message: '已结束' };
  if (state.essenceTokens <= 0) return { ok: false, message: '精华代币不足' };
  const held = state.items.find((it) => it.def.id === itemId);
  if (!held) return { ok: false, message: '没有这个道具' };
  const essenceId = `${itemId}_essence`;
  if (!SYMBOL_BY_ID.has(essenceId)) return { ok: false, message: '这个道具没有精华形态' };

  held.def = symbol(essenceId);
  state.essenceTokens -= 1;
  state.log.unshift({
    turn: state.totalSpins,
    kind: 'buy',
    text: `精华升级：${symbolName(itemId)} → ${symbolName(essenceId)}（剩 ${state.essenceTokens} 精华）`,
  });
  trimLog(state);
  return { ok: true, message: `已升华为 ${symbolName(essenceId)}` };
}

/** 能否对某道具做精华升级（界面据此显示按钮） */
export function canEssenceUpgrade(state: GameState, itemId: string): boolean {
  if (state.essenceTokens <= 0) return false;
  if (!state.items.some((it) => it.def.id === itemId)) return false;
  if (itemId.endsWith('_essence')) return false;
  return SYMBOL_BY_ID.has(`${itemId}_essence`);
}

/**
 * 消耗一个道具（源码 item_to_destroy）：数量减一，归零则离开道具栏。
 * 洒水壶、掠夺手套精华、逃税精华都用它实现「用一次就没了」。
 */
function consumeItem(state: GameState, itemId: string): void {
  const idx = state.items.findIndex((it) => it.def.id === itemId && it.count > 0);
  if (idx < 0) return;
  const held = state.items[idx];
  held.count -= 1;
  if (held.count <= 0) state.items.splice(idx, 1);
  state.log.unshift({
    turn: state.totalSpins,
    kind: 'info',
    text: `消耗道具：${symbolName(itemId)}`,
  });
  trimLog(state);
}

/** 牌库汇总：符号池按 id 归并，供「牌库」面板展示（原版 deck_button） */
export interface PoolEntry {
  id: string;
  name: string;
  count: number;
  value: number;
  rarity: string;
}

export function poolSummary(state: GameState): PoolEntry[] {
  const map = new Map<string, PoolEntry>();
  for (const def of state.pool) {
    const at = map.get(def.id);
    if (at) at.count += 1;
    else map.set(def.id, { id: def.id, name: symbolName(def.id), count: 1, value: def.value, rarity: def.rarity });
  }
  return [...map.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh'));
}

/**
 * 商店稀有度：不是概率抽取，而是按付租次数强制配比
 * （Pop-up__Pop-up.gd:2657-2677）。
 */
export function shopRaritySlots(paid: number): Rarity[] {
  if (paid <= 5) return ['uncommon', 'uncommon', 'uncommon'];
  if (paid <= 8) return ['rare', 'uncommon', 'uncommon'];
  if (paid === 9) return ['rare', 'rare', 'uncommon'];
  return ['rare', 'rare', 'rare'];
}

/**
 * 每 spin 后的三选一：按「已付租次数」对应的稀有度**概率**抽样
 * （Pop-up__Pop-up.gd::add_cards，档位见 data/rarity.json）。
 * 与付租后固定配比的 shopRaritySlots 是两个不同来源，不能混用。
 */
/**
 * 商店第 0 位固定为道具位。
 * 原作里道具走独立的 add_item 商店事件、符号走 add_tile，两者各有自己的稀有度表
 * （Pop-up__Pop-up.gd:1151-1210 + rarityRowFor('item'|'symbol')）。
 * 复现台把两个事件合并成「每次开店 1 个道具位 + 其余符号位」，道具因此可得。
 */
/** 代币卡出现概率：原版 token 卡是独立卡牌类型（Card__Card.gd:343），这里按低权重混入 */
const TOKEN_CARD_CHANCE = 0.1;
const TOKEN_KINDS: TokenKind[] = ['reroll', 'removal', 'essence'];

function drawCard(state: GameState, kind: 'item' | 'symbol', payment: number): ShopCard {
  if (state.rand() < TOKEN_CARD_CHANCE) {
    const token = TOKEN_KINDS[Math.floor(state.rand() * TOKEN_KINDS.length)];
    return { def: tokenDef(token), rarity: 'uncommon', token };
  }
  const row = rarityRowFor(kind, payment);
  // Pop-up__Pop-up.gd:1147：r_chances[r] *= rarity_bonuses["symbols"|"items"][r]
  const bonus: Partial<Record<Rarity, number>> =
    kind === 'item' ? state.rarityBonus.items : state.rarityBonus.symbols;
  const ladder: Array<[Rarity, number]> = [
    ['very_rare', row.veryRare * (bonus.very_rare ?? 1)],
    ['rare', row.rare * (bonus.rare ?? 1)],
    ['uncommon', row.uncommon * (bonus.uncommon ?? 1)],
  ];
  let roll = state.rand();
  let rarity: Rarity = 'common';
  for (const [name, p] of ladder) {
    if (roll < p) {
      rarity = name;
      break;
    }
    roll -= p;
  }
  const pool = kind === 'item' ? ITEM_POOL : SYMBOL_POOL;
  const bucket = pool[rarity].length ? pool[rarity] : pool.common;
  const id = bucket[Math.floor(state.rand() * bucket.length)];
  return { def: symbol(id), rarity };
}

export function drawShopByChance(state: GameState, payment: number, count: number): ShopCard[] {
  const cards: ShopCard[] = [];
  for (let i = 0; i < count; i += 1) {
    cards.push(drawCard(state, i === 0 ? 'item' : 'symbol', payment));
  }
  return cards;
}

export function drawShop(state: GameState, paid: number, count: number): ShopCard[] {
  const cards: ShopCard[] = [];
  for (let i = 0; i < count; i += 1) {
    cards.push(drawCard(state, i === 0 ? 'item' : 'symbol', paid));
  }
  return cards;
}

/**
 * 一次性道具：买下的瞬间生效，不属于「持有期间」的声明，所以不写进 item_effects.csv。
 * 逐条对应 Item__Item.gd:426-520 的 match type 分支，数量取自 items.csv 的 values。
 * 未覆盖：devils_deal（补空位，values=66 远超棋盘容量）、dark_humor（改喜剧演员稀有度）、
 * treasure_map（攒满才生成钥匙，走的是摧毁分支而不是购买分支）。
 */
function applyItemOnBuy(state: GameState, def: SymbolDef): void {
  const v = def.values ?? [];
  const added: string[] = [];
  const put = (target: SymbolDef, n: number): void => {
    let placed = 0;
    for (let i = 0; i < n; i += 1) {
      if (!placeSymbol(state, target)) break;
      state.pool.push(target);
      placed += 1;
    }
    if (placed > 0) added.push(`${symbolName(target.id)}×${placed}`);
  };
  /** 按稀有度抽一个符号；booster_pack 的 all_symbols_same 让多个副本共用同一张 */
  const pick = (rarity: Rarity): SymbolDef | null => {
    const pool = DRAWABLE_SYMBOLS.filter((s) => s.rarity === rarity);
    return pool.length === 0 ? null : pool[Math.floor(state.rand() * pool.length)];
  };
  const pickGroup = (group: string): SymbolDef | null => {
    const pool = DRAWABLE_SYMBOLS.filter((s) => s.groups.includes(group));
    return pool.length === 0 ? null : pool[Math.floor(state.rand() * pool.length)];
  };

  switch (def.id) {
    case 'barrel_o_dwarves':
      put(symbol('dwarf'), v[0] ?? 0);
      break;
    case 'goldilocks':
      put(symbol('bear'), v[0] ?? 0);
      break;
    case 'lunchbox': {
      const s = pickGroup('food');
      if (s) put(s, v[0] ?? 0);
      break;
    }
    case 'adoption_papers': {
      const s = pickGroup('animal');
      if (s) put(s, v[0] ?? 0);
      break;
    }
    case 'symbol_bomb_quantum': {
      // forced_group "passed" 是动态组：Main__Main.gd:1470 把它设成 popup.passed，
      // 也就是本转结算后仍留在盘上的符号；商店打开时棋盘正好停在这个状态
      const onBoard = state.cells
        .map((c) => c.def)
        .filter((d): d is SymbolDef => Boolean(d));
      for (let i = 0; i < (v[0] ?? 0); i += 1) {
        if (onBoard.length === 0) break;
        put(onBoard[Math.floor(state.rand() * onBoard.length)], 1);
      }
      break;
    }
    case 'symbol_bomb_small':
    case 'symbol_bomb_big':
    case 'symbol_bomb_very_big': {
      // 源码 add_tile 不带条件：按当前稀有度表随机，逐个抽
      for (let i = 0; i < (v[0] ?? 0); i += 1) {
        const s = DRAWABLE_SYMBOLS[Math.floor(state.rand() * DRAWABLE_SYMBOLS.length)];
        if (s) put(s, 1);
      }
      break;
    }
    case 'booster_pack': {
      // values = [4, 3, 1]：4 个普通同种、3 个罕见同种、1 个稀有同种
      const tiers: Array<[Rarity, number]> = [
        ['common', v[0] ?? 0],
        ['uncommon', v[1] ?? 0],
        ['rare', v[2] ?? 0],
      ];
      for (const [rarity, n] of tiers) {
        const s = pick(rarity);
        if (s) put(s, n);
      }
      break;
    }
    case 'coffee':
      // popup.rent_values[1] += 1：本期多给一次旋转，而不是加钱
      state.spinsLeft += 1;
      added.push('本期 +1 次旋转');
      break;
    default:
      break;
  }

  if (added.length === 0) return;
  state.cells = visibleCells(state.reels);
  state.log.unshift({
    turn: state.totalSpins,
    kind: 'buy',
    text: `${symbolName(def.id)} 生效：${added.join('、')}`,
  });
}

export function buyFromShop(state: GameState, index: number): boolean {
  const card = state.shop[index];
  if (!card) return false;

  // 代币卡：买到直接进代币存量
  if (card.token) {
    if (card.token === 'reroll') state.rerollTokens += 1;
    else if (card.token === 'removal') state.removalTokens += 1;
    else state.essenceTokens += 1;
    state.log.unshift({
      turn: state.totalSpins,
      kind: 'buy',
      text: `获得${TOKEN_LABEL[card.token]}（重掷 ${state.rerollTokens} / 移除 ${state.removalTokens} / 精华 ${state.essenceTokens}）`,
    });
    closeShop(state);
    trimLog(state);
    return true;
  }

  if (isItemDef(card.def)) state.buys += 1;

  // 道具进道具栏，不进池、不占格（Items__Items.gd:44-214）
  if (isItemDef(card.def)) {
    const held = state.items.find((h) => h.def.id === card.def.id);
    if (held) held.count += 1;
    else state.items.push({ def: card.def, count: 1 });
    state.log.unshift({
      turn: state.totalSpins,
      kind: 'buy',
      text: `获得道具 ${symbolName(card.def.id)}${held ? ` ×${held.count}` : ''}`,
    });
    // 一次性道具在买下的这一刻就结算（生成符号 / 加旋转）
    applyItemOnBuy(state, card.def);
    // 一次商店只能选一张（Pop-up__Pop-up.gd 的选项回调里直接关面板）
    // 第一件道具时补一封「道具栏怎么用」（原版邮件 kind：inventory）
    if (!hasMailKind(state, 'inventory')) addMail(state, inventoryMail(state.totalSpins));
    if (card.def.id === 'chili_powder' && !hasMailKind(state, 'chili_powder_essence_prompt')) {
      addMail(state, chiliEssenceMail(state.essenceTokens, state.totalSpins));
    }
    closeShop(state);
    trimLog(state);
    return true;
  }

  if (!placeSymbol(state, card.def)) return false;
  state.pool.push(card.def);
  state.cells = visibleCells(state.reels);
  // 新买入的格子立刻带上细则的「不可移除 / 不可摧毁」标记
  refreshTileFlags(state);
  state.log.unshift({
    turn: state.totalSpins,
    kind: 'buy',
    text: `加入符号 ${symbolName(card.def.id)}`,
  });
  closeShop(state);
  trimLog(state);
  return true;
}

export function closeShop(state: GameState): void {
  state.shopOpen = false;
  state.shop = [];
}

function trimLog(state: GameState): void {
  if (state.log.length > 200) state.log.length = 200;
}

/** 按稀有度概率表抽样（仅用于商店之外的抽卡与实验对照） */
export function rollRarity(
  rand: Random,
  row: { common: number; uncommon: number; rare: number; veryRare: number },
): Rarity {
  const r = rand() * 100;
  if (r < row.veryRare) return 'very_rare';
  if (r < row.veryRare + row.rare) return 'rare';
  if (r < row.veryRare + row.rare + row.uncommon) return 'uncommon';
  return 'common';
}

export interface Progress {
  period: number;
  rent: number;
  avgPerSpin: number;
}

export function progress(state: GameState): Progress {
  // 房东战租金另走一套（500 + (n-12)*500）
  const rent = state.boss?.active
    ? bossRent(state.rentPaid + 1)
    : rentFor(state.floor, state.rentPaid + 1).rent;
  return {
    period: state.rentPaid + 1,
    rent,
    avgPerSpin: state.totalSpins > 0 ? state.totalEarned / state.totalSpins : 0,
  };
}
