/**
 * 棋盘彩蛋互动。
 *
 * 原版 Stats.gd 的计数器（摸狗时长、兔子跳数）是靠悬停时播放动画、
 * 每帧 `add_stat` 累加出来的（Slot_Icon__Slot_Icon.gd:680-712 的 petting 分支）。
 * Web 版沿用同一套数值：
 *   - 桌面端悬停 → 每帧按原版增量累加（60fps 基准）；
 *   - 移动端没有 hover，点一下视为摸了一小会儿（perTap）。
 * 单位保持源码写法（小时 / 跳），成就阈值才和原版对得上。
 */
export interface EggDef {
  /** 符号 id */
  id: string;
  /** 动作名，用于提示文案 */
  verb: string;
  /** 存档统计名（progress/save.ts 的 STAT_KEYS 键） */
  stat: string;
  /** 每帧增量（原版 add_stat 的数值） */
  perFrame: number;
  /** 点击一次相当于多久/多少下 */
  perTap: number;
  hint: string;
}

export const EGGS: EggDef[] = [
  {
    id: 'dog',
    verb: '撸狗',
    stat: 'time_spent_petting_dog',
    // 源码：add_stat("time_spent_petting_dog", 35.0 / 3600.0, false)，逐帧
    perFrame: 35 / 3600,
    perTap: 0.3,
    hint: '尾巴摇起来了',
  },
  {
    id: 'rabbit',
    verb: '逗兔子',
    stat: 'rabbit_hops',
    // 源码：add_stat("rabbit_hops", 3.0 / 31.0, false)，逐帧
    perFrame: 3 / 31,
    perTap: 20,
    hint: '兔子蹦了一下',
  },
];

export const EGG_BY_ID = new Map(EGGS.map((e) => [e.id, e]));
