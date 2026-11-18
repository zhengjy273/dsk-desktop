/**
 * 单元测试：`src/inject/quota-overlay.ts`
 *
 * 覆盖四类东西：
 *  1. **红线机器断言**（最重要）：生成的脚本里绝不出现 `.value` / `localStorage` /
 *     `sessionStorage` / `cookie` / `fetch` / `XMLHttpRequest` —— 这是 R1（不碰凭据）与
 *     R2（不逆向接口）的可检验保证，和 selector-registry 的同类断言同一性质。
 *  2. **R3**：AI 生成声明只被追加内容，绝不被改写（v1.1.2 用户要求"接在标识后面"）。
 *  3. 脚本结构与幂等性：数据被安全内联、有卸载路径、有观察器节流。
 *  4. 浮层行为：可拖动、可恢复默认位置、迷你窗隐藏、位置上报口径。
 *
 * 纪律：不 import electron；只对生成的字符串做静态检查（不执行页面代码）。
 */
import { describe, expect, it } from 'vitest';
import {
  QUOTA_POS_RESET_MARK,
  buildQuotaInjectScript,
  buildQuotaResetScript,
} from '../../src/inject/quota-overlay.ts';
import type { QuotaView } from '../../src/shared/ipc-contract.ts';

const VIEW: QuotaView = {
  accountId: 'personal',
  updatedAt: 1791598000000,
  modelLabel: 'V4.1 Flash',
  regenerateLimits: '重新生成上限 6 次 · 修改上限 6 次',
  regenerateUsed: null,
  editUsed: null,
  actionCountsEstimated: true,
  inputLimit: '单次输入上限 40,960 字',
  quotaSummary: '额度正常',
  isMuted: false,
  muteUntil: 0,
  muteMsg: null,
  serverMessages: [],
  exhaustedModels: [],
  quotas: [{ modelType: 'default', isExhausted: false, resetAt: 0, msg: null }],
  sessionTokens: 73,
  sessionTokensText: '本会话已用 73 tokens',
  fromCache: false,
};

const MUTED_VIEW: QuotaView = {
  ...VIEW,
  isMuted: true,
  muteUntil: 1791684400000,
  muteMsg: '由于违反用户使用规范，你的账号已被禁言至 11 月 19 日。',
  quotaSummary: '已禁言至 22:23',
  exhaustedModels: ['deep_think'],
  serverMessages: ['深度思考额度已用尽', '额度提醒'],
};

const script = buildQuotaInjectScript(VIEW);
const mutedScript = buildQuotaInjectScript(MUTED_VIEW);
const hiddenScript = buildQuotaInjectScript(VIEW, { hidden: true });
const posScript = buildQuotaInjectScript(VIEW, { pos: { x: 640, y: 220 } });
const resetScript = buildQuotaResetScript();

describe('红线：注入脚本不碰凭据与存储（R1）', () => {
  it('不出现 .value —— 绝不读取输入控件的值', () => {
    expect(script).not.toMatch(/\.value\b/);
    expect(mutedScript).not.toMatch(/\.value\b/);
    expect(resetScript).not.toMatch(/\.value\b/);
  });

  it('不出现 localStorage / sessionStorage', () => {
    for (const s of [script, mutedScript, hiddenScript, posScript, resetScript]) {
      expect(s).not.toContain('localStorage');
      expect(s).not.toContain('sessionStorage');
    }
  });

  it('不读取 cookie / document.cookie', () => {
    for (const s of [script, mutedScript, resetScript]) {
      expect(s).not.toContain('document.cookie');
      expect(s).not.toMatch(/\bcookie\b/);
    }
  });

  it('不出现 fetch / XMLHttpRequest —— 不新增任何请求（R2）', () => {
    for (const s of [script, mutedScript, resetScript]) {
      expect(s).not.toContain('fetch(');
      expect(s).not.toContain('XMLHttpRequest');
      expect(s).not.toContain('sendBeacon');
    }
  });
});

