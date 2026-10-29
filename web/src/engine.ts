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
  ESSENCES,
  FINE_PRINTS,
  ITEM_POOL,
  SYMBOL_BY_ID,
  SYMBOL_POOL,
  rarityRowFor,
  rentRowFor,
  symbol,
} from './data';
import { CELL_COUNT, COLS as REELS_X, ROWS as REELS_Y, SLOTS_PER_REEL, neighborsOf } from './grid';
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

/**
 * 一次发卡的阶段。
 *   旋转奖励 → 只有符号（Main__Reels.gd:1955）
 *   付租奖励 → 先符号（强制配比）、再道具（Pop-up__Pop-up.gd:2684 / :2707）
 *   精华代币 → 每枚再开一次「三张精华任选」
 *              （Pop-up__Pop-up.gd:2661 的 `forced_rarity: ["essence"] × 3`）
 * 原版是一串连续邮件事件，复现台用队列串起来。
 */
export type ShopStage = 'spin-symbol' | 'rent-symbol' | 'rent-item' | 'rent-essence';

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
  /**
   * 玩家手动关闭该道具（`Item__Item.gd:32` 的 `disabled`）。
   * 关闭后 `add_conditional_effects` 整段跳过（`:1851` 的 `if not disabled`），
   * 即「持有但不生效」——用于买了道具又不想它干预当前的构建方向。
   */
  disabled?: boolean;
}

/**
 * 该道具是否**允许**被禁用（`Item__Item.gd:146`）。
 *
 * 三个例外：
 *   · `popsicle` / `popsicle_essence` / `frozen_pizza_essence` —— 关掉会让它们
 *     的「每转自减」逻辑失效，从而永久占用栏位
 *   · 细则 31 生效时全部道具都不可禁用（`:143-145`）
 */
export function canToggleItem(state: GameState, id: string): boolean {
  if (state.finePrints.some((fp) => fp.num === 31)) return false;
  const blocked = new Set(['popsicle', 'popsicle_essence', 'frozen_pizza_essence']);
  return !blocked.has(id);
}

/** 切换某道具的启用状态；返回是否成功 */
export function toggleItemEnabled(
  state: GameState,
  id: string,
): { ok: boolean; message: string } {
  if (!canToggleItem(state, id)) {
    return { ok: false, message: `${symbolName(id)} 不能被禁用` };
  }
  const held = state.items.find((it) => it.def.id === id);
  if (!held) return { ok: false, message: '没有这件道具' };
  held.disabled = !held.disabled;
  state.log.unshift({
    turn: state.totalSpins,
    kind: 'info',
    text: `${held.disabled ? '禁用' : '启用'}道具：${symbolName(id)}`,
  });
  trimLog(state);
  return { ok: true, message: held.disabled ? `已禁用 ${symbolName(id)}` : `已启用 ${symbolName(id)}` };
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
  /**
   * 待兑现的发卡队列。原版付租后连发两个独立事件
   * （Pop-up__Pop-up.gd:2684 的 `add_tile` + :2707 的 `add_item`），
   * 玩家先选符号、再选道具，共两次三选一。
   * 复现台同一时刻只渲染一个商店面板，所以用队列串起来。
   */
  shopQueue: Array<ShopStage>;
  /** 当前面板属于哪个阶段（队列被 shift 之后由 openNextQueuedShop 写入） */
  shopStage: ShopStage | null;
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
  /**
   * 本转用「油壶」重摇过的那一列（原版 Pop-up.respun_reel，-1 表示没用过）。
   * 该列的符号吃到 `oil_can` 的「本轮倍率 ×values[0]」
   * （effects.csv 里 oil_can 的 `when:reel_respun` 声明就是读它）。
   */
  respunReel: number;
  /** 本转是否已经用掉油壶（sme_this_spin 去重） */
  oilCanUsed: boolean;
  /**
   * 被摧毁道具的冷却（`Items.recently_destroyed_items`，Item__Item.gd:665）。
   *
   * 道具被销毁时以 `payments: 3` 入列，每付一次租减 1，归零后移出
   * （Pop-up__Pop-up.gd:2932-2937）。期间该道具**不会出现在商店候选里**
   * （`:1157` 的 `card_pool[i.rarity].erase(i.type)` 循环）。
   *
   * 这条机制的作用：摧毁一件道具往往是为了「腾位 / 换流派」，
   * 冷却能防止「销毁后立刻在下一家店买回来」的无效操作。
   */
  recentlyDestroyedItems: Array<{ type: string; rarity: string; payments: number }>;
  /**
   * 洗牌时是否剔除多余空格以维持「池 ≤ 25」（`Main__Reels.gd:379-394` 的 `nice_empties`）。
   *
   * 一旦销毁过 `devils_deal`，原版把 `nice_empties` 永久置 false ——
   * 池子从此不受 25 上限约束，会随空格一路膨胀。
   * 这是「魔鬼交易」真正付出的代价，不是一次性的填格子。
   */
  niceEmpties: boolean;
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

/**
 * 开局每列的基础符号（Reel__Reel.gd:278-298 `load_base_icons()`）。
 *
 * 原版按楼层分档，不只是「有没有 dud」——列长度也会变：
 *
 * | 列 | 1–4 层 | 5–6 层 | 7–11 层 | 12+ 层 |
 * |---|---|---|---|---|
 * | 0 | `coin` | 同 | 同 | 同 |
 * | 1 | `cherry` | 同 | `dud` + `cherry` | 同 7–11 |
 * | 2 | `pearl` | `pearl` + `dud` | `pearl`（无 dud） | `pearl` + `dud` |
 * | 3 | `flower` | 同 | `dud` + `flower` | 同 7–11 |
 * | 4 | `cat` | 同 | 同 | 同 |
 *
 * 注意第 2 列的 dud 是**第 5 层起**加的，第 7 层又去掉，第 12 层再加回来 ——
 * 原版这段是一个 `(floor>=5 and floor<7) or floor>=12` 的复合条件，
 * 不是单调递增，容易照着「越往上越多」猜错。
 */
function baseIconsFor(floor: number): Array<Array<string | null>> {
  const col0: Array<string | null> = [null, 'coin'];
  const early = floor < 7;
  const col1: Array<string | null> = early ? [null, null, 'cherry'] : ['dud', null, 'cherry'];
  const col2HasDud = (floor >= 5 && floor < 7) || floor >= 12;
  const col2: Array<string | null> = col2HasDud
    ? [null, 'pearl', null, 'dud']
    : [null, 'pearl'];
  const col3: Array<string | null> = early ? [null, null, 'flower'] : ['dud', null, 'flower'];
  const col4: Array<string | null> = [null, 'cat'];
  return [col0, col1, col2, col3, col4];
}

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

  // 沙盒：直接从第 12 期起，给一大笔金币和三种代币，用来自由试组合
  const sandbox = mode === 'sandbox';
  const startPaid = sandbox ? 11 : 0;
  const startCoins = sandbox ? 999999 : 1;
  const startSpins = 5;
  const chosenFloor = Math.min(MAX_FLOOR, Math.max(1, Math.trunc(floor)));
  const startRent = rentFor(chosenFloor, startPaid + 1);

  // 开局符号按楼层分档（Reel__Reel.gd:278-298）
  const baseIcons = baseIconsFor(chosenFloor);
  baseIcons.forEach((col, x) => {
    col.forEach((id, y) => {
      if (id && reels[x][y]) reels[x][y] = createCell(symbol(id));
    });
  });

  const state: GameState = {
    seed,
    rand,
    cells: visibleCells(reels),
    reels,
    // 池 = 开局落在棋盘上的全部非空符号（含屏幕外槽位，与原版 icons 一致）
    pool: baseIcons.flat().filter((id): id is string => Boolean(id)).map((id) => symbol(id)),
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
    shopQueue: [],
    shopStage: null,
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
    respunReel: -1,
    oilCanUsed: false,
    recentlyDestroyedItems: [],
    niceEmpties: true,
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
  // `nice_empties = false`（销毁过 devils_deal）时**不剔除**多余空格，
  // 池子可以突破 25 上限（Main__Reels.gd:386-394）。
  while (state.niceEmpties && pool.length > SLOTS_PER_REEL * REELS_X && blanks > 0) {
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
      // Main__Reels.gd:332 can_add_highlander()：场上已有 highlander 时不再补第二个
      if (id === 'highlander' && !canAddHighlander(state)) return false;
      return Boolean(SYMBOL_BY_ID.get(id)?.rarity);
    });
    if (pool.length === 0) return null;
    return symbol(pool[Math.floor(state.rand() * pool.length)]);
  }
  if (spec.type) {
    // 精确生成也要守住 highlander 唯一性（Slot_Icon__Slot_Icon.gd:1783）
    if (spec.type === 'highlander' && !canAddHighlander(state)) return null;
    return SYMBOL_BY_ID.has(spec.type) ? symbol(spec.type) : null;
  }
  if (!spec.group) return null;
  const minIdx = spec.minRarity ? RARITY_ORDER.indexOf(spec.minRarity as Rarity) : 0;
  const group = spec.group;
  const pool = DRAWABLE_SYMBOLS.filter(
    (s) =>
      s.groups.includes(group) &&
      RARITY_ORDER.indexOf(s.rarity as Rarity) >= minIdx &&
      // highlander 只能有一个：场上已有时把它从分组抽取池里剔掉
      !(s.id === 'highlander' && !canAddHighlander(state)),
  );
  if (pool.length === 0) return null;
  return pool[Math.floor(state.rand() * pool.length)];
}

