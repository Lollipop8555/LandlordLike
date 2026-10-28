import './styles.css';
import {
  buyFromShop,
  closeShop,
  createGame,
  essenceUpgrade,
  markAllMailsRead,
  markMailRead,
  moveSymbol,
  payRent,
  removeSymbolAt,
  rerollShop,
  spin,
  type GameState,
} from './engine';
import { fillerEmoji, fitBoard, renderGame, type GameUi } from './game';
import { CELL_COUNT, COLS } from './grid';
import { checkAchievements, type AchEvent } from './progress/achievements';
import { clearRun, hasRun, loadRun, saveRun } from './progress/runstate';
import { STAT_KEYS, loadProfile, recordRun, resetProfile, saveProfile, type Profile } from './progress/save';
import { EGG_BY_ID, type EggDef } from './easter-eggs';
import { applySettings, loadSettings, saveSettings } from './progress/settings';
import {
  TUTORIAL_STEPS,
  maxSelectableFloor,
  renderAchievementsPanel,
  renderSettingsPanel,
  renderStatsPanel,
  renderTitle,
  renderToast,
  renderTutorial,
} from './screens';
import { emojiOf } from './sprites';
import type { GameMode } from './types';

const app = document.querySelector<HTMLDivElement>('#app')!;

/* ── 全局状态 ── */

type Screen = 'title' | 'game';
type Panel = 'achievements' | 'stats' | null;

let screen: Screen = 'title';
let panel: Panel = null;
let mode: GameMode = loadProfile().lastMode;
/** 开局楼层：标题页选，一局内不变（Pop-up.current_floor） */
let startFloor = 1;
let profile: Profile = loadProfile();
let game: GameState = createGame(Date.now() % 100000, mode, startFloor);
const ui: GameUi = {
  animating: false,
  detail: null,
  peek: null,
  itemDetail: null,
  removing: false,
  deck: false,
  fineprint: false,
  mailbox: false,
  mailOpen: null,
  confirmHome: false,
  holding: null,
  settingsOpen: false,
};

/** 本局是否已写入存档，避免重复计数 */
let runRecorded = false;

/** 引导当前步（null = 不显示）。首次开局自动弹，看完即写 tutorialDone */
let tutorialStep: number | null = null;

/** 显示偏好：动效强度、提示条开关（与统计档案分开存） */
let settings = loadSettings();
applySettings(settings);

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
  if (!settings.toasts) return;
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

/**
 * 把引擎这一转攒下的彩蛋统计（摸狗、喝酒、斩首……）并入存档。
 * 必须在 afterEvent 之前跑：这批成就就是按统计阈值判的。
 */
function flushStats(): void {
  const pending = game.pendingStats;
  let dirty = false;
  for (const [key, amount] of Object.entries(pending ?? {})) {
    const field = STAT_KEYS[key];
    if (!field || !amount) continue;
    profile.stats[field] += amount;
    dirty = true;
  }
  // 清空已并入的部分，否则下一次 flush 会把同一批统计再加一遍
  game.pendingStats = {};
  if (dirty) saveProfile(profile);
}

/* ── 彩蛋互动：撸狗 / 逗兔子（原版靠悬停逐帧累加，见 easter-eggs.ts）── */

let petEgg: EggDef | null = null;
let petRaf = 0;
let petTicks = 0;

function addStat(key: string, amount: number): void {
  const field = STAT_KEYS[key];
  if (!field || !Number.isFinite(amount) || amount === 0) return;
  profile.stats[field] += amount;
}

function stopPet(): void {
  if (!petEgg) return;
  cancelAnimationFrame(petRaf);
  const who = petEgg.id;
  petEgg = null;
  saveProfile(profile);
  afterEvent({ t: 'pet', who });
}

/** 只停循环不结算：重绘时用，避免在 paint 里触发成就弹窗 */
function haltPet(): void {
  if (!petEgg) return;
  cancelAnimationFrame(petRaf);
  petEgg = null;
}