describe('数据内联安全', () => {
  it('把展示数据内联进脚本', () => {
    expect(script).toContain('"accountId":"personal"');
    expect(script).toContain('"sessionTokensText":"本会话已用 73 tokens"');
  });

  it('`</` 被转义 —— 数据里带闭合标签也不会截断脚本', () => {
    const evil: QuotaView = { ...VIEW, muteMsg: '</script><img src=x onerror=alert(1)>' };
    const s = buildQuotaInjectScript(evil);
    expect(s).not.toContain('</script>');
    expect(s).toContain('\\u003c/script');
  });

  it('U+2028 / U+2029 被转义（否则会打断 JS 解析）', () => {
    const evil: QuotaView = { ...VIEW, muteMsg: 'a\u2028b\u2029c' };
    const s = buildQuotaInjectScript(evil);
    expect(s).toContain('\\u2028');
    expect(s).toContain('\\u2029');
  });
});

describe('结构：两处 UI（v1.1.2 去掉回答徽标）', () => {
  it('可折叠浮层在脚本里', () => {
    expect(script).toContain('dsk-quota-host');
    expect(script).toContain('attachShadow');
    expect(script).toContain("wrap.classList.toggle('open')");
  });

  it('回答下方的次数徽标已整体移除（用户要求）', () => {
    expect(script).not.toContain('dsk-quota-badge');
    expect(script).not.toContain('本回答由 AI 生成');
  });

  it('浮层里不再渲染「次数」行', () => {
    expect(script).not.toContain("row('次数'");
    expect(mutedScript).not.toContain("row('次数'");
  });

  it('输入栏 token 行仍然存在，锚点是那行 AI 声明', () => {
    expect(script).toContain('内容由 AI 生成，请仔细甄别');
    expect(script).toContain('dsk-quota-token');
  });

  it('幂等：二次执行只更新，不堆叠元素', () => {
    expect(script).toContain('window.__dskQuota');
    expect(script).toContain('reused: true');
  });

  it('SPA 兜底：有 MutationObserver 与节流定时器', () => {
    expect(script).toContain('MutationObserver');
    expect(script).toContain('setTimeout');
  });

  it('页面不可见时不重绘（省 CPU）', () => {
    expect(script).toContain('visibilityState');
  });

  it('每一步都 try/catch —— 增强层不许把页面拖崩', () => {
    expect(script).toContain('catch (e)');
  });
});

describe('R3：AI 生成声明只追加、不改写', () => {
  it('不出现替换原文的两件套（data-dsk-orig 写入 + 改写 nodeValue）', () => {
    expect(script).not.toContain('data-dsk-orig');
    expect(script).not.toContain("setAttribute('title'");
    expect(script).not.toContain('node.nodeValue =');
  });

  it('token 用新建 span 插到声明之后', () => {
    expect(script).toContain("el('span', 'dsk-quota-token')");
    expect(script).toContain('insertBefore(');
  });

  it('没有数据时摘掉自己插入的片段，不留空标签', () => {
    expect(script).toContain("node.remove()");
  });
});

