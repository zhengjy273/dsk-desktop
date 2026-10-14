/**
 * 深入查看**单个最大帧**的结构骨架 —— 只输出键路径、类型与字符串长度，**不输出任何内容**。
 *
 * 用途：确认"最终快照"里消息 / 片段 / 引用的完整结构，进而决定解析策略
 *（快照优先 vs 增量拼接）。样本里出现过 18872 字符的单帧，值得单独看清。
 *
 * 用法：node spike/inspect-frame.mjs <样本文件> [--index=N]
 */
import { readFileSync } from 'node:fs';
import { parseSseFrames } from '../src/session/sse-parser.ts';

const file = process.argv[2];
if (!file) {
  console.error('用法：node spike/inspect-frame.mjs <样本文件>');
  process.exit(1);
}
const indexArg = process.argv.find((a) => a.startsWith('--index='));

const raw = readFileSync(file, 'utf8');
const frames = parseSseFrames(raw);

const jsonFrames = frames
  .map((f, i) => ({ i, event: f.event, data: f.data.trim() }))
  .filter((f) => {
    if (!f.data) return false;
    try {
      JSON.parse(f.data);
      return true;
    } catch {
      return false;
    }
  });

let target;
if (indexArg) {
  const want = Number(indexArg.slice('--index='.length));
  target = jsonFrames.find((f) => f.i === want) ?? jsonFrames[0];
} else {
  target = jsonFrames.reduce((a, b) => (b.data.length > a.data.length ? b : a), jsonFrames[0]);
}
if (!target) {
  console.log('（没有可解析的 JSON 帧）');
  process.exit(0);
}

const obj = JSON.parse(target.data);
console.log(`帧 #${target.i}｜event=${target.event ?? '(无)'}｜长度=${target.data.length} 字符｜共 ${jsonFrames.length} 个 JSON 帧`);

const out = [];
const tree = (v, label, depth) => {
  const pad = '  '.repeat(depth);
  if (v === null) {
    out.push(`${pad}${label}: null`);
    return;
  }
  if (Array.isArray(v)) {
    out.push(`${pad}${label}: array[${v.length}]`);
    if (v.length > 0 && depth < 8) tree(v[0], '[0]', depth + 1);
    return;
  }
  if (typeof v === 'object') {
    const keys = Object.keys(v);
    out.push(`${pad}${label}: object{${keys.length}}`);
    if (depth < 8) for (const [k, vv] of Object.entries(v)) tree(vv, k, depth + 1);
    return;
  }
  if (typeof v === 'string') {
    out.push(`${pad}${label}: string(len=${v.length})`);
    return;
  }
  out.push(`${pad}${label}: ${typeof v} = ${String(v)}`);
};
tree(obj, '$', 0);
console.log(out.join('\n'));

// 另外给出"各 JSON 帧长度分布 top5"，帮助判断快照出现在流的哪个位置
const top = [...jsonFrames].sort((a, b) => b.data.length - a.data.length).slice(0, 5);
console.log('\n最大的 5 个 JSON 帧（位置 / 长度）：');
for (const f of top) console.log(`  #${f.i} event=${f.event ?? '(无)'} len=${f.data.length}`);
