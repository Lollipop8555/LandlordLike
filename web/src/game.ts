// 对局界面：老虎机式棋盘 + 商店 + HUD。
// 只负责把状态渲染成 DOM，动画与事件在 main.ts 里处理。
import { CELL_COUNT, COLS, ROWS } from './grid';
import {
  TOKEN_ICON,
  TOKEN_LABEL,
  bossRent,
  canEssenceUpgrade,
  poolSummary,
  rentFor,
  unreadMails,
  type GameState,
} from './engine';
import type { Mail } from './mail';
import { evaluateCell } from './value';
import { RARITY_LABEL, emojiOf } from './sprites';
import { FINE_PRINTS, ITEM_BY_ID, RENT_TABLE, SYMBOL_BY_ID } from './data';
import { META } from './data';
import { describeFinePrint, describeRule, rulesOf } from './effects';
import { essenceLines, isEssence } from './essence-notes';
import { SELF_VALUE_NOTE, itemDesc } from './item-notes';
import { groupList, literalName, symbolName } from './names';
import { isUnimplemented } from './unimplemented';
import { EGG_BY_ID } from './easter-eggs';

export interface GameUi {
  animating: boolean;
  detail: number | null;
  /** 商店中正在查看定义的卡片下标 */
  peek: number | null;
  /** 正在查看的道具 id */
  itemDetail: string | null;
  /** 移除模式下点击棋盘符号即删除（消耗移除代币） */
  removing: boolean;
  /** 牌库面板 */
  deck: boolean;
  /** 细则面板 */
  fineprint: boolean;
  /** 房东信箱面板 */
  mailbox: boolean;
  /** 信箱里正在展开的信件 id */
  mailOpen: string | null;
  /** 返回标题前的确认层 */
  confirmHome: boolean;
  /** 换位装置：已选中的第一格（还能再点一格完成交换，null 表示还没选） */
  swapFrom: number | null;
  /** 设置面板（标题页与对局中都能开） */
  settingsOpen: boolean;
}

const money = (n: number): string => n.toLocaleString('en-US');

/** 换位提示里怎么称呼一格：符号名，或「空位」 */
function slotLabel(game: GameState, slot: number): string {
  const def = game.cells[slot]?.def;
  return def ? symbolName(def.id) : '空位';
}

