import { describe, expect, it } from 'vitest';
import { isSameSiteUrl, SITE_ORIGIN } from '../../src/shared/brand';

describe('isSameSiteUrl', () => {
  it('站点自身 URL 放行（路径/查询/hash 不影响来源判定）', () => {
    expect(isSameSiteUrl(`${SITE_ORIGIN}/`)).toBe(true);
    expect(isSameSiteUrl(`${SITE_ORIGIN}/a/chat/s/11111111-1111-4111-8111-111111111111`)).toBe(true);
    expect(isSameSiteUrl(`${SITE_ORIGIN}/?x=1#y`)).toBe(true);
  });

  it('同前缀不同 origin 一律拦下（startsWith 前缀匹配漏洞）', () => {
    expect(isSameSiteUrl('https://chat.deepseek.com.evil.com/')).toBe(false);
    expect(isSameSiteUrl('https://chat.deepseek.com.evil.com/a/chat/s/x')).toBe(false);
    expect(isSameSiteUrl('https://chat.deepseek.com:8443/')).toBe(false);
    expect(isSameSiteUrl('http://chat.deepseek.com/')).toBe(false);
  });

  it('站外 URL 与非 http 协议拦下', () => {
    expect(isSameSiteUrl('https://example.com/')).toBe(false);
    expect(isSameSiteUrl('file:///E:/work/error.html')).toBe(false);
    expect(isSameSiteUrl('about:blank')).toBe(false);
    expect(isSameSiteUrl('')).toBe(false);
    expect(isSameSiteUrl('not a url')).toBe(false);
  });

  it('支持自定义 origin（content-view 用注入值比较）', () => {
    expect(isSameSiteUrl('https://a.example/', 'https://a.example')).toBe(true);
    expect(isSameSiteUrl('https://b.example/', 'https://a.example')).toBe(false);
  });

  it('origin 带不带尾斜杠等价', () => {
    expect(isSameSiteUrl(`${SITE_ORIGIN}/x`, `${SITE_ORIGIN}/`)).toBe(true);
  });
});
