import type { GameState } from '../engine';
import type { Profile } from './save';

/** 触发成就检查的事件（由引擎在关键节点发出） */
export type AchEvent =
  | { t: 'spin'; output: number; destroyed: number; negative: number }
  | { t: 'rent'; paid: number }
  | { t: 'buy'; stacks: number }
  | { t: 'boss'; damage: number }
  | { t: 'end'; won: boolean };

export interface AchContext {
  state: GameState;
  event: AchEvent;
  profile: Profile;
}

export interface Achievement {
  id: string;
  icon: string;
  name: string;
  desc: string;
  /** 隐藏成就：解锁前只显示轮廓 */
  hidden?: boolean;
  check: (ctx: AchContext) => boolean;
}

const itemCount = (s: GameState): number => s.items.reduce((n, it) => n + it.count, 0);
const symbolCount = (s: GameState): number => s.pool.length;
const maxStack = (s: GameState): number => s.items.reduce((n, it) => Math.max(n, it.count), 0);
const paid = (c: AchContext): number => c.state.rentPaid;

export const ACHIEVEMENTS: Achievement[] = [
  // —— 租金进度 ——
  { id: 'rent_1', icon: '🔑', name: '第一次交租', desc: '付清第 1 期租金', check: (c) => c.event.t === 'rent' && paid(c) >= 1 },
  { id: 'rent_3', icon: '🏠', name: '站稳脚跟', desc: '付清第 3 期租金', check: (c) => c.event.t === 'rent' && paid(c) >= 3 },
  { id: 'rent_6', icon: '🏢', name: '租客的逆袭', desc: '付清第 6 期租金', check: (c) => c.event.t === 'rent' && paid(c) >= 6 },
  { id: 'rent_9', icon: '🌆', name: '顶楼风景', desc: '付清第 9 期租金', check: (c) => c.event.t === 'rent' && paid(c) >= 9 },
  { id: 'rent_12', icon: '🏆', name: '幸运房东', desc: '付清全部 12 期租金', check: (c) => c.event.t === 'rent' && paid(c) >= 12 },

  // —— 结局 ——
  { id: 'clear_normal', icon: '🎉', name: '自由身', desc: '在普通模式通关', check: (c) => c.event.t === 'end' && c.event.won && c.state.mode === 'normal' },
  { id: 'bankrupt', icon: '💸', name: '被赶出门', desc: '因付不起租金破产', check: (c) => c.event.t === 'end' && !c.event.won && c.state.mode !== 'sandbox' },
  { id: 'boss_win', icon: '👊', name: '反客为主', desc: '击败房东本人', check: (c) => c.event.t === 'boss' && c.state.boss !== null && c.state.boss.hp <= 0 },

  // —— 经济 ——
  { id: 'coin_500', icon: '💰', name: '小有积蓄', desc: '在付租前攒到 500 金币', check: (c) => c.event.t === 'rent' && c.state.totalEarned >= 500 },
  { id: 'coin_1500', icon: '🤑', name: '暴发户', desc: '在付租前攒到 1500 金币', check: (c) => c.event.t === 'rent' && c.state.totalEarned >= 1500 },
  { id: 'coin_5000', icon: '🏦', name: '现金为王', desc: '累计产出达到 5000', check: (c) => c.event.t === 'rent' && c.state.totalEarned >= 5000 },
  { id: 'earn_10000', icon: '💎', name: '财源滚滚', desc: '累计产出达到 10000', check: (c) => c.event.t === 'rent' && c.state.totalEarned >= 10000 },
  { id: 'spin_50', icon: '⚡', name: '手气不错', desc: '单次旋转产出 50 金币', check: (c) => c.event.t === 'spin' && c.event.output >= 50 },
  { id: 'spin_100', icon: '🌩️', name: '一发入魂', desc: '单次旋转产出 100 金币', check: (c) => c.event.t === 'spin' && c.event.output >= 100 },
  { id: 'spin_200', icon: '☄️', name: '失控的组合', desc: '单次旋转产出 200 金币', check: (c) => c.event.t === 'spin' && c.event.output >= 200 },

  // —— 组合 ——
  { id: 'symbol_10', icon: '🧩', name: '初具规模', desc: '棋盘上同时有 10 个符号', check: (c) => symbolCount(c.state) >= 10 },
  { id: 'symbol_16', icon: '🧱', name: '满满当当', desc: '棋盘上同时有 16 个符号', check: (c) => symbolCount(c.state) >= 16 },
  { id: 'symbol_20', icon: '🌈', name: '满编阵容', desc: '棋盘上同时有 20 个符号', check: (c) => symbolCount(c.state) >= 20 },
  { id: 'destroy_1', icon: '💥', name: '第一滴血', desc: '让一个符号被摧毁', check: (c) => c.event.t === 'spin' && c.event.destroyed >= 1 },
  { id: 'destroy_10', icon: '🔥', name: '拆迁队', desc: '累计摧毁 10 个符号', check: (c) => c.state.destroyed >= 10 },
  { id: 'negative', icon: '🕳️', name: '负负得正', desc: '在场上放下负数符号', check: (c) => c.event.t === 'spin' && c.event.negative >= 1 },

  // —— 道具 ——
  { id: 'item_1', icon: '🛍️', name: '第一件道具', desc: '购买第一件道具', check: (c) => c.event.t === 'buy' && itemCount(c.state) >= 1 },
  { id: 'item_4', icon: '🎒', name: '背包初具', desc: '同时持有 4 件道具', check: (c) => c.event.t === 'buy' && itemCount(c.state) >= 4 },
  { id: 'item_8', icon: '🧳', name: '满载而归', desc: '同时持有 8 件道具', check: (c) => c.event.t === 'buy' && itemCount(c.state) >= 8 },
  { id: 'item_12', icon: '🚚', name: '搬家现场', desc: '同时持有 12 件道具', check: (c) => c.event.t === 'buy' && itemCount(c.state) >= 12 },
  { id: 'stack_3', icon: '📚', name: '囤货癖', desc: '同一种道具叠到 3 层', check: (c) => c.event.t === 'buy' && maxStack(c.state) >= 3 },
  { id: 'buy_10', icon: '🧾', name: '老主顾', desc: '一局内购买 10 次', check: (c) => c.event.t === 'buy' && c.state.buys >= 10 },

  // —— 模式 ——
  { id: 'endless_15', icon: '🛫', name: '超出合同', desc: '无尽模式付清第 15 期租金', check: (c) => c.event.t === 'rent' && c.state.mode === 'endless' && paid(c) >= 15 },
  { id: 'endless_20', icon: '🌌', name: '无休止的旋转', desc: '无尽模式付清第 20 期租金', check: (c) => c.event.t === 'rent' && c.state.mode === 'endless' && paid(c) >= 20 },
  { id: 'sandbox_spin_100', icon: '🧪', name: '实验室常客', desc: '沙盒模式旋转 100 次', check: (c) => c.state.mode === 'sandbox' && c.state.totalSpins >= 100 },

  // —— Boss ——
  { id: 'boss_start', icon: '🚪', name: '敲开房东的门', desc: '进入房东之战', check: (c) => c.state.boss !== null && c.state.boss.active },
  { id: 'boss_damage_300', icon: '🩸', name: '重创', desc: '对房东累计造成 300 伤害', check: (c) => c.state.boss !== null && c.state.boss.maxHp - c.state.boss.hp >= 300 },
  { id: 'boss_damage_600', icon: '💣', name: '过半', desc: '对房东累计造成 600 伤害', check: (c) => c.state.boss !== null && c.state.boss.maxHp - c.state.boss.hp >= 600 },

  // —— 档案 ——
  { id: 'run_5', icon: '📖', name: '屡败屡战', desc: '累计开局 5 次', check: (c) => c.profile.stats.runs >= 5 },
  { id: 'run_20', icon: '🗂️', name: '老租客', desc: '累计开局 20 次', check: (c) => c.profile.stats.runs >= 20 },
  { id: 'win_3', icon: '👑', name: '三连房东', desc: '累计通关 3 次', check: (c) => c.profile.stats.wins >= 3 },
  { id: 'spins_300', icon: '🎰', name: '肌肉记忆', desc: '累计旋转 300 次', check: (c) => c.profile.stats.totalSpins >= 300 },
];

export const ACHIEVEMENT_TOTAL = ACHIEVEMENTS.length;

const BY_ID = new Map(ACHIEVEMENTS.map((a) => [a.id, a]));

export function achievementById(id: string): Achievement | undefined {
  return BY_ID.get(id);
}

export function unlockedCount(profile: Profile): number {
  return ACHIEVEMENTS.filter((a) => profile.unlocked[a.id]).length;
}

/** 检查并解锁；返回本次新解锁的成就（供界面弹提示） */
export function checkAchievements(profile: Profile, state: GameState, event: AchEvent): Achievement[] {
  const fresh: Achievement[] = [];
  for (const ach of ACHIEVEMENTS) {
    if (profile.unlocked[ach.id]) continue;
    if (ach.check({ state, event, profile })) {
      profile.unlocked[ach.id] = Date.now();
      fresh.push(ach);
    }
  }
  return fresh;
}