export function renderGame(game: GameState, ui: GameUi): string {
  // 本期租金 = 基础表 + 楼层加成（Pop-up.update_rent_values）
  const row = rentFor(game.floor, game.rentPaid + 1);
  const hit = Math.min(CELL_COUNT, game.pool.length) / game.pool.length;
  const boss = game.boss;
  const bossFight = Boolean(boss?.active);
  // 战斗结束（房东倒下）后仍按 Boss 口径显示，否则血条会退回「本期租金」
  const bossMode = Boolean(boss);
  // 房东战同样按期付租，但走另一套租金（Pop-up.update_rent_values）
  const rent = bossFight ? bossRent(game.rentPaid + 1) : row.rent;
  const coinsPct = rent > 0 ? Math.min(100, (game.coins / rent) * 100) : 100;
  const shortfall = Math.max(0, rent - game.coins);
  const broke = game.spinsLeft === 0 && shortfall > 0;
  const ended = game.over || game.won;
  const canSpin = !ended && !game.shopOpen && game.spinsLeft > 0 && !ui.animating && !game.swapPending;
  const canPay = !ended && !game.shopOpen && game.spinsLeft === 0 && !ui.animating && !game.swapPending;
  const bossHp = boss ? Math.max(0, boss.hp) : 0;
  const bossPct = boss ? (bossHp / boss.maxHp) * 100 : 0;
  const cleared = !bossMode && game.won && game.mode === 'normal';
  const unread = unreadMails(game);
  const landlordPct = bossMode ? bossPct : cleared ? 100 : coinsPct;
  const landlordHp = bossMode ? bossHp : Math.max(0, rent - game.coins);
  const landlordMax = bossMode ? (boss?.maxHp ?? 1) : Math.max(1, rent);
  const landlordFace = bossMode
    ? boss?.active
      ? '👹'
      : '😵'
    : cleared
      ? '😵'
      : broke
        ? '😠'
        : '🧔';
  const landlordName = bossMode
    ? boss?.active
      ? '房东本人'
      : '房东被击败'
    : cleared
      ? '12 期租金已付清'
      : `第 ${game.rentPaid + 1} 期房东`;
  const landlordHpText = bossMode
    ? `HP ${money(landlordHp)} / ${money(landlordMax)}`
    : cleared
      ? '已付 12 / 12 期'
      : `HP ${money(landlordHp)} / ${money(landlordMax)}`;

  const swapping = game.swapPending;
  const tiles = game.cells
    .map((cell, i) => {
      const final = game.lastFinals[i] ?? 0;
      if (!cell.def) {
        // 换位时空格也能当落点（源码 swap_icon_positions 连 empty 一起换）
        return swapping
          ? `<div class="tile empty swap-open" data-slot="${i}" data-action="swap" data-index="${i}"></div>`
          : `<div class="tile empty" data-slot="${i}" aria-hidden="true"></div>`;
      }
      const synergy = cell.valueBonus;
      const action = swapping ? 'swap' : ui.removing ? 'remove' : 'inspect';
      // 位置信息对键盘操作是必要的：读屏只说符号名，玩家不知道自己在第几格
      const pos = `第 ${Math.floor(i / COLS) + 1} 行第 ${(i % COLS) + 1} 列`;
      const picked = swapping && ui.swapFrom === i ? ' swap-pick' : swapping ? ' swap-open' : '';
      // 彩蛋：狗/兔子能撸（悬停或点一下），其余符号不挂这个属性
      const egg = EGG_BY_ID.get(cell.def.id);
      return `
      <div class="tile r-${cell.def.rarity || 'common'}${ui.removing ? ' removable' : ''}${picked}" data-slot="${i}" data-action="${action}" data-index="${i}"${egg ? ` data-egg="${egg.id}"` : ''} tabindex="0" role="button" aria-label="${symbolName(cell.def.id)}（${pos}）${egg ? `，可${egg.verb}` : ''}${swapping ? '，可换位' : ''}">
        <div class="face">${emojiOf(cell.def)}</div>
        <div class="num ${final < 0 ? 'neg' : ''}">${final}</div>
        ${synergy ? `<div class="syn">+${synergy}</div>` : ''}
      </div>`;
    })
    .join('');

  const spinPips = Array.from({ length: Math.min(game.spinsLeft, 12) }, () => '<i></i>').join('');

  return `
  <div class="stage">
    <div class="hud">
      <div class="coin-box">
        <div class="coin-icon">🪙</div>
        <div class="coin-num" id="coin-num">${money(game.coins)}</div>
        <div class="coin-sub">${
          bossMode
            ? game.won
              ? '房东已击败'
              : '持有 · 房东战期间照常付租'
            : cleared
              ? '租金已付清，可挑战房东'
              : `持有 / 本期租金 ${money(rent)}`
        }</div>
      </div>
      <div class="landlord">
        <div class="landlord-face ${broke ? 'angry' : ''}">${landlordFace}</div>
        <div class="landlord-body">
          <div class="landlord-name">${landlordName}</div>
          <div class="hp-bar ${bossMode ? 'boss' : ''}"><i style="width:${landlordPct.toFixed(1)}%"></i></div>
          <div class="landlord-hp">${landlordHpText}</div>
        </div>
      </div>
      <div class="hud-right">
      <div class="hud-row">
        <span class="chip chip-mode mode-${game.mode}">${MODE_CHIP[game.mode]}</span>
        <span class="chip" title="开局时选定的楼层，本局内不变">第 <b>${game.floor}</b> 层</span>
        <span class="chip chip-period">${
          bossMode
            ? '房东战'
            : cleared
              ? '12 期已完成'
              : game.mode === 'normal'
                ? `第 <b>${game.rentPaid + 1}</b> / 12 期`
                : `第 <b>${game.rentPaid + 1}</b> 期`
        }</span>
        <span class="chip">旋转 <b>${game.spinsLeft}</b></span>
        <span class="chip chip-pool" title="符号池大小与每转上盘概率">池 <b>${game.pool.length}</b> · 上盘 ${(hit * 100).toFixed(0)}%</span>
      </div>
      <div class="hud-row token-row">
        <span class="token-chip" title="重掷代币：在商店中更换一批候选（每次 ${game.rerollCost} 枚）">${TOKEN_ICON.reroll} <b>${game.rerollTokens}</b></span>
        <button class="token-chip ${ui.removing ? 'active' : ''} ${game.removalTokens >= game.removalCost && !swapping ? '' : 'spent'}"
          data-action="removal-mode" ${swapping ? 'disabled' : ''} title="移除代币：进入移除模式后点击符号删除（每次 ${game.removalCost} 枚）">
          ${TOKEN_ICON.removal} <b>${game.removalTokens}</b>
        </button>
        <span class="token-chip" title="精华代币：将道具升级为精华版，付租时未使用的部分不保留">${TOKEN_ICON.essence} <b>${game.essenceTokens}</b></span>
        <button class="chip chip-btn" data-action="deck" title="查看符号池中的全部符号">📚 牌库</button>
        <button class="chip chip-btn ${game.finePrints.length > 0 ? 'fineprint-on' : ''}" data-action="fineprint"
          title="细则：房东随租金上涨追加的全局修正">📜 细则 <b>${game.finePrints.length}</b></button>
        <button class="chip chip-btn mail-btn ${unread > 0 ? 'unread' : ''}" data-action="mailbox" title="房东来信">
          📬 信箱${unread > 0 ? ` <b>${unread}</b>` : ''}
        </button>
        <button class="chip chip-btn" data-action="home" title="返回标题页（进行中的对局会先确认）">🚪 主页</button>
        <button class="chip chip-btn" data-action="tutorial" title="重新查看玩法引导（共三步）">❓ 引导</button>
      </div>
      <div class="hud-hint ${broke ? 'short' : ''}">
        ${
          game.swapPending
            ? ui.swapFrom === null
              ? '🔀 交换装置：本转可交换两个符号的位置（每转一次），请先选择一个符号'
              : `🔀 已选 ${slotLabel(game, ui.swapFrom)}，请再选择一格完成交换`
            : ui.removing
            ? `移除模式：点击棋盘上任意符号将其删除（每次 ${game.removalCost} 枚移除代币；再次点击按钮取消）`
            : bossMode
            ? game.won
              ? '房东已击败，本局结束'
              : '房东之战：每转产出的金币同时计入对房东的伤害，租金仍需照付'
            : cleared
              ? '12 期租金已全部付清，可挑战房东'
              : broke
                ? `本期累计 ${money(game.roundEarned)}，尚差 ${money(shortfall)}；旋转次数已用尽`
                : `本期累计 ${money(game.roundEarned)} · 尚差 ${money(shortfall)}`
        }
      </div>
      </div>
    </div>

    ${renderBag(game)}

    <div class="reels-wrap">
      <div class="reels" id="reels" style="--cols:${COLS};--rows:${ROWS}">${tiles}</div>
    </div>

    <div class="spin-strip"><div class="pips">${spinPips}</div></div>


    <div class="actions">
      ${
        game.swapPending
          ? `<button class="ghost-btn swap-skip" data-action="swap-skip">不换位，继续结算</button>`
          : ended
          ? `<button class="big-btn danger" data-action="reset">${
              game.won ? (game.boss ? '🏆 击败房东 · 开始新对局' : '🎉 已通关 · 开始新对局') : '💀 破产 · 重新开始'
            }</button>`
          : game.spinsLeft > 0
            ? `<button class="big-btn ${canSpin ? '' : 'busy'}" data-action="spin" ${canSpin ? '' : 'disabled'}>
                 <span class="big-btn-label">旋转</span>
               </button>`
            : bossFight
              ? `<button class="big-btn pay ${game.coins < rent ? 'danger' : ''}" data-action="pay" ${canPay ? '' : 'disabled'}>
                   付租 ${money(rent)}（房东战）
                 </button>`
              : `<button class="big-btn pay ${game.coins < rent ? 'danger' : ''}" data-action="pay" ${canPay ? '' : 'disabled'}>
                   付租 ${money(rent)}
                 </button>`
      }
    </div>

    ${renderProgress(game)}
  </div>
  ${game.shopOpen ? renderShop(game) : ''}
  ${game.shopOpen && ui.peek !== null ? renderPeek(game, ui.peek) : ''}
  ${ui.detail !== null ? renderDetail(game, ui.detail) : ''}
  ${ui.itemDetail ? renderItemDetail(game, ui.itemDetail) : ''}
  ${ui.deck ? renderDeck(game) : ''}
  ${ui.fineprint ? renderFinePrints(game) : ''}
  ${ui.mailbox ? renderMailbox(game, ui) : ''}
  ${ui.confirmHome ? renderHomeConfirm() : ''}`;
}

