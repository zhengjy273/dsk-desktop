/**
 * DSH 插件注册表扫描器 —— 从 awesome-dsh-plugin 快照里按关键词找可用插件。
 *
 * 快照字段：name/owner/url/page/category/description{en,zh}/npm/version/stars/downloads/
 *          capabilities/capabilityRedLines/install/added
 * 选插件原则（对应方案 R1–R8）：优先选 capabilityRedLines 为空、capabilities 不含
 *          fs-write/env/net-egress 之类的插件；能用纯配置插件就不装可执行代码。
 *
 * 用法：
 *   node spike/registry-scan.mjs                 # 打印结构 + 样例
 *   node spike/registry-scan.mjs webview tray    # 按关键词过滤
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'docs', 'm0-evidence', 'plugins.json');
const raw = JSON.parse(readFileSync(FILE, 'utf8'));

const items = Array.isArray(raw)
  ? raw
  : raw.plugins || raw.items || raw.data || raw.list || Object.values(raw).find(Array.isArray) || [];

const pick = (o, names) => {
  for (const n of names) {
    if (o && o[n] !== undefined && o[n] !== null && o[n] !== '') return o[n];
  }
  return undefined;
};
const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const asText = (v) => (typeof v === 'object' && v !== null ? v.zh || v.en || JSON.stringify(v) : v);

console.log(`file=${FILE}`);
console.log(`top-level=${Array.isArray(raw) ? 'array' : 'object keys=' + Object.keys(raw).slice(0, 12).join(',')}`);
console.log(`items=${items.length}`);
if (items[0]) {
  console.log(`fields=${Object.keys(items[0]).join(',')}`);
  const cats = {};
  for (const it of items) cats[it.category || '?'] = (cats[it.category || '?'] || 0) + 1;
  console.log('categories=' + Object.entries(cats).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(' '));
}

const kws = process.argv.slice(2).map((s) => s.toLowerCase());
if (!kws.length) process.exit(0);

const rows = [];
for (const it of items) {
  const name = asText(pick(it, ['name', 'package', 'pkg', 'id', 'title', 'plugin'])) ?? '';
  const desc = clip(asText(pick(it, ['description', 'desc', 'summary'])) ?? '', 140);
  const repo = pick(it, ['repository', 'repo', 'url', 'github', 'homepage']) ?? '';
  const page = pick(it, ['page']) ?? '';
  const cat = asText(pick(it, ['category'])) ?? '';
  const tags = pick(it, ['keywords', 'tags']) ?? '';
  const caps = pick(it, ['capabilities']) ?? [];
  const red = pick(it, ['capabilityRedLines']) ?? [];
  const stars = pick(it, ['stars']) ?? '';
  const dl = pick(it, ['downloads']) ?? '';
  const upd = clip(pick(it, ['added', 'updatedAt', 'updated']) ?? '', 10);
  const hay = `${name} ${desc} ${repo} ${page} ${cat} ${Array.isArray(tags) ? tags.join(' ') : tags}`.toLowerCase();
  const hit = kws.filter((k) => hay.includes(k));
  if (hit.length) {
    rows.push({
      name, hit: hit.join('+'), stars, dl, upd, cat,
      repo: clip(repo, 72),
      desc,
      caps: (Array.isArray(caps) ? caps : [caps]).filter(Boolean).join(','),
      red: (Array.isArray(red) ? red : [red]).filter(Boolean).join(','),
    });
  }
}

rows.sort((a, b) => Number(b.dl || 0) - Number(a.dl || 0));
console.log(`\n=== matches=${rows.length} (keywords: ${kws.join(', ')}) 按下载量排序 ===`);
for (const r of rows.slice(0, 70)) {
  console.log(
    `- [${r.hit}] ${r.name} | ${r.cat} | ★${r.stars || '?'} dl=${r.dl || '?'} | ${r.repo}\n` +
      `    caps=[${r.caps}]${r.red ? ' ⚠️REDLINES=[' + r.red + ']' : ''}\n    ${r.desc}`,
  );
}
