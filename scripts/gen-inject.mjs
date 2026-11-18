/**
 * 调试辅助：把注入脚本写到临时文件（用真实 view 数据），便于用 CDP 手动执行验证。
 *
 * 用法：node scripts/gen-inject.mjs <out-file> [sessionTokens] [regenerateUsed] [editUsed]
 */
import { writeFileSync } from 'node:fs';
import { formatRegenerateLimits } from '../src/session/quota-parser.ts';
import { buildQuotaInjectScript } from '../src/inject/quota-overlay.ts';

const out = process.argv[2];
const tokens = process.argv[3] ? Number(process.argv[3]) : null;
const regenUsed = process.argv[4] ? Number(process.argv[4]) : null;
const editUsed = process.argv[5] ? Number(process.argv[5]) : null;
if (!out) {
  console.error(
    'usage: node scripts/gen-inject.mjs <out-file> [sessionTokens] [regenerateUsed] [editUsed]',
  );
  process.exit(2);
}

const cfg =
  regenUsed === null && editUsed === null
    ? null
    : { modelType: 'default', regenerateQuota: 5, editQuota: 5 };

const view = {
  accountId: 'personal',
  updatedAt: Date.now(),
  modelLabel: '快速模式',
  regenerateLimits: formatRegenerateLimits(
    cfg,
    regenUsed === null && editUsed === null
      ? undefined
      : { regenerateUsed: regenUsed ?? 0, editUsed: editUsed ?? 0 },
  ),
  inputLimit: '单次输入上限 2,621,440 字',
  quotaSummary: '额度正常',
  isMuted: false,
  muteUntil: 0,
  muteMsg: null,
  serverMessages: [],
  exhaustedModels: [],
  quotas: [],
  sessionTokens: tokens,
  sessionTokensText: tokens === null ? null : `本会话已用 ${tokens.toLocaleString('zh-CN')} tokens`,
  regenerateUsed: regenUsed,
  editUsed: editUsed,
  actionCountsEstimated: false,
  fromCache: false,
};

writeFileSync(out, buildQuotaInjectScript(view), 'utf8');
console.log(`written ${out} regenerateLimits=${view.regenerateLimits}`);