describe('浮层：拖动 / 恢复默认位置 / 迷你窗隐藏', () => {
  it('按住 bar 可拖动，并记住位置', () => {
    expect(script).toContain("bar.addEventListener('mousedown'");
    // 具名注册（不再裸 window.addEventListener），便于卸载时逐个摘掉
    expect(script).toContain("onWin('mousemove', onMove)");
    expect(script).toContain("onWin('mouseup', onUp)");
    expect(script).toContain('state.manualPos = { x:');
  });

  it('window 监听器登记在册，reset 时全部摘掉（反复注入不叠层）', () => {
    expect(script).toContain('winListeners');
    expect(script).toContain('offAllWin');
    expect(script).toContain('window.removeEventListener');
    // reset 脚本必须调用卸载
    expect(resetScript).toContain('offAllWin');
  });

  it('拖动后不误触发折叠（吞掉那次 click）', () => {
    expect(script).toContain('suppressClick');
  });

  it('展开后提供「恢复默认位置」按钮', () => {
    expect(script).toContain('恢复默认位置');
    expect(script).toContain('state.manualPos = null');
  });

  it('恢复默认位置要通知主进程，否则页面重载会把旧坐标灌回来（实测 bug）', () => {
    // 页面内清 manualPos 只解决"当下"，主进程 overlayPos 里还留着旧坐标，
    // 重载后首次注入又会拿它恢复 → 表现为"点了恢复默认，刷新一下又跑回原处"。
    expect(script).toContain('console.log(POS_RESET_MARK)');
    expect(script).toContain('[dsk-quota] pos-reset');
    // 主进程侧必须能匹配到同一个标记（两处字面量不能各写一份）
    expect(QUOTA_POS_RESET_MARK).toBe('[dsk-quota] pos-reset');
  });

  it('展开后重定位：rAF + 60ms 双保险（修过"展开不贴合输入栏"）', () => {
    expect(script).toContain('requestAnimationFrame');
    expect(script).toContain('reposition');
    expect(script).toContain(', 60)');
  });

  it('计算尺寸用 getBoundingClientRect，不用 offsetWidth（旧 bug）', () => {
    expect(script).toContain('getBoundingClientRect()');
    // 注释里会提到这两个名字（说明为什么不能用），这里断言的是**真的没有调用**
    expect(script).not.toMatch(/\.offsetWidth\b/);
    expect(script).not.toMatch(/\.offsetHeight\b/);
  });

  it('迷你窗：hidden 选项让宿主元素 display:none', () => {
    expect(hiddenScript).toContain('const HIDDEN = true;');
    expect(hiddenScript).toContain("host.style.display = state.hidden ? 'none' : ''");
    // 数据仍然内联，只是不渲染 —— 退出迷你窗后立刻恢复，不需要重新拉数据
    expect(hiddenScript).toContain('"sessionTokensText":"本会话已用 73 tokens"');
  });

  it('位置上报只认"用户拖动过"的值，默认位置不固化', () => {
    // pos 为 null 时上报 null，主进程据此继续贴输入框，而不是记成固定坐标
    expect(script).toContain('pos: state.manualPos ?');
    expect(posScript).toContain('"x":640');
    expect(posScript).toContain('"y":220');
  });

  it('二次注入不覆盖页面内的拖动结果（否则位置被数据刷新拽回）', () => {
    const reused = script.slice(script.indexOf('if (window.__dskQuota)'));
    expect(reused).not.toContain('prev.manualPos =');
  });
});

describe('模板转义正确性（历史上踩过的坑）', () => {
  it('注入脚本能被 JS 解析器接受', () => {
    // 只构造不执行：语法错误会在这里抛，比在真实页面里静默失败好得多
    for (const s of [script, mutedScript, hiddenScript, posScript, resetScript]) {
      expect(() => new Function(s)).not.toThrow();
    }
  });

  it('CSS 的换行分隔符保留 \\n —— 模板里写单个反斜杠会被吃掉', () => {
    // 坏味道：].join('\n') 在模板里退化成真正的换行符，样式表整段失效
    expect(script).toContain("].join('\\n')");
  });
});

describe('卸载脚本', () => {
  it('移除宿主元素与 token 片段（不碰页面原文）', () => {
    expect(resetScript).toContain('dsk-quota-host');
    expect(resetScript).toContain('dsk-quota-token');
    expect(resetScript).not.toContain('dsk-quota-badge');
  });

  it('断开观察器与定时器，清掉全局标记', () => {
    expect(resetScript).toContain('observer.disconnect()');
    expect(resetScript).toContain('resizeObserver.disconnect()');
    expect(resetScript).toContain('clearTimeout');
    expect(resetScript).toContain('delete window.__dskQuota');
  });
});

describe('禁言/额度耗尽状态', () => {
  it('禁言数据进脚本，浮层据此变色', () => {
    expect(mutedScript).toContain('"isMuted":true');
    expect(mutedScript).toContain("classList.toggle('mute'");
    expect(mutedScript).toContain('已禁言');
  });

  it('服务端文案逐条显示（明文）', () => {
    expect(mutedScript).toContain('深度思考额度已用尽');
    expect(mutedScript).toContain('额度提醒');
  });
});