function startPet(id: string): void {
  const egg = EGG_BY_ID.get(id);
  if (!egg || petEgg?.id === id) return;
  stopPet();
  petEgg = egg;
  petTicks = 0;
  const tick = (): void => {
    if (!petEgg) return;
    addStat(petEgg.stat, petEgg.perFrame);
    petTicks += 1;
    // 每 30 帧落一次盘并判成就：每帧写 localStorage 太贵
    if (petTicks % 30 === 0) {
      saveProfile(profile);
      afterEvent({ t: 'pet', who: petEgg.id });
    }
    petRaf = requestAnimationFrame(tick);
  };
  petRaf = requestAnimationFrame(tick);
}

/** 点一下：手机上没法悬停，用一次点击折算成「摸了一小会儿」 */
function petOnce(id: string, el: HTMLElement): void {
  const egg = EGG_BY_ID.get(id);
  if (!egg) return;
  addStat(egg.stat, egg.perTap);
  saveProfile(profile);
  el.classList.remove('petting');
  void el.offsetWidth;
  el.classList.add('petting');
  afterEvent({ t: 'pet', who: id });
}

function afterEvent(ev: AchEvent): void {
  flushStats();
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
    floor: game.floor,
  });
  // 已经分出胜负的对局没有恢复价值
  clearRun();
  afterEvent({ t: 'end', won: game.won });
}

/**
 * 关掉引导并记成"看过了"。跳过 / Esc / 走完最后一步都走这里：
 * 只要弹过一次就不再自动弹，HUD 里的 ❓ 随时能再看一遍。
 */
function endTutorial(): void {
  tutorialStep = null;
  if (!profile.tutorialDone) {
    profile.tutorialDone = true;
    saveProfile(profile);
  }
}

/* ── 渲染 ── */

function paint(coinFrom?: number): void {
  // 重绘会换掉 DOM，悬停循环挂在旧节点上就没意义了，先停掉（统计已经按帧累加过）
  haltPet();
  app.innerHTML = `
    <div class="app">
      ${screen === 'title' ? renderTitle(profile, mode, startFloor) : renderGame(game, ui)}
      ${panel === 'achievements' ? renderAchievementsPanel(profile) : ''}
      ${panel === 'stats' ? renderStatsPanel(profile) : ''}
      ${ui.settingsOpen ? renderSettingsPanel(settings, hasRun()) : ''}
      ${tutorialStep !== null && screen === 'game' ? renderTutorial(tutorialStep) : ''}
    </div>`;
  fitBoard();
  if (coinFrom !== undefined && screen === 'game') countUp(coinFrom, game.coins);
  scheduleRunSave();
}

/**
 * 对局存档写在 paint 之后，但要节流：旋转动画期间 paint 会被调用很多次，
 * 每次都序列化整局会把主线程拖住。500ms 一次足够——最坏情况也就丢半秒操作。
 */
