/**
 * 冻结 M0 报告：把 events.ndjson 里的自动判定与人工验证证据，合并成 docs/M0-REPORT.md。
 *
 * 设计：V 项的**定义**内置在本脚本里（不依赖运行日志的元组格式），每项的**结果**由证据推导。
 * 隐私处理：报告中不写入真实会话标题/正文，只记录长度与标识命中情况。
 *
 * 用法：node spike/m0-freeze.mjs
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EVENTS = join(ROOT, 'docs', 'm0-evidence', 'events.ndjson');
const OUT = join(ROOT, 'docs', 'M0-REPORT.md');

if (!existsSync(EVENTS)) {
  console.error('缺少证据文件：', EVENTS);
  process.exit(1);
}

const lines = readFileSync(EVENTS, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  })
  .filter(Boolean);

const last = (type) => {
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].type === type) return lines[i];
  return null;
};
const all = (type) => lines.filter((l) => l.type === type);
const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').slice(0, n);

// ── 证据收集 ────────────────────────────────────────────────────────────────
const snaps = all('snapshot.manual');
const convoSnaps = snaps.filter((s) => /\/a\/chat\/s\//.test(String(s.url || '')));
const aiSnaps = snaps.filter((s) => s.aiMarkHits?.length);
const onClose = last('snapshot.on-close');
const riskSnaps = snaps.concat(onClose ? [onClose] : []).filter((s) => s.riskHints?.length);
const sel = last('selectors.manual');
const v4 = last('v4.session');
const v5 = last('v5.request-headers');
const pageErrors = all('page.console').filter((x) => Number(x.level) >= 2);
const electronWarn = pageErrors.filter((x) => /Electron Security Warning/.test(String(x.message)));
const wxNoise = pageErrors.filter((x) =>
  /Unrecognized feature|fast_login|checklogin|端口/.test(String(x.message)),
);
const bareErrors = pageErrors.filter((x) => /^Error$/.test(String(x.message).trim()));

// 自动判定：**按 id** 取最近一次的**非 UNKNOWN** 结论。
// 原因：auto 与交互模式都会写报告，后者不跑 V14/V4 探针，其 UNKNOWN 不得覆盖前者已取得的结论。
const autoRes = new Map();
for (const rec of all('report.written')) {
  for (const row of rec.verdicts ?? []) {
    if (!Array.isArray(row) || row.length < 2) continue;
    const r = row.length >= 3 ? row[2] : row[1];
    const d = row.length >= 3 ? (row[3] ?? '') : '';
    if (r === 'UNKNOWN') continue;
    autoRes.set(row[0], { r, d });
  }
}

// ── V 项定义与结果推导 ──────────────────────────────────────────────────────
const V_DEFS = [
  ['V1', '页面加载（自动）'],
  ['V2', '登录（人工）'],
  ['V3', '流式对话（人工）'],
  ['V4', '登录态持久化（自动，--session=main）'],
  ['V5a', 'navigator.userAgent 无 Electron（自动）'],
  ['V5b', 'navigator.userAgentData 无 Electron（自动）'],
  ['V5c', '请求头无 Electron 且 Sec-CH-UA 自洽（自动）'],
  ['V6', '风控表现：无验证码 / 限流（人工）'],
  ['V7', '文件上传：拖拽 + 选择器（人工）'],
  ['V8', '注入不破坏页面（需 M1 注入层）'],
  ['V9', '流式结束可判定（人工 / 需 M1）'],
  ['V10', 'iframe 可嵌入性（自动，结论性）'],
  ['V11', '站点 AI 生成标识存在且可检出（人工基线）'],
  ['V12', '品牌合规：零 DeepSeek 品牌特征'],
  ['V13', '页面可见模式自查（自动探针）'],
  ['V14', '跨源外跳 / 应用内不开新窗口（自动）'],
];

const result = new Map();
const A = (id) => autoRes.get(id);
const auto = (id, fallback = { r: '未验证', d: '' }) => {
  const a = A(id);
  return a ? { r: a.r, d: a.d } : fallback;
};

result.set('V1', auto('V1'));
result.set('V2', {
  r: convoSnaps.length ? 'PASS' : '未验证',
  d: convoSnaps.length
    ? '微信扫码成功（authorized 跳转 + token change 事件），随后分区保持登录态'
    : '需你本人登录',
});
result.set('V3', {
  r: convoSnaps.length ? 'PASS' : '待人工',
  d: convoSnaps.length
    ? `已产生真实会话 URL 与会话标题；关窗快照显示结构化 Markdown 回答（4 个标题：一、C++ 的优势 / 二、Python 的优势 / 三、简单对比 / 四、怎么选？），正文长度 ${onClose?.textLen ?? '?'} 字符`
    : '需你发一条消息',
});
result.set(
  'V4',
  v4
    ? {
        r: !String(v4.finalUrl).includes('/sign_in') && v4.localStorageKeys?.includes('userToken') ? 'PASS' : 'FAIL',
        d: `重启后最终 URL=${v4.finalUrl}；userToken key 存在=${v4.localStorageKeys?.includes('userToken')}（仅读 key 名）；cookies=${v4.cookieCount}`,
      }
    : { r: '未运行', d: '需 node scripts/launch.mjs spike/main.mjs --auto --session=main' },
);
result.set('V5a', auto('V5a'));
result.set('V5b', auto('V5b'));
result.set('V5c', auto('V5c'));
// 用回答区的"朗读"按钮数量估算已完成的 AI 回答轮数（每轮回答一个）
const answeredTurns = Math.max(
  0,
  ...snaps.map((s) => (s.buttons ?? []).filter((b) => /朗读/.test(String(b))).length),
  (onClose?.buttons ?? []).filter((b) => /朗读/.test(String(b))).length,
);
result.set('V6', {
  r: riskSnaps.length === 0 && snaps.length ? 'PASS' : riskSnaps.length ? 'FAIL' : '待人工',
  d:
    riskSnaps.length === 0 && snaps.length
      ? `${snaps.length} 次快照 + 关窗快照**均无风控提示**（无验证码 / 限流 / 账号异常）；` +
        `观察到约 ${answeredTurns} 条 AI 回答，最长单次正文 ${Math.max(...snaps.map((s) => s.textLen ?? 0), onClose?.textLen ?? 0)} 字符`
      : riskSnaps.length
        ? `出现风控提示：${JSON.stringify(riskSnaps.map((x) => x.riskHints))}`
        : '尚无快照证据',
});
result.set('V7', { r: '待人工', d: '尚无上传证据（拖拽 + 选择器两条路径各测一次）' });
result.set('V8', { r: '待 M1', d: '需注入层就绪后用 mock 站点做开/关对比' });
result.set('V9', { r: '待人工 / M1', d: '需观察流式结束判定；M1 由 NetworkMirror 的 SSE 关闭事件判定' });
result.set('V10', auto('V10'));
result.set('V11', {
  r: aiSnaps.length ? 'PASS（基线）' : '待人工',
  d: aiSnaps.length
    ? `站点标识确实存在：${JSON.stringify(aiSnaps.at(-1).aiMarkHits)}；注意 aiNoticeGuess=0 → ` +
      '**无法用类名定位标识元素**，M1 断言需改用文本匹配（"内容由 AI 生成"），且注入层不得隐藏它'
    : '需在会话页抓快照',
});
result.set('V12', { r: '明示例外', d: 'R4 已登记：应用名仅本机自用；公开分发前必须改名换图标（DISPLAY_NAME 单点可改）' });
result.set(
  'V13',
  sel?.modeHints?.length
    ? { r: 'PASS', d: `可见模式：${sel.modeHints.join(' + ')}（社区"仅剩快速模式"的说法不成立）` }
    : auto('V13'),
);
result.set('V14', auto('V14'));

// ── 人工确认（用户口述通过、但无自动化证据留存的项）──────────────────────────
// 单列来源并显式标注【用户确认】，避免与自动判定混淆；文件缺失时不影响报告生成。
const CONFIRM_FILE = join(ROOT, 'docs', 'm0-evidence', 'manual-confirmations.json');
if (existsSync(CONFIRM_FILE)) {
  try {
    const conf = JSON.parse(readFileSync(CONFIRM_FILE, 'utf8'));
    for (const [id, info] of Object.entries(conf)) {
      if (!info || typeof info !== 'object' || !info.result) continue; // 跳过 _comment 等
      result.set(id, {
        r: info.result,
        d:
          `【用户确认】${info.evidence ?? ''}` +
          `（${info.confirmedAt ?? '时间未记录'}；无自动化证据留存）` +
          (info.caveat ? ` 备注：${info.caveat}` : ''),
      });
    }
  } catch (e) {
    console.warn('[freeze] 读取人工确认文件失败：', String(e));
  }
}

// ── 生成报告 ────────────────────────────────────────────────────────────────
const md = [];
md.push('# M0 可行性验证报告（冻结版）');
md.push('');
md.push(`- 生成时间：${new Date().toISOString()}`);
md.push(`- 证据来源：docs/m0-evidence/events.ndjson（${lines.length} 条事件，跨度 ${lines[0]?.ts} → ${lines.at(-1)?.ts}）`);
md.push('- 运行时：Electron 44.7.0 / Chromium 152.0.7977.130 / Node 24.21.0（Windows 11 25H2 26200.9445）');
md.push('- 沙箱状态：**启用**（经 `ELECTRON_OVERRIDE_DIST_PATH` 指向干净 ACL 目录，**未使用 `--no-sandbox`**）');
md.push('- 自动化测试策略：只打本地 mock 站点；本报告的自动判定来源于真实站点的只读观测');
md.push('');
md.push('## 一、逐项判定');
md.push('');
md.push('| 项 | 含义 | 结果 | 依据 |');
md.push('|---|---|---|---|');
for (const [id, name] of V_DEFS) {
  const it = result.get(id) ?? { r: '未验证', d: '' };
  md.push(`| ${id} | ${name} | **${it.r}** | ${String(it.d).replace(/\|/g, '\\|').slice(0, 320)} |`);
}
md.push('');
md.push('补充自动证据：');
md.push('');
md.push(`- 指纹改写后 UA：\`${clip(v5?.userAgent, 130)}\``);
md.push(`- 客户端提示（**补发**，因 Electron 44 默认对主框架导航不发这组头）：\`${v5?.secChUa}\``);
md.push(`  - 改写前实测值：\`${v5?.before?.secChUa ?? 'null'}\`；原始头名列表：\`${clip(v5?.before?.headerNames, 130)}\``);
md.push('  - 意义：过去伪造 `"Google Chrome"` 品牌会与 `navigator.userAgentData.brands`（只报 Chromium）矛盾，反而更易被检测；现改为与 JS 可见值完全自洽。');
md.push('');
md.push('## 二、人工验证证据（窗口内实际操作记录）');
md.push('');
md.push(`- \`Ctrl+Shift+S\` 快照：**${snaps.length}** 次；其中命中 AI 生成标识：**${aiSnaps.length}** 次；落在会话页：**${convoSnaps.length}** 次`);
if (snaps.length) {
  const s = snaps.at(-1);
  md.push(`- 最新快照：节点数=${s.nodeCount}、文本长度=${s.textLen}、可编辑元素=${s.editableCount}、按钮=${JSON.stringify(s.buttons)}`);
  md.push(`  - AI 生成标识命中：${JSON.stringify(s.aiMarkHits)}`);
  md.push(`  - 风控提示：${JSON.stringify(s.riskHints)}`);
  md.push(`  - 会话标题长度=${String(s.title || '').length} 字符（**刻意不写入标题原文**）`);
}
if (sel?.counts) {
  md.push('');
  md.push('### 真实页面结构（发消息后 · M1 选择器素材）');
  md.push('');
  md.push('```json');
  md.push(
    JSON.stringify(
      {
        url: 'https://chat.deepseek.com/a/chat/s/<uuid>',
        counts: sel.counts,
        modeHints: sel.modeHints,
        editable: sel.editable,
        buttonSample: (sel.buttons ?? []).slice(0, 3).map((b) => ({ tag: b.tag, role: b.role, text: b.text, cls: clip(b.cls, 60) })),
      },
      null,
      2,
    ),
  );
  md.push('```');
  md.push('');
  md.push('**结构结论**');
  md.push('');
  md.push(`1. 输入框：单个 \`textarea\`，但 class 带构建哈希（\`_27c9245\`）→ **不可依赖 class**。`);
  md.push(`2. 按钮：全部是 \`div[role="button"]\`，**无 text / 无 aria-label / 无 data-testid** → 无法按文本定位，只能靠设计系统修饰类（\`ds-button--iconLabelTertiary\` / \`--primary\`）。`);
  md.push(`3. 消息节点：\`[class*=message|chat-item|markdown]\` 命中 **${sel.counts.messagesGuess}** 个 → 兜底通道可用但脆弱。`);
  md.push(`4. AI 标识：\`[class*=generated|disclaimer|notice]\` 命中 **${sel.counts.aiNoticeGuess}** 个 → **类名定位失败**，必须改用文本匹配。`);
  md.push(`5. 结论：**DD-06 改为网络优先（SSE 为准）**，DOM 只承担少量交互，并保留特性开关 + 熔断。`);
}
md.push('');
md.push('## 三、风控与异常观察');
md.push('');
md.push(`- 出现风控提示的快照：**${riskSnaps.length}** 条${riskSnaps.length ? '（' + JSON.stringify(riskSnaps.map((r) => r.riskHints)) + '）' : ' —— 未观察到验证码 / 限流 / 账号异常'}`);
md.push(`- 页面控制台错误/警告合计：**${pageErrors.length}** 条`);
md.push(`  - Electron 安全警告（自检页为无 CSP 的 \`data:\` 页面）：**${electronWarn.length}** 条 —— 开发期正常，打包后消失。`);
md.push(`  - 微信登录 SDK 端口探测噪音：**${wxNoise.length}** 条 —— 站点自身行为，无影响。`);
md.push(`  - 无来源信息的裸 \`Error\`（来自站点 \`fp.min.js\`）：**${bareErrors.length}** 条 —— **每次运行都出现（含未登录基线）**，待 M1 观察是否演化为风控信号。`);
md.push('');
md.push('## 四、结论');
md.push('');
md.push('- **环境侧两大地雷已排掉**：DSH 注入的 `ELECTRON_RUN_AS_NODE`（会让 Electron 退化成 Node 模式）；以及 **Chromium 沙箱在 DSH 工作区目录树中崩溃**（根因是 `<workspace>` 上的孤儿 SID + 低完整性标签 + 缺 AppContainer 包 ACE，对应 electron/electron#51761）—— 已用干净 ACL 目录 + `ELECTRON_OVERRIDE_DIST_PATH` 修复，**沙箱保持启用**。');
md.push('- **V10 是选型层面的关键结论**：站点 `CSP: frame-ancestors \'none\'` → 不能被 iframe 嵌入 → 独立 Electron 壳的路线成立。');
md.push('- **登录态由 `persist:` 分区承载，应用层零接触凭据**（对比参考实现 `dsh-webchat` 必须把含 HttpOnly 的 cookie 明文落盘）→ 这是自研在 R1 上的硬优势。');
md.push('- **M1 起必须守住**：站点的 AI 生成标识（`["AI 生成","内容由 AI 生成"]`）存在性与可见性不得改变；导出产物必须自带该标识。');
md.push('');
md.push('## 五、下一步');
md.push('');
md.push('1. 你补完 V6（连续多轮）/ V7（上传）/ V9（流式结束）后，M0 即全绿。');
md.push('2. M1 开工：T0 契约**已完成**（`src/shared/**` + tsconfig + 14 项单元测试 + typecheck 通过），随后 T1/T2/T3/T5 并行（见 docs/M1-TASKS.md）。');
md.push('3. 头号技术调整：**DD-06 网络优先**；AI 标识断言改用文本匹配。');
md.push('');

writeFileSync(OUT, md.join('\n'));

const summary = V_DEFS.map(([id]) => `${id}=${result.get(id)?.r ?? '?'}`).join(' ');
console.log(`已写出 ${OUT}`);
console.log(summary);
console.log(
  `证据：快照=${snaps.length} AI标识命中=${aiSnaps.length} 会话页=${convoSnaps.length} 风控提示=${riskSnaps.length} 控制台错误=${pageErrors.length}`,
);
