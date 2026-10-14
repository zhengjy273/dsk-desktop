/**
 * M2：选择器注册表 + **失配降级与诊断**（DD-05：降级而非崩溃）。
 *
 * 职责链：
 *   `src/shared/selectors.json`（唯一真源）→ `parseRegistry()`（宽容解析）→
 *   `buildProbeScript()`（生成**只读**探测脚本）→ 页面里执行 → `evaluateProbes()`（判定可用/降级）
 *   → `toWarnings()`（产出 `SelectorWarning[]` 供 diagnostics 上报）。
 *
 * 红线（R1 / PLAN §1.3）：
 *  - 探测脚本**只统计选择器命中数量**，绝不读取输入控件的值、绝不读 cookie/localStorage；
 *  - 任何非法选择器、任何异常都必须被吞掉并降级 —— 增强层不许因页面改版把外壳拖崩；
 *  - `unverified` 目标本来就无稳定锚点，未命中时**静默降级**（不产生告警噪音）；
 *    只有声明为 `verified` / `text-match` 却探测不到的，才算**真失配**并上报。
 *
 * 写作用域：`src/inject/**`（T2）。
 */
import type { SelectorWarning } from '../shared/ipc-contract.ts';

export type SelectorStatus = 'verified' | 'text-match' | 'unverified';

export interface SelectorTargetSpec {
  status?: string;
  selectors?: string[];
  fallback?: string[];
  textMatch?: string;
  mustNotHide?: boolean;
  /**
   * 条件性目标：只在**特定页面状态**下存在（例如消息列表只出现在有消息的会话页）。
   * 未命中时仍然降级，但**不计为真失配** —— 否则打开首页就会刷一堆告警噪音。
   */
  conditional?: boolean;
  observed?: string;
}

export interface SelectorRegistry {
  version: string;
  targets: Record<string, SelectorTargetSpec>;
}

export interface TargetProbe {
  hits: number;
  usedSelector: string | null;
  /**
   * 每个候选选择器的命中数（`-1` = 非法选择器）。
   * 一次探测拿到**完整命中矩阵** —— 补齐锚点时靠它判断哪个候选可用。
   */
  all?: Record<string, number>;
}

export interface TargetVerdict {
  id: string;
  status: SelectorStatus;
  hits: number;
  usedSelector: string | null;
  /** 不可用作增强锚点（命中 0 处）。 */
  degraded: boolean;
  /** 是否属于"真失配"、需要上报诊断。 */
  warn: boolean;
  reason: string;
}

const STATUSES: readonly SelectorStatus[] = ['verified', 'text-match', 'unverified'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && v.trim() !== '');
}

/**
 * 宽容解析注册表：坏数据一律跳过（绝不抛错）。
 * 返回 null 表示整体不可用（调用方应视为"无锚点可用"并降级）。
 */
export function parseRegistry(raw: unknown): SelectorRegistry | null {
  if (!isRecord(raw)) return null;
  const rawTargets = raw['targets'];
  if (!isRecord(rawTargets)) return null;

  const targets: Record<string, SelectorTargetSpec> = {};
  for (const [id, spec] of Object.entries(rawTargets)) {
    if (id === '' || !isRecord(spec)) continue;
    const entry: SelectorTargetSpec = {};
    if (typeof spec['status'] === 'string') entry.status = spec['status'];
    const selectors = toStringArray(spec['selectors']);
    if (selectors.length > 0) entry.selectors = selectors;
    const fallback = toStringArray(spec['fallback']);
    if (fallback.length > 0) entry.fallback = fallback;
    if (typeof spec['textMatch'] === 'string') entry.textMatch = spec['textMatch'];
    if (spec['mustNotHide'] === true) entry.mustNotHide = true;
    if (spec['conditional'] === true) entry.conditional = true;
    targets[id] = entry;
  }

  return {
    version: typeof raw['version'] === 'string' ? raw['version'] : 'unknown',
    targets,
  };
}

/**
 * 生成**只读**探测脚本：对每个目标依次尝试 selectors → fallback → 可见文本匹配，
 * 只返回命中数量与所用选择器。
 *
 * 注意脚本里**不出现 `.value`**（测试里有对应断言）—— 这是 R1 的机器可检验保证。
 */
export function buildProbeScript(registry: SelectorRegistry): string {
  const specs: Record<string, { selectors: string[]; fallback: string[]; textMatch: string | null }> = {};
  for (const [id, t] of Object.entries(registry.targets)) {
    specs[id] = {
      selectors: t.selectors ?? [],
      fallback: t.fallback ?? [],
      textMatch: t.textMatch ?? null,
    };
  }
  return `(() => {
  const specs = ${JSON.stringify(specs)};
  const out = {};
  const bodyText = (document.body ? document.body.innerText : '') || '';
  for (const id of Object.keys(specs)) {
    const spec = specs[id];
    let hits = 0;
    let used = null;
    const perSelector = {};
    const lists = [spec.selectors, spec.fallback];
    for (const list of lists) {
      for (const selector of list) {
        let n = -1;
        try {
          n = document.querySelectorAll(selector).length;
        } catch (err) {
          n = -1;
        }
        perSelector[selector] = n;
        // 第一个命中者作为"实际使用"的选择器，但**所有候选都统计**（拿到完整命中矩阵）
        if (n > 0 && !used) { hits = n; used = selector; }
      }
    }
    if (!used && spec.textMatch && bodyText.indexOf(spec.textMatch) >= 0) {
      hits = 1;
      used = 'text:' + spec.textMatch;
    }
    out[id] = { hits: hits, usedSelector: used, all: perSelector };
  }
  return out;
})()`;
}

