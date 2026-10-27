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
import { ITEM_POOL, SYMBOL_POOL, rarityRowFor, rentRowFor, symbol } from './data';
import { CELL_COUNT, COLS as REELS_X, ROWS as REELS_Y, SLOTS_PER_REEL } from './grid';
import { applyEffects, applyItemEffects } from './effects';
import { symbolName } from './names';
import { mulberry32, shuffle, type Random } from './rng';
import type { SynergyHit } from './synergy';
import { boardTotal, evaluateCell } from './value';
import type { Cell, Rarity, SymbolDef } from './types';

export { CELL_COUNT, REELS_X, REELS_Y, SLOTS_PER_REEL };

export interface ShopCard {
  def: SymbolDef;
  rarity: Rarity;
}

/** 道具栏里的一项；同类道具可叠加，count 即 Item__Item.gd 的 item_count */
export interface HeldItem {
  def: SymbolDef;
  count: number;
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
  /** 最近一次旋转的协同明细，供界面展示 */
  lastHits: SynergyHit[];
  /** 最近一次旋转每个格子的最终产出 */
  lastFinals: number[];
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

export function createGame(seed = 20261027): GameState {
  const rand = mulberry32(seed);
  const reels = emptyReels();
  BASE_ICONS.forEach((id, x) => {
    if (id) reels[x][1] = createCell(symbol(id));
  });

  const state: GameState = {
    seed,
    rand,
    cells: visibleCells(reels),
    reels,
    pool: BASE_ICONS.filter((id): id is string => Boolean(id)).map((id) => symbol(id)),
    items: [],
    coins: 1,
    // 首期 5 次旋转（Main__Main.gd:1286 rent_values = [25, 5]）
    spinsLeft: 5,
    payment: 0,
    floor: 1,
    rentPaid: 0,
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
        text: `新开局：5 个基础符号，1 金币，5 次旋转，首期租金 ${rentRowFor(1).rent}`,
      },
    ],
    over: false,
    won: false,
    lastHits: [],
    lastFinals: new Array(CELL_COUNT).fill(0),
  };
  return state;
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

