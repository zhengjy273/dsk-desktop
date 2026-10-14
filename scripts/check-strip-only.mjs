/**
 * 防回归检查：本项目的 .ts 由 Electron 44 直接运行（Node **strip-only** 类型剥离），
 * 因此**只允许纯类型语法**。以下语法会在运行期抛 ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX：
 *
 *   - 构造函数参数属性：`constructor(private readonly x: T)`   ← 本项目已踩过
 *   - `enum` / `namespace`（含 `module X {}`）
 *   - 装饰器（experimental decorators）
 *
 * 这类错误 tsc 不会报（类型层面合法），只在运行期炸，所以必须有独立检查。
 *
 * 用法：node scripts/check-strip-only.mjs        # 有违规时退出码 1
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_DIRS = ['src', 'tests', 'spike', 'scripts'];
const IGNORE_DIRS = new Set(['node_modules', 'dist', '.git']);

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (IGNORE_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|mts|cts)$/.test(name)) out.push(p);
  }
  return out;
}

/** 构造函数参数属性检测：先取出 constructor 的参数列表，再看是否带可见性/readonly 修饰符。 */
function findParamProperty(code) {
  const m = code.match(/constructor\s*\(([\s\S]*?)\)\s*\{/);
  if (!m || !m[1]) return null;
  return /(?:^|,|\s)(?:private|public|protected|readonly)\s+[A-Za-z_$][\w$]*\s*[?:]/.test(m[1])
    ? m[1].trim().slice(0, 80)
    : null;
}

const RULES = [
  ['constructor-parameter-property', (c) => findParamProperty(c)],
  ['enum', (c) => (/\benum\s+[A-Za-z_$][\w$]*\s*\{/.exec(c) ?? [])[0] ?? null],
  ['namespace', (c) => (/\b(?:namespace|module)\s+[A-Za-z_$][\w$]*\s*\{/.exec(c) ?? [])[0] ?? null],
  ['decorator', (c) => (/^\s*@[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*\(/m.exec(c) ?? [])[0] ?? null],
];

const files = SCAN_DIRS.flatMap((d) => walk(join(ROOT, d)));
const violations = [];

/** 剥离注释但**保持行号不变**：本项目的注释里会举例说明被禁止的写法，不能把它们算成违规。 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/^([ \t]*)\/\/.*$/gm, (_m, indent) => indent);
}

for (const file of files) {
  const code = stripComments(readFileSync(file, 'utf8'));
  for (const [id, detect] of RULES) {
    const hit = detect(code);
    if (hit) {
      const idx = code.indexOf(hit);
      const line = code.slice(0, Math.max(idx, 0)).split('\n').length;
      violations.push({ file: relative(ROOT, file), line, rule: id, sample: hit.replace(/\s+/g, ' ').slice(0, 70) });
    }
  }
}

console.log(`[strip-only] 扫描 ${files.length} 个文件，规则：参数属性 / enum / namespace / 装饰器`);
if (!violations.length) {
  console.log('[strip-only] OK：没有 strip-only 不兼容语法');
  process.exit(0);
}
for (const v of violations) {
  console.error(`[strip-only] ✗ ${v.file}:${v.line}  ${v.rule}  →  ${v.sample}`);
}
console.error(`[strip-only] 共 ${violations.length} 处违规；这些写法 tsc 不报错但 Electron 运行期会崩。`);
process.exit(1);