/** 返回标题前的确认：未打完的对局不计入统计，进度直接丢掉 */
function renderHomeConfirm(): string {
  return `
  <div class="overlay confirm-overlay" data-action="home-no">
    <div class="sheet confirm-sheet" data-stop="1">
      <h2>结束本局？</h2>
      <p class="note">这一局还没打完，退出后进度不保留，也不计入统计。</p>
      <div class="confirm-btns">
        <button class="ghost-btn" data-action="home-no" data-stop="1">继续这局</button>
        <button class="big-btn danger" data-action="home-yes" data-stop="1">结束并返回</button>
      </div>
    </div>
  </div>`;
}

const MODE_CHIP: Record<GameState['mode'], string> = {
  normal: '🏠 普通',
  endless: '♾️ 无尽',
  sandbox: '🧪 沙盒',
};

/** 道具栏：原版在主界面常驻，购买的道具按堆叠层数展示 */
function renderBag(game: GameState): string {
  if (game.items.length === 0) {
    return `<div class="bag empty"><span class="bag-label">道具栏</span><span class="bag-none">尚未持有道具，可在付租后或旋转奖励中获得</span></div>`;
  }
  const total = game.items.reduce((n, it) => n + it.count, 0);
  const slots = game.items
    .map(
      (it) => `
      <button class="bag-slot" data-action="inspect-item" data-id="${it.def.id}" title="${symbolName(it.def.id)} ×${it.count}">
        <span class="bag-face">${emojiOf(it.def)}</span>
        ${it.count > 1 ? `<span class="bag-count">×${it.count}</span>` : ''}
      </button>`,
    )
    .join('');
  return `<div class="bag"><span class="bag-label">道具栏 ${total}</span><div class="bag-slots">${slots}</div></div>`;
}

