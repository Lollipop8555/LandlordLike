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
import { ITEM_POOL, SYMBOL_BY_ID, SYMBOL_POOL, rarityRowFor, rentRowFor, symbol } from './data';
import { CELL_COUNT, COLS as REELS_X, ROWS as REELS_Y, SLOTS_PER_REEL } from './grid';
import { applyEffects, applyItemEffects } from './effects';
import {
  bossMail,
  chiliEssenceMail,
  comradeMail,
  comradeValues,
  endingMail,
  gameOverMail,
  introMail,
  removalTipMail,
  rentDueMail,
  rentIncreaseMail,
  type Mail,
} from './mail';
import { symbolName } from './names';
import { mulberry32, shuffle, type Random } from './rng';
import type { SynergyHit } from './synergy';
import { boardTotal, evaluateCell } from './value';
import type { Cell, GameMode, Rarity, SymbolDef } from './types';

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
  /** 当前模式 */
  mode: GameMode;
  /** 房东之战；未进入时为 null */
  boss: BossState | null;
  /** 本局购买次数（成就统计用） */
  buys: number;
  /** 本局累计摧毁的符号数 */
  destroyed: number;
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

export function createGame(seed = 20261027, mode: GameMode = 'normal'): GameState {
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
  const startRent = rentRowFor(startPaid + 1);

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
    floor: startPaid + 1,
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
          ? `沙盒模式：从第 ${startPaid + 1} 期开始，金币 ${startCoins}，重掷 / 移除 / 精华各 3 枚，租金 ${startRent.rent}`
          : `新开局：5 个基础符号，1 金币，5 次旋转，首期租金 ${rentRowFor(1).rent}`,
      },
    ],
    over: false,
    won: false,
    mode,
    boss: null,
    buys: 0,
    destroyed: 0,
    // 沙盒给几枚代币，方便直接试重掷/移除/精华
    rerollTokens: sandbox ? 3 : 0,
    removalTokens: sandbox ? 3 : 0,
    essenceTokens: sandbox ? 3 : 0,
    rerollCost: 1,
    removalCost: 1,
    lastHits: [],
    lastFinals: new Array(CELL_COUNT).fill(0),
    mails: [],
  };
  // 开局一封房东来信（原版 intro），只提示、不阻塞操作
  addMail(state, introMail(mode, 0));
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