/** 把新符号放进随机空槽；无空槽时扩到某列末尾（add_tile 的语义） */
function placeSymbol(state: GameState, def: SymbolDef): boolean {
  const empties: Array<[number, number]> = [];
  state.reels.forEach((col, x) =>
    col.forEach((cell, y) => {
      if (!cell.def) empties.push([x, y]);
    }),
  );
  if (empties.length > 0) {
    const [x, y] = empties[Math.floor(state.rand() * empties.length)];
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
 * 旋转：洗牌 → 结算 → 产出 → 符号奖励
 *
 * 符号奖励在**每次 spin 后**发放（Main__Reels.gd:1954-1968）：
 * 只要本期还有剩余旋转（rent_values[1] > 0）且本次确有产出，就开一次三选一。
 * 这就是第 1 期能拿 5→6→7→8→9 的原因，也是租金曲线能兑现的前提。
 */
export function spin(state: GameState): void {
  if (state.over || state.spinsLeft <= 0) return;
  if (state.shopOpen) return;

  shuffleTiles(state);
  state.cells = visibleCells(state.reels);

  // 临时加成清零 → 道具全局效果 → 符号声明效果 → 结算（§4.5 / §5）
  // 道具先于符号：Items__Items.add_cond_effects() 把 effect 挂到目标符号，
  // 目标符号自身的 add_effect 随后在同一轮里叠加（Pop-up__Pop-up.gd:1180-1210）。
  for (const cell of state.cells) {
    cell.valueBonus = 0;
    cell.valueMultiplier = 1;
    cell.tbd = false;
    cell.destroyed = false;
    cell.appliedRules = new Set();
  }
  applyItemEffects(state.items, state.cells);

  // 销毁是「先挂 tbd、转完再落地」的两段式（Slot_Icon__Slot_Icon.gd:2394-2405）：
  // 落地后再跑一轮声明，被摧毁符号的「{destroyed:true} → value_bonus」才会结算。
  // 同一转最多迭代 6 轮，防止互相触发的声明来回打架（源码用 current_effect_hashes 收敛）。
  const destroyedIds: string[] = [];
  for (let pass = 0; pass < 6; pass += 1) {
    applyEffects(state.cells);
    const pending = state.cells.filter((c) => c.tbd && !c.destroyed);
    if (pending.length === 0) break;
    for (const c of pending) {
      c.destroyed = true;
      c.tbd = false;
      if (c.def) destroyedIds.push(c.def.id);
    }
  }

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

  if (destroyedIds.length > 0) removeDestroyed(state);

  state.log.unshift({
    turn: state.totalSpins,
    kind: 'spin',
    text: `#${state.totalSpins} 旋转产出 ${output}（池 ${
      state.reels.reduce((n, col) => n + col.filter((c) => c.def).length, 0)
    } 个符号）`,
  });

  if (state.spinsLeft === 0) {
    state.log.unshift({ turn: state.totalSpins, kind: 'info', text: '旋转次数用尽，需付租' });
  } else if (output > 0) {
    // 每次 spin 后的三选一；本期最后一次不给（源码 rent_values[1] > 0 才起卡）
    state.shop = drawShopByChance(state, state.rentPaid + 1, 3);
    state.shopSource = 'spin';
    state.shopOpen = true;
  }
  trimLog(state);
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
      col[s] = createCell(null);
    }
  }
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

/** 付租：扣款 → 累加旋转 → 开商店（§7.1 / §7.2，Pop-up__Pop-up.gd:2882-2890） */
export function payRent(state: GameState): { ok: boolean; message: string } {
  if (state.over) return { ok: false, message: '已结束' };
  if (state.spinsLeft > 0) return { ok: false, message: '旋转次数尚未用尽' };

  const nextPayment = state.rentPaid + 1;
  const row = rentRowFor(nextPayment);
  if (state.coins < row.rent) {
    state.over = true;
    return { ok: false, message: `租金 ${row.rent} 不足（持有 ${state.coins}）` };
  }

  state.coins -= row.rent;
  state.rentPaid = nextPayment;
  state.spinsLeft += row.spinsGain;
  state.roundEarned = 0;
  state.payment = nextPayment;
  if (nextPayment >= 12) state.won = true;

  state.log.unshift({
    turn: state.totalSpins,
    kind: 'rent',
    text: `付租 #${nextPayment}：-${row.rent}，+${row.spinsGain} 旋转（剩余 ${state.spinsLeft}）`,
  });

  // 通关后不再起卡，避免商店盖住结算页
  if (!state.won) {
    state.shop = drawShop(state, nextPayment, 3);
    state.shopSource = 'rent';
    state.shopOpen = true;
  }
  trimLog(state);

  return { ok: true, message: `已付第 ${nextPayment} 期租金 ${row.rent}` };
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
function drawCard(state: GameState, kind: 'item' | 'symbol', payment: number): ShopCard {
  const row = rarityRowFor(kind, payment);
  const ladder: Array<[Rarity, number]> = [
    ['very_rare', row.veryRare],
    ['rare', row.rare],
    ['uncommon', row.uncommon],
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

export function buyFromShop(state: GameState, index: number): boolean {
  const card = state.shop[index];
  if (!card) return false;

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
    // 一次商店只能选一张（Pop-up__Pop-up.gd 的选项回调里直接关面板）
    closeShop(state);
    trimLog(state);
    return true;
  }

  if (!placeSymbol(state, card.def)) return false;
  state.pool.push(card.def);
  state.cells = visibleCells(state.reels);
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
  const row = rentRowFor(state.rentPaid + 1);
  return {
    period: state.rentPaid + 1,
    rent: row.rent,
    avgPerSpin: state.totalSpins > 0 ? state.totalEarned / state.totalSpins : 0,
  };
}
