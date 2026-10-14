/**
 * 只读分析**请求体样本**的结构：只输出键名 / 类型 / 长度 / 形态标签，
 * 用户长文本**只报长度不报内容**（避免把对话内容写进报告或终端）。
 *
 * 用途：确认"用户消息"与"会话 id"在请求体里的确切字段位置。
 * 用法：node spike/inspect-request.mjs [样本文件…]
 */
import { readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'docs', 'm2-evidence', 'request-samples');

const args = process.argv.slice(2);
const files = args.length > 0 ? args : readdirSync(DIR).sort().map((f) => join(DIR, f));

if (files.length === 0) {
  console.log('（没有请求体样本）');
  process.exit(0);
}

for (const file of files) {
  const raw = readFileSync(file, 'utf8');
  console.log(`\n=== ${basename(file)}（${raw.length} 字符）`);
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    console.log(`  非合法 JSON：${e.message}`);
    continue;
  }

  const walk = (value, path, depth) => {
    if (depth > 3) return;
    if (value === null) {
      console.log(`  ${path}: null`);
      return;
    }
    if (Array.isArray(value)) {
      console.log(`  ${path}: array[${value.length}]`);
      if (value.length > 0) walk(value[0], `${path}[0]`, depth + 1);
      return;
    }
    if (typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) walk(v, path ? `${path}.${k}` : k, depth + 1);
      return;
    }
    if (typeof value === 'string') {
      const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(value);
      const tag = uuid ? 'uuid' : value.length <= 12 ? 'short/枚举' : '长文本';
      console.log(`  ${path}: string(len=${value.length}, ${tag})`);
      return;
    }
    console.log(`  ${path}: ${typeof value} = ${String(value)}`);
  };
  walk(obj, '$', 0);
}