/**
 * 道具造成的**全局稀有度迁移**（Item__Item.gd:1502-1535 的 `match type` 分支）。
 *
 * 三条规则都写在 `Item.set_type` / `update` 里，不是 `add_effect` 声明，
 * 所以不会出现在 `item_effects.csv` 中：
 *
 * | 持有道具 | 被改写的符号 | 原稀有度 → 新稀有度 |
 * |---|---|---|
 * | `rain_cloud` | `rain` | uncommon → common |
 * | `dark_humor` | `comedian` | rare → uncommon |
 * | `void_party` | `void_creature` / `void_stone` / `void_fruit` | common → uncommon |
 *
 * 原版直接改 `tile_database[x].rarity` 与 `rarity_database`，等价于「持有期间
 * 该符号归入新的稀有度桶」。复现台用一张覆盖表代替，抽取时查表。
 */
const RARITY_MIGRATIONS: Record<string, Array<{ ids: string[]; to: Rarity }>> = {
  rain_cloud: [{ ids: ['rain'], to: 'common' }],
  dark_humor: [{ ids: ['comedian'], to: 'uncommon' }],
  void_party: [{ ids: ['void_creature', 'void_stone', 'void_fruit'], to: 'uncommon' }],
};

/** 当前生效的符号 → 稀有度覆盖（道具持有即生效；同符号多条规则以先命中者为准） */
export function rarityOverrideOf(state: GameState): Map<string, Rarity> {
  const out = new Map<string, Rarity>();
  for (const held of state.items) {
    if (held.count <= 0) continue;
    const rules = RARITY_MIGRATIONS[held.def.id];
    if (!rules) continue;
    for (const rule of rules) {
      for (const id of rule.ids) if (!out.has(id)) out.set(id, rule.to);
    }
  }
  return out;
}

/** 把稀有度覆盖应用到某个桶：锚定符号被迁走，同时把它们加进目标桶 */
function applyRarityOverride(
  state: GameState,
  bucket: string[],
  rarity: Rarity,
): string[] {
  const override = rarityOverrideOf(state);
  if (override.size === 0) return bucket;
  // 1) 移出「原本属于本桶但被迁走」的
  const stay = bucket.filter((id) => (override.get(id) ?? rarity) === rarity);
  // 2) 加入「原本不在本桶但被迁入」的（只补当前池里真实存在的可抽符号）
  for (const [id, to] of override) {
    if (to !== rarity) continue;
    if (stay.includes(id)) continue;
    const def = SYMBOL_BY_ID.get(id);
    if (!def || !def.rarity) continue;
    stay.push(id);
  }
  return stay.length ? stay : bucket;
}

/**
 * `highlander` 是否还能再放一个（Main__Reels.gd:332-337 `can_add_highlander()`）。
 *
 * 原版按**全部槽位**（含屏幕外 icon）判断，遍历 `reels[x].icons`。
 * 这里用整条 `reels`，与 `placeSymbol` 能触及的范围一致。
 */
export function canAddHighlander(state: GameState): boolean {
  return !state.pool.some((def) => def.id === 'highlander');
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
    text: `难度注入：第 ${state.floor} 层，每 ${every} 次旋转生成 1 个哑弹`,
  });
}

/**
 * 符号可产出代币（reroll_value / removal_value / essence_value），旋转结算后统一入账。
 *
 * 原版的 `get_value("reroll_token")` 走的是**另一套槽位组**
 * （`reroll_token_value` / `_value_bonus_arr` / `_value_multiplier_arr` /
 * `_permanent_bonus` / `_permanent_multiplier`，Slot_Icon__Slot_Icon.gd:27-41），
 * 与金币完全独立。这里把乘数一并结算，否则 `currency` 声明写进去的倍率会被忽略。
 */
