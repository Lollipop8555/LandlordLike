// 文案自查：跑 selfcheck，并逐条打印声明/道具/精华的最终文案，便于人工通读措辞。
// 用法：npx esbuild scripts/check-desc.ts --bundle --format=esm --platform=node \
//         --outfile=node_modules/.cache/check-desc.mjs --log-level=warning && node node_modules/.cache/check-desc.mjs
import { EFFECTS, ESSENCES, ITEMS, SYMBOL_BY_ID } from '../src/data';
import { describeRule } from '../src/effects';
import { essenceLines } from '../src/essence-notes';
import { itemDesc } from '../src/item-notes';
import { runSelfChecks } from '../src/selfcheck';

// 脚本由 esbuild 打包后交给 node 运行；项目不带 @types/node，这里只声明用到的部分
// （与 scripts/sim.ts 的做法一致）。
declare const process: { argv: string[] };

const checks = runSelfChecks();
for (const c of checks.filter((x) => x.group === '文案' || !x.pass)) {
  console.log(c.pass ? 'PASS' : 'FAIL', c.group, c.name, '|', c.actual);
}
console.log(`\n自检合计 ${checks.filter((c) => c.pass).length} / ${checks.length}`);

if (process.argv.includes('--all')) {
  console.log('\n########## 符号 / 道具的声明 ##########');
  for (const rule of EFFECTS) {
    const def = SYMBOL_BY_ID.get(rule.symbol);
    const text = describeRule(rule, def ? { id: def.id, values: def.values ?? [] } : undefined);
    if (text) console.log(`${rule.symbol}\t${text}`);
  }

  console.log('\n########## 道具 ##########');
  for (const item of ITEMS) {
    const d = itemDesc(item.id);
    if (!d) {
      console.log(`\n== ${item.id} <未收录>`);
      continue;
    }
    console.log(`\n== ${item.id} values=${JSON.stringify(item.values)}`);
    console.log(`   概括：${d.summary}`);
    for (const line of d.lines) console.log(`   条件：${line.when}`);
    if (d.selfValueOnly) console.log('   （自身价值不参与产出）');
    if (d.gap) console.log(`   注：${d.gap}`);
  }

  console.log('\n########## 精华 ##########');
  for (const e of ESSENCES) {
    console.log(`\n== ${e.id}`);
    for (const line of essenceLines(e.id)) console.log(`   ${line}`);
  }
}