/** 道具详情：点道具栏里的图标弹出 */
function renderItemDetail(game: GameState, id: string): string {
  const held = game.items.find((it) => it.def.id === id);
  if (!held) return '';
  const def = held.def;
  // 细则 17 会按持有数量扣减道具自身 value（Item__Item.gd 的 <outside> 块）
  const eaten = held.itemValue ?? 0;
  const shownValue = held.value ?? def.value + eaten;
  const notes: string[] = [];
  if (held.value) notes.push('含细则修正');
  if (eaten) notes.push(`移除符号累计 +${eaten}`);
  if (held.savedValue) notes.push(`累积 ${held.savedValue}`);
  const valueNote = notes.length > 0 ? ` · ${notes.join('，')}` : '';
  return `
  <div class="overlay" data-action="close-item">
    <div class="sheet detail" data-stop="1">
      <div class="detail-hero">
        <div class="detail-face">${emojiOf(def)}</div>
        <div>
          <h2>${symbolName(def.id)}</h2>
          <p class="muted small">道具 · 持有 ×${held.count}${valueNote}</p>
        </div>
        <div class="detail-total">${shownValue}</div>
        <button class="icon-btn" data-action="close-item">✕</button>
      </div>
      ${renderDeclarations(def.id)}
      ${
        canEssenceUpgrade(game, id)
          ? `<button class="ghost-btn essence-up" data-action="essence" data-id="${id}">
               ${TOKEN_ICON.essence} 精华化 · 升级为精华版（剩余 ${game.essenceTokens} 枚）
             </button>`
          : ''
      }
      <p class="muted small" style="margin-top:12px">道具不占棋盘格，效果作用于全场符号；道具自身价值不计入每转产出</p>
    </div>
  </div>`;
}

/**
 * 按「剩余高度」重算格子边长，写成 --cell。
 * 高度够时棋盘保持正方形、整块内容贴顶排列，多余空间全部留到底部；
 * 高度不足时才靠缩小格子收敛，页面因此不会滚动。
 */
export function fitBoard(): void {
  const stage = document.querySelector<HTMLElement>('.stage');
  const wrap = document.querySelector<HTMLElement>('.reels-wrap');
  const reels = document.querySelector<HTMLElement>('#reels');
  if (!stage || !wrap || !reels) return;

  const cs = getComputedStyle(reels);
  const pad = parseFloat(cs.paddingTop) || 0;
  const colGap = parseFloat(cs.columnGap) || 0;
  const rowGap = parseFloat(cs.rowGap) || 0;
  const stageGap = parseFloat(getComputedStyle(stage).rowGap) || 0;

  let taken = stageGap * Math.max(0, stage.children.length - 1);
  for (const el of Array.from(stage.children)) {
    if (el !== wrap) taken += (el as HTMLElement).offsetHeight;
  }

  const availW = wrap.clientWidth;
  const availH = stage.clientHeight - taken;
  if (availW <= 0) return;

  const byW = (availW - 2 * pad - (COLS - 1) * colGap) / COLS;
  const byH = (availH - 2 * pad - (ROWS - 1) * rowGap) / ROWS;
  // 横屏矮窗（styles.css 的紧凑状态带）把格子下限放到 26px：
  // 金币/血量的位数变长会让状态带多占一行，靠格子让出这几个像素，避免顶出滚动条
  const compactHud = window.innerHeight <= 500 && window.innerWidth > window.innerHeight;
  const minCell = compactHud ? 26 : 34;
  const cell = Math.max(minCell, Math.floor(Math.min(byW, byH)));
  reels.style.setProperty('--cell', `${cell}px`);
}

