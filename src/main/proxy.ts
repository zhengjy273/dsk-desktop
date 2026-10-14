/**
 * M1 · T1：网络代理。
 *
 * 只做标准的代理转发（直连 / 手动规则 / PAC），**不实现任何绕过地区限制的功能**（合规红线）。
 * 凭据（若代理需要）由调用方用 Electron 的 `safeStorage` 加密后传入，本模块不落盘任何秘密。
 *
 * 写作用域：`src/main/**`（T1）。
 */
import type { Session } from 'electron';

export type ProxyMode = 'direct' | 'manual' | 'pac';

export interface ProxyConfig {
  mode: ProxyMode;
  /** 手动模式：Electron 的 proxyRules 语法，如 `http=127.0.0.1:8888;https=127.0.0.1:8888` */
  rules?: string;
  /** PAC 模式：PAC 脚本 URL（https） */
  pacUrl?: string;
  /** 绕过列表，默认绕过本机 */
  bypass?: string;
}

export const DEFAULT_BYPASS = '<local>';

/** 校验并归一化外部输入（设置页/配置文件都可能给出脏数据）。 */
export function normalizeProxyConfig(input: unknown): ProxyConfig {
  const o = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  const mode: ProxyMode = o.mode === 'manual' || o.mode === 'pac' ? o.mode : 'direct';
  const rules = typeof o.rules === 'string' && o.rules.trim() ? o.rules.trim() : undefined;
  const pacRaw = typeof o.pacUrl === 'string' ? o.pacUrl.trim() : '';
  // PAC 只接受 https，避免明文取脚本
  const pacUrl = pacRaw.startsWith('https://') ? pacRaw : undefined;
  const bypass = typeof o.bypass === 'string' && o.bypass.trim() ? o.bypass.trim() : DEFAULT_BYPASS;
  const out: ProxyConfig = { mode, bypass };
  if (rules) out.rules = rules;
  if (pacUrl) out.pacUrl = pacUrl;
  return out;
}

/** 配置是否具备生效条件（用于设置页给出明确错误）。 */
export function validateProxyConfig(cfg: ProxyConfig): { ok: boolean; error?: string } {
  if (cfg.mode === 'manual' && !cfg.rules) return { ok: false, error: '手动模式需要填写代理规则' };
  if (cfg.mode === 'pac' && !cfg.pacUrl) return { ok: false, error: 'PAC 模式需要提供 https 的 PAC 地址' };
  return { ok: true };
}

/** 应用到指定会话（只影响本应用的分区，不动系统代理）。 */
export async function applyProxy(
  ses: Session,
  cfg: ProxyConfig,
): Promise<{ ok: boolean; error?: string }> {
  const v = validateProxyConfig(cfg);
  if (!v.ok) return v;
  try {
    if (cfg.mode === 'direct') {
      await ses.setProxy({ mode: 'direct' });
    } else if (cfg.mode === 'pac') {
      await ses.setProxy({ mode: 'pac_script', pacScript: cfg.pacUrl as string });
    } else {
      await ses.setProxy({
        mode: 'fixed_servers',
        proxyRules: cfg.rules as string,
        proxyBypassRules: cfg.bypass ?? DEFAULT_BYPASS,
      });
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e) };
  }
}

/** 探测某个 URL 实际会走哪条链路（设置页的"连通性探测"用它展示结果）。 */
export async function probeProxy(ses: Session, url: string): Promise<string> {
  try {
    return await ses.resolveProxy(url);
  } catch (e) {
    return `PROBE_FAILED: ${String((e as Error)?.message ?? e)}`;
  }
}
