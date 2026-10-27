// 对局界面：老虎机式棋盘 + 商店 + HUD。
// 只负责把状态渲染成 DOM，动画与事件在 main.ts 里处理。
import { rentRowFor } from './data';
import { CELL_COUNT, COLS, ROWS } from './grid';
import type { GameState } from './engine';
import { evaluateCell } from './value';
import { RARITY_LABEL, emojiOf } from './sprites';
import { RENT_TABLE, SYMBOL_BY_ID } from './data';
import { META } from './data';
import { describeRule, rulesOf } from './effects';
import { groupList, symbolName } from './names';

export interface GameUi {
  animating: boolean;
  detail: number | null;
  /** 商店中正在查看定义的卡片下标 */
  peek: number | null;
}

const money = (n: number): string => n.toLocaleString('en-US');

export function renderGame(game: GameState, ui: GameUi): string {
  const row = rentRowFor(game.rentPaid + 1);
  const hit = Math.min(CELL_COUNT, game.pool.length) / game.pool.length;
  const coinsPct = Math.min(100, (game.coins / row.rent) * 100);
  const shortfall = Math.max(0, row.rent - game.coins);
  const broke = game.spinsLeft === 0 && shortfall > 0;
  const canSpin = !game.over && !game.shopOpen && game.spinsLeft > 0 && !ui.animating;
  const canPay = !game.over && !game.shopOpen && game.spinsLeft === 0 && !ui.animating;

  const tiles = game.cells
    .map((cell, i) => {
      const final = game.lastFinals[i] ?? 0;
      if (!cell.def) return `<div class="tile empty" data-slot="${i}"></div>`;
      const synergy = cell.valueBonus;
      return `
      <div class="tile r-${cell.def.rarity || 'common'}" data-slot="${i}" data-action="inspect" data-index="${i}">
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
        <div class="coin-sub">持有 / 本期租金 ${money(row.rent)}</div>
      </div>
      <div class="hud-right">
      <div class="hud-row">
        <span class="chip">第 <b>${game.rentPaid + 1}</b> / 12 期</span>
        <span class="chip">旋转 <b>${game.spinsLeft}</b></span>
        <span class="chip" title="符号池容量与单格命中率">池 <b>${game.pool.length}</b> · ${(hit * 100).toFixed(0)}%</span>
      </div>
      <div class="bar"><i style="width:${coinsPct.toFixed(1)}%"></i></div>
      <div class="hud-hint ${broke ? 'short' : ''}">
        ${
          broke
            ? `本期累计 ${money(game.roundEarned)}，还差 ${money(shortfall)}，旋转已用尽`
            : `本期累计 ${money(game.roundEarned)} · 还差 ${money(shortfall)}`
        }
      </div>
      </div>
    </div>

    <div class="reels-wrap">
      <div class="reels" id="reels" style="--cols:${COLS};--rows:${ROWS}">${tiles}</div>
    </div>

    <div class="spin-strip"><div class="pips">${spinPips}</div></div>


    <div class="actions">
      ${
        game.over
          ? `<button class="big-btn danger" data-action="reset">${game.won ? '🎉 已通关 · 再来一局' : '💀 破产 · 重新开始'}</button>`
          : game.spinsLeft > 0
            ? `<button class="big-btn ${canSpin ? '' : 'busy'}" data-action="spin" ${canSpin ? '' : 'disabled'}>
                 <span class="big-btn-label">旋转</span>
               </button>`
            : `<button class="big-btn pay ${game.coins < row.rent ? 'danger' : ''}" data-action="pay" ${canPay ? '' : 'disabled'}>
                 付租 ${money(row.rent)}
               </button>`
      }
    </div>

    ${renderProgress(game)}
  </div>
  ${game.shopOpen ? renderShop(game) : ''}
  ${game.shopOpen && ui.peek !== null ? renderPeek(game, ui.peek) : ''}
  ${ui.detail !== null ? renderDetail(game, ui.detail) : ''}`;
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
  const cell = Math.max(34, Math.floor(Math.min(byW, byH)));
  reels.style.setProperty('--cell', `${cell}px`);
}

function renderProgress(game: GameState): string {
  const cells = RENT_TABLE.map((r) => {
    const done = r.payment <= game.rentPaid;
    const now = r.payment === game.rentPaid + 1;
    return `<div class="rent-dot ${done ? 'done' : ''} ${now ? 'now' : ''}" title="第 ${r.payment} 期 · ${money(r.rent)}">
      <span>${r.payment}</span>
    </div>`;
  }).join('');
  return `<div class="rent-track">${cells}</div>`;
}

function renderShop(game: GameState): string {
  const offers = game.shop
    .map(
      (card, i) => `
      <div class="offer r-${card.rarity}">
        <button class="offer-main" data-action="buy" data-index="${i}">
          <span class="offer-rare">${RARITY_LABEL[card.rarity] ?? card.rarity}</span>
          <span class="offer-art"><span class="offer-face">${emojiOf(card.def)}</span></span>
          <span class="offer-name">${symbolName(card.def.id)}</span>
          <span class="offer-val"><small>值</small>${card.def.value}</span>
        </button>
        <button class="offer-peek" data-action="peek" data-index="${i}" title="查看定义" aria-label="查看定义">?</button>
      </div>`,
    )
    .join('');

  const isSpinReward = game.shopSource === 'spin';
  const title = isSpinReward ? `第 ${game.rentPaid + 1} 期 · 旋转奖励` : `第 ${game.payment} 期租金已付`;
  const note = isSpinReward
    ? `本次旋转后按稀有度概率给出 ${game.shop.length} 个符号，可择一加入符号池；跳过则放弃本次奖励。`
    : `付租后按档位配比给出 ${game.shop.length} 个符号，可择一加入符号池；跳过则放弃本次奖励。`;

  return `
  <div class="overlay shop-overlay">
    <div class="sheet">
      <div class="sheet-head">
        <h2>${title}</h2>
        <p class="muted small">${note}</p>
      </div>
      <div class="offers">${offers}</div>
      <button class="ghost-btn" data-action="skip">跳过本次</button>
    </div>
  </div>`;
}

/** 商店卡片的定义面板：选之前能看清值、稀有度、分组与源码声明 */
function renderPeek(game: GameState, index: number): string {
  const card = game.shop[index];
  if (!card) return '';
  const n = game.pool.length;
  const hitNow = Math.min(CELL_COUNT, n) / n;
  const hitAfter = Math.min(CELL_COUNT, n + 1) / (n + 1);

  return `
  <div class="overlay peek-overlay" data-action="close-peek">
    <div class="sheet detail" data-stop="1">
      <div class="detail-hero">
        <div class="detail-face">${emojiOf(card.def)}</div>
        <div>
          <h2>${symbolName(card.def.id)}</h2>
          <p class="muted small">${RARITY_LABEL[card.rarity] ?? card.rarity} · ${groupList(card.def.groups)}</p>
        </div>
        <div class="detail-total">${card.def.value}</div>
      </div>
      <table class="data">
        <tbody>
          <tr><td>基础值</td><td class="num">${card.def.value}</td></tr>
          <tr><td>符号池</td><td class="num">${n} → ${n + 1}</td></tr>
          <tr><td>单格命中率</td><td class="num">${(hitNow * 100).toFixed(0)}% → ${(hitAfter * 100).toFixed(0)}%</td></tr>
          <tr><td>单格期望</td><td class="num">${(hitAfter * card.def.value).toFixed(2)}</td></tr>
        </tbody>
      </table>
      ${renderDeclarations(card.def.id)}
      <p class="muted small" style="margin-top:12px">点击空白处返回选择</p>
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
      <p class="muted small mono" style="margin:8px 0 0">
        value · value_bonus · permanent_bonus · value_multiplier · permanent_multiplier
      </p>
      ${renderDeclarations(cell.def.id)}
      <p class="muted small" style="margin-top:12px">点击空白处关闭</p>
    </div>
  </div>`;
}

/** 该符号在玩法里的效果，用玩家能读懂的话写；没有可展示的效果就写「无特效」 */
function renderDeclarations(id: string): string {
  const def = SYMBOL_BY_ID.get(id) ?? null;
  const owner = def ? { id: def.id, values: def.values ?? [] } : undefined;
  const texts: string[] = [];
  for (const rule of rulesOf(id)) {
    const text = describeRule(rule, owner);
    if (text && !texts.includes(text)) texts.push(text);
  }
  const head = `<div class="decl-head">${symbolName(id)} <span class="muted small">原名 ${id}</span></div>`;
  if (texts.length === 0) {
    return `
      <div class="decls">
        ${head}
        <p class="note small"><b>无特效</b></p>
      </div>`;
  }
  const rows = texts.map((text) => `<div class="decl"><div class="decl-cond">${text}</div></div>`).join('');
  return `
      <div class="decls">
        ${head}
        ${rows}
      </div>`;
}

/** 旋转动画用的随机表情 */
const FILLER = ['🪙', '💎', '🍒', '🎲', '🐱', '🍺', '🌸', '🐟', '⚓', '🏺', '🔑', '🧿'];

export function fillerEmoji(tick: number): string {
  return FILLER[tick % FILLER.length];
}

export const META_INFO = META;
