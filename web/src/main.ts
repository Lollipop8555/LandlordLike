import './styles.css';
import {
  buyFromShop,
  closeShop,
  createGame,
  essenceUpgrade,
  markAllMailsRead,
  markMailRead,
  payRent,
  removeSymbolAt,
  rerollShop,
  spin,
  startBossFight,
  type GameState,
} from './engine';
import { fillerEmoji, fitBoard, renderGame, type GameUi } from './game';
import { checkAchievements, type AchEvent } from './progress/achievements';
import { loadProfile, recordRun, resetProfile, saveProfile, type Profile } from './progress/save';
import { renderAchievementsPanel, renderStatsPanel, renderTitle, renderToast } from './screens';
import { emojiOf } from './sprites';
import { runSelfChecks, summarize } from './selfcheck';
import type { GameMode } from './types';
import {
  renderAbout,
  renderChecks,
  renderDist,
  renderFormula,
  renderRestore,
  type DistState,
  type FormulaState,
} from './views';

const app = document.querySelector<HTMLDivElement>('#app')!;
const results = runSelfChecks();
const summary = summarize(results);

/* ── 全局状态 ── */

type Screen = 'title' | 'game';
type Panel = 'achievements' | 'stats' | null;

let screen: Screen = 'title';
let panel: Panel = null;
let mode: GameMode = loadProfile().lastMode;
let profile: Profile = loadProfile();
let game: GameState = createGame(Date.now() % 100000, mode);
const ui: GameUi = {
  animating: false,
  detail: null,
  peek: null,
  itemDetail: null,
  removing: false,
  deck: false,
  mailbox: false,
  mailOpen: null,
  confirmHome: false,
};
let analysisOpen = false;
let analysisTab = 'formula';
let formula: FormulaState = {
  value: 2,
  valueBonus: 3,
  valueMultiplier: 4,
  permanentBonus: 0,
  permanentMultiplier: 2,
  prevCount: 0,
  negativeCase: false,
};
let dist: DistState = { S: 40, trials: 20000 };

/** 本局是否已写入存档，避免重复计数 */
let runRecorded = false;

interface Toast {
  icon: string;
  title: string;
  text: string;
}

/* ── 成就与存档 ── */

/**
 * 提示条挂在 #app 之外的常驻容器里，只做局部插入/移除。
 * 早前每次都整页 paint()，会把已弹出的道具选择框重建、入场动画重播一遍。
 */
function pushToast(t: Toast): void {
  const host = document.getElementById('toast-host');
  if (!host) return;
  // 顶部只留最近两条，避免整排提示把 HUD 遮死
  while (host.childElementCount >= 2) host.firstElementChild?.remove();
  host.insertAdjacentHTML('beforeend', renderToast(t));
  const el = host.lastElementChild as HTMLElement | null;
  if (!el) return;
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 240);
  }, 3400);
}

function afterEvent(ev: AchEvent): void {
  const fresh = checkAchievements(profile, game, ev);
  if (fresh.length === 0) return;
  saveProfile(profile);
  for (const a of fresh) pushToast({ icon: a.icon, title: `成就解锁 · ${a.name}`, text: a.desc });
}

function finishRun(): void {
  const ended = game.over || game.won;
  if (runRecorded || !ended) return;
  runRecorded = true;
  const bossWin = Boolean(game.boss && !game.boss.active && game.won);
  recordRun(profile, {
    won: game.won,
    bossWin,
    payment: game.rentPaid,
    earned: game.totalEarned,
    mode: game.mode,
    spins: game.totalSpins,
    buys: game.buys,
  });
  afterEvent({ t: 'end', won: game.won });
}

/* ── 分析抽屉 ── */

function analysisBody(): string {
  switch (analysisTab) {
    case 'dist':
      return renderDist(dist);
    case 'restore':
      return renderRestore();
    case 'checks':
      return renderChecks(results);
    case 'about':
      return renderAbout();
    default:
      return renderFormula(formula);
  }
}

