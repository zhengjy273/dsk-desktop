import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildProbeScript,
  buildStructureDiscoveryScript,
  evaluateProbes,
  parseRegistry,
  summarize,
  toWarnings,
  type SelectorRegistry,
} from '../../src/inject/selector-registry';

const registry: SelectorRegistry = {
  version: 'test-1',
  targets: {
    composer: { status: 'verified', selectors: ['textarea'], fallback: ['[contenteditable="true"]'] },
    modeDeepThink: { status: 'text-match', textMatch: '深度思考' },
    messageList: { status: 'unverified', selectors: [] },
    aiGeneratedNotice: { status: 'unverified', mustNotHide: true },
    weird: { status: 'not-a-status' },
  },
};

describe('parseRegistry（宽容解析）', () => {
  it('解析真实 selectors.json 且不抛错', () => {
    const raw = JSON.parse(
      readFileSync(resolve(__dirname, '../../src/shared/selectors.json'), 'utf8'),
    ) as unknown;
    const parsed = parseRegistry(raw);
    expect(parsed).not.toBeNull();
    expect(parsed?.targets['composer']?.selectors).toEqual(['textarea']);
    expect(parsed?.targets['modeDeepThink']?.textMatch).toBe('深度思考');
  });

  it('非对象/缺 targets 返回 null', () => {
    expect(parseRegistry(null)).toBeNull();
    expect(parseRegistry([])).toBeNull();
    expect(parseRegistry({ version: 'x' })).toBeNull();
  });

  it('坏目标被跳过，其余照常解析', () => {
    const parsed = parseRegistry({
      version: 'v',
      targets: { good: { status: 'verified', selectors: ['a'] }, bad: 42, '': { status: 'x' } },
    });
    expect(Object.keys(parsed?.targets ?? {})).toEqual(['good']);
  });

  it('过滤非法选择器项（非字符串/空白）', () => {
    const parsed = parseRegistry({ targets: { t: { selectors: ['a', '', 42, '  ', 'b'] } } });
    expect(parsed?.targets['t']?.selectors).toEqual(['a', 'b']);
  });
});

describe('buildProbeScript（R1 机器可检验保证）', () => {
  const script = buildProbeScript(registry);

  it('脚本里不出现 .value —— 绝不读取输入控件的值（R1）', () => {
    expect(script).not.toMatch(/\.value\b/);
    expect(script).not.toContain('getAttribute(\'value\')');
  });

  it('不读取 cookie / localStorage / sessionStorage', () => {
    expect(script).not.toContain('cookie');
    expect(script).not.toContain('localStorage');
    expect(script).not.toContain('sessionStorage');
  });

  it('内嵌了目标规格且是可求值的 IIFE', () => {
    expect(script.startsWith('(() => {')).toBe(true);
    expect(script).toContain('composer');
    expect(script).toContain('深度思考');
    expect(script.trimEnd().endsWith('})()')).toBe(true);
  });

  it('非法选择器被 try/catch 包裹（页面改版不拖崩外壳）', () => {
    expect(script).toContain('catch (err)');
  });
});

describe('buildStructureDiscoveryScript（结构发现，只读）', () => {
  const script = buildStructureDiscoveryScript();

  it('不读取输入值 / cookie / storage（R1）', () => {
    expect(script).not.toMatch(/\.value\b/);
    expect(script).not.toContain('cookie');
    expect(script).not.toContain('localStorage');
    expect(script).not.toContain('sessionStorage');
  });

  it('只统计数量与类名，绝不读取元素文本（不泄内容）', () => {
    expect(script).not.toContain('innerText');
    expect(script).not.toContain('textContent');
    expect(script).not.toContain('innerHTML');
    expect(script).toContain('querySelectorAll');
    expect(script).toContain('topClasses');
  });

  it('是可求值的 IIFE，且统计口径包含候选选择器', () => {
    expect(script.startsWith('(() => {')).toBe(true);
    expect(script.trimEnd().endsWith('})()')).toBe(true);
    expect(script).toContain('candidates');
    expect(script).toContain('totals');
  });
});

