// 标题页、成就面板、统计面板：与对局界面分离，避免 game.ts 继续膨胀
import { MAX_FLOOR, landlordMaxHp, rentFor } from './engine';
import { ACHIEVEMENTS, unlockedCount } from './progress/achievements';
import type { Profile } from './progress/save';
import type { Settings } from './progress/settings';
import type { GameMode } from './types';

const MODES: Array<{ id: GameMode; icon: string; name: string; desc: string }> = [
  { id: 'normal', icon: '🏠', name: '普通', desc: '付满 12 期租金' },
  { id: 'endless', icon: '♾️', name: '无尽', desc: '12 期后租金持续上涨' },
  { id: 'sandbox', icon: '🧪', name: '沙盒', desc: '从第 12 期开始，金币 999,999' },
];

const money = (n: number): string => n.toLocaleString('en-US');

/** 第 1–12 期累计租金（含楼层加价） */
function totalRentOf(floor: number): number {
  let sum = 0;
  for (let p = 1; p <= 12; p += 1) sum += rentFor(floor, p).rent;
  return sum;
}

/** 哑弹注入间隔（Main__Reels.gd:273），0 表示该楼层不注入 */
function dudEvery(floor: number): number {
  return floor >= 19 ? 15 : floor >= 14 ? 20 : floor >= 10 ? 25 : 0;
}

/** 楼层参数，与引擎读同一套函数，避免文案与实现漂移 */
function floorRows(floor: number): Array<[string, string]> {
  const hp = landlordMaxHp(floor);
  const dud = dudEvery(floor);
  return [
    ['1–12 期租金', money(totalRentOf(floor))],
    ['房东 HP', money(hp)],
    ['细则阈值', `${Math.floor(hp / 10)}`],
    ['哑弹间隔', dud > 0 ? `${dud} 转` : '—'],
  ];
}

/**
 * 当前能选的最高层：通关第 N 层才放行第 N+1 层（原版逐层解锁）。
 * 新档只能选第 1 层，老玩家按最远通关层换算。
 */
export function maxSelectableFloor(profile: Profile): number {
  const top = Number.isFinite(profile.topFloor) ? profile.topFloor : 0;
  return Math.min(MAX_FLOOR, Math.max(1, Math.trunc(top) + 1));
}

export function renderTitle(profile: Profile, mode: GameMode, floor = 1): string {
  const unlocked = unlockedCount(profile);
  const s = profile.stats;
  const maxFloor = maxSelectableFloor(profile);
  const floorChips = Array.from({ length: MAX_FLOOR }, (_, i) => i + 1)
    .map((n) => {
      if (n > maxFloor) {
        const need = n === maxFloor + 1 ? `通关第 ${maxFloor} 层解锁` : '先通关前一层';
        return `
      <button class="floor-chip locked" disabled data-floor="${n}"
        title="${need}（第 ${n} 层）" aria-label="第 ${n} 层，${need}">🔒</button>`;
      }
      return `
      <button class="floor-chip ${floor === n ? 'picked' : ''}" data-action="pick-floor" data-floor="${n}"
        aria-label="第 ${n} 层">${n}</button>`;
    })
    .join('');
  return `
  <div class="title-screen">
    <div class="brand-block">
      <div class="brand-mark">🏠</div>
      <h1 class="brand">LandlordLike</h1>
    </div>

    <div class="mode-list">
      ${MODES.map(
        (m) => `
        <button class="mode-card ${mode === m.id ? 'picked' : ''}" data-action="pick-mode" data-mode="${m.id}">
          <span class="mode-icon">${m.icon}</span>
          <span class="mode-text">
            <b>${m.name}</b>
            <small>${m.desc}</small>
          </span>
        </button>`,
      ).join('')}
    </div>

    <div class="floor-pick">
      <div class="floor-pick-head">
        <span>楼层</span>
        <b>第 ${floor} / ${MAX_FLOOR} 层</b>
      </div>
      <div class="floor-row">${floorChips}</div>
      <table class="data floor-data">
        <tbody>
          ${floorRows(floor)
            .map(([k, v]) => `<tr><td>${k}</td><td class="num">${v}</td></tr>`)
            .join('')}
        </tbody>
      </table>
    </div>

    <div class="title-actions">
      <button class="big-btn start" data-action="start">开始游戏</button>
      <button class="ghost-btn" data-action="open-achievements">🏅 成就 ${unlocked}/${ACHIEVEMENTS.length}</button>
      <button class="ghost-btn" data-action="open-stats">📊 统计</button>
      <button class="ghost-btn" data-action="open-settings">⚙️ 设置</button>
    </div>

    <div class="title-stats">
      <span>开局 <b>${s.runs}</b></span>
      <span>通关 <b>${s.wins}</b></span>
      <span>最远 <b>${s.bestPayment}</b> 期</span>
      <span>击败房东 <b>${s.bosses}</b> 次</span>
    </div>
  </div>`;
}

