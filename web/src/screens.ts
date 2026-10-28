// 标题页、成就面板、统计面板：与对局界面分离，避免 game.ts 继续膨胀
import { ACHIEVEMENTS, unlockedCount } from './progress/achievements';
import type { Profile } from './progress/save';
import type { GameMode } from './types';

const MODES: Array<{ id: GameMode; icon: string; name: string; desc: string }> = [
  { id: 'normal', icon: '🏠', name: '普通', desc: '付满 12 期租金' },
  { id: 'endless', icon: '♾️', name: '无尽', desc: '12 期后租金持续上涨' },
  { id: 'sandbox', icon: '🧪', name: '沙盒', desc: '从第 12 期开始，金币 999,999' },
];

export function renderTitle(profile: Profile, mode: GameMode): string {
  const unlocked = unlockedCount(profile);
  const s = profile.stats;
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

    <div class="title-actions">
      <button class="big-btn start" data-action="start">开始游戏</button>
      <button class="ghost-btn" data-action="open-achievements">🏅 成就 ${unlocked}/${ACHIEVEMENTS.length}</button>
      <button class="ghost-btn" data-action="open-stats">📊 统计</button>
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
      <button class="ghost-btn" data-action="reset-profile" style="margin-top:14px">清空存档与成就</button>
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
