/**
 * 诊断一轮 SSE 的**阶段归属**：打印 fragments 快照帧的 type / stage_id / status 序列，
 * 以及解析出的正文与思考字符数。**不打印任何对话内容。**
 *
 * 用途：上一轮"靠 fragments[].type 切换到正文阶段"是推断，真实归档出现
 * "正文=0字 / 思考=359字" 的异常，需要看清阶段信号到底是什么。
 *
 * 用法：node spike/diagnose-turn.mjs <样本文件>
 */
import { readFileSync } from 'node:fs';
import { parseDeepSeekSse, parseSseFrames } from '../src/session/sse-parser.ts';

const file = process.argv[2];
if (!file) {
  console.error('用法：node spike/diagnose-turn.mjs <样本文件>');
  process.exit(1);
}
const raw = readFileSync(file, 'utf8');
const frames = parseSseFrames(raw);

const snapshots = [];
const deltaStats = { string: 0, object: 0, array: 0, other: 0 };
let index = 0;

for (const f of frames) {
  index += 1;
  const data = f.data.trim();
  if (!data) continue;
  let obj;
  try {
    obj = JSON.parse(data);
  } catch {
    continue;
  }

  const v = obj?.v;
  if (typeof v === 'string') {
    deltaStats.string += 1;
    continue;
  }
  if (Array.isArray(v)) {
    deltaStats.array += 1;
    // 数组形态：可能是引用集合
    const kinds = new Set();
    for (const item of v) {
      if (item === null || typeof item !== 'object') continue;
      if (typeof item.url === 'string') kinds.add('citation');
      else if (Array.isArray(item.v)) kinds.add('nested-array');
      else kinds.add('other');
    }
    if (kinds.has('citation') || kinds.has('nested-array')) {
      snapshots.push(`#${index} v=array[${v.length}] kinds=[${[...kinds].join(',')}] o=${obj?.o ?? '-'}`);
    }
    continue;
  }
  if (v !== null && typeof v === 'object') {
    deltaStats.object += 1;
    const resp = v.response ?? {};
    const frags = Array.isArray(resp.fragments) ? resp.fragments : [];
    if (frags.length > 0 || resp.status !== undefined) {
      snapshots.push(
        `#${index} o=${obj?.o ?? '-'} status=${resp.status ?? '-'} pending=${resp.has_pending_fragment ?? '-'}` +
          ` thinking_enabled=${resp.thinking_enabled ?? '-'} frags=[${frags
            .map((x) => `${x?.type ?? '?'}(stage=${x?.stage_id ?? '-'},len=${String(x?.content ?? '').length})`)
            .join(' ')}]`,
      );
    }
    continue;
  }
  deltaStats.other += 1;
}

const turn = parseDeepSeekSse(raw);
console.log(`帧=${frames.length}｜增量文本帧=${deltaStats.string}｜对象帧=${deltaStats.object}｜数组帧=${deltaStats.array}`);
console.log(
  `解析结果：正文=${turn.text.length}字 思考=${turn.thinking.length}字 引用=${turn.citations.length} done=${turn.done} skipped=${turn.skipped}`,
);
console.log(`counts=${JSON.stringify(turn.counts)}`);
console.log(`快照帧 ${snapshots.length} 个（按出现顺序，最多 25 条）：`);
for (const s of snapshots.slice(0, 25)) console.log('  ' + s);