let runSaveTimer: number | null = null;
function scheduleRunSave(): void {
  if (screen !== 'game') return;
  if (runSaveTimer !== null) return;
  runSaveTimer = window.setTimeout(() => {
    runSaveTimer = null;
    saveRun(game);
  }, 500);
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

  // 减弱动效：不逐格滚动，直接把结果摆上去（等待时间也一起压掉）
  const reduced = settings.reducedMotion;
  const jobs = tiles.map(
    (el, i) =>
      new Promise<void>((resolve) => {
        const ticks = reduced ? 1 : 5 + (i % 5);
        let n = 0;
        const step = () => {
          if (n < ticks) {
            el.className = 'tile rolling';
            el.innerHTML = `<div class="face rolling">${fillerEmoji(n * 3 + i)}</div>`;
            n += 1;
            setTimeout(step, reduced ? 0 : 52);
          } else {
            settleTile(el, i);
            setTimeout(resolve, reduced ? 0 : 90);
          }
        };
        setTimeout(step, reduced ? 0 : i * 26);
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
  const bossHpBefore = game.boss?.active ? game.boss.hp : null;
  const mailBefore = game.mails[0]?.id;
  spin(game);
  const destroyedNow = game.destroyed - destroyedBefore;
  const negative = game.cells.filter((c) => c.def && c.def.value < 0).length;
  await animateReels();
  await new Promise((r) => setTimeout(r, settings.reducedMotion ? 0 : 280));
  ui.animating = false;
  paint(from);
  mailHint(mailBefore);
  afterEvent({
    t: 'spin',
    output: game.lastSpinOutput,
    destroyed: destroyedNow,
    negative,
    kills: game.lastKills,
    spawned: game.lastSpawned,
  });
  // 房东战：本回合收入就是伤害（引擎里已结算），这里只补成就事件
  if (bossHpBefore !== null && game.boss && game.boss.hp < bossHpBefore) {
    afterEvent({ t: 'boss', damage: bossHpBefore - game.boss.hp });
  }
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
  const mailBefore = game.mails[0]?.id;
  const res = payRent(game);
  paint();
  mailHint(mailBefore);
  if (!res.ok && !game.over) {
    pushToast({ icon: '⚠️', title: '付租失败', text: res.message });
    return;
  }
  afterEvent({ t: 'rent', paid: game.rentPaid });
  finishRun();
}

function startRun(): void {
  // 新局就丢掉上一局的存档，免得下次打开又"恢复"到已经放弃的那一局
  clearRun();
  game = createGame(Date.now() % 100000, mode, startFloor);
  endDrag();
  ui.holding = null;
  ui.detail = null;
  ui.peek = null;
  ui.itemDetail = null;
  ui.removing = false;
  ui.deck = false;
  ui.fineprint = false;
  ui.mailbox = false;
  ui.mailOpen = null;
  ui.confirmHome = false;
  runRecorded = false;
  screen = 'game';
  // 第一次开局先讲三件事；老档和已经看过的不再打断
  tutorialStep = profile.tutorialDone ? null : 0;
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
    case 'pick-floor': {
      const n = Number(el.dataset.floor);
      // 未通关的层不给选：标题页已经把格子锁掉，这里再挡一次（防键盘/连点绕过）
      const cap = maxSelectableFloor(profile);
      const want = Number.isFinite(n) ? Math.trunc(n) : 1;
      startFloor = Math.max(1, Math.min(cap, want));
      if (want > cap) {
        pushToast({ icon: '🔒', title: `第 ${want} 层还没解锁`, text: `先通关第 ${cap} 层` });
      }
      break;
    }
    case 'start':
      startRun();
      return;
    case 'home':
      // 未打完的对局不计入统计，误触就是白丢一局，先确认
      if (game.over || game.won) {
        finishRun();
        screen = 'title';
      } else {
        ui.confirmHome = true;
      }
      break;
    case 'home-yes':
      ui.confirmHome = false;
      tutorialStep = null;
      // 主动放弃的对局不该在下次打开时"复活"
      clearRun();
      finishRun();
      screen = 'title';
      break;
    case 'home-no':
      ui.confirmHome = false;
      break;
    case 'open-achievements':
      panel = 'achievements';
      break;
    case 'open-stats':
      panel = 'stats';
      break;
    case 'open-settings':
      ui.settingsOpen = true;
      break;
    case 'close-settings': {
      const t = event.target as HTMLElement;
      if (t.closest('.sheet') && !t.closest('.icon-btn')) return;
      ui.settingsOpen = false;
      break;
    }
    case 'toggle-motion':
      settings = { ...settings, reducedMotion: !settings.reducedMotion };
      saveSettings(settings);
      applySettings(settings);
      break;
    case 'toggle-toasts':
      settings = { ...settings, toasts: !settings.toasts };
      saveSettings(settings);
      break;
    case 'wipe-run':
      clearRun();
      pushToast({ icon: '🗑️', title: '已放弃上一局', text: '下次打开不会再恢复它' });
      break;
    case 'tutorial':
      // 手动重看：不影响 tutorialDone，关掉就没了
      tutorialStep = 0;
      break;
    case 'tutorial-next':
      if (tutorialStep === null) return;
      if (tutorialStep + 1 >= TUTORIAL_STEPS.length) endTutorial();
      else tutorialStep += 1;
      break;
    case 'tutorial-prev':
      if (tutorialStep === null) return;
      tutorialStep = Math.max(0, tutorialStep - 1);
      break;
    case 'tutorial-skip':
      endTutorial();
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
      if (res.ok) {
        ui.itemDetail = `${id}_essence`;
        afterEvent({ t: 'essence', id });
      }
      break;
    }
    case 'deck':
      ui.deck = true;
      break;
    case 'close-deck':
      if ((event.target as HTMLElement).closest('[data-stop]') && !(event.target as HTMLElement).closest('.ghost-btn')) return;
      ui.deck = false;
      break;
    case 'fineprint':
      ui.fineprint = true;
      break;
    case 'close-fineprint': {
      const t = event.target as HTMLElement;
      if (t.closest('[data-stop]') && !t.closest('.icon-btn') && !t.closest('.ghost-btn')) return;
      ui.fineprint = false;
      break;
    }
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
    default:
      return;
  }
  paint();
}

/* ── 拖拽重排 ──
 *
 * 位置是玩家唯一能主动干预产出的手段（把乘数符号挪到中心格、让邻居去吃），
 * 所以棋盘上的格子可以直接拖动互换。三个要点：
 *   · 超过阈值才算拖动，否则松手仍然按"点开定义/移除"处理；
 *   · 交换落到引擎的 reels 上，paint() 之后补一段弹跳动画做反馈；
 *   · 拖动过程中把 click 吞掉，避免松手顺手点开详情面板。
 */

/** 拖动多少像素才算"拖"而不是"点" */
const DRAG_THRESHOLD = 8;
let swallowClickUntil = 0;

let dragFrom: number | null = null;
let dragOrigin: { x: number; y: number } | null = null;
let dragMoved = false;
let dragGhost: HTMLElement | null = null;
let dragPointer: number | null = null;

function tileEl(slot: number): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.tile[data-slot="${slot}"]`);
}

function slotAtPoint(x: number, y: number): number | null {
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  const tile = el?.closest<HTMLElement>('.tile');
  if (!tile) return null;
  const n = Number(tile.dataset.slot);
  return Number.isInteger(n) ? n : null;
}

function canRearrange(): boolean {
  return screen === 'game' && !ui.animating && !ui.removing && !game.shopOpen && !game.over && !game.won;
}

function endDrag(): void {
  dragGhost?.remove();
  dragGhost = null;
  dragFrom = null;
  dragOrigin = null;
  dragPointer = null;
  dragMoved = false;
  document
    .querySelectorAll('.tile.dragging, .tile.drag-hover')
    .forEach((el) => el.classList.remove('dragging', 'drag-hover'));
}

/** 交换两格并重绘；返回是否真的换了 */
function applyMove(from: number, to: number): boolean {
  if (!moveSymbol(game, from, to).ok) return false;
  paint();
  for (const slot of [from, to]) {
    const el = tileEl(slot);
    if (!el) continue;
    el.classList.add('just-moved');
    setTimeout(() => el.classList.remove('just-moved'), 420);
  }
  return true;
}

function focusSlot(slot: number): void {
  tileEl(slot)?.focus({ preventScroll: true });
}

document.addEventListener(
  'pointerdown',
  (event) => {
    if (!canRearrange()) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const tile = (event.target as HTMLElement | null)?.closest<HTMLElement>('.tile');
    if (!tile || tile.classList.contains('empty')) return;
    const slot = Number(tile.dataset.slot);
    if (!Number.isInteger(slot)) return;
    dragFrom = slot;
    dragOrigin = { x: event.clientX, y: event.clientY };
    dragPointer = event.pointerId;
    dragMoved = false;
    try {
      tile.setPointerCapture(event.pointerId);
    } catch {
      /* 没有指针捕获也不影响，document 上的监听照样收到 */
    }
  },
  { passive: true },
);

document.addEventListener(
  'pointermove',
  (event) => {
    if (dragFrom === null || !dragOrigin) return;
    if (dragPointer !== null && event.pointerId !== dragPointer) return;
    if (!dragMoved) {
      if (Math.hypot(event.clientX - dragOrigin.x, event.clientY - dragOrigin.y) < DRAG_THRESHOLD) return;
      dragMoved = true;
      const src = tileEl(dragFrom);
      if (src) {
        src.classList.add('dragging');
        const rect = src.getBoundingClientRect();
        dragGhost = document.createElement('div');
        dragGhost.className = `${src.className.replace(/\bdragging\b/, '').trim()} drag-ghost`;
        dragGhost.innerHTML = src.innerHTML;
        dragGhost.style.width = `${rect.width}px`;
        dragGhost.style.height = `${rect.height}px`;
        dragGhost.style.setProperty('--cell', `${Math.round(rect.width)}px`);
        document.body.appendChild(dragGhost);
      }
    }
    // 棋盘不滚动，这里可以直接吃掉手势，避免移动端把拖动当成滚动
    event.preventDefault();
    if (dragGhost) {
      dragGhost.style.transform = `translate(${event.clientX}px, ${event.clientY}px) translate(-50%, -50%)`;
    }
    document.querySelectorAll('.tile.drag-hover').forEach((el) => el.classList.remove('drag-hover'));
    const slot = slotAtPoint(event.clientX, event.clientY);
    if (slot !== null && slot !== dragFrom) tileEl(slot)?.classList.add('drag-hover');
  },
  { passive: false },
);

document.addEventListener('pointerup', (event) => {
  if (dragFrom === null) return;
  const from = dragFrom;
  const moved = dragMoved;
  const slot = moved ? slotAtPoint(event.clientX, event.clientY) : null;
  endDrag();
  if (!moved) return; // 没拖动过：交给 click 去做「查看定义 / 移除」
  swallowClickUntil = performance.now() + 400;
  if (slot !== null && slot !== from) applyMove(from, slot);
});

document.addEventListener('pointercancel', () => {
  if (dragFrom === null) return;
  endDrag();
  swallowClickUntil = performance.now() + 400;
});

/**
 * 键盘操作棋盘：焦点落在格子上时 Enter/Space 拾起，方向键换位，再按一次放下。
 * 返回 true 表示这次按键已被棋盘消费。
 */
function handleBoardKey(event: KeyboardEvent): boolean {
  const active = document.activeElement as HTMLElement | null;
  const activeTile = active?.classList.contains('tile') ? active : null;
  const activeSlot = activeTile ? Number(activeTile.dataset.slot) : null;
  const STEPS: Record<string, number> = {
    ArrowLeft: -1,
    ArrowRight: 1,
    ArrowUp: -COLS,
    ArrowDown: COLS,
  };

  if (ui.holding !== null) {
    const held = ui.holding;
    if (event.key in STEPS) {
      event.preventDefault();
      const to = held + STEPS[event.key];
      if (to < 0 || to >= CELL_COUNT) return true;
      if (event.key === 'ArrowLeft' && held % COLS === 0) return true;
      if (event.key === 'ArrowRight' && held % COLS === COLS - 1) return true;
      const prev = ui.holding;
      ui.holding = to;
      if (!applyMove(held, to)) {
        ui.holding = prev;
        paint();
        focusSlot(held);
        return true;
      }
      focusSlot(to);
      return true;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      ui.holding = null;
      paint();
      if (activeSlot !== null) focusSlot(activeSlot);
      return true;
    }
    if (event.key === 'Escape') {
      ui.holding = null;
      paint();
      if (activeSlot !== null) focusSlot(activeSlot);
      return true;
    }
    return false;
  }

  if (!activeTile || activeSlot === null || !Number.isInteger(activeSlot)) return false;

  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    if (!canRearrange()) return true;
    ui.holding = activeSlot;
    paint();
    focusSlot(activeSlot);
    return true;
  }
  if (event.key in STEPS) {
    event.preventDefault();
    const to = activeSlot + STEPS[event.key];
    if (to < 0 || to >= CELL_COUNT) return true;
    if (event.key === 'ArrowLeft' && activeSlot % COLS === 0) return true;
    if (event.key === 'ArrowRight' && activeSlot % COLS === COLS - 1) return true;
    focusSlot(to);
    return true;
  }
  return false;
}

document.addEventListener('click', (event) => {
  const target = event.target as HTMLElement | null;
  // 刚拖完的那一下不当作点击
  if (performance.now() < swallowClickUntil && target?.closest('.tile')) return;
  // 彩蛋：点狗/兔子撸一下（仍照常打开详情，两件事互不干扰）
  const eggTile = target?.closest<HTMLElement>('.tile[data-egg]');
  if (eggTile && screen === 'game' && !ui.removing) petOnce(eggTile.dataset.egg ?? '', eggTile);
  const el = target?.closest<HTMLElement>('[data-action]');
  if (!el) return;
  handleAction(el.dataset.action ?? '', el, event);
});

// 桌面端悬停 = 原版的「一直在摸」，逐帧累加；移走就停
document.addEventListener('pointerover', (event) => {
  if (screen !== 'game') return;
  const tile = (event.target as HTMLElement | null)?.closest<HTMLElement>('.tile[data-egg]');
  if (!tile) return;
  startPet(tile.dataset.egg ?? '');
});

document.addEventListener('pointerout', (event) => {
  const tile = (event.target as HTMLElement | null)?.closest<HTMLElement>('.tile[data-egg]');
  if (!tile) return;
  const to = event.relatedTarget as Node | null;
  if (to && tile.contains(to)) return; // 在 tile 内部挪动不算离开
  stopPet();
});

// 快捷键：棋盘上的方向键/Enter 归拖拽重排，Esc 退回一层（移除模式 → 信箱 → 牌库 → 成就/统计 → 详情面板）
document.addEventListener('keydown', (event) => {
  if (handleBoardKey(event)) return;
  if (event.key !== 'Escape') return;
  // 引导在最上层，Esc 等于跳过
  if (tutorialStep !== null) {
    endTutorial();
    paint();
    return;
  }
  if (ui.settingsOpen) {
    ui.settingsOpen = false;
    paint();
    return;
  }
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
  if (ui.fineprint) {
    ui.fineprint = false;
    paint();
    return;
  }
  if (ui.deck) {
    ui.deck = false;
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

let fitRaf = 0;
function scheduleFit(): void {
  cancelAnimationFrame(fitRaf);
  fitRaf = requestAnimationFrame(fitBoard);
}

window.addEventListener('resize', scheduleFit);
window.addEventListener('orientationchange', scheduleFit);
if (document.fonts) void document.fonts.ready.then(() => fitBoard());

// 上次没打完就关掉了页面：直接接着打，别让玩家重开一局。
// 恢复失败（存档损坏/版本不符）时 loadRun 内部会清掉存档，退回标题页。
const restored = loadRun();
if (restored) {
  game = restored;
  mode = game.mode;
  startFloor = game.floor;
  screen = 'game';
  tutorialStep = profile.tutorialDone ? null : 0;
  paint();
  pushToast({ icon: '♻️', title: '接着上次的对局', text: `第 ${game.floor} 层 · 第 ${game.payment + 1} 期` });
} else {
  paint();
}