function renderProgress(game: GameState): string {
  // 普通模式固定 12 期；无尽模式只显示已走过的与下一期，避免无限增长
  const rows =
    game.mode === 'normal' ? RENT_TABLE : RENT_TABLE.filter((r) => r.payment <= game.rentPaid + 1);
  const cells = rows
    .map((r) => {
      const done = r.payment <= game.rentPaid;
      const now = r.payment === game.rentPaid + 1;
      return `<div class="rent-dot ${done ? 'done' : ''} ${now ? 'now' : ''}" title="第 ${r.payment} 期 · ${money(rentFor(game.floor, r.payment).rent)}">
      <span>${r.payment}</span>
    </div>`;
    })
    .join('');
  // 无尽与沙盒都没有第 12 期终点，末尾挂一个 ∞ 表示还能继续
  const tail = game.mode === 'normal' ? '' : '<div class="rent-dot more">∞</div>';
  // 矮屏横屏（styles.css 极小横屏段）把整条方块轨换成一行文字，省掉 12 个 24px 方块
  const now = game.mode === 'normal' ? Math.min(game.rentPaid + 1, 12) : game.rentPaid + 1;
  const sum =
    game.mode === 'normal' ? `第 <b>${now}</b> / 12 期` : `第 <b>${now}</b> 期 · 继续`;
  return `<div class="rent-track">
    <span class="rent-sum">${sum}</span>
    <div class="rent-dots">${cells}${tail}</div>
  </div>`;
}

function renderShop(game: GameState): string {
  const offers = game.shop
    .map((card, i) => {
      // 代币卡不是符号，展示名与图标走 token 表
      const token = card.token;
      const name = token ? TOKEN_LABEL[token] : symbolName(card.def.id);
      const face = token ? TOKEN_ICON[token] : emojiOf(card.def);
      const rare = token ? '代币' : (RARITY_LABEL[card.rarity] ?? card.rarity);
      const val = token ? '+1' : String(card.def.value);
      return `
      <div class="offer r-${card.rarity} ${token ? 'token' : ''}">
        <button class="offer-main" data-action="buy" data-index="${i}">
          <span class="offer-rare">${rare}</span>
          <span class="offer-art"><span class="offer-face">${face}</span></span>
          <span class="offer-name">${name}</span>
          <span class="offer-val"><small>值</small>${val}</span>
        </button>
        ${token ? '' : `<button class="offer-peek" data-action="peek" data-index="${i}" title="查看详情" aria-label="查看详情"><span class="offer-peek-dot">?</span></button>`}
      </div>`;
    })
    .join('');

  const isSpinReward = game.shopSource === 'spin';
  const title = isSpinReward ? `第 ${game.rentPaid + 1} 期 · 旋转奖励` : `第 ${game.payment} 期租金已付`;
  const note = `从 ${game.shop.length} 个候选里选一个放进牌库；跳过就放弃这次奖励。`;

  return `
  <div class="overlay shop-overlay">
    <div class="sheet">
      <div class="sheet-head">
        <h2>${title}</h2>
        <p class="muted small">${note}</p>
      </div>
      <div class="offers">${offers}</div>
      <div class="shop-foot">
        <button class="ghost-btn reroll" data-action="reroll" ${
          game.rerollTokens >= game.rerollCost ? '' : 'disabled'
        }>
          ${TOKEN_ICON.reroll} 重掷 · 消耗 ${game.rerollCost} 枚（剩余 ${game.rerollTokens} 枚）
        </button>
        <button class="ghost-btn" data-action="skip">放弃本次奖励</button>
      </div>
    </div>
  </div>`;
}

