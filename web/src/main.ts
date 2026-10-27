import './styles.css';
import { buyFromShop, closeShop, createGame, payRent, spin } from './engine';
import { fillerEmoji, fitBoard, renderGame, type GameUi } from './game';
import { emojiOf } from './sprites';
import { runSelfChecks, summarize } from './selfcheck';
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

let game = createGame();
const ui: GameUi = { animating: false, detail: null, peek: null };
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
      <button class="corner-btn" data-action="open-analysis" title="机制分析" aria-label="机制分析">📊</button>
      ${renderGame(game, ui)}
      ${renderAnalysis()}
    </div>`;
  fitBoard();
  if (coinFrom !== undefined) countUp(coinFrom, game.coins);
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
  if (ui.animating || game.over || game.shopOpen || game.spinsLeft <= 0) return;
  ui.animating = true;
  const from = game.coins;
  spin(game);
  await animateReels();
  await new Promise((r) => setTimeout(r, 280));
  ui.animating = false;
  paint(from);
}

function doPay(): void {
  if (ui.animating) return;
  const res = payRent(game);
  paint();
  if (!res.ok) setTimeout(() => window.alert(res.message), 30);
}

function handleAction(action: string, el: HTMLElement, event: Event): void {
  switch (action) {
    case 'spin':
      void doSpin();
      return;
    case 'pay':
      void doPay();
      return;
    case 'reset':
      game = createGame();
      ui.detail = null;
      ui.peek = null;
      break;
    case 'buy': {
      const idx = Number(el.dataset.index);
      buyFromShop(game, idx);
      closeShop(game);
      ui.peek = null;
      break;
    }
    case 'skip':
      closeShop(game);
      ui.peek = null;
      break;
    case 'peek':
      ui.peek = Number(el.dataset.index);
      break;
    case 'close-peek':
      if ((event.target as HTMLElement).closest('[data-stop]')) return;
      ui.peek = null;
      break;
    case 'inspect': {
      const target = event.target as HTMLElement;
      if (target.closest('.float')) return;
      ui.detail = Number(el.dataset.index);
      break;
    }
    case 'close-detail':
      if ((event.target as HTMLElement).closest('[data-stop]')) return;
      ui.detail = null;
      break;
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