/**
 * 生成**结构发现**脚本（只读）。
 *
 * 用途：注册表里 `unverified` 且**没有候选选择器**的目标（messageList / messageAssistant /
 * reasoningBlock / generatingIndicator / sendButton），探测脚本无从下手 ——
 * 必须先看清页面骨架（元素计数 + 候选命中 + 类名分布），才能写出精确锚点。
 *
 * 只统计**数量与类名**，绝不读取任何元素文本、绝不读取输入控件的值（R1）。
 */
export function buildStructureDiscoveryScript(): string {
  return `(() => {
  const out = { totals: {}, candidates: {}, topClasses: [] };
  const totals = [['div','div'],['button','button'],['roleButton','[role="button"]'],['textarea','textarea'],['svg','svg'],['img','img']];
  for (const pair of totals) {
    try { out.totals[pair[0]] = document.querySelectorAll(pair[1]).length; } catch (e) { out.totals[pair[0]] = -1; }
  }
  const candidates = ['main','[role="main"]','section','article','[class*="chat"]','[class*="message"]','[class*="markdown"]','[class*="think"]','[class*="loading"]','[class*="typing"]','[class*="stream"]','[class*="answer"]','[class*="content"]','[class*="stop"]','[class*="generating"]','[class*="cursor"]','[class*="pending"]','[class*="blink"]','[class*="assistant"]','[class*="user"]','[class*="send"]','[class*="primary"]','[class*="filled"]','[data-testid]','[aria-label]'];
  for (const sel of candidates) {
    try { out.candidates[sel] = document.querySelectorAll(sel).length; } catch (e) { out.candidates[sel] = -1; }
  }
  const counts = {};
  for (const el of document.querySelectorAll('div[class]')) {
    for (const c of String(el.className).split(/\\s+/)) {
      if (c) counts[c] = (counts[c] || 0) + 1;
    }
  }
  out.topClasses = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 15).map((pair) => pair[0] + ':' + pair[1]);
  return out;
})()`;
}

/** 把探测结果判定为"可用 / 降级 / 真失配"。 */
export function evaluateProbes(
  registry: SelectorRegistry,
  probes: Record<string, TargetProbe> | null | undefined,
  lastOk: Record<string, number> = {},
): TargetVerdict[] {
  const verdicts: TargetVerdict[] = [];
  const safeProbes = isRecord(probes) ? probes : {};

  for (const [id, spec] of Object.entries(registry.targets)) {
    const declared = spec.status;
    const status: SelectorStatus = STATUSES.includes(declared as SelectorStatus)
      ? (declared as SelectorStatus)
      : 'unverified';

    const rawProbe = (safeProbes as Record<string, unknown>)[id];
    const probe = isRecord(rawProbe) ? rawProbe : {};
    const rawHits = probe['hits'];
    const hits = typeof rawHits === 'number' && Number.isFinite(rawHits) ? Math.max(0, Math.trunc(rawHits)) : 0;
    const used = typeof probe['usedSelector'] === 'string' ? probe['usedSelector'] : null;
    const degraded = hits === 0;

    let reason: string;
    if (!degraded) {
      reason = `命中 ${hits} 处（${used ?? '未知选择器'}）`;
      if (status === 'unverified') reason += '；实测已可用，可考虑升级为 verified';
    } else if (status === 'unverified') {
      reason = '尚未登记锚点（设计上不依赖它，静默降级）';
    } else if (spec.conditional === true) {
      reason = `条件性目标在当前页面不存在（status=${status}，已降级，不计失配）`;
    } else {
      reason = `声明的锚点未命中（status=${status}）→ 页面可能改版，已降级`;
    }

    verdicts.push({
      id,
      status,
      hits,
      usedSelector: used,
      degraded,
      // 真失配 = 声明过锚点却探测不到，且**不是**条件性目标（unverified 未命中属预期）
      warn: degraded && status !== 'unverified' && spec.conditional !== true,
      reason,
    });
  }

  void lastOk; // 目前不参与判定，保留参数以便调用方传入历史成功时间
  return verdicts;
}

/** 汇总为可上报的 diagnostics 载荷。 */
export function toWarnings(
  verdicts: readonly TargetVerdict[],
  lastOk: Record<string, number> = {},
): SelectorWarning[] {
  return verdicts
    .filter((v) => v.warn)
    .map((v) => {
      const when = lastOk[v.id];
      return {
        selector: v.usedSelector ?? v.id,
        hits: v.hits,
        lastOk: typeof when === 'number' && Number.isFinite(when) ? when : 0,
      };
    });
}

/** 一句话摘要，供日志/自检使用。 */
export function summarize(verdicts: readonly TargetVerdict[]): string {
  const ok = verdicts.filter((v) => !v.degraded).length;
  const warn = verdicts.filter((v) => v.warn).length;
  const pending = verdicts.filter((v) => v.degraded && !v.warn).length;
  return `可用 ${ok} / 失配 ${warn} / 未验证降级 ${pending}（共 ${verdicts.length}）`;
}
