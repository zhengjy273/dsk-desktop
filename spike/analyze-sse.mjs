/**
 * 只读分析抓到的 SSE 样本：**只输出结构**（键路径 / 类型 / 长度 / 事件分布），
 * **不输出任何对话内容** —— 便于把"该往候选路径里加什么"写进报告，同时不泄露会话。
 *
 * 用法：
 *   node spike/analyze-sse.mjs                 # 分析 docs/m2-evidence/sse-samples 下全部 .txt
 *   node spike/analyze-sse.mjs <file> [file2]  # 分析指定样本
 *
 * 复用 src/session/sse-parser.ts 的解析与结构指纹（Node 24 支持直接 import .ts）。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSseFrames, structureFingerprint } from '../src/session/sse-parser.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLE_DIR = join(ROOT, 'docs', 'm2-evidence', 'sse-samples');

const argv = process.argv.slice(2);
const files = argv.length
  ? argv
  : readdirSync(SAMPLE_DIR)
      .filter((f) => f.endsWith('.txt'))
      .sort()
      .map((f) => join(SAMPLE_DIR, f));

if (files.length === 0) {
  console.log('（没有样本文件）');
  process.exit(0);
}

function quantile(nums, q) {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))];
}

for (const file of files) {
  const raw = readFileSync(file, 'utf8');
  const frames = parseSseFrames(raw);
  const fp = structureFingerprint(raw);

  const eventCounts = {};
  for (const f of frames) {
    const key = f.event ?? '(无 event 字段)';
    eventCounts[key] = (eventCounts[key] ?? 0) + 1;
  }

  const dataLens = frames.map((f) => f.data.length);
  const jsonFrames = frames.filter((f) => {
    const d = f.data.trim();
    if (!d) return false;
    try {
      JSON.parse(d);
      return true;
    } catch {
      return false;
    }
  });
  const nonJsonSamples = frames
    .map((f) => f.data.trim())
    .filter((d) => d && d !== '[DONE]')
    .filter((d) => {
      try {
        JSON.parse(d);
        return false;
      } catch {
        return true;
      }
    })
    // 非 JSON 帧可能是纯文本增量；只报告"形态"，截断且去掉可能的正文
    .map((d) => (d.startsWith('{') || d.startsWith('[') ? `(损坏 JSON，长度 ${d.length})` : `(非 JSON，长度 ${d.length})`));

  console.log(`\n=== ${basename(file)}`);
  console.log(`  原始字符数=${raw.length}；帧数=${frames.length}；其中 JSON 帧=${jsonFrames.length}`);
  console.log(`  event 分布=${JSON.stringify(eventCounts)}`);
  console.log(
    `  data 长度：min=${Math.min(...dataLens, 0)} 中位=${quantile(dataLens, 0.5)} p90=${quantile(dataLens, 0.9)} max=${Math.max(...dataLens, 0)}`,
  );
  console.log(`  是否存在 [DONE] 结束标记=${raw.includes('[DONE]')}`);
  if (nonJsonSamples.length) {
    console.log(`  非 JSON 帧形态（去内容）：${JSON.stringify(nonJsonSamples.slice(0, 5))}`);
  }
  console.log(`  结构键路径与类型（共 ${fp.keys.length} 个，不含任何值）：`);
  for (const k of fp.keys) console.log(`    ${k}: ${fp.sampleTypes[k]}`);

  // 键的"出现次数"与"值的长度区间"——判断哪个键是正文增量、哪个是固定字段
  const stats = new Map();
  for (const f of jsonFrames) {
    let obj;
    try {
      obj = JSON.parse(f.data.trim());
    } catch {
      continue;
    }
    const walk = (v, prefix) => {
      if (v === null || typeof v !== 'object') {
        if (typeof v === 'string') {
          const cur = stats.get(prefix) ?? { count: 0, minLen: Infinity, maxLen: 0 };
          cur.count += 1;
          cur.minLen = Math.min(cur.minLen, v.length);
          cur.maxLen = Math.max(cur.maxLen, v.length);
          stats.set(prefix, cur);
        }
        return;
      }
      if (Array.isArray(v)) {
        v.forEach((item, i) => walk(item, `${prefix}[${i}]`));
        return;
      }
      for (const [k, vv] of Object.entries(v)) walk(vv, prefix ? `${prefix}.${k}` : k);
    };
    walk(obj, '');
  }
  console.log('  字符串字段统计（出现次数 @ 长度 min~max，值不输出）：');
  for (const [k, s] of [...stats.entries()].sort((a, b) => b[1].count - a[1].count)) {
    console.log(`    ${k}: ${s.count} 次 @ ${s.minLen}~${s.maxLen}`);
  }

  // 只对**枚举类字段**打印去重值（白名单 + 长度上限）：它们不是对话内容，却直接决定解析映射
  const ENUM_FIELDS = [
    'v.response.role',
    'v.response.status',
    'v.response.conversation_mode',
    'v.response.model',
    'v.response.fragments[].type',
    'v[].type',
    'o',
    'click_behavior',
  ];
  const enumValues = new Map();
  for (const f of jsonFrames) {
    let obj;
    try {
      obj = JSON.parse(f.data.trim());
    } catch {
      continue;
    }
    const collect = (v, prefix) => {
      if (v === null || typeof v !== 'object') {
        if (typeof v === 'string' && ENUM_FIELDS.includes(prefix) && v.length <= 24) {
          const set = enumValues.get(prefix) ?? new Set();
          set.add(v);
          enumValues.set(prefix, set);
        }
        return;
      }
      if (Array.isArray(v)) {
        for (const item of v) collect(item, `${prefix}[]`);
        return;
      }
      for (const [k, vv] of Object.entries(v)) collect(vv, prefix ? `${prefix}.${k}` : k);
    };
    collect(obj, '');
  }
  console.log('  枚举类字段的去重值（白名单，非对话内容）：');
  if (enumValues.size === 0) console.log('    （无）');
  for (const [k, set] of enumValues) console.log(`    ${k}: ${JSON.stringify([...set])}`);
}
