/**
 * M1 · T2：会话指纹 —— UA 与客户端提示（Client Hints）的**最小必要改写**。
 *
 * M0 实测结论（见 docs/M0-REPORT.md）：
 *  1. Electron 44 对主框架导航**根本不发** `Sec-CH-UA*` 系列头，而真实 Chrome 会发 → "缺失"本身可被检测；
 *  2. 其 `navigator.userAgentData.brands` 只报 Chromium（无 "Google Chrome"）→ 若请求头伪造
 *     Google Chrome 品牌，会与 JS 可见值**互相矛盾**，反而更容易被识别；
 *  3. 早期版本曾这么伪造过，实测后已纠正。
 *
 * 因此本模块只做两件事：**剔除 Electron 残留** + **补齐与 JS 可见值自洽的客户端提示**。
 * 它不伪造身份、不改变能力声明，也不接触任何凭据（R1）。
 *
 * 全部为纯函数，便于单元测试（tests/unit/fingerprint.test.ts）。
 */

export interface ClientHints {
  /** 索引签名：使 ClientHints 可直接作为 Record<string, string> 使用（供审计函数与头改写）。 */
  [name: string]: string;
  'sec-ch-ua': string;
  'sec-ch-ua-full-version-list': string;
  'sec-ch-ua-mobile': string;
  'sec-ch-ua-platform': string;
}

/** 与 navigator.userAgentData.brands 对齐的 greasy brand 字面量（Electron 44 实测值）。 */
const GREASY_BRAND = 'Not?A_Brand';

/** 构造与真实 Chrome 同形的 UA，但不含任何 Electron 标识。 */
export function buildUserAgent(chromeFullVersion: string): string {
  return (
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
    `Chrome/${chromeFullVersion} Safari/537.36`
  );
}

/** 从 `sec-ch-ua` 一类的逗号分隔列表里剔除含 Electron 的条目；空输入返回 null。 */
export function stripElectronBrand(value: string | null | undefined): string | null {
  if (!value) return null;
  const parts = String(value)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !/electron/i.test(s));
  return parts.length ? parts.join(', ') : null;
}

/**
 * 生成与 `navigator.userAgentData` 一致的客户端提示。
 * 注意：**不包含** "Google Chrome" 品牌 —— 因为 Electron 的 userAgentData 也不包含，
 * 两边保持自洽比"更像 Chrome"更重要（M0 实测教训）。
 */
export function buildClientHints(chromeFullVersion: string): ClientHints {
  const major = String(chromeFullVersion).split('.')[0] ?? '';
  return {
    'sec-ch-ua': `"Chromium";v="${major}", "${GREASY_BRAND}";v="24"`,
    'sec-ch-ua-full-version-list': `"Chromium";v="${chromeFullVersion}", "${GREASY_BRAND}";v="24.0.0.0"`,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
  };
}

/** 大小写不敏感地查头字段的真实键名（Electron 用 `Sec-CH-UA` 这类规范名）。 */
export function headerKey(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  return Object.keys(headers).find((k) => k.toLowerCase() === lower);
}

/** 大小写不敏感地设置头字段，避免产生仅大小写不同的重复头。 */
export function setHeader(headers: Record<string, string>, name: string, value: string): void {
  const k = headerKey(headers, name);
  if (k) headers[k] = value;
  else headers[name] = value;
}

/** 大小写不敏感地读头字段。 */
export function getHeader(headers: Record<string, string>, name: string): string | null {
  const k = headerKey(headers, name);
  return k ? (headers[k] ?? null) : null;
}

/**
 * 对将要发往目标站点的请求头做最小改写（原地修改并返回同一对象，便于 Electron 的 onBeforeSendHeaders 使用）。
 * 规则：UA 统一为 `buildUserAgent`；若已存在 Electron 残留的客户端提示则剔除，否则补发自洽的一组。
 */
export function applyFingerprintHeaders(
  headers: Record<string, string>,
  chromeFullVersion: string,
): Record<string, string> {
  setHeader(headers, 'user-agent', buildUserAgent(chromeFullVersion));

  const hints = buildClientHints(chromeFullVersion);
  for (const [name, fallback] of Object.entries(hints)) {
    if (name === 'sec-ch-ua' || name === 'sec-ch-ua-full-version-list') {
      // 一律替换为"与 navigator.userAgentData 自洽"的值：
      // 上游若带 Electron 品牌要去掉；若带 Google Chrome 品牌**同样**要去掉 ——
      // Electron 的 userAgentData 并不声明它，声明了反而制造矛盾（M0 实测教训）。
      setHeader(headers, name, fallback);
    } else if (!getHeader(headers, name)) {
      setHeader(headers, name, fallback);
    }
  }
  return headers;
}

/** 审计一个 UA 是否仍带 Electron 痕迹（供自检与自动化断言使用）。 */
export function auditUserAgent(ua: string | null | undefined): {
  clean: boolean;
  hasElectron: boolean;
  hasChrome: boolean;
} {
  const s = String(ua ?? '');
  const hasElectron = /electron/i.test(s);
  const hasChrome = /Chrome\/\d/.test(s);
  return { clean: !hasElectron && hasChrome, hasElectron, hasChrome };
}

/** 审计一组客户端提示是否与给定的 Chromium 版本自洽（不得出现 Google Chrome / Electron）。 */
export function auditClientHints(
  hints: Record<string, string>,
  chromeFullVersion: string,
): { consistent: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const major = String(chromeFullVersion).split('.')[0] ?? '';
  const brands = getHeader(hints, 'sec-ch-ua') ?? '';
  if (/electron/i.test(brands)) reasons.push('sec-ch-ua 含 Electron 品牌');
  if (/Google Chrome/i.test(brands)) reasons.push('sec-ch-ua 声明了 Google Chrome，但 userAgentData 不含该品牌');
  if (!brands.includes(`Chromium";v="${major}"`)) reasons.push(`sec-ch-ua 缺少 Chromium v=${major}`);
  return { consistent: reasons.length === 0, reasons };
}