/** 商店卡片的定义面板：选之前能看清值、稀有度、分组与源码声明 */
function renderPeek(game: GameState, index: number): string {
  const card = game.shop[index];
  if (!card) return '';
  // 道具不进符号池、也不占棋盘格，「符号池 / 上盘比例 / 单格期望」对它没有意义
  const isItem = ITEM_BY_ID.has(card.def.id);
  let stats = '';
  if (!isItem) {
    const n = game.pool.length;
    const hitNow = Math.min(CELL_COUNT, n) / n;
    const hitAfter = Math.min(CELL_COUNT, n + 1) / (n + 1);
    stats = `
      <table class="data">
        <tbody>
          <tr><td>基础值</td><td class="num">${card.def.value}</td></tr>
          <tr><td>符号池</td><td class="num">${n} → ${n + 1}</td></tr>
          <tr><td>上盘比例</td><td class="num">${(hitNow * 100).toFixed(0)}% → ${(hitAfter * 100).toFixed(0)}%</td></tr>
          <tr><td>单格期望</td><td class="num">${(hitAfter * card.def.value).toFixed(2)}</td></tr>
        </tbody>
      </table>`;
  }

  return `
  <div class="overlay peek-overlay" data-action="close-peek">
    <div class="sheet detail" data-stop="1">
      <div class="detail-hero">
        <div class="detail-face">${emojiOf(card.def)}</div>
        <div>
          <h2>${symbolName(card.def.id)}</h2>
          <p class="muted small">${RARITY_LABEL[card.rarity] ?? card.rarity}${isItem ? ' · 道具' : ` · ${groupList(card.def.groups)}`}</p>
        </div>
        <div class="detail-total">${card.def.value}</div>
        <button class="icon-btn" data-action="close-peek">✕</button>
      </div>
      ${stats}
      ${renderDeclarations(card.def.id)}
    </div>
  </div>`;
}

function renderDetail(game: GameState, index: number): string {
  const cell = game.cells[index];
  if (!cell?.def) return '';
  const bd = evaluateCell(cell);
  const part = bd.parts[0];
  return `
  <div class="overlay" data-action="close-detail">
    <div class="sheet detail" data-stop="1">
      <div class="detail-hero">
        <div class="detail-face">${emojiOf(cell.def)}</div>
        <div>
          <h2>${symbolName(cell.def.id)}</h2>
          <p class="muted small">${RARITY_LABEL[cell.def.rarity] ?? cell.def.rarity} · ${groupList(cell.def.groups)}</p>
        </div>
        <div class="detail-total">${part.final}</div>
        <button class="icon-btn" data-action="close-detail">✕</button>
      </div>
      <table class="data">
        <tbody>
          <tr><td>基础值</td><td class="num">${cell.def.value}</td></tr>
          <tr><td>相邻加算</td><td class="num">${cell.valueBonus}</td></tr>
          <tr><td>永久加算</td><td class="num">${cell.permanentBonus}</td></tr>
          <tr><td>本轮乘数</td><td class="num">×${cell.valueMultiplier}</td></tr>
          <tr><td>永久乘数</td><td class="num">×${cell.permanentMultiplier}</td></tr>
          <tr><td>本格产出</td><td class="num">${part.final}</td></tr>
        </tbody>
      </table>
      <p class="muted small" style="margin:8px 0 0">
        本格产出 =（基础值 + 相邻加算 + 永久加算）× 本轮乘数 × 永久乘数
      </p>
      ${renderDeclarations(cell.def.id)}
    </div>
  </div>`;
}

/**
 * 同一前提的多条声明合并成一句（洒水壶既是「种子数值 +10」又是「种子变植物」）。
 * 拆成两行会让玩家以为条件重复、甚至互相冲突，其实是一个触发两个效果。
 */
function mergeSameCondition(texts: string[]): string[] {
  const out: string[] = [];
  const index = new Map<string, number>();
  for (const text of texts) {
    const at = text.indexOf('时，');
    if (at <= 0) {
      out.push(text);
      continue;
    }
    const cond = text.slice(0, at);
    const body = text.slice(at + 2);
    const seen = index.get(cond);
    if (seen === undefined) {
      index.set(cond, out.length);
      out.push(text);
    } else {
      out[seen] = `${out[seen]}，并且${body}`;
    }
  }
  return out;
}

/**
 * 道具说明：一段「触发条件 → 效果」的对照列表。
 * 道具不占格、作用于全场，复用符号那套渲染会说出「本符号…」「相邻的…」这类错话，
 * 所以道具走 item-notes.ts 的专用文案（数值仍从 items.csv 取）。
 */
function renderItemDeclarations(id: string): string {
  const desc = itemDesc(id);
  const head = `<div class="decl-head">${symbolName(id)} <span class="muted small">${literalName(id)}</span></div>`;
  if (!desc) {
    return `
      <div class="decls">
        ${head}
        <p class="decl-warn">⚠ 这件道具还没有说明文案</p>
      </div>`;
  }
  // 效果缺口的说明由 item-notes.ts 的 gap 统一给出，这里不再重复一遍
  const rows = desc.lines
    .map(
      (line) => `<div class="decl">
        <div class="decl-when">${line.when}</div>
        <div class="decl-do">${line.effect}</div>
      </div>`,
    )
    .join('');
  // 「只改自身价值」的道具统一提示一次，避免逐条重复写「没有收益」
  const selfNote = desc.selfValueOnly ? `<p class="decl-gap">${SELF_VALUE_NOTE}</p>` : '';
  const gap = desc.gap ? `<p class="decl-gap">${desc.gap}</p>` : '';
  const empty = rows ? '' : '<p class="note small"><b>无特效</b></p>';
  return `
      <div class="decls">
        ${head}
        <p class="decl-summary">${desc.summary}</p>
        ${rows}${empty}
        ${selfNote}
        ${gap}
      </div>`;
}