export function renderAchievementsPanel(profile: Profile): string {
  const unlocked = unlockedCount(profile);
  const pct = (unlocked / ACHIEVEMENTS.length) * 100;
  const cards = ACHIEVEMENTS.map((a) => {
    const got = Boolean(profile.unlocked[a.id]);
    const name = a.hidden && !got ? '???' : a.name;
    const desc = a.hidden && !got ? '达成后揭晓' : a.desc;
    return `
      <div class="ach ${got ? 'got' : ''}">
        <span class="ach-icon">${got ? a.icon : '🔒'}</span>
        <span class="ach-text">
          <b>${name}</b>
          <small>${desc}</small>
        </span>
      </div>`;
  }).join('');

  return `
  <div class="overlay" data-action="close-panel">
    <div class="sheet wide" data-stop="1">
      <div class="analysis-head">
        <div>
          <h2>成就</h2>
          <p class="muted small">${unlocked} / ${ACHIEVEMENTS.length} 已解锁</p>
        </div>
        <button class="icon-btn" data-action="close-panel">✕</button>
      </div>
      <div class="ach-progress"><i style="width:${pct.toFixed(1)}%"></i></div>
      <div class="ach-grid">${cards}</div>
    </div>
  </div>`;
}

export function renderStatsPanel(profile: Profile): string {
  const s = profile.stats;
  const unlocked = unlockedCount(profile);
  const rows: Array<[string, string]> = [
    ['开局次数', `${s.runs}`],
    ['通关次数', `${s.wins}`],
    ['破产次数', `${s.losses}`],
    ['最远付租', `第 ${s.bestPayment} 期`],
    ['最高单局产出', `${s.bestEarned.toLocaleString('en-US')}`],
    ['累计旋转', `${s.totalSpins}`],
    ['击败房东', `${s.bosses}`],
    ['累计道具购买', `${s.buys}`],
    // 彩蛋计数（原版 Stats.gd 同名统计，单位沿用源码）
    ['撸狗时长', `${s.petDogHours.toFixed(2)} 小时`],
    ['兔子跳数', `${Math.round(s.rabbitHops)}`],
    ['收集兔毛', `${s.rabbitFluff.toFixed(2)} 磅`],
    ['打翻的酒', `${s.alcoholGallons.toFixed(2)} 加仑`],
    ['成就进度', `${unlocked} / ${ACHIEVEMENTS.length}`],
  ];
  return `
  <div class="overlay" data-action="close-panel">
    <div class="sheet" data-stop="1">
      <div class="analysis-head">
        <div>
          <h2>统计</h2>
          <p class="muted small">仅保存在本机</p>
        </div>
        <button class="icon-btn" data-action="close-panel">✕</button>
      </div>
      <table class="data">
        <tbody>
          ${rows.map(([k, v]) => `<tr><td>${k}</td><td class="num">${v}</td></tr>`).join('')}
        </tbody>
      </table>
      <button class="ghost-btn reset-profile" data-action="reset-profile">清空存档与成就</button>
    </div>
  </div>`;
}

