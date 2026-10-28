// 棋盘几何：5 列 × 4 行，8 邻域（含对角）
// 依据 docs §3 / §5：Slot_Icon.get_adjacent_icons() 为 8 邻域

export const COLS = 5;
export const ROWS = 4;
export const CELL_COUNT = COLS * ROWS;
/** 每列槽数 = max_icons：4 个可视 + 1 个屏幕外（Main__Main.gd:1237） */
export const SLOTS_PER_REEL = 5;

export const indexOf = (x: number, y: number): number => y * COLS + x;
export const xOf = (i: number): number => i % COLS;
export const yOf = (i: number): number => Math.floor(i / COLS);

/**
 * 8 邻域偏移。`diagonal=false` 退化为 4 邻域（上下左右）；
 * `skipVertical=true` 去掉正上/正下（细则 22：Slot_Icon__Slot_Icon.gd:1184-1191 跳过 n==1 与 n==7）。
 */
export function neighborsOf(i: number, opts: { diagonal?: boolean; skipVertical?: boolean } = {}): number[] {
  const { diagonal = true, skipVertical = false } = opts;
  const x = xOf(i);
  const y = yOf(i);
  const out: number[] = [];
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      if (dx === 0 && dy === 0) continue;
      if (!diagonal && dx !== 0 && dy !== 0) continue;
      if (skipVertical && dx === 0) continue;
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx >= COLS || ny < 0 || ny >= ROWS) continue;
      out.push(indexOf(nx, ny));
    }
  }
  return out;
}

/** 结算遍历顺序：Godot 对 Vector2 的 sort() 是 lexicographic → 列优先、自上而下 */
export const SETTLE_ORDER: number[] = Array.from({ length: CELL_COUNT }, (_, i) => i).sort(
  (a, b) => xOf(a) - xOf(b) || yOf(a) - yOf(b),
);

/** 邻接计数：角 3 / 边 5 / 内部 8，用于自检比对 §9 的 5.50 扇入 */
export function neighborCounts(): number[] {
  return Array.from({ length: CELL_COUNT }, (_, i) => neighborsOf(i).length);
}