describe('evaluateProbes（可用 / 降级 / 真失配）', () => {
  it('verified 命中 → 可用、不告警', () => {
    const v = evaluateProbes(registry, { composer: { hits: 1, usedSelector: 'textarea' } });
    const composer = v.find((x) => x.id === 'composer');
    expect(composer?.degraded).toBe(false);
    expect(composer?.warn).toBe(false);
    expect(composer?.reason).toContain('命中 1 处');
  });

  it('verified 未命中 → **真失配**并告警（页面可能改版）', () => {
    const v = evaluateProbes(registry, { composer: { hits: 0, usedSelector: null } });
    const composer = v.find((x) => x.id === 'composer');
    expect(composer?.degraded).toBe(true);
    expect(composer?.warn).toBe(true);
    expect(composer?.reason).toContain('可能改版');
  });

  it('unverified 未命中 → 静默降级（不产生告警噪音）', () => {
    const v = evaluateProbes(registry, {});
    const list = v.find((x) => x.id === 'messageList');
    expect(list?.degraded).toBe(true);
    expect(list?.warn).toBe(false);
  });

  it('unverified 实测命中 → 可用，且提示可升级为 verified', () => {
    const v = evaluateProbes(registry, { messageList: { hits: 3, usedSelector: 'div' } });
    const list = v.find((x) => x.id === 'messageList');
    expect(list?.degraded).toBe(false);
    expect(list?.reason).toContain('可考虑升级为 verified');
  });

  it('未知 status 按 unverified 处理（宽容）', () => {
    const v = evaluateProbes(registry, {});
    expect(v.find((x) => x.id === 'weird')?.status).toBe('unverified');
  });

  it('探测结果缺失/畸形一律按 0 命中处理，不抛错', () => {
    expect(() => evaluateProbes(registry, null)).not.toThrow();
    const v = evaluateProbes(registry, { composer: { hits: 'many', usedSelector: 7 } as never });
    expect(v.find((x) => x.id === 'composer')?.hits).toBe(0);
  });

  it('负命中数被规整为 0', () => {
    const v = evaluateProbes(registry, { composer: { hits: -5, usedSelector: 'x' } });
    expect(v.find((x) => x.id === 'composer')?.hits).toBe(0);
  });
});

describe('条件性目标（conditional）：降级但不刷告警', () => {
  it('conditional 目标未命中 → 降级、不告警', () => {
    const reg: SelectorRegistry = {
      version: 't',
      targets: { msgList: { status: 'verified', selectors: ['[class*="message"]'], conditional: true } },
    };
    const v = evaluateProbes(reg, {});
    expect(v[0]?.degraded).toBe(true);
    expect(v[0]?.warn).toBe(false);
    expect(v[0]?.reason).toContain('条件性目标');
  });

  it('非 conditional 的 verified 目标未命中 → 仍然告警（真失配）', () => {
    const reg: SelectorRegistry = { version: 't', targets: { must: { status: 'verified', selectors: ['x'] } } };
    expect(evaluateProbes(reg, {})[0]?.warn).toBe(true);
  });

  it('conditional 命中时照常算可用', () => {
    const reg: SelectorRegistry = {
      version: 't',
      targets: { msgList: { status: 'verified', selectors: ['x'], conditional: true } },
    };
    const v = evaluateProbes(reg, { msgList: { hits: 2, usedSelector: 'x' } });
    expect(v[0]?.degraded).toBe(false);
    expect(v[0]?.warn).toBe(false);
  });

  it('真实 selectors.json：messageList / reasoningBlock / aiGeneratedNotice 标为 conditional，composer 不是', () => {
    const raw = JSON.parse(
      readFileSync(resolve(__dirname, '../../src/shared/selectors.json'), 'utf8'),
    ) as unknown;
    const parsed = parseRegistry(raw);
    expect(parsed?.targets['messageList']?.conditional).toBe(true);
    expect(parsed?.targets['reasoningBlock']?.conditional).toBe(true);
    expect(parsed?.targets['aiGeneratedNotice']?.conditional).toBe(true);
    expect(parsed?.targets['composer']?.conditional).toBeUndefined();
  });
});

describe('toWarnings / summarize', () => {
  it('只把真失配转成 warning，且带上 lastOk', () => {
    // 注意：modeDeepThink 也是"声明过锚点"的目标，这里给它命中，确保只有 composer 算真失配
    const verdicts = evaluateProbes(registry, {
      composer: { hits: 0, usedSelector: 'textarea' },
      modeDeepThink: { hits: 1, usedSelector: 'text:深度思考' },
    });
    const warnings = toWarnings(verdicts, { composer: 12345 });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toEqual({ selector: 'textarea', hits: 0, lastOk: 12345 });
  });

  it('无失配时返回空数组', () => {
    const verdicts = evaluateProbes(registry, {
      composer: { hits: 1, usedSelector: 'textarea' },
      modeDeepThink: { hits: 1, usedSelector: 'text:深度思考' },
    });
    expect(toWarnings(verdicts)).toEqual([]);
  });

  it('摘要统计三类数量', () => {
    const text = summarize(evaluateProbes(registry, { composer: { hits: 1, usedSelector: 'textarea' } }));
    expect(text).toContain('可用 1');
    expect(text).toMatch(/失配 \d+/);
    expect(text).toMatch(/未验证降级 \d+/);
  });
});