/** 设置面板：动效、提示条、清掉没打完的对局 */
export function renderSettingsPanel(settings: Settings, hasRun: boolean): string {
  const toggle = (on: boolean, action: string, label: string) => `
    <button class="toggle ${on ? 'on' : ''}" data-action="${action}" role="switch" aria-checked="${on}" aria-label="${label}">
      <span class="knob"></span>
    </button>`;
  return `
  <div class="overlay" data-action="close-settings">
    <div class="sheet" data-stop="1">
      <div class="analysis-head">
        <div>
          <h2>设置</h2>
          <p class="muted small">只保存在本机</p>
        </div>
        <button class="icon-btn" data-action="close-settings">✕</button>
      </div>
      <div class="setting-row">
        <div>
          <b>减弱动效</b>
          <small>旋转只滚一圈，数字不再缓动，面板直接出现</small>
        </div>
        ${toggle(settings.reducedMotion, 'toggle-motion', '减弱动效')}
      </div>
      <div class="setting-row">
        <div>
          <b>顶部提示条</b>
          <small>新信件、成就解锁一类的轻提示</small>
        </div>
        ${toggle(settings.toasts, 'toggle-toasts', '顶部提示条')}
      </div>
      <button class="ghost-btn wipe-run" data-action="wipe-run" ${hasRun ? '' : 'disabled'}>
        ${hasRun ? '放弃进行中的对局' : '当前没有进行中的对局'}
      </button>
    </div>
  </div>`;
}

/**
 * 首次引导：只讲三件"不看就会打错"的事——位置与邻接、旋转与期数、付租与商店。
 * 内容刻意短，每步三条；具体数值留给牌库和细则面板。
 */
export const TUTORIAL_STEPS: Array<{ icon: string; title: string; lead: string; points: string[] }> = [
  {
    icon: '🧲',
    title: '位置不是装饰',
    lead: '符号就是你的牌组，落在哪一格由旋转决定。',
    points: [
      '相邻加成沿邻接传播，位置决定增益落在谁身上',
      '棋盘不能自由拖动；只有稀有的「交换装置」能在每转停盘后换一次，两个格子',
      '所以想叠乘数，靠的是抽到相邻，而不是摆好阵型',
    ],
  },
  {
    icon: '🎰',
    title: '每期 10 次旋转',
    lead: '一次旋转会把整盘符号重新排列，并结算一次产出。',
    points: [
      '本期累计显示在顶部"还差"里，每次旋转都会往上加',
      '旋转用尽才轮得到付租，所以多留几次旋转就是多一轮产出',
      '金币不会清零，可以攒着穿过几期',
    ],
  },
  {
    icon: '🧾',
    title: '付租，再白拿一张',
    lead: '累计金币够租金就能付，付不起立刻出局。',
    points: [
      '旋转有产出、以及每期付完租之后，都会开一次三选一商店，免费拿一张',
      '重掷 / 移除 / 精华代币按需花，付租时没用的精华会作废',
      '第 12 期付清后房东下场，你每回合的收入同时就是伤害',
    ],
  },
];

/** 引导卡片：盖在棋盘上方，走到最后一步点"开始"写入 tutorialDone */
export function renderTutorial(step: number): string {
  const i = Math.max(0, Math.min(TUTORIAL_STEPS.length - 1, Math.trunc(step)));
  const s = TUTORIAL_STEPS[i];
  const last = i === TUTORIAL_STEPS.length - 1;
  const dots = TUTORIAL_STEPS.map((_, n) => `<i class="${n === i ? 'on' : ''}"></i>`).join('');
  return `
  <div class="overlay tutorial-overlay" data-stop="1">
    <div class="sheet tutorial-sheet" data-stop="1">
      <div class="tutorial-head">
        <span class="tutorial-icon">${s.icon}</span>
        <div>
          <p class="muted small">第 ${i + 1} / ${TUTORIAL_STEPS.length} 步</p>
          <h2>${s.title}</h2>
        </div>
      </div>
      <p class="tutorial-lead">${s.lead}</p>
      <ul class="tutorial-list">${s.points.map((p) => `<li>${p}</li>`).join('')}</ul>
      <div class="tutorial-dots">${dots}</div>
      <div class="tutorial-foot">
        <button class="ghost-btn" data-action="tutorial-skip" data-stop="1">跳过</button>
        ${i > 0 ? '<button class="ghost-btn" data-action="tutorial-prev" data-stop="1">上一步</button>' : ''}
        <button class="big-btn" data-action="tutorial-next" data-stop="1">${last ? '开始吧' : '下一步'}</button>
      </div>
    </div>
  </div>`;
}

/** 单条提示条：由 main.ts 直接插进 #toast-host，避免整页重绘打断弹窗 */
export function renderToast(t: { icon: string; title: string; text: string }): string {
  return `
      <div class="toast">
        <span class="toast-icon">${t.icon}</span>
        <span>
          <b>${t.title}</b>
          <small>${t.text}</small>
        </span>
      </div>`;
}