function collectExtraTokens(state: GameState): void {
  let reroll = 0;
  let removal = 0;
  let essence = 0;
  for (const cell of state.cells) {
    if (!cell.def) continue;
    // drained 的代币产出同样归零（get_value 的 `if drained: return 0`）
    if (cell.drained) continue;
    reroll += Math.max(0, Math.round((cell.rerollValue ?? 0) * (cell.rerollMultiplier ?? 1)));
    removal += Math.max(0, Math.round((cell.removalValue ?? 0) * (cell.removalMultiplier ?? 1)));
    essence += Math.max(0, Math.round((cell.essenceValue ?? 0) * (cell.essenceMultiplier ?? 1)));
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
  // 每次旋转固定消耗 1 金币，身上没钱就起不了转（Main__Reels.gd:184）。
  // 这时原版走 `out_of_money` 终局（Main__Reels.gd:1966-1973），而不是干等着：
  // 旋转次数还在、钱却不够，是必死状态，必须立刻判负，否则状态机会卡死。
  if (state.coins <= 0) {
    endRunOutOfMoney(state);
    return 'blocked';
  }

  injectDud(state);
  shuffleTiles(state);
  state.cells = visibleCells(state.reels);
  state.swapUsed = false;
  state.swapPending = false;
  // 每转重置油壶状态（Pop-up.sme_this_spin.clear() + respun_reel = -1，Main__Reels.gd:1933-1935）
  state.respunReel = -1;
  state.oilCanUsed = false;
  // 停盘时还没结算：先把数字摆成各自的面板值，否则上一转的产出会留在旧格子上
  state.lastFinals = state.cells.map((cell) => cell.def?.value ?? 0);
  state.lastHits = [];

  // 「显示次数」每转 +1（Main__Reels.gd:898 的 `times_displayed += 1`）。
  // 原版在停盘、挂上 conditional_effects 之后、结算之前做，所以
  // coal / crow / sloth / turtle / wine 这类「第 N 次出现后触发」的符号
  // 在本转就能读到已经 +1 的值。之前这一步整个缺失，这些符号永远停在 0。
  for (const cell of state.cells) {
    if (cell.def) cell.timesDisplayed = (cell.timesDisplayed ?? 0) + 1;
  }

  if (canSwapThisSpin(state)) {
    state.swapPending = true;
    return 'awaiting-swap';
  }
  return 'resolving';
}

/**
 * 万能牌的 `flat_value_bonus` 传播（Slot_Icon__Slot_Icon.gd:976-981 `wc_update`）：
 *
 * ```gdscript
 * if adj_icon.wildcarded and adj_icon.flat_value_bonus < flat_value_bonus:
 *     adj_icon.flat_value_bonus = flat_value_bonus
 *     adj_icon.wc_update("flat_value_bonus")   # 递归
 * ```
 *
 * 语义是「取邻域内最大的固定加值」，只增不减、递归扩散到连通的万能牌群。
 * 用不动点迭代代替递归（20 格规模，最多 20 轮必收敛）。
 *
 * 值得注意的是：这条传播的**发起者不必是万能牌** —— 任何有非零
 * `flat_value_bonus` 的格子都会向相邻的万能牌写入自己的值
 * （`wanted_poster` 的「盗贼被摧毁时 +1」正是靠它传到 wildcard/card_shark 上）。
 */
export function spreadWildcardFlatBonus(cells: Cell[]): void {
  const idxOf = new Map<number, number>();
  cells.forEach((c, i) => idxOf.set(c.uid, i));
  // 预计算邻居下标，避免重复计算
  const neighborIdx = cells.map((_, i) => neighborsOf(i));

  for (let pass = 0; pass < CELL_COUNT; pass += 1) {
    let changed = false;
    for (let i = 0; i < cells.length; i += 1) {
      const source = cells[i];
      if (!source.def) continue;
      const fvb = source.flatValueBonus ?? 0;
      if (fvb <= 0) continue;
      for (const j of neighborIdx[i]) {
        const target = cells[j];
        if (!target?.def || !target.wildcarded) continue;
        if ((target.flatValueBonus ?? 0) < fvb) {
          target.flatValueBonus = fvb;
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
}

/**
 * 金币耗尽终局（Main__Reels.gd:1966-1973 的 `out_of_money`）。
 *
 * 原版把它和 `game_over`（付不起租）分成两个邮件类型，但表现一致：
 * 音乐淡出 → 提示重试/回标题。复现台复用 `gameOverMail`，只是正文不同。
 */
function endRunOutOfMoney(state: GameState): void {
  if (state.over || state.won) return;
  state.over = true;
  state.shopOpen = false;
  state.shop = [];
  state.shopStage = null;
  state.shopQueue = [];
  state.log.unshift({
    turn: state.totalSpins,
    kind: 'rent',
    text: '金币耗尽，无法支付下一次旋转的费用',
  });
  addMail(
    state,
    gameOverMail({
      period: state.rentPaid + 1,
      rent: rentFor(state.floor, state.rentPaid + 1).rent,
      coins: state.coins,
      turn: state.totalSpins,
    }),
  );
}

/**
 * 本转能否用油壶重摇一列（Pop-up__Pop-up.gd:2619-2635 的 `oil_can_prompt`）。
 *
 * 原版条件是「持有 oil_can**或** oil_can_essence」且本转还没用过。
 * 复现台先只实现 `oil_can`（essence 版的差别只是消耗计数与可用次数，
 * 等 `oil_can_essence` 的 saved_value 计数补齐后一并接上）。
 * 与换位装置共用同一个停盘窗口，但两者**互不影响**：都用 `sme_this_spin` 的
 * 不同键去重（`oil_can` vs `swapping_device`），所以同一转可以各用一次。
 */
export function canRespinReel(state: GameState): boolean {
  if (state.over || state.won) return false;
  if (state.oilCanUsed) return false;
  // 与换位一样，只在「已停盘、尚未结算」的窗口里可用
  if (!state.swapPending && state.spinsLeft <= 0) return false;
  const hasOil =
    state.items.some((it) => it.def.id === 'oil_can' && !it.disabled) ||
    state.items.some((it) => it.def.id === 'oil_can_essence' && !it.disabled);
  if (!hasOil) return false;
  return state.cells.filter((c) => c.def).length >= 2;
}

/**
 * 重摇一列（Pop-up__Pop-up.gd:3150-3200）。
 *
 * 原版做法：把该列 `icons` 全部取出塞回池（保留 empty 的空位语义），
 * 再走一次该列的洗牌回填。效果是「这一列的构成重新随机，其余列不动」。
 * 重摇过的列会记进 `respun_reel`，供 `oil_can` 的倍率声明读取。
 */
export function respinReel(state: GameState, col: number): { ok: boolean; message: string } {
  if (!canRespinReel(state)) return { ok: false, message: '当前无法重摇（没有油壶或本转已用过）' };
  if (!Number.isInteger(col) || col < 0 || col >= REELS_X) {
    return { ok: false, message: '列号无效' };
  }

  const column = state.reels[col];
  // 1) 该列非空符号收进池、空槽留位
  const symbols: Cell[] = [];
  for (const cell of column) if (cell.def) symbols.push(createCell(cell.def));
  const empties = column.length - symbols.length;

  // 2) 洗牌后回填（保持列长度不变，只重排本列）
  const shuffled = shuffle(state.rand, symbols);
  const next: Cell[] = [...shuffled];
  for (let k = 0; k < empties; k += 1) next.push(createCell(null));
  state.reels[col] = next;

  state.respunReel = col;
  state.oilCanUsed = true;
  state.cells = visibleCells(state.reels);
  state.lastFinals = state.cells.map((cell) => cell.def?.value ?? 0);

  // `oil_can_essence` 是**有限次**的（Pop-up__Pop-up.gd:3160-3165）：
  //   saved_value += 1；达到 values[0] 就 temp_destroy()
  // `oil_can` 本体不计数，永久可用。
  const ess = state.items.find((it) => it.def.id === 'oil_can_essence');
  let consumed = false;
  if (ess) {
    ess.savedValue = (ess.savedValue ?? 0) + 1;
    const limit = ess.def.values?.[0] ?? 0;
    if (limit > 0 && ess.savedValue >= limit) {
      consumeByForce(state, 'oil_can_essence');
      consumed = true;
    }
  }

  state.log.unshift({
    turn: state.totalSpins + 1,
    kind: 'spin',
    text: `油壶重摇第 ${col + 1} 列${consumed ? '（精华版已耗尽）' : ''}`,
  });
  return { ok: true, message: `已重摇第 ${col + 1} 列` };
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
  if (!state.swapPending) return { ok: false, message: '当前不处于交换窗口' };
  if (from === to) return { ok: false, message: '两次选择的是同一格' };
  if (!onBoard(from) || !onBoard(to)) return { ok: false, message: '只能在棋盘可见格之间交换' };
  const a = state.cells[from];
  const b = state.cells[to];
  if (!a || !b) return { ok: false, message: '格子已变动，请重试' };
  if (!a.def && !b.def) return { ok: false, message: '两个格子都是空的' };

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

  // 旋转的入场成本（Main__Reels.gd:283 的 `Coins.queued_increase -= 1`）。
  // 原版把它记在 queued_increase 里、由 Coins.update 逐帧扣到 coins，
  // 复现台没有动画帧，直接在结算入口一次性扣掉，语义与「本转开始时 -1」一致。
  state.coins -= 1;

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
  // 万能牌的固定加值向相邻万能牌传播（Slot_Icon__Slot_Icon.gd:976-981 的 wc_update）
  spreadWildcardFlatBonus(state.cells);
  // 本次旋转的「重摇列」标记在结算开始时清零（Main__Reels.gd:1933-1935）
  // 注意要在读取 state.respunReel 之前清 —— 见下面的 effectCtx 构造顺序
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
  /**
   * 场上某符号的个数（Main__Reels.gd:801 `count_symbols()`）。
   *
   * 统计口径：**当前 20 格**（原版 `displayed_icons`）+ `prev_data` 历史身份。
   * 原版对 `eachother` 组的符号有一步去重：同一格里「本体是本符号」时不再计入
   * prev_data 里的同名历史身份（`:817` 的 `first_bools`）—— 否则复制/变形后的
   * 符号会被同一格重复计两次。这里照做。
   *
   * 之前 effectCtx 没提供 count，`counted_symbols` 一律读成 0，
   * cultist / diamond / watermelon / strawberry / ruby / emerald 的「同类计数加成」
   * 整段失效。
   */
  const countCache = new Map<string, number>();
  const countSymbol = (id: string): number => {
    const cached = countCache.get(id);
    if (cached !== undefined) return cached;
    let n = 0;
    for (const cell of state.cells) {
      if (!cell.def) continue;
      if (cell.def.id === id) {
        n += 1;
        // 本体已经是本符号 → 本格不再计 prev_data 里的同名历史身份
        continue;
      }
      for (const p of cell.prev) if (p.symbolId === id) n += 1;
    }
    countCache.set(id, n);
    return n;
  };

  const effectCtx: Parameters<typeof applyEffects>[1] = {
    chanceRoll: state.rand,
    finePrint: state.finePrints,
    rarityBonus: state.rarityBonus,
    // 油壶重摇过的那一列（Pop-up.respun_reel）；-1 表示本转没用过
    respunReel: state.respunReel,
    itemCount: (id: string): number =>
      state.items.reduce((n, it) => n + (it.def.id === id ? it.count : 0), 0),
    // 场上符号计数：counted_symbols 谓词与 diff 都靠它
    count: countSymbol,
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
  // 结算完毕，重摇标记作废（原版在 spin 收尾处清）
  state.respunReel = -1;
  state.oilCanUsed = false;

  state.lastFinals = state.cells.map((cell) => {
    cell.lastOutput = evaluateCell(cell).final;
    return cell.lastOutput;
  });

  // 「给过几次钱」每转按格子累计（Main__Reels.gd:1150-1154：
  // `if coin_value != 0: times_coins_given += 1`）。
  // spirit / bubble / mine / bar_of_soap 的「产出几次后自毁」全靠它。
  state.cells.forEach((cell, i) => {
    if (!cell.def) return;
    if ((state.lastFinals[i] ?? 0) !== 0) cell.timesCoinsGiven = (cell.timesCoinsGiven ?? 0) + 1;
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
      text: state.boss?.active ? '旋转次数已用尽，需支付租金（房东战）' : '旋转次数已用尽，需支付租金',
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
  } else if (state.coins <= 0) {
    // 还有旋转次数，但付不起下一次的入场费 → 出局（Main__Reels.gd:1966-1973 的
    // `out_of_money` 分支）。注意原版这一支与「本转有没有产出」无关，
    // 只看身上还有没有钱。
    endRunOutOfMoney(state);
  } else {
    // 每次 spin 后的三选一。原版条件是 `rent_values[1] > 0` 且「手上还有钱」
    // （Main__Reels.gd:1955-1956），**与本转产出是否为 0 无关** ——
    // 之前写成 output > 0 会让「产出 0 但还有本金」的一转白丢一次奖励。
    // 原版这一支只发 `add_tile`（纯符号），不带道具位。
    state.shopQueue = ['spin-symbol'];
    openNextQueuedShop(state);
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

/**
 * 候选数（`symbols_to_choose_from`，Pop-up__Pop-up.gd:646-661）。
 *
 * 基线 3，之后按顺序加减：
 *   细则 30                     −values[0]
 *   shattered_mirror            −values[2] × 持有数
 *   shattered_mirror_essence    −values[1]
 *   credit_card（saved_value=0 时） +values[1] × 持有数
 *   credit_card_essence         +values[0]
 *
 * 注意 `credit_card` 只在 `saved_value == 0` 时给额外候选
 * （原版 `and Items.items[find("credit_card")].saved_value == 0`），
 * 用了就没了 —— 这是它「先垫后还」的设计。
 */
function shopSize(state: GameState): number {
  const fp30 = state.finePrints.find((fp) => fp.num === 30);
  let n = 3 - (fp30?.values[0] ?? 0);

  const heldQty = (id: string): number =>
    state.items.reduce((sum, it) => sum + (it.def.id === id ? it.count : 0), 0);
  const valsOf = (id: string): number[] => SYMBOL_BY_ID.get(id)?.values ?? [];

  const mirrorQty = heldQty('shattered_mirror');
  if (mirrorQty > 0) n -= (valsOf('shattered_mirror')[2] ?? 0) * mirrorQty;
  const mirrorEssQty = heldQty('shattered_mirror_essence');
  if (mirrorEssQty > 0) n -= (valsOf('shattered_mirror_essence')[1] ?? 0) * mirrorEssQty;

  const cardHolder = state.items.find((it) => it.def.id === 'credit_card');
  if (cardHolder && (cardHolder.savedValue ?? 0) === 0) {
    n += (valsOf('credit_card')[1] ?? 0) * cardHolder.count;
  }
  const cardEssQty = heldQty('credit_card_essence');
  if (cardEssQty > 0) n += (valsOf('credit_card_essence')[0] ?? 0) * cardEssQty;

  return Math.max(0, n);
}

/**
 * 付租后**额外**要发几批符号三选一（`extra_symbol_choices`）。
 *
 * 触发点（Pop-up__Pop-up.gd:2690-2705）：
 *   1. `frozen_pizza`：`saved_value >= values[0]` 时，每层给一次并把 saved_value 归零
 *      （本质是「攒够就兑现一张」，不是额外加成）
 *   2. `frozen_pizza_essence`：每层给一次，不消耗
 *   3. `extra_symbol_choices`：由 `add_effect` / `add_to_cond_effects` 写入，
 *      数据表里没有行使用它 —— 目前只留给未来扩展
 *
 * 返回结构化结果，调用方按顺序把批次推进 `shopQueue`。
 */
export interface ExtraBatches {
  /** 额外符号批次数（frozen_pizza 系列兑现） */
  symbols: number;
  /** 额外道具批次数（bag_of_holding 系列） */
  items: number;
  /** 本次兑现掉的 frozen_pizza 层数（用于清 saved_value） */
  pizzaConsumed: number;
}

export function extraBatchesFor(state: GameState): ExtraBatches {
  let symbols = 0;
  let items = 0;
  let pizzaConsumed = 0;

  const pizza = state.items.find((it) => it.def.id === 'frozen_pizza');
  if (pizza) {
    const need = pizza.def.values?.[0] ?? 0;
    if (need > 0 && (pizza.savedValue ?? 0) >= need) {
      // 每层给一次；原版把 saved_value 直接归零，不是减 need
      symbols += pizza.count;
      pizzaConsumed = pizza.count;
    }
  }
  const pizzaEss = state.items.find((it) => it.def.id === 'frozen_pizza_essence');
  if (pizzaEss) symbols += pizzaEss.count;

  // bag_of_holding：每层多给一次道具三选一（Pop-up__Pop-up.gd:2710-2712）
  const bag = state.items.find((it) => it.def.id === 'bag_of_holding');
  if (bag) items += bag.count;
  const bagEss = state.items.find((it) => it.def.id === 'bag_of_holding_essence');
  if (bagEss) items += bagEss.count;

  return { symbols, items, pizzaConsumed };
}

/* ── 破产救助：devils_deal ────────────────────────────────────────────
 *
 * 原版把它写成两条独立逻辑，缺一不可：
 *
 * 1. **付租时自救**（Pop-up__Pop-up.gd:2833-2843 的 `rent_due` 分支）：
 *    ```gdscript
 *    elif choice == "<icon_devils_deal>":
 *        Items.items[find("devils_deal")].destroy()
 *        rent_paid = true        # ← 直接置为「已付」，不扣金币
 *    ```
 *    它的代价不在金币，而在第 2 条。
 *
 * 2. **销毁时填满空格**（Item__Item.gd:428-438）：
 *    ```gdscript
 *    var current_empties = 0
 *    if not destroyed_item_types.has("devils_deal"):   # 只算一次
 *        for s in reels.symbol_arr: if s.type == "empty": current_empties += 1
 *        for r in reels.reels: for t in r.icon_types_to_be_added: ...
 *    for i in range(values[0] - current_empties):
 *        reels.add_tile("empty")
 *    ```
 *    `values[0] = 66`，远超棋盘容量 —— 实际效果是**把棋盘剩余空位全部填成空格**。
 *    于是玩家的池子被永久稀释：`P = 20/S` 里 S 变大、且新增的全是 0 值，
 *    下一期起产出立刻回落。
 *
 * 这两条合起来才是「魔鬼交易」：用一次免租，换一张被填满的废盘。
 * 只做第 1 条会白送一命，只做第 2 条则毫无触发时机。
 */

/** 场上（含屏幕外槽位）的空格数 */
export function emptySlotCount(state: GameState): number {
  let n = 0;
  for (const col of state.reels) for (const cell of col) if (!cell.def) n += 1;
  return n;
}

/**
 * `devils_deal` 销毁时的真实效果（Item__Item.gd:428-438 + Main__Reels.gd:379-394）。
 *
 * 我最初以为它只是「填满空格」，读完洗牌逻辑才看清真正的代价：
 *
 * ```gdscript
 * # Item__Item.gd:428 —— 销毁时尽量补空格
 * for i in range(values[0] - current_empties):   # values[0] = 66
 *     reels.add_tile("empty")
 *
 * # Main__Reels.gd:379 —— 从此以后洗牌不再剔除多余空格
 * var nice_empties = true
 * if Items.destroyed_items.has("devils_deal") or Items.destroyed_item_types.has("devils_deal"):
 *     nice_empties = false
 * while true:
 *     if pool.size() <= 25 or total_empties == 0 or not nice_empties:
 *         break        # ← nice_empties = false 时永不剔除
 * ```
 *
 * 也就是说：**签一次魔鬼交易，永久失去「池 ≤ 25」这道保护**。
 * 池子会随空格一路膨胀，`P = 20/S` 单调下降，且新增的全是 0 值空格。
 * 「填满空格」只是这一步的即时表现，`nice_empties` 才是长期代价。
 *
 * 在 5×5 = 25 槽的棋盘上，`add_tile("empty")` 循环 66 次会被 `max_icons = 5`
 * 挡住，实际就是把所有能补的槽位补成空格。
 */
function fillEmptiesTo(state: GameState, target: number): number {
  const current = emptySlotCount(state);
  const want = Math.max(0, target - current);
  if (want === 0) return 0;

  let filled = 0;
  for (const col of state.reels) {
    while (col.length < SLOTS_PER_REEL && filled < want) {
      col.push(createCell(null));
      filled += 1;
    }
  }
  // 列已满仍有剩余：不可再扩（max_icons），与原版行为一致
  if (filled > 0) state.cells = visibleCells(state.reels);
  return filled;
}

/** 持有且未被摧毁的某道具 */
function heldItem(state: GameState, id: string): HeldItem | undefined {
  return state.items.find((it) => it.def.id === id && it.count > 0);
}

/**
 * 付不起租时，玩家是否有「销毁道具自救」的选项
 * （Pop-up__Pop-up.gd:2606-2615 `can_try_to_pay_rent()`）。
 *
 * 原版列了 6 个：`piggy_bank` / `swear_jar` / `devils_deal` / `coffee` /
 * `coffee_essence`，加上 MOD 的 `can_be_destroyed_before_rent`。
 * 复现台目前实现 `devils_deal` / `piggy_bank` / `swear_jar` 三个
 * （`coffee` 在本实现里是「买入时 +1 旋转」，不参与付租结算）。
 */
export function rentRescueOptions(state: GameState): string[] {
  const out: string[] = [];
  for (const id of ['devils_deal', 'piggy_bank', 'swear_jar']) {
    // essence 版也视作同类救援
    if (heldItem(state, id) || heldItem(state, `${id}_essence`)) out.push(id);
  }
  return out;
}

/**
 * 只保留「确实能付清本期租金」的自救道具。
 *
 * 原版 `can_try_to_pay_rent()`（Pop-up__Pop-up.gd:2606-2615）也是这么做的：
 * 只要持有就返回 true，但那是因为原版会把这些道具做成**可反复点击**的选项。
 * 复现台是单次交互，所以必须先筛掉「点了也不够」的，避免出现死状态。
 */
function viableRescues(state: GameState, owed: number): string[] {
  const out: string[] = [];
  for (const id of rentRescueOptions(state)) {
    if (id === 'devils_deal') {
      out.push(id); // 免租，必然可行
      continue;
    }
    const held = heldItem(state, id) ?? heldItem(state, `${id}_essence`);
    if (!held) continue;
    const v = held.def.values ?? [];
    const gain = Math.round((held.savedValue ?? 0) * (v[1] ?? 0)) * held.count;
    if (state.coins + gain >= owed) out.push(id);
  }
  return out;
}

/**
 * 用道具自救付清本期租金（`rent_due` 分支的 `<icon_xxx>` 三条路径）。
 *
 * - `devils_deal`：销毁自己 → 免掉本期租金，但棋盘被空格填满
 * - `piggy_bank`：销毁自己 → 按 `saved_value × values[1]` 结算金币（可能不够）
 * - `swear_jar`：销毁自己 → 按 `saved_value × values[1]` 结算金币
 *
 * 返回 `paid` 表示是否真的付清了；未付清则调用方应判负。
 */
export function payRentWithItem(
  state: GameState,
  id: string,
): { ok: boolean; paid: boolean; message: string } {
  if (state.over || state.won) return { ok: false, paid: false, message: '已结束' };
  // 注意：**不能**用 `spinsLeft > 0` 做前置检查。
  //
  // 有一种正常状态是「spinsLeft 仍 > 0 但已经无法继续」：
  // `beginSpin` 在 `coins <= 0` 时返回 blocked 而不消耗 spinsLeft，
  // 于是调用方跳出旋转循环、直接进入付租 —— 此时 spinsLeft 还是 1。
  // 那一刻 `payRentWithItem` 正是唯一出路，用 spinsLeft 挡下会把玩家锁死。
  //
  // 真正的前置条件是「确实付不起本期租金」，由下面的 owed 比较决定。

  // `rentRescueOptions` 返回的是**基名**（`devils_deal`），玩家库存里可能只有
  // `devils_deal_essence`。两个方向都要查，否则「有 essence 版却报没有道具」。
  const baseId = id.endsWith('_essence') ? id.slice(0, -'_essence'.length) : id;
  const held = heldItem(state, id) ?? heldItem(state, baseId) ?? heldItem(state, `${baseId}_essence`);
  if (!held) return { ok: false, paid: false, message: '没有这件道具' };

  const nextPayment = state.rentPaid + 1;
  const inBoss = Boolean(state.boss?.active);
  const owed = inBoss ? bossRent(nextPayment) : rentFor(state.floor, nextPayment).rent;
  const v = held.def.values ?? [];
  const stack = held.count;

  let gained = 0;
  switch (baseId) {
    case 'devils_deal': {
      // 免掉本期租金，代价有两条（Item__Item.gd:428 + Main__Reels.gd:379）：
      //   1. 立刻把棋盘能补的槽位全补成空格
      //   2. **永久**关闭「洗牌时剔除多余空格」的保护 → 池不再受 25 上限约束
      const filled = fillEmptiesTo(state, v[0] ?? 66);
      state.niceEmpties = false;
      consumeByForce(state, held.def.id);
      state.log.unshift({
        turn: state.totalSpins,
        kind: 'rent',
        text: `签订魔鬼交易：销毁魔鬼契约，免去本期租金 ${owed}；棋盘新增 ${filled} 个空格，此后洗牌不再剔除多余空格`,
      });
      // 免租等价于「金币足够」，走正常付租流程但跳过扣款
      return settleRent(state, nextPayment, owed, { skipCharge: true });
    }
    case 'piggy_bank':
      // destroy() 分支：Coin Sum + HP Sum 都加 round(saved_value * values[1])
      gained = Math.round((held.savedValue ?? 0) * (v[1] ?? 0)) * stack;
      break;
    case 'swear_jar':
      // destroy() 分支：Coin Sum + HP Sum 都加 saved_value * values[1]
      gained = Math.round((held.savedValue ?? 0) * (v[1] ?? 0)) * stack;
      break;
    default:
      return { ok: false, paid: false, message: `不支持的道具 ${id}` };
  }

  consumeByForce(state, held.def.id);
  state.coins += gained;
  state.totalEarned += gained;
  // 原版同时打 HP Sum（道具直伤房东）；房东战里这部分算伤害
  if (state.boss?.active && gained > 0) dealBossDamage(state, gained);
  state.log.unshift({
    turn: state.totalSpins,
    kind: 'rent',
    text: `销毁 ${symbolName(held.def.id)}：换取 ${gained} 金币`,
  });

  if (state.coins < owed) {
    state.over = true;
    addMail(
      state,
      gameOverMail({ period: nextPayment, rent: owed, coins: state.coins, turn: state.totalSpins }),
    );
    trimLog(state);
    return { ok: true, paid: false, message: `仍差 ${owed - state.coins} 金币，破产` };
  }
  return settleRent(state, nextPayment, owed, { skipCharge: false });
}

/**
 * 把一件道具记入「近期摧毁」冷却（Item__Item.gd:665）。
 * 同类型只保留一条，重复摧毁时重置计数。
 */
function noteDestroyedItem(state: GameState, id: string): void {
  const def = SYMBOL_BY_ID.get(id);
  if (!def) return;
  const at = state.recentlyDestroyedItems.findIndex((r) => r.type === id);
  if (at >= 0) state.recentlyDestroyedItems[at].payments = 3;
  else state.recentlyDestroyedItems.push({ type: id, rarity: def.rarity, payments: 3 });
}

/** 无条件移除一件道具（不走 item_to_destroy 的「每转限一次」去重） */
function consumeByForce(state: GameState, id: string): void {
  const idx = state.items.findIndex((it) => it.def.id === id && it.count > 0);
  if (idx < 0) return;
  const held = state.items[idx];
  held.count -= 1;
  if (held.count <= 0) {
    state.items.splice(idx, 1);
    // 整件用完（不是叠层减一）才算「被摧毁」
    noteDestroyedItem(state, id);
  }
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
  if (state.coins < owed) {
    // 付不起：若有**确实能付清**的自救道具，`payRent` 不擅自替玩家做决定，
    // 而是返回 ok=false 并保留 `state` 不动 —— UI 据此弹出自救按钮
    // （对应原版 `rent_due` 邮件里的 `<icon_devils_deal>` 等选项）。
    //
    // 关键点：只把「真的付得清」的道具列为可选。
    //   devils_deal            → 免租，必然付得清
    //   piggy_bank / swear_jar → 只有 saved_value × values[1] 够数才算
    // 否则会出现「按钮点了也付不起、payRent 又不判负」的悬空状态。
    const rescues = viableRescues(state, owed);
    if (rescues.length > 0) {
      trimLog(state);
      return {
        ok: false,
        message: `租金 ${owed} 不足（持有 ${state.coins}）；可销毁 ${rescues
          .map((id) => symbolName(id))
          .join(' / ')} 自救`,
      };
    }
    endRunCannotPayRent(state, nextPayment, owed);
    return { ok: false, message: `租金 ${owed} 不足（持有 ${state.coins}）` };
  }

  return settleRent(state, nextPayment, owed, { skipCharge: false });
}

/** 付不起租且无自救手段 → 破产（`game_over`） */
function endRunCannotPayRent(state: GameState, nextPayment: number, owed: number): void {
  state.over = true;
  state.log.unshift({ turn: state.totalSpins, kind: 'rent', text: `付租失败：需 ${owed}，持有 ${state.coins}` });
  addMail(
    state,
    gameOverMail({ period: nextPayment, rent: owed, coins: state.coins, turn: state.totalSpins }),
  );
  trimLog(state);
}

/**
 * 租金结清之后的全部流程：扣款（可跳过）、推进期数、发旋转、发卡、进房东战。
 *
 * `skipCharge` 用于 `devils_deal` —— 原版那条路径把 `rent_paid` 直接置 true，
 * 不经过 `Coin Sum.add_value(-rent)`，所以金币不动。
 */
function settleRent(
  state: GameState,
  nextPayment: number,
  owed: number,
  opts: { skipCharge: boolean },
): { ok: boolean; paid: boolean; message: string } {
  const inBoss = Boolean(state.boss?.active);
  const row = rentFor(state.floor, nextPayment);
  const spinsGain = inBoss ? 10 : row.spinsGain;
  if (!opts.skipCharge) state.coins -= owed;
  state.rentPaid = nextPayment;
  state.spinsLeft += spinsGain;
  state.roundEarned = 0;
  // 楼层是开局选定的，付租不再改它（Pop-up.current_floor 一局内不变）
  state.payment = nextPayment;

  // 精华代币在付租时**兑现成商店**，不是作废
  // （Pop-up__Pop-up.gd:2876 `queued_essence_emails = essence_tokens`，
  //  随后 :2661 每枚开一次「三张精华任选」）。
  // 重掷 / 移除代币则继续保留。
  const essenceToSpend = state.essenceTokens;
  state.essenceTokens = 0;

  // 宝藏图兑现：saved_value 攒够就给钥匙 + 宝箱（Item__Item.gd:486-492）。
  // 放在冷却递减之前，语义上属于「本期结束时的结算」。
  {
    const dug = consumeTreasureMap(state);
    if (dug.dug) {
      state.log.unshift({
        turn: state.totalSpins,
        kind: 'info',
        text: '宝藏图兑现：获得钥匙与宝箱',
      });
    }
  }

  // 近期摧毁道具的冷却递减（Pop-up__Pop-up.gd:2932-2937）：
  // 每付一期租减 1，归零后从黑名单移除，重新可被抽到。
  if (state.recentlyDestroyedItems.length > 0) {
    const expired: string[] = [];
    for (const r of state.recentlyDestroyedItems) {
      r.payments -= 1;
      if (r.payments <= 0) expired.push(r.type);
    }
    if (expired.length > 0) {
      state.recentlyDestroyedItems = state.recentlyDestroyedItems.filter(
        (r) => !expired.includes(r.type),
      );
    }
  }

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
    // 付租奖励的顺序（Pop-up__Pop-up.gd:2684-2715）：
    //   1. 符号三选一（强制稀有度配比）
    //   2. frozen_pizza / frozen_pizza_essence 各兑现 N 次额外符号批
    //   3. extra_symbol_choices 额外符号批
    //   4. 道具三选一（概率）
    //   5. bag_of_holding / extra_item_choices 追加道具批
    //   6. 每枚精华代币一次精华三选一（:2661）
    const extra = extraBatchesFor(state);
    if (extra.pizzaConsumed > 0) {
      const pizza = state.items.find((it) => it.def.id === 'frozen_pizza');
      if (pizza) pizza.savedValue = 0;
      state.log.unshift({
        turn: state.totalSpins,
        kind: 'rent',
        text: `冷冻披萨兑现：追加 ${extra.pizzaConsumed} 次符号三选一`,
      });
    }

    state.shopQueue = ['rent-symbol'];
    for (let i = 0; i < extra.symbols; i += 1) state.shopQueue.push('rent-symbol');
    state.shopQueue.push('rent-item');
    for (let i = 0; i < extra.items; i += 1) state.shopQueue.push('rent-item');
    for (let i = 0; i < essenceToSpend; i += 1) state.shopQueue.push('rent-essence');
    openNextQueuedShop(state);
  }
  trimLog(state);

  return {
    ok: true,
    paid: true,
    message: opts.skipCharge
      ? `魔鬼交易：第 ${nextPayment} 期租金 ${owed} 已免除`
      : `已付第 ${nextPayment} 期租金 ${owed}`,
  };
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
    text: `房东之战开始：房东生命值 ${maxHp}，每转产出的金币同时计入对房东的伤害`,
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
  const payment = state.shopStage === 'spin-symbol' ? state.rentPaid + 1 : state.payment;
  const count = shopSize(state);
  // 重掷换一批候选，但**阶段不变**：符号位重掷出符号，道具位重掷出道具。
  // 原版 reroll 只重抽当前这个事件（Pop-up__Pop-up.gd:2769-2778 把同一份
  // extra_values 推回 queued_symbols），不会跳到同一期的另一个事件。
  state.shop =
    state.shopStage === 'spin-symbol'
      ? drawShopByChance(state, payment, count)
      : state.shopStage === 'rent-symbol'
        ? drawRentSymbols(state, payment, count)
        : drawRentItems(state, payment, count);
  state.log.unshift({
    turn: state.totalSpins,
    kind: 'buy',
    text: `重掷商店：消耗 ${state.rerollCost} 枚重掷代币（剩余 ${state.rerollTokens} 枚）`,
  });
  trimLog(state);
  return { ok: true, message: '商店已重掷' };
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
  if (!cell?.def) return { ok: false, message: '该格没有符号' };
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

  // 被移除的符号自己产出的代币（jellyfish → removal_token、pufferfish → reroll_token）
  // 走的也是 `currency` 槽位。**必须在清格之前入账**：那几个值就写在
  // `state.cells[cellIndex]` 上，一旦 `visibleCells()` 重建、该格变成空，
  // 这些产出就丢了。
  {
    const produced = {
      reroll: Math.max(0, Math.round((cell.rerollValue ?? 0) * (cell.rerollMultiplier ?? 1))),
      removal: Math.max(0, Math.round((cell.removalValue ?? 0) * (cell.removalMultiplier ?? 1))),
      essence: Math.max(0, Math.round((cell.essenceValue ?? 0) * (cell.essenceMultiplier ?? 1))),
    };
    state.rerollTokens += produced.reroll;
    state.removalTokens += produced.removal;
    state.essenceTokens += produced.essence;
    if (produced.reroll || produced.removal || produced.essence) {
      const parts: string[] = [];
      if (produced.reroll) parts.push(`${TOKEN_ICON.reroll}×${produced.reroll}`);
      if (produced.removal) parts.push(`${TOKEN_ICON.removal}×${produced.removal}`);
      if (produced.essence) parts.push(`${TOKEN_ICON.essence}×${produced.essence}`);
      state.log.unshift({
        turn: state.totalSpins,
        kind: 'spin',
        text: `${symbolName(id)} 被移除时产出代币 ${parts.join(' ')}`,
      });
    }
  }

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
    text: `移除符号 ${symbolName(id)}：消耗 ${state.removalCost} 枚移除代币（剩余 ${state.removalTokens} 枚）${
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
  if (!SYMBOL_BY_ID.has(essenceId)) return { ok: false, message: '该道具没有精华版' };

  held.def = symbol(essenceId);
  state.essenceTokens -= 1;
  state.log.unshift({
    turn: state.totalSpins,
    kind: 'buy',
    text: `精华化：${symbolName(itemId)} → ${symbolName(essenceId)}（剩余 ${state.essenceTokens} 枚精华代币）`,
  });
  trimLog(state);
  return { ok: true, message: `已升级为 ${symbolName(essenceId)}` };
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
 * 代币卡：原版没有这类卡牌。
 *
 * `reroll_token` / `removal_token` / `essence_token` 在三张原始 JSON
 * （Symbols / Items / Essences）里都不存在，`Main__Main.gd:2373-2375` 只把
 * 它们当作图标资源加载。原版的三种代币只有两个来源：
 *   1. 符号产出（`*_capsule`、`jellyfish`、`pufferfish` 的 `currency` 声明）
 *   2. 同伴援助（`comrade_values`，第 3 期起每两个奇数期一次）
 *
 * 复现台早期为了让玩家能试到重掷/移除/精华，混入了 10% 概率的「代币卡」。
 * 这是**自造机制**，会让代币总量高出原版一个数量级，也让 `check_spend_triggers`
 * 所依赖的「代币稀缺」这层决策消失。
 *
 * 默认关闭；需要观察代币交互时用 `?tokens=1` 打开。
 */
const TOKEN_CARD_CHANCE = 0;

/**
 * 稀有度桶。两处修正：
 *   1. highlander 在「已有一个」时从 very_rare 里剔掉（Pop-up__Pop-up.gd:1142）
 *   2. 道具造成的稀有度迁移（rain_cloud / dark_humor / void_party）在这里生效
 */
function bucketOf(state: GameState, kind: 'item' | 'symbol', rarity: Rarity): string[] {
  const pool = kind === 'item' ? ITEM_POOL : SYMBOL_POOL;
  let bucket = pool[rarity].length ? pool[rarity] : pool.common;
  if (kind === 'symbol') {
    bucket = applyRarityOverride(state, bucket, rarity);
    if (rarity === 'very_rare' && !canAddHighlander(state)) {
      const filtered = bucket.filter((id) => id !== 'highlander');
      if (filtered.length) bucket = filtered;
    }
  }
  return bucket;
}

/** 按稀有度档位抽一张符号卡（不含道具、不含代币） */
function drawSymbolCard(state: GameState, payment: number): ShopCard {
  if (TOKEN_CARD_CHANCE > 0 && state.rand() < TOKEN_CARD_CHANCE) {
    const kinds: TokenKind[] = ['reroll', 'removal', 'essence'];
    const token = kinds[Math.floor(state.rand() * kinds.length)];
    return { def: tokenDef(token), rarity: 'uncommon', token };
  }
  return drawCardOf(state, 'symbol', payment);
}

/** 按稀有度档位抽一张道具卡 */
function drawItemCard(state: GameState, payment: number): ShopCard {
  return drawCardOf(state, 'item', payment);
}

/** 按稀有度概率表抽一张（符号或道具），池子已剔除未实现项与近期摧毁项 */
function drawCardOf(state: GameState, kind: 'item' | 'symbol', payment: number): ShopCard {
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
  let bucket = bucketOf(state, kind, rarity);
  if (kind === 'item' && state.recentlyDestroyedItems.length > 0) {
    // 近期摧毁的道具不进候选（Pop-up__Pop-up.gd:1157）
    const cooling = new Set(state.recentlyDestroyedItems.map((r) => r.type));
    const filtered = bucket.filter((id) => !cooling.has(id));
    if (filtered.length > 0) bucket = filtered;
  }
  const id = bucket[Math.floor(state.rand() * bucket.length)];
  return { def: symbol(id), rarity };
}

/** 按「指定稀有度列表」抽符号卡（付租奖励的强制配比走这里） */
function drawSymbolOfRarity(state: GameState, rarity: Rarity): ShopCard {
  const bucket = bucketOf(state, 'symbol', rarity);
  const id = bucket[Math.floor(state.rand() * bucket.length)];
  return { def: symbol(id), rarity };
}

/** 每转之后的纯符号三选一（Main__Reels.gd:1955-1968） */
export function drawShopByChance(state: GameState, payment: number, count: number): ShopCard[] {
  const cards: ShopCard[] = [];
  for (let i = 0; i < count; i += 1) cards.push(drawSymbolCard(state, payment));
  return cards;
}

/**
 * 付租后的符号三选一：稀有度是**写死的配比**，不走概率表
 * （Pop-up__Pop-up.gd:2688 的 `rent_rarity_arr`）。
 */
export function drawRentSymbols(state: GameState, paid: number, count: number): ShopCard[] {
  const slots = shopRaritySlots(paid);
  const cards: ShopCard[] = [];
  for (let i = 0; i < count; i += 1) {
    cards.push(drawSymbolOfRarity(state, slots[i] ?? slots[slots.length - 1]));
  }
  return cards;
}

/** 付租后的道具三选一：走道具概率表（Pop-up__Pop-up.gd:2707 的 `add_item`） */
export function drawRentItems(state: GameState, paid: number, count: number): ShopCard[] {
  const cards: ShopCard[] = [];
  for (let i = 0; i < count; i += 1) cards.push(drawItemCard(state, paid));
  return cards;
}

/**
 * 精华三选一（Pop-up__Pop-up.gd:2661 的 `add_event("add_item", {"forced_rarity":
 * ["essence","essence","essence"]})`）。
 *
 * 原版每枚精华代币在**付租时**换一次「三张精华任选」，精华作为**独立道具**
 * 进入道具栏。复现台早期把它改成「用代币原地升级已有道具」
 * （`essenceUpgrade`），绕过了这道商店，也改变了精华的来源语义。
 * 现在恢复成商店，`essenceUpgrade` 保留为兼容入口。
 */
export function drawEssenceChoices(state: GameState, count: number): ShopCard[] {
  const pool = ESSENCES.filter((e) => e.rarity !== '' || e.groups.includes('essence'));
  const cards: ShopCard[] = [];
  for (let i = 0; i < count; i += 1) {
    const def = pool[Math.floor(state.rand() * pool.length)] ?? ESSENCES[0];
    cards.push({ def: def as unknown as SymbolDef, rarity: 'rare' });
  }
  return cards;
}

/** @deprecated 保留旧名以免外部脚本断裂；语义等同 drawRentSymbols */
export function drawShop(state: GameState, paid: number, count: number): ShopCard[] {
  return drawRentSymbols(state, paid, count);
}

/**
 * 从队列里取出下一个奖励并开店。队列空则关店。
 * 调用方：buyFromShop / closeShop（跳过）。
 */
function openNextQueuedShop(state: GameState): boolean {
  const next = state.shopQueue.shift() ?? null;
  if (!next) {
    state.shopOpen = false;
    state.shop = [];
    state.shopStage = null;
    return false;
  }
  const count = shopSize(state);
  if (next === 'spin-symbol') {
    state.shop = drawShopByChance(state, state.rentPaid + 1, count);
    state.shopSource = 'spin';
  } else if (next === 'rent-symbol') {
    state.shop = drawRentSymbols(state, state.payment, count);
    state.shopSource = 'rent';
  } else if (next === 'rent-essence') {
    state.shop = drawEssenceChoices(state, count);
    state.shopSource = 'rent';
  } else {
    state.shop = drawRentItems(state, state.payment, count);
    state.shopSource = 'rent';
  }
  state.shopStage = next;
  state.shopOpen = true;
  return true;
}

/** 当前面板属于哪个阶段；未开店时为 null */
export function currentShopStage(state: GameState): ShopStage | null {
  return state.shopOpen ? state.shopStage : null;
}

/**
 * 一次性道具：买下的瞬间生效，不属于「持有期间」的声明，所以不写进 item_effects.csv。
 * 逐条对应 Item__Item.gd:426-520 的 match type 分支，数量取自 items.csv 的 values。
 * 未覆盖：devils_deal（补空位，values=66 远超棋盘容量）、dark_humor（改喜剧演员稀有度）、
 * treasure_map（攒满才生成钥匙，走的是摧毁分支而不是购买分支）。
 */
/**
 * `treasure_map` / `treasure_map_essence` 的兑现（Item__Item.gd:486-492）。
 *
 * ```gdscript
 * "treasure_map":
 *     if saved_value >= values[0]:
 *         reels.add_tile("key"); reels.add_tile("treasure_chest")
 *     else:
 *         can_be_destroyed = false        # ← 未攒满时**不可摧毁**
 * "treasure_map_essence":
 *     reels.add_tile("key"); reels.add_tile("mega_chest")   # 无条件
 * ```
 *
 * `saved_value` 由 `item_effects.csv` 里那条 `saved_value +1` 每转累积。
 * 返回是否兑现，调用方负责真正往棋盘放符号。
 */
export function consumeTreasureMap(state: GameState): { dug: boolean; key: boolean } {
  const map = state.items.find((it) => it.def.id === 'treasure_map');
  if (map) {
    const need = map.def.values?.[0] ?? 0;
    if (need > 0 && (map.savedValue ?? 0) >= need) {
      putSymbolOnBoard(state, 'key');
      putSymbolOnBoard(state, 'treasure_chest');
      consumeByForce(state, 'treasure_map');
      return { dug: true, key: true };
    }
    return { dug: false, key: false };
  }
  const ess = state.items.find((it) => it.def.id === 'treasure_map_essence');
  if (ess) {
    putSymbolOnBoard(state, 'key');
    putSymbolOnBoard(state, 'mega_chest');
    consumeByForce(state, 'treasure_map_essence');
    return { dug: true, key: true };
  }
  return { dug: false, key: false };
}

/** 往棋盘空格放一个符号（找不到定义或没有空位时静默跳过） */
function putSymbolOnBoard(state: GameState, id: string): boolean {
  const def = SYMBOL_BY_ID.get(id);
  if (!def) return false;
  if (!placeSymbol(state, def)) return false;
  state.pool.push(def);
  state.cells = visibleCells(state.reels);
  return true;
}

/**
 * `treasure_map` 未攒满时不可被摧毁 / 移除（`can_be_destroyed = false`）。
 * 由 UI 与 `removeSymbolAt` 共同使用。
 */
export function isItemDestroyable(state: GameState, id: string): boolean {
  if (id !== 'treasure_map') return true;
  const map = state.items.find((it) => it.def.id === 'treasure_map');
  if (!map) return true;
  const need = map.def.values?.[0] ?? 0;
  return need > 0 && (map.savedValue ?? 0) >= need;
}

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
    const pool = DRAWABLE_SYMBOLS.filter(
      (s) => s.rarity === rarity && !(s.id === 'highlander' && !canAddHighlander(state)),
    );
    return pool.length === 0 ? null : pool[Math.floor(state.rand() * pool.length)];
  };
  const pickGroup = (group: string): SymbolDef | null => {
    const pool = DRAWABLE_SYMBOLS.filter(
      (s) => s.groups.includes(group) && !(s.id === 'highlander' && !canAddHighlander(state)),
    );
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
      // 源码 add_tile 不带条件：按当前稀有度表随机，逐个抽。
      // highlander 仍受唯一性约束（Slot_Icon__Slot_Icon.gd:1783）。
      for (let i = 0; i < (v[0] ?? 0); i += 1) {
        const pool = DRAWABLE_SYMBOLS.filter(
          (s) => !(s.id === 'highlander' && !canAddHighlander(state)),
        );
        const s = pool[Math.floor(state.rand() * pool.length)];
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
  state.shopStage = null;
  // 队列里还有下一次奖励（付租后的道具三选一）→ 直接接着开
  if (openNextQueuedShop(state)) return;
  // 所有奖励兑现完毕：若身上恰好 0 金币，房东垫付 1 枚
  // （Pop-up__Pop-up.gd:2825-2832 的 `coin_node.coins + queued + coin_sum == 0` 分支）。
  // 这是原版的死锁保护：付完租、在商店白拿一张之后，玩家必须还能再转一次，
  // 否则游戏会在「有旋转次数但没钱起转」的状态下卡住。
  if (!state.over && !state.won && state.coins <= 0) {
    state.coins = 1;
    state.log.unshift({
      turn: state.totalSpins,
      kind: 'info',
      text: '金币归零：房东垫付 1 枚，可再旋转一次',
    });
  }
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
