import { effectCoverage, ruleStatus, rulesOf } from '../src/effects';
import { EFFECTS, PLACEABLES } from '../src/data';

const cov = effectCoverage();
console.log(
  `total=${cov.total} executable=${cov.executable} gated=${cov.gated} dynamic=${cov.dynamic} noop=${cov.noop}`,
);

const noop = EFFECTS.filter((r) => ruleStatus(r) === 'noop');
const byVtc = new Map<string, number>();
for (const r of noop) byVtc.set(r.vtc || '<空>', (byVtc.get(r.vtc || '<空>') ?? 0) + 1);
console.log('\n--- noop 按 vtc');
for (const [k, n] of [...byVtc].sort((a, b) => b[1] - a[1])) console.log(`  ${n}  ${k}`);
console.log('样例:');
for (const r of noop.slice(0, 8)) console.log(`  ${r.symbol} #${r.i} vtc='${r.vtc}' cmp=${JSON.stringify(r.comparisons).slice(0, 90)} flags=[${r.flags.join(',')}]`);

const noRule = PLACEABLES.filter((p) => rulesOf(p.id).length === 0);
console.log(`\n无声明可放置物 ${noRule.length}/${PLACEABLES.length}`);
console.log(noRule.map((p) => p.id).join(' '));
