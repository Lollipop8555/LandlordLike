// 引擎级对局模拟：不经浏览器，直接驱动 createGame / spin / payRent。
//
// 用法：
//   npm run sim                     默认策略（每次奖励三选一）
//   npm run sim -- --buy=3 --seeds=500
//
// 参数：
//   --seeds=N   模拟局数（默认 300）
//   --buy=N     每次奖励从商店取 N 张（默认 1，与源码 symbols_to_choose_from 的「候选 3 领 1」一致；2/3 用于对照）
//   --spins=N   首期额外旋转次数（默认 0，用于验证旋转供给敏感性）
//   --rounds=N  打印前 N 期明细（默认 6）
import { buyFromShop, closeShop, createGame, payRent, spin } from '../src/engine';
import { rentRowFor } from '../src/data';

// 脚本由 esbuild 打包后交给 node 运行；项目不带 @types/node，这里只声明用到的部分。
declare const process: { argv: string[] };

interface Args {
  seeds: number;
  buy: number;
  extraSpins: number;
  rounds: number;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { seeds: 300, buy: 1, extraSpins: 0, rounds: 6 };
  for (const raw of argv) {
    const m = /^--([a-z]+)=(\d+)$/.exec(raw);
    if (!m) continue;
    const n = Number(m[2]);
    if (m[1] === 'seeds') out.seeds = n;
    if (m[1] === 'buy') out.buy = n;
    if (m[1] === 'spins') out.extraSpins = n;
    if (m[1] === 'rounds') out.rounds = n;
  }
  return out;
}

interface RoundLog {
  spins: number;
  output: number;
  rent: number;
  coinsAfter: number;
  paid: boolean;
}

interface RunResult {
  diedAt: number;
  rounds: RoundLog[];
}

/** 按估值取卡：每次 spin 后 / 付租后各有一轮三选一 */
function takeFromShop(game: ReturnType<typeof createGame>, buy: number): void {
  if (!game.shopOpen) return;
  for (let k = 0; k < buy && game.shop.length > 0; k += 1) {
    let best = 0;
    let bestValue = -Infinity;
    game.shop.forEach((card, i) => {
      if (card.def.value > bestValue) {
        bestValue = card.def.value;
        best = i;
      }
    });
    buyFromShop(game, best);
  }
  closeShop(game);
}

/** 一局：付租前尽量旋转（每次旋转后取卡），付租后再取一次 */
function play(seed: number, args: Args): RunResult {
  const game = createGame(seed);
  game.spinsLeft += args.extraSpins;
  const rounds: RoundLog[] = [];

  for (let round = 1; round <= 12; round += 1) {
    const spins = game.spinsLeft;
    while (game.spinsLeft > 0) {
      spin(game);
      takeFromShop(game, args.buy);
    }
    const output = game.roundEarned;
    const rent = rentRowFor(round).rent;
    const res = payRent(game);
    rounds.push({ spins, output, rent, coinsAfter: game.coins, paid: res.ok });
    if (!res.ok) return { diedAt: round, rounds };

    takeFromShop(game, args.buy);
    if (game.won) return { diedAt: 0, rounds };
  }
  return { diedAt: 0, rounds };
}

const args = parseArgs(process.argv.slice(2));
const results = Array.from({ length: args.seeds }, (_, i) => play(9000 + i, args));

const wins = results.filter((r) => r.diedAt === 0).length;
const died = new Map<number, number>();
for (const r of results) if (r.diedAt) died.set(r.diedAt, (died.get(r.diedAt) ?? 0) + 1);

console.log(
  `策略：每次奖励取 ${args.buy} 张 · 首期 +${args.extraSpins} 旋转 · ${args.seeds} 局\n` +
    `通关 ${wins}（${((wins / args.seeds) * 100).toFixed(1)}%） · 破产 ${args.seeds - wins}\n` +
    `破产期分布 ${JSON.stringify([...died.entries()].sort((a, b) => a[0] - b[0]))}`,
);

console.log('\n期 | 旋转 | 产出 | 租金 | 缺口 | 付租后余额');
for (let round = 1; round <= args.rounds; round += 1) {
  const rows = results.map((r) => r.rounds[round - 1]).filter((x): x is RoundLog => Boolean(x));
  if (!rows.length) break;
  const avg = (f: (x: RoundLog) => number): number => rows.reduce((n, x) => n + f(x), 0) / rows.length;
  const rent = rentRowFor(round).rent;
  const output = avg((x) => x.output);
  console.log(
    `${String(round).padStart(2)} | ${avg((x) => x.spins).toFixed(1).padStart(4)} | ${output
      .toFixed(1)
      .padStart(4)} | ${String(rent).padStart(4)} | ${(rent - output).toFixed(1).padStart(5)} | ${avg((x) => x.coinsAfter)
      .toFixed(1)
      .padStart(6)}`,
  );
}