export function spin(state: GameState): void {
  if (state.over || state.spinsLeft <= 0) return;
  if (state.shopOpen) return;

  injectDud(state);
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

  collectExtraTokens(state);

  if (destroyedIds.length > 0) removeDestroyed(state);

  state.log.unshift({
    turn: state.totalSpins,
    kind: 'spin',
    text: `#${state.totalSpins} 旋转产出 ${output}（池 ${
      state.reels.reduce((n, col) => n + col.filter((c) => c.def).length, 0)
    } 个符号）`,
  });

  if (state.spinsLeft === 0) {
    state.log.unshift({
      turn: state.totalSpins,
      kind: 'info',
      text: state.boss?.active ? '旋转次数用尽，可以攻击房东' : '旋转次数用尽，需付租',
    });
    if (!state.boss?.active && !state.over && !state.won) {
      addMail(
        state,
        rentDueMail({
          period: state.rentPaid + 1,
          rent: rentRowFor(state.rentPaid + 1).rent,
          coins: state.coins,
          essenceTokens: state.essenceTokens,
          removalCost: state.removalCost,
          turn: state.totalSpins,
        }),
      );
    }
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

/** 付租：扣款 → 累加旋转 → 开商店（§7.1 / §7.2，Pop-up__Pop-up.gd:2882-2890） */
export function payRent(state: GameState): { ok: boolean; message: string } {
  if (state.over || state.won) return { ok: false, message: '已结束' };
  if (state.spinsLeft > 0) return { ok: false, message: '旋转次数尚未用尽' };

  // 房东之战：不再交租，金币直接换成伤害
  if (state.boss?.active) return attackBoss(state);

  const nextPayment = state.rentPaid + 1;
  const row = rentRowFor(nextPayment);
  if (state.coins < row.rent) {
    state.over = true;
    state.log.unshift({ turn: state.totalSpins, kind: 'rent', text: `付租失败：租金 ${row.rent}，持有 ${state.coins}` });
    addMail(
      state,
      gameOverMail({ period: nextPayment, rent: row.rent, coins: state.coins, turn: state.totalSpins }),
    );
    trimLog(state);
    return { ok: false, message: `租金 ${row.rent} 不足（持有 ${state.coins}）` };
  }

  state.coins -= row.rent;
  state.rentPaid = nextPayment;
  state.spinsLeft += row.spinsGain;
  state.roundEarned = 0;
  state.payment = nextPayment;
  state.floor = nextPayment + 1;

  // 付租时未花掉的精华在房东手里作废（Main__Main.gd:1300 essence_tokens = 0），
  // 重掷/移除代币则保留。
  state.essenceTokens = 0;

  // 普通模式付完 12 期即通关；无尽模式继续往上加租，永不结束
  // 通关只用 won 表示（over 代表破产），界面把两者都当成对局结束
  const cleared = state.mode === 'normal' && nextPayment >= 12;
  if (cleared) state.won = true;

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
  const nextRow = rentRowFor(nextPayment + 1);
  addMail(
    state,
    rentIncreaseMail({
      period: nextPayment,
      nextRent: nextRow.rent,
      spinsGain: nextRow.spinsGain,
      endless: state.mode === 'endless',
      turn: state.totalSpins,
    }),
  );

  if (cleared) {
    addMail(
      state,
      endingMail({ rent: row.rent, totalEarned: state.totalEarned, turn: state.totalSpins }),
    );
  }

  state.log.unshift({
    turn: state.totalSpins,
    kind: 'rent',
    text: state.mode === 'endless'
      ? `付租 #${nextPayment}：-${row.rent}，+${row.spinsGain} 旋转（无尽模式，下一期租金 ${rentRowFor(nextPayment + 1).rent}）`
      : `付租 #${nextPayment}：-${row.rent}，+${row.spinsGain} 旋转（剩余 ${state.spinsLeft}）`,
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

/** 进入房东之战：通关后的额外一关，血量固定 750（Boss 战） */
export function startBossFight(state: GameState): void {
  if (state.boss?.active || state.over) return;
  // 从「已通关」切换到房东战，重新进入可玩状态
  state.won = false;
  state.boss = { maxHp: BOSS_HP, hp: BOSS_HP, active: true };
  state.spinsLeft = Math.max(state.spinsLeft, 5);
  addMail(state, bossMail(BOSS_HP, state.totalSpins));
  state.log.unshift({
    turn: state.totalSpins,
    kind: 'info',
    text: `房东之战开始：房东血量 ${BOSS_HP}，用金币造成伤害`,
  });
  trimLog(state);
}

/** 房东之战里「付租」＝用当前金币攻击 */
export function attackBoss(state: GameState): { ok: boolean; message: string } {
  const boss = state.boss;
  if (!boss || !boss.active) return { ok: false, message: '未在房东之战中' };
  if (state.spinsLeft > 0) return { ok: false, message: '旋转次数尚未用尽' };

  const damage = state.coins;
  boss.hp = Math.max(0, boss.hp - damage);
  state.coins = 0;
  const dead = boss.hp <= 0;
  if (dead) {
    boss.active = false;
    state.won = true;
  } else {
    state.spinsLeft += 5;
  }
  state.log.unshift({
    turn: state.totalSpins,
    kind: 'rent',
    text: dead
      ? `对房东造成 ${damage} 伤害，房东倒下（${boss.maxHp}/${boss.maxHp}）`
      : `对房东造成 ${damage} 伤害，剩余血量 ${boss.hp}`,
  });
  trimLog(state);
  return { ok: true, message: dead ? '击败房东' : `造成 ${damage} 伤害` };
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
  state.shop =
    state.shopSource === 'spin'
      ? drawShopByChance(state, payment, 3)
      : drawShop(state, payment, 3);
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
  const x = cellIndex % REELS_X;
  const y = Math.floor(cellIndex / REELS_X) + 1;
  const slot = state.reels[x]?.[y];
  if (!slot || slot.uid !== cell.uid) return { ok: false, message: '格子已变动，请重试' };

  const id = cell.def.id;
  state.reels[x][y] = createCell(null);
  const at = state.pool.findIndex((def) => def.id === id);
  if (at >= 0) state.pool.splice(at, 1);
  state.removalTokens -= state.removalCost;
  state.cells = visibleCells(state.reels);
  state.log.unshift({
    turn: state.totalSpins,
    kind: 'buy',
    text: `移除符号 ${symbolName(id)}：-${state.removalCost} 移除代币（剩 ${state.removalTokens}）`,
  });
  trimLog(state);
  return { ok: true, message: `已移除 ${symbolName(id)}` };
}

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
    // 一次商店只能选一张（Pop-up__Pop-up.gd 的选项回调里直接关面板）
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
