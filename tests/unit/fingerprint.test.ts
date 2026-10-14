import { describe, expect, it } from 'vitest';
import {
  applyFingerprintHeaders,
  auditClientHints,
  auditUserAgent,
  buildClientHints,
  buildUserAgent,
  getHeader,
  headerKey,
  setHeader,
  stripElectronBrand,
} from '../../src/session/fingerprint';

const CHROME = '152.0.7977.130';

describe('buildUserAgent', () => {
  it('产出不含 Electron 的 Chrome UA', () => {
    const ua = buildUserAgent(CHROME);
    expect(ua).toContain(`Chrome/${CHROME}`);
    expect(ua).not.toMatch(/electron/i);
    expect(ua).toContain('Windows NT 10.0');
  });
});

describe('stripElectronBrand', () => {
  it('剔除含 Electron 的条目并保留其余', () => {
    expect(stripElectronBrand('"Chromium";v="152", "Electron";v="44"')).toBe('"Chromium";v="152"');
  });

  it('null / 空串返回 null', () => {
    expect(stripElectronBrand(null)).toBeNull();
    expect(stripElectronBrand('')).toBeNull();
  });

  it('全部条目都被剔除时返回 null', () => {
    expect(stripElectronBrand('"Electron";v="44"')).toBeNull();
  });
});

describe('buildClientHints', () => {
  it('与 Electron 的 userAgentData 自洽：只有 Chromium，不声明 Google Chrome', () => {
    const h = buildClientHints(CHROME);
    expect(h['sec-ch-ua']).toContain('Chromium";v="152"');
    expect(h['sec-ch-ua']).not.toMatch(/Google Chrome/i);
    expect(h['sec-ch-ua']).not.toMatch(/electron/i);
    expect(h['sec-ch-ua-platform']).toBe('"Windows"');
    expect(h['sec-ch-ua-mobile']).toBe('?0');
  });

  it('full-version-list 使用完整版本号', () => {
    expect(buildClientHints(CHROME)['sec-ch-ua-full-version-list']).toContain(CHROME);
  });
});

describe('头字段的大小写不敏感读写', () => {
  it('headerKey 找到规范名键', () => {
    expect(headerKey({ 'Sec-CH-UA': 'x' }, 'sec-ch-ua')).toBe('Sec-CH-UA');
    expect(headerKey({}, 'sec-ch-ua')).toBeUndefined();
  });

  it('setHeader 复用已有键，不产生仅大小写不同的重复头', () => {
    const h: Record<string, string> = { 'Sec-CH-UA': 'old' };
    setHeader(h, 'sec-ch-ua', 'new');
    expect(Object.keys(h)).toEqual(['Sec-CH-UA']);
    expect(h['Sec-CH-UA']).toBe('new');
  });

  it('getHeader 大小写不敏感', () => {
    expect(getHeader({ 'User-Agent': 'ua' }, 'user-agent')).toBe('ua');
    expect(getHeader({}, 'user-agent')).toBeNull();
  });
});

describe('applyFingerprintHeaders', () => {
  it('在没有客户端提示时补发（Electron 44 的实测行为）', () => {
    const h: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 ... Electron/44.7.0',
      Accept: '*/*',
    };
    applyFingerprintHeaders(h, CHROME);
    expect(h['Accept']).toBe('*/*');
    expect(String(h['User-Agent'] ?? h['user-agent'])).not.toMatch(/electron/i);
    expect(h['sec-ch-ua']).toContain('Chromium');
  });

  it('去掉上游的 Electron 品牌残留', () => {
    const h: Record<string, string> = {
      'sec-ch-ua': '"Chromium";v="152", "Electron";v="44"',
    };
    applyFingerprintHeaders(h, CHROME);
    expect(h['sec-ch-ua']).not.toMatch(/electron/i);
    expect(h['sec-ch-ua']).toContain('Chromium');
  });

  it('去掉上游伪造的 Google Chrome 品牌（与 userAgentData 矛盾，M0 踩过的坑）', () => {
    const h: Record<string, string> = {
      'sec-ch-ua': '"Google Chrome";v="152", "Chromium";v="152"',
    };
    applyFingerprintHeaders(h, CHROME);
    expect(h['sec-ch-ua']).not.toMatch(/Google Chrome/i);
    expect(h['sec-ch-ua']).toContain('Chromium');
  });

  it('保留已有的大小写规范键，不产生重复头', () => {
    const h: Record<string, string> = { 'Sec-CH-UA': 'stale', 'User-Agent': 'stale' };
    applyFingerprintHeaders(h, CHROME);
    expect(Object.keys(h).filter((k) => k.toLowerCase() === 'sec-ch-ua')).toHaveLength(1);
    expect(Object.keys(h).filter((k) => k.toLowerCase() === 'user-agent')).toHaveLength(1);
  });
});

describe('审计函数', () => {
  it('auditUserAgent 检出 Electron 痕迹', () => {
    expect(auditUserAgent('Mozilla/5.0 Chrome/152 Electron/44').clean).toBe(false);
    expect(auditUserAgent('Mozilla/5.0 Chrome/152').clean).toBe(true);
    expect(auditUserAgent('').hasChrome).toBe(false);
  });

  it('auditClientHints 认为自洽的一组通过', () => {
    expect(auditClientHints(buildClientHints(CHROME), CHROME).consistent).toBe(true);
  });

  it('auditClientHints 检出 Electron 品牌与伪造的 Google Chrome', () => {
    expect(
      auditClientHints({ 'sec-ch-ua': '"Chromium";v="152", "Electron";v="44"' }, CHROME).reasons.join(),
    ).toMatch(/Electron/);
    expect(
      auditClientHints({ 'sec-ch-ua': '"Google Chrome";v="152", "Chromium";v="152"' }, CHROME).reasons.join(),
    ).toMatch(/Google Chrome/);
    expect(auditClientHints({ 'sec-ch-ua': '"Chromium";v="999"' }, CHROME).consistent).toBe(false);
  });
});