/** 该符号在玩法里的效果，用玩家能读懂的话写；没有可展示的效果就写「无特效」 */
function renderDeclarations(id: string): string {
  // 道具与符号是两套语义（不占格、作用于全场），不能共用同一段生成逻辑
  if (ITEM_BY_ID.has(id)) return renderItemDeclarations(id);
  const def = SYMBOL_BY_ID.get(id) ?? null;
  const owner = def ? { id: def.id, values: def.values ?? [] } : undefined;
  const head = `<div class="decl-head">${symbolName(id)} <span class="muted small">${literalName(id)}</span></div>`;
  // 玩法还没补全的符号要明说，否则玩家会以为自己漏看了什么机制
  const warn = isUnimplemented(id)
    ? `<p class="decl-warn">⚠ 这张的玩法还在补：目前只有基础值，暂时不会出现在商店里</p>`
    : '';
  // 精华走自己的措辞：数据里是「触发→销毁自己」+「销毁→永久加成」两条技术声明，
  // 通用渲染会读成「被其他符号触发过时，摧毁自己」，玩家看不出它强化了什么
  if (isEssence(id)) {
    const rows = essenceLines(id)
      .map((text) => `<div class="decl"><div class="decl-cond">${text}</div></div>`)
      .join('');
    return `
      <div class="decls">
        ${head}
        ${warn}
        ${rows}
      </div>`;
  }
  const texts: string[] = [];
  for (const rule of rulesOf(id)) {
    const text = describeRule(rule, owner);
    if (text && !texts.includes(text)) texts.push(text);
  }
  const merged = mergeSameCondition(texts);
  if (texts.length === 0) {
    return `
      <div class="decls">
        ${head}
        ${warn || '<p class="note small"><b>无特效</b></p>'}
      </div>`;
  }
  const rows = merged.map((text) => `<div class="decl"><div class="decl-cond">${text}</div></div>`).join('');
  return `
      <div class="decls">
        ${head}
        ${warn}
        ${rows}
      </div>`;
}

/** 牌库面板：池里每种符号的数量与合计产出（原版 deck_button） */
function renderDeck(game: GameState): string {
  const entries = poolSummary(game);
  const total = entries.reduce((n, e) => n + e.count, 0);
  const rows = entries
    .map(
      (e) => `
      <div class="deck-row r-${e.rarity || 'common'}">
        <span class="deck-face">${e.id === 'dud' ? '🕳️' : emojiOf(SYMBOL_BY_ID.get(e.id) ?? { id: e.id, value: 0, values: [], rarity: '', groups: [], sfx: [] })}</span>
        <span class="deck-name">${e.name}</span>
        <span class="deck-rare">${e.rarity ? (RARITY_LABEL[e.rarity as keyof typeof RARITY_LABEL] ?? e.rarity) : '特殊'}</span>
        <span class="deck-count">×${e.count}</span>
      </div>`,
    )
    .join('');
  return `
  <div class="overlay deck-overlay" data-action="close-deck">
    <div class="sheet" data-stop="1">
      <div class="sheet-head">
        <h2>牌库 · ${total} 个符号</h2>
        <p class="muted small">符号池中的符号全部参与洗牌，每转上盘比例 ${Math.min(CELL_COUNT, total) ? ((Math.min(CELL_COUNT, total) / Math.max(1, total)) * 100).toFixed(0) : 0}%</p>
      </div>
      <div class="deck-list">${rows || '<p class="muted small">符号池为空</p>'}</div>
      <button class="ghost-btn" data-action="close-deck">关闭</button>
    </div>
  </div>`;
}