function renderAnalysis(): string {
  if (!analysisOpen) return '';
  const tabs: Array<[string, string]> = [
    ['formula', '数值管线'],
    ['restore', '还原对照'],
    ['dist', '分布实验'],
    ['checks', '自检'],
    ['about', '说明'],
  ];
  return `
  <div class="overlay analysis-overlay">
    <div class="sheet wide">
      <div class="analysis-head">
        <div>
          <h2>机制分析</h2>
          <p class="muted small">自检 ${summary.pass}/${summary.total} 通过 · 结论均可在 data/*.csv 中复算</p>
        </div>
        <button class="icon-btn" data-action="close-analysis">✕</button>
      </div>
      <div class="analysis-tabs">
        ${tabs
          .map(
            ([key, label]) =>
              `<button class="a-tab" data-action="analysis-tab" data-tab="${key}" aria-selected="${
                analysisTab === key ? 'true' : 'false'
              }">${label}</button>`,
          )
          .join('')}
      </div>
      <div class="analysis-body">${analysisBody()}</div>
    </div>
  </div>`;
}

/* ── 渲染 ── */

function paint(coinFrom?: number): void {
  app.innerHTML = `
    <div class="app">
      ${
        screen === 'title'
          ? `<button class="corner-btn" data-action="open-analysis" title="机制分析" aria-label="机制分析">📊</button>`
          : ''
      }
      ${screen === 'title' ? renderTitle(profile, mode) : renderGame(game, ui)}
      ${panel === 'achievements' ? renderAchievementsPanel(profile) : ''}
      ${panel === 'stats' ? renderStatsPanel(profile) : ''}
      ${renderAnalysis()}
    </div>`;
  fitBoard();
  if (coinFrom !== undefined && screen === 'game') countUp(coinFrom, game.coins);
}

function countUp(from: number, to: number): void {
  const el = document.getElementById('coin-num');
  if (!el || from === to) return;
  const start = performance.now();
  const dur = 520;
  const step = (t: number) => {
    const k = Math.min(1, (t - start) / dur);
    const v = Math.round(from + (to - from) * (1 - (1 - k) ** 2));
    el.textContent = v.toLocaleString('en-US');
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/* ── 旋转动画 ── */

function settleTile(el: HTMLElement, index: number): void {
  const cell = game.cells[index];
  const final = game.lastFinals[index] ?? 0;
  if (!cell.def) {
    el.className = 'tile empty';
    el.removeAttribute('data-action');
    el.innerHTML = '';
    return;
  }
  el.className = `tile r-${cell.def.rarity || 'common'} landed`;
  el.setAttribute('data-action', 'inspect');
  el.setAttribute('data-index', String(index));
  el.innerHTML = `
    <div class="face">${emojiOf(cell.def)}</div>
    <div class="num ${final < 0 ? 'neg' : ''}">${final}</div>
    ${cell.valueBonus ? `<div class="syn">+${cell.valueBonus}</div>` : ''}
    <span class="float">+${final}</span>`;
}

function animateReels(): Promise<void> {
  const reels = document.getElementById('reels');
  if (!reels) return Promise.resolve();
  const tiles = Array.from(reels.querySelectorAll<HTMLElement>('.tile'));

  const jobs = tiles.map(
    (el, i) =>
      new Promise<void>((resolve) => {
        const ticks = 5 + (i % 5);
        let n = 0;
        const step = () => {
          if (n < ticks) {
            el.className = 'tile rolling';
            el.innerHTML = `<div class="face rolling">${fillerEmoji(n * 3 + i)}</div>`;
            n += 1;
            setTimeout(step, 52);
          } else {
            settleTile(el, i);
            setTimeout(resolve, 90);
          }
        };
        setTimeout(step, i * 26);
      }),
  );
  return Promise.all(jobs).then(() => undefined);
}

async function doSpin(): Promise<void> {
  if (ui.animating || game.over || game.won || game.shopOpen || game.spinsLeft <= 0) return;
  ui.animating = true;
  ui.removing = false;
  const from = game.coins;
  const destroyedBefore = game.destroyed;
  const mailBefore = game.mails[0]?.id;
  spin(game);
  const destroyedNow = game.destroyed - destroyedBefore;
  const negative = game.cells.filter((c) => c.def && c.def.value < 0).length;
  await animateReels();
  await new Promise((r) => setTimeout(r, 280));
  ui.animating = false;
  paint(from);
  mailHint(mailBefore);
  afterEvent({ t: 'spin', output: game.lastSpinOutput, destroyed: destroyedNow, negative });
  saveProfile(profile);
}

/** 新信只弹一条顶栏提示，不自动开面板（避免挡住商店/棋盘） */
function mailHint(prevTopId: string | undefined): void {
  const top = game.mails[0];
  if (top && top.id !== prevTopId && !top.read) {
    pushToast({ icon: '📬', title: `新信件：${top.subject}`, text: '点顶部 📬 收信' });
  }
}

function doPay(): void {
  if (ui.animating) return;
  ui.removing = false;
  const bossFight = Boolean(game.boss?.active);
  const damageBefore = game.boss ? game.boss.maxHp - game.boss.hp : 0;
  const mailBefore = game.mails[0]?.id;
  const res = payRent(game);
  paint();
  mailHint(mailBefore);
  if (!res.ok && !game.over) {
    pushToast({ icon: '⚠️', title: '付租失败', text: res.message });
    return;
  }
  if (bossFight && game.boss) {
    const dealt = game.boss.maxHp - game.boss.hp - damageBefore;
    afterEvent({ t: 'boss', damage: dealt });
  } else {
    afterEvent({ t: 'rent', paid: game.rentPaid });
  }
  finishRun();
}

function startRun(): void {
  game = createGame(Date.now() % 100000, mode);
  analysisOpen = false;
  ui.detail = null;
  ui.peek = null;
  ui.itemDetail = null;
  ui.removing = false;
  ui.deck = false;
  ui.mailbox = false;
  ui.mailOpen = null;
  ui.confirmHome = false;
  runRecorded = false;
  screen = 'game';
  profile.lastMode = mode;
  profile.stats.runs += 1;
  saveProfile(profile);
  paint();
}

function handleAction(action: string, el: HTMLElement, event: Event): void {
  switch (action) {
    case 'pick-mode':
      mode = (el.dataset.mode as GameMode) ?? 'normal';
      break;
    case 'start':
      startRun();
      return;
    case 'home':
      // 未打完的对局不计入统计，误触就是白丢一局，先确认
      if (game.over || game.won) {
        finishRun();
        analysisOpen = false;
        screen = 'title';
      } else {
        ui.confirmHome = true;
      }
      break;
    case 'home-yes':
      ui.confirmHome = false;
      finishRun();
      analysisOpen = false;
      screen = 'title';
      break;
    case 'home-no':
      ui.confirmHome = false;
      break;
    case 'boss':
      startBossFight(game);
      afterEvent({ t: 'boss', damage: 0 });
      break;
    case 'open-achievements':
      panel = 'achievements';
      break;
    case 'open-stats':
      panel = 'stats';
      break;
    case 'close-panel': {
      // 点面板内部不关闭；右上角 ✕ 与遮罩可以关
      const t = event.target as HTMLElement;
      if (t.closest('.sheet') && !t.closest('.icon-btn')) return;
      panel = null;
      break;
    }
    case 'reset-profile':
      if (!window.confirm('清空所有统计与成就？')) return;
      profile = resetProfile();
      break;
    case 'spin':
      void doSpin();
      return;
    case 'pay':
      void doPay();
      return;
    case 'reset':
      finishRun();
      startRun();
      return;
    case 'buy': {
      const idx = Number(el.dataset.index);
      buyFromShop(game, idx);
      closeShop(game);
      ui.peek = null;
      afterEvent({ t: 'buy', stacks: game.items.length });
      break;
    }
    case 'skip':
      closeShop(game);
      ui.peek = null;
      break;
    case 'reroll': {
      const res = rerollShop(game);
      if (!res.ok) pushToast({ icon: '⚠️', title: '无法重掷', text: res.message });
      else pushToast({ icon: '♻️', title: '商店已重掷', text: `剩 ${game.rerollTokens} 重掷代币` });
      ui.peek = null;
      break;
    }
    case 'removal-mode':
      if (!ui.removing && game.removalTokens < game.removalCost) {
        pushToast({ icon: '⚠️', title: '移除代币不足', text: `需要 ${game.removalCost} 个移除代币` });
        return;
      }
      ui.removing = !ui.removing;
      break;
    case 'remove': {
      const res = removeSymbolAt(game, Number(el.dataset.index));
      pushToast({
        icon: res.ok ? '🗑️' : '⚠️',
        title: res.ok ? '已移除' : '无法移除',
        text: res.message,
      });
      if (game.removalTokens < game.removalCost) ui.removing = false;
      break;
    }
    case 'essence': {
      const id = el.dataset.id ?? '';
      const res = essenceUpgrade(game, id);
      pushToast({
        icon: res.ok ? '💎' : '⚠️',
        title: res.ok ? '精华升级' : '无法升级',
        text: res.message,
      });
      if (res.ok) ui.itemDetail = `${id}_essence`;
      break;
    }
    case 'deck':
      ui.deck = true;
      break;
    case 'close-deck':
      if ((event.target as HTMLElement).closest('[data-stop]') && !(event.target as HTMLElement).closest('.ghost-btn')) return;
      ui.deck = false;
      break;
    case 'mailbox':
      ui.mailbox = true;
      break;
    case 'close-mail': {
      // 点面板内容不关闭；右上角 ✕ 与遮罩可以关
      const t = event.target as HTMLElement;
      if (t.closest('[data-stop]') && !t.closest('.icon-btn') && !t.closest('.ghost-btn')) return;
      ui.mailbox = false;
      ui.mailOpen = null;
      break;
    }
    case 'mail-open': {
      const id = el.dataset.id ?? '';
      ui.mailOpen = ui.mailOpen === id ? null : id;
      if (ui.mailOpen) markMailRead(game, id);
      break;
    }
    case 'mail-all':
      markAllMailsRead(game);
      break;
    case 'peek':
      ui.peek = Number(el.dataset.index);
      break;
    case 'close-peek': {
      const t = event.target as HTMLElement;
      if (t.closest('[data-stop]') && !t.closest('.icon-btn')) return;
      ui.peek = null;
      break;
    }
    case 'inspect': {
      const target = event.target as HTMLElement;
      if (target.closest('.float')) return;
      ui.detail = Number(el.dataset.index);
      break;
    }
    case 'close-detail': {
      const t = event.target as HTMLElement;
      if (t.closest('[data-stop]') && !t.closest('.icon-btn')) return;
      ui.detail = null;
      break;
    }
    case 'inspect-item':
      ui.itemDetail = el.dataset.id ?? null;
      break;
    case 'close-item': {
      const t = event.target as HTMLElement;
      if (t.closest('[data-stop]') && !t.closest('.icon-btn')) return;
      ui.itemDetail = null;
      break;
    }
    case 'open-analysis':
      analysisOpen = true;
      break;
    case 'close-analysis':
      analysisOpen = false;
      break;
    case 'analysis-tab':
      analysisTab = el.dataset.tab ?? 'formula';
      break;
    case 'formula-neg':
      formula = {
        value: -5,
        valueBonus: 0,
        valueMultiplier: 10,
        permanentBonus: 2,
        permanentMultiplier: 1,
        prevCount: 0,
        negativeCase: true,
      };
      break;
    case 'formula-reset':
      formula = {
        value: 2,
        valueBonus: 3,
        valueMultiplier: 4,
        permanentBonus: 0,
        permanentMultiplier: 2,
        prevCount: 0,
        negativeCase: false,
      };
      break;
    default:
      return;
  }
  paint();
}

document.addEventListener('click', (event) => {
  const target = event.target as HTMLElement | null;
  const el = target?.closest<HTMLElement>('[data-action]');
  if (!el) return;
  handleAction(el.dataset.action ?? '', el, event);
});

// 快捷键：Esc 退回一层（移除模式 → 信箱 → 牌库 → 分析/成就/统计 → 详情面板）
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (ui.confirmHome) {
    ui.confirmHome = false;
    paint();
    return;
  }
  if (ui.removing) {
    ui.removing = false;
    paint();
    return;
  }
  if (ui.mailbox) {
    if (ui.mailOpen) ui.mailOpen = null;
    else ui.mailbox = false;
    paint();
    return;
  }
  if (ui.deck) {
    ui.deck = false;
    paint();
    return;
  }
  if (analysisOpen) {
    analysisOpen = false;
    paint();
    return;
  }
  if (panel) {
    panel = null;
    paint();
    return;
  }
  if (ui.itemDetail || ui.detail !== null || ui.peek !== null) {
    ui.itemDetail = null;
    ui.detail = null;
    ui.peek = null;
    paint();
  }
});

document.addEventListener('change', (event) => {
  const el = event.target as HTMLInputElement | null;
  if (!el?.dataset.f) return;
  const raw = Number(el.value);
  if (!Number.isFinite(raw)) return;
  const key = el.dataset.f;
  if (analysisTab === 'dist' && key === 'S') {
    dist = { ...dist, S: Math.max(20, Math.min(200, Math.round(raw))) };
  } else if (analysisTab === 'formula' && key in formula) {
    const next = { ...formula } as FormulaState & Record<string, unknown>;
    next[key] = key === 'prevCount' ? Math.max(0, Math.min(4, Math.round(raw))) : raw;
    formula = next;
  }
  paint();
});

let fitRaf = 0;
function scheduleFit(): void {
  cancelAnimationFrame(fitRaf);
  fitRaf = requestAnimationFrame(fitBoard);
}

window.addEventListener('resize', scheduleFit);
window.addEventListener('orientationchange', scheduleFit);
if (document.fonts) void document.fonts.ready.then(() => fitBoard());

paint();