/** 细则面板：房东在付租失败时追加的永久修正（Landlord.fine_print） */
function renderFinePrints(game: GameState): string {
  const cards = game.finePrints
    .map((fp) => {
      const def = FINE_PRINTS.find((d) => d.id === fp.num);
      const lines = describeFinePrint(fp);
      const iconOk = fp.dynamicIcon ? SYMBOL_BY_ID.get(fp.dynamicIcon) : undefined;
      const icon = fp.dynamicIcon
        ? `<span class="fp-icon" title="${symbolName(fp.dynamicIcon)}">${iconOk ? emojiOf(iconOk) : '❔'}</span>`
        : '';
      const values = fp.values.length > 0 ? `<span class="fp-vals">数值 ${fp.values.join(' / ')}</span>` : '';
      return `
      <article class="fp-card">
        <div class="fp-head">
          <span class="fp-num">#${fp.num}</span>
          <b>${fp.name ?? `细则 ${fp.num}`}</b>
          ${def ? `<span class="fp-diff">难度 ${def.difficulty}</span>` : ''}
          ${values}
          ${icon}
        </div>
        <ul class="fp-lines">${
          lines.length > 0
            ? lines.map((l) => `<li>${l}</li>`).join('')
            : '<li class="muted small">本条细则不影响当前棋面上的任何符号</li>'
        }</ul>
      </article>`;
    })
    .join('');

  const next = Math.max(0, game.finePrintThreshold - game.finePrintCounter);
  return `
  <div class="overlay fp-overlay" data-action="close-fineprint">
    <div class="sheet wide" data-stop="1">
      <div class="analysis-head">
        <div>
          <h2>📜 细则 · ${game.finePrints.length} 条</h2>
          <p class="muted small">房东战期间每累计一定伤害追加一条，越往后越严格；每条只出现一次</p>
        </div>
        <button class="icon-btn" data-action="close-fineprint">✕</button>
      </div>
      <div class="fp-meter">
        <div class="fp-meter-bar"><i style="width:${Math.min(100, (game.finePrintCounter / Math.max(1, game.finePrintThreshold)) * 100).toFixed(0)}%"></i></div>
        <span>再打掉 ${next} 点血触发下一条 · 每 ${game.finePrintThreshold} 点伤害一条</span>
      </div>
      <div class="fp-list">${
        cards || '<p class="muted small">本局尚未获得细则。房东战期间造成的伤害会累积，达到阈值即追加一条。</p>'
      }</div>
      <button class="ghost-btn" data-action="close-fineprint">关闭</button>
    </div>
  </div>`;
}

/** 房东信箱：同伴援助、催租、教学、通关与破产信都在这里（原版以邮件模态呈现） */
function renderMailbox(game: GameState, ui: GameUi): string {
  const unread = unreadMails(game);
  const cards = game.mails
    .map((m: Mail) => {
      const open = ui.mailOpen === m.id;
      const paras = m.body
        .split('\n\n')
        .map((p) => `<p>${p}</p>`)
        .join('');
      const reward = m.reward
        ? `<div class="mail-reward">
             <span>${TOKEN_ICON.reroll} +${m.reward.reroll}</span>
             <span>${TOKEN_ICON.removal} +${m.reward.removal}</span>
             <span>${TOKEN_ICON.essence} +${m.reward.essence}</span>
             <small>已入账</small>
           </div>`
        : '';
      return `
      <article class="mail ${m.read ? '' : 'unread'} ${open ? 'open' : ''}">
        <button class="mail-head" data-action="mail-open" data-id="${m.id}">
          <span class="mail-dot"></span>
          <span class="mail-meta">
            <b>${m.subject}</b>
            <small>${m.from} · ${m.turn > 0 ? `第 ${m.turn} 次旋转后` : '开局'}</small>
          </span>
          <span class="mail-caret">${open ? '▾' : '▸'}</span>
        </button>
        ${open ? `<div class="mail-body">${paras}${reward}</div>` : ''}
      </article>`;
    })
    .join('');

  return `
  <div class="overlay mail-overlay" data-action="close-mail">
    <div class="sheet wide mail-sheet" data-stop="1">
      <div class="analysis-head">
        <div>
          <h2>📬 房东信箱</h2>
          <p class="muted small">${game.mails.length} 封 · 未读 ${unread}</p>
        </div>
        <button class="icon-btn" data-action="close-mail">✕</button>
      </div>
      ${
        game.mails.length > 0
          ? `<div class="mail-tools"><button class="ghost-btn" data-action="mail-all">全部标记已读</button></div>`
          : ''
      }
      <div class="mail-list">${cards || '<p class="muted small">暂无来信。付租、获得代币或结束对局时会收到信件。</p>'}</div>
    </div>
  </div>`;
}

/** 旋转动画用的随机表情 */
const FILLER = ['🪙', '💎', '🍒', '🎲', '🐱', '🍺', '🌸', '🐟', '⚓', '🏺', '🔑', '🧿'];

export function fillerEmoji(tick: number): string {
  return FILLER[tick % FILLER.length];
}

export const META_INFO = META;
