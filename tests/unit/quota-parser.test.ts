/**
 * 单元测试：`src/session/quota-parser.ts`
 *
 * 覆盖：
 *  - `chat/status` / `client/settings` / `history_messages` 三类响应的解析（含真实字段名 snake_case）；
 *  - **宽容性**：坏 JSON、code 非 0、字段缺失、类型错乱一律不抛错；
 *  - 口径约束：没有总量就不编造"剩余"，`null` 不渲染成 0；
 *  - 展示快照组装（禁言 / 额度耗尽 / 无数据 / 缓存标记）。
 *
 * 纪律：纯函数测试，不 import electron、不碰网络。
 */
import { describe, expect, it } from 'vitest';
import {
  accountQuotaSuffix,
  collectServerMessages,
  composeQuotaView,
  configLabel,
  describeQuotaStatus,
  exhaustedModelTypes,
  findConfig,
  formatClock,
  formatInputLimit,
  formatRegenerateLimits,
  formatSessionTokens,
  formatTrayTooltip,
  maxAccumulatedTokens,
  parseChatStatusResponse,
  parseHistoryAccumulatedTokens,
  parseHistoryActionUsage,
  parseHistorySessionId,
  parseModelSettingsResponse,
  classifyQuotaAction,
  pickBizData,
  safeJsonParse,
  toMillis,
  type ChatStatus,
  type ModelQuotaConfig,
  type QuotaState,
} from '../../src/session/quota-parser.ts';

/* ---------------------------------------------------------------- fixture */

/** 站点真实包络：`{code, data:{biz_code, biz_data}}` */
function envelope(bizData: unknown): string {
  return JSON.stringify({ code: 0, msg: '', data: { biz_code: 0, biz_data: bizData } });
}

const CHAT_STATUS_BODY = envelope({
  generated_at: 1791598000,
  mute: null,
  quotas: [
    { model_type: 'default', is_exhausted: false, reset_at: 0, msg: null, alert: null },
    {
      model_type: 'deep_think',
      is_exhausted: true,
      reset_at: 1791600000,
      msg: '深度思考额度已用完',
      alert: {
        show_key: 'quota-2026-11',
        content: {
          title: '额度提醒',
          description: '深度思考额度已用尽，将于 22:23 重置',
          button_group: { button_layout: 'row', buttons: [{ text: '知道了', style: 'primary', action: 'dismiss' }] },
        },
      },
    },
  ],
});

const MUTED_BODY = envelope({
  generated_at: 1791598100,
  mute: { mute_until: 1791684400, msg: '由于违反用户使用规范，你的账号已被禁言至 11 月 19 日。' },
  quotas: [],
});

const SETTINGS_BODY = envelope({
  entries: [
    {
      key: 'model_configs',
      value: [
        {
          model_type: 'default',
          name: 'V4.1 Flash',
          enabled: true,
          switchable: true,
          regenerate_quota: 6,
          edit_quota: 6,
          input_character_limit: 40960,
          file_feature: { token_limit: 61440, token_limit_with_thinking: 122880 },
        },
        {
          model_type: 'deep_think',
          name: '深度思考',
          enabled: true,
          regenerate_quota: 3,
          edit_quota: 2,
          input_character_limit: 32768,
        },
      ],
    },
  ],
  version: 7,
  fetchAfterSec: 300,
});

const HISTORY_BODY = envelope({
  chat_messages: [
    { message_id: 1, role: 'USER', accumulated_token_usage: 12 },
    { message_id: 2, role: 'ASSISTANT', accumulated_token_usage: 73 },
    { message_id: 3, role: 'USER', accumulated_token_usage: 75 },
  ],
});

/* ---------------------------------------------------------------- 通用工具 */

describe('toMillis：秒/毫秒宽容转换', () => {
  it('秒级时间戳转毫秒', () => {
    expect(toMillis(1791598000)).toBe(1791598000000);
  });

  it('已经是毫秒的原样返回', () => {
    expect(toMillis(1791598000000)).toBe(1791598000000);
  });

  it('字符串数字也接受', () => {
    expect(toMillis('1791598000')).toBe(1791598000000);
  });

  it('非法值返回 0 且不抛错', () => {
    expect(toMillis(null)).toBe(0);
    expect(toMillis(undefined)).toBe(0);
    expect(toMillis('abc')).toBe(0);
    expect(toMillis(-5)).toBe(0);
    expect(toMillis(NaN)).toBe(0);
  });
});

describe('safeJsonParse / pickBizData', () => {
  it('坏 JSON 返回 null', () => {
    expect(safeJsonParse('{not json')).toBeNull();
    expect(safeJsonParse('')).toBeNull();
  });

  it('正常包络取出 biz_data', () => {
    const data = pickBizData(safeJsonParse(CHAT_STATUS_BODY));
    expect(data).toMatchObject({ generated_at: 1791598000 });
  });

  it('code 非 0 视为失败', () => {
    const body = JSON.stringify({ code: 40001, data: { biz_code: 0, biz_data: { quotas: [] } } });
    expect(pickBizData(safeJsonParse(body))).toBeNull();
  });

  it('biz_code 非 0 视为失败', () => {
    const body = JSON.stringify({ code: 0, data: { biz_code: 7, biz_data: { quotas: [] } } });
    expect(pickBizData(safeJsonParse(body))).toBeNull();
  });

  it('没有包络时接受裸 biz_data', () => {
    expect(pickBizData({ biz_data: { quotas: [] } })).toEqual({ quotas: [] });
  });
});

/* ---------------------------------------------------------------- chat/status */

describe('parseChatStatusResponse', () => {
  it('解析额度列表与告警文案', () => {
    const status = parseChatStatusResponse(CHAT_STATUS_BODY);
    expect(status).not.toBeNull();
    expect(status?.generatedAt).toBe(1791598000000);
    expect(status?.isMuted).toBe(false);
    expect(status?.quotas).toHaveLength(2);

    const deep = status?.quotas.find((q) => q.modelType === 'deep_think');
    expect(deep?.isExhausted).toBe(true);
    expect(deep?.resetAt).toBe(1791600000000);
    expect(deep?.msg).toBe('深度思考额度已用完');
    expect(deep?.alertTitle).toBe('额度提醒');
    expect(deep?.alertDescription).toBe('深度思考额度已用尽，将于 22:23 重置');
  });

  it('有 mute 对象即视为禁言中（前端口径 isMuted = mute != null）', () => {
    const status = parseChatStatusResponse(MUTED_BODY);
    expect(status?.isMuted).toBe(true);
    expect(status?.muteUntil).toBe(1791684400000);
    expect(status?.muteMsg).toContain('已被禁言');
  });

  it('坏 JSON 返回 null', () => {
    expect(parseChatStatusResponse('<html>502</html>')).toBeNull();
  });

  it('缺少 quotas 时不抛错，返回空列表', () => {
    const status = parseChatStatusResponse(envelope({ generated_at: 1791598000 }));
    expect(status).not.toBeNull();
    expect(status?.quotas).toEqual([]);
  });

  it('camelCase 字段也接受', () => {
    const body = envelope({
      generatedAt: 1791598000,
      mute: { muteUntil: 1791684400, msg: '禁言中' },
      quotas: [{ modelType: 'x', isExhausted: true, resetAt: 1791600000, msg: '没了' }],
    });
    const status = parseChatStatusResponse(body);
    expect(status?.isMuted).toBe(true);
    expect(status?.quotas[0]).toMatchObject({ modelType: 'x', isExhausted: true });
  });
});

/* ---------------------------------------------------------------- client/settings */

describe('parseModelSettingsResponse', () => {
  it('深度搜索出 model_configs 的上限字段', () => {
    const configs = parseModelSettingsResponse(SETTINGS_BODY);
    expect(configs).not.toBeNull();
    expect(configs).toHaveLength(2);

    const def = configs?.find((c) => c.modelType === 'default');
    expect(def).toMatchObject({
      name: 'V4.1 Flash',
      enabled: true,
      regenerateQuota: 6,
      editQuota: 6,
      inputCharacterLimit: 40960,
      fileTokenLimit: 61440,
      fileTokenLimitWithThinking: 122880,
    });
  });

  it('解析不到配置返回 null（调用方保留旧值，不覆盖成空）', () => {
    expect(parseModelSettingsResponse(envelope({ entries: [] }))).toBeNull();
    expect(parseModelSettingsResponse('not json')).toBeNull();
  });

  it('同一 modelType 重复出现时保留字段更完整的那份', () => {
    const body = envelope({
      entries: [
        { model_type: 'm', regenerate_quota: 6 },
        { model_type: 'm', regenerate_quota: 6, edit_quota: 6, input_character_limit: 100, name: '完整' },
      ],
    });
    const configs = parseModelSettingsResponse(body);
    expect(configs).toHaveLength(1);
    expect(configs?.[0]).toMatchObject({ name: '完整', editQuota: 6, inputCharacterLimit: 100 });
  });

  it('没有上限字段的对象不算 model_config（避免误吞别的配置）', () => {
    const body = envelope({ entries: [{ model_type: 'm', unrelated: 1 }] });
    expect(parseModelSettingsResponse(body)).toBeNull();
  });
});

/* ---------------------------------------------------------------- history */

describe('maxAccumulatedTokens / parseHistoryAccumulatedTokens', () => {
  it('取数组里的最大值（累计值是单调递增的）', () => {
    expect(maxAccumulatedTokens([{ accumulated_token_usage: 12 }, { accumulated_token_usage: 73 }])).toBe(73);
  });

  it('嵌套结构也能找到', () => {
    expect(maxAccumulatedTokens({ a: { b: [{ accumulatedTokenUsage: 5 }, { accumulatedTokenUsage: 9 }] } })).toBe(9);
  });

  it('没有该字段返回 null（不是 0）', () => {
    expect(maxAccumulatedTokens({ foo: 'bar' })).toBeNull();
    expect(maxAccumulatedTokens(null)).toBeNull();
  });

  it('从 history_messages 响应里取到 75', () => {
    expect(parseHistoryAccumulatedTokens(HISTORY_BODY)).toBe(75);
  });

  it('坏响应返回 null', () => {
    expect(parseHistoryAccumulatedTokens('garbage')).toBeNull();
  });
});

describe('parseHistorySessionId', () => {
  const SESSION_ID = '11111111-1111-4111-8111-111111111111';

  it('从真实形态的 history 响应里取到 chat_session.id', () => {
    expect(
      parseHistorySessionId(
        envelope({
          chat_session: { id: SESSION_ID, title: '<会话标题>', model_type: 'default' },
          chat_messages: [],
        }),
      ),
    ).toBe(SESSION_ID);
  });

  it('缺字段 / 类型不对 / 过短 id 返回 null（调用方退回 URL 比对）', () => {
    expect(parseHistorySessionId(envelope({ chat_messages: [] }))).toBeNull();
    expect(parseHistorySessionId(envelope({ chat_session: { id: 12 } }))).toBeNull();
    expect(parseHistorySessionId(envelope({ chat_session: { id: 'too-short' } }))).toBeNull();
    expect(parseHistorySessionId('not json')).toBeNull();
    expect(parseHistorySessionId('')).toBeNull();
  });

  it('业务码非 0 的失败响应不当作有效归属', () => {
    const body = JSON.stringify({
      code: 0,
      data: { biz_code: 1, biz_data: { chat_session: { id: SESSION_ID } } },
    });
    expect(parseHistorySessionId(body)).toBeNull();
  });

  it('失败响应即使带顶层 chat_session 也不兜底（N36）', () => {
    expect(
      parseHistorySessionId(JSON.stringify({ code: 1, chat_session: { id: SESSION_ID } })),
    ).toBeNull();
  });

  it('缓存命中时顶层 chat_session 也能取到（N27）', () => {
    expect(
      parseHistorySessionId(
        JSON.stringify({
          chat_session: { id: SESSION_ID },
          chat_messages: [],
          cache_control: 'MERGE',
        }),
      ),
    ).toBe(SESSION_ID);
  });

  it('大写 UUID 归一化为小写，避免与页面 URL 大小写敏感比较失败（N28）', () => {
    expect(
      parseHistorySessionId(envelope({ chat_session: { id: SESSION_ID.toUpperCase() } })),
    ).toBe(SESSION_ID);
  });
});

/* ---------------------------------------------------------------- 展示文案 */

describe('格式化文案', () => {
  const cfg: ModelQuotaConfig = {
    modelType: 'default',
    name: 'V4.1 Flash',
    enabled: true,
    regenerateQuota: 6,
    editQuota: 4,
    inputCharacterLimit: 40960,
    fileTokenLimit: null,
    fileTokenLimitWithThinking: null,
  };

  it('重新生成/修改上限行', () => {
    expect(formatRegenerateLimits(cfg)).toBe('重新生成上限 6 次 · 修改上限 4 次');
  });

  it('站点未下发时回落 5（与前端 u1 判定一致）', () => {
    const bare: ModelQuotaConfig = { ...cfg, regenerateQuota: null, editQuota: null };
    expect(formatRegenerateLimits(bare)).toBe('重新生成上限 5 次 · 修改上限 5 次');
    expect(formatRegenerateLimits(null)).toBe('重新生成上限 5 次 · 修改上限 5 次');
  });

  it('单次输入上限带千分位；未下发返回 null（不显示）', () => {
    expect(formatInputLimit(cfg)).toBe('单次输入上限 40,960 字');
    expect(formatInputLimit({ ...cfg, inputCharacterLimit: null })).toBeNull();
    expect(formatInputLimit(null)).toBeNull();
  });

  it('会话 token 只显示已用量；null 不显示（绝不显示 0）', () => {
    expect(formatSessionTokens(14800)).toBe('本会话已用 14,800 tokens');
    expect(formatSessionTokens(0)).toBe('本会话已用 0 tokens');
    expect(formatSessionTokens(null)).toBeNull();
  });

  it('formatClock 输出 HH:MM，非法返回空串', () => {
    const ms = new Date(2026, 10, 17, 22, 23, 0).getTime();
    expect(formatClock(ms)).toBe('22:23');
    expect(formatClock(0)).toBe('');
    expect(formatClock(NaN)).toBe('');
  });

  it('configLabel 依次回落 name → modelType → 默认模型', () => {
    expect(configLabel(cfg)).toBe('V4.1 Flash');
    expect(configLabel({ ...cfg, name: null })).toBe('default');
    expect(configLabel({ ...cfg, name: null, modelType: null })).toBe('默认模型');
    expect(configLabel(null)).toBe('默认模型');
  });

  it('findConfig 按 modelType 命中，未命中回落第一个启用项', () => {
    const list: ModelQuotaConfig[] = [
      { ...cfg, modelType: 'a', enabled: false },
      { ...cfg, modelType: 'b', enabled: true },
    ];
    expect(findConfig(list, 'b')?.modelType).toBe('b');
    expect(findConfig(list, 'zzz')?.modelType).toBe('b');
    expect(findConfig([], 'b')).toBeNull();
  });
});

describe('describeQuotaStatus / exhaustedModelTypes / collectServerMessages', () => {
  const normal: ChatStatus = { generatedAt: 1, isMuted: false, muteUntil: 0, muteMsg: null, quotas: [] };

  it('没有数据说"额度未知"，不假装正常', () => {
    expect(describeQuotaStatus(null)).toBe('额度未知');
  });

  it('全部正常', () => {
    expect(describeQuotaStatus(normal)).toBe('额度正常');
  });

  it('禁言优先于额度耗尽，并给出截止时间', () => {
    const muted: ChatStatus = {
      ...normal,
      isMuted: true,
      muteUntil: new Date(2026, 10, 17, 22, 23, 0).getTime(),
      quotas: [{ modelType: 'x', isExhausted: true, resetAt: 0, msg: null, alertTitle: null, alertDescription: null }],
    };
    expect(describeQuotaStatus(muted)).toBe('已禁言至 22:23');
  });

  it('额度耗尽带重置时间', () => {
    const exhausted: ChatStatus = {
      ...normal,
      quotas: [
        {
          modelType: 'deep_think',
          isExhausted: true,
          resetAt: new Date(2026, 10, 17, 22, 23, 0).getTime(),
          msg: null,
          alertTitle: null,
          alertDescription: null,
        },
      ],
    };
    expect(describeQuotaStatus(exhausted)).toBe('deep_think 已耗尽（22:23 重置）');
    expect(exhaustedModelTypes(exhausted)).toEqual(['deep_think']);
  });

  it('服务端文案去重且跳过空值', () => {
    const status: ChatStatus = {
      ...normal,
      muteMsg: '禁言文案',
      quotas: [
        {
          modelType: 'a',
          isExhausted: true,
          resetAt: 0,
          msg: '额度文案',
          alertTitle: '标题',
          alertDescription: '额度文案',
        },
        { modelType: 'b', isExhausted: false, resetAt: 0, msg: '', alertTitle: null, alertDescription: null },
      ],
    };
    expect(collectServerMessages(status)).toEqual(['禁言文案', '额度文案', '标题']);
  });
});

/* ---------------------------------------------------------------- 快照组装 */

describe('composeQuotaView', () => {
  const state: QuotaState = {
    accountId: 'personal',
    updatedAt: 1791598000000,
    chatStatus: parseChatStatusResponse(CHAT_STATUS_BODY),
    modelConfigs: parseModelSettingsResponse(SETTINGS_BODY) ?? [],
  };

  it('完整数据 → 三处 UI 都有内容', () => {
    const view = composeQuotaView(state, { accountId: 'personal', sessionTokens: 73 });
    expect(view.modelLabel).toBe('V4.1 Flash');
    expect(view.regenerateLimits).toBe('重新生成上限 6 次 · 修改上限 6 次');
    expect(view.inputLimit).toBe('单次输入上限 40,960 字');
    expect(view.sessionTokens).toBe(73);
    expect(view.sessionTokensText).toBe('本会话已用 73 tokens');
    expect(view.fromCache).toBe(false);
    expect(view.exhaustedModels).toEqual(['deep_think']);
    expect(view.quotaSummary).toContain('deep_think 已耗尽');
  });

  it('完全没有数据：仍给上限行（前端回落 5），额度说未知，token 不显示', () => {
    const view = composeQuotaView(null, { accountId: 'work' });
    expect(view.quotaSummary).toBe('额度未知');
    expect(view.regenerateLimits).toBe('重新生成上限 5 次 · 修改上限 5 次');
    expect(view.inputLimit).toBeNull();
    expect(view.sessionTokens).toBeNull();
    expect(view.sessionTokensText).toBeNull();
    expect(view.updatedAt).toBe(0);
  });

  it('sessionTokens 未传入时不显示 0', () => {
    const view = composeQuotaView(state, { accountId: 'personal' });
    expect(view.sessionTokens).toBeNull();
    expect(view.sessionTokensText).toBeNull();
  });

  it('fromCache 透传（其余账号显示缓存）', () => {
    const view = composeQuotaView(state, { accountId: 'work', fromCache: true });
    expect(view.fromCache).toBe(true);
  });

  it('指定 modelType 时用对应配置的上限', () => {
    const view = composeQuotaView(state, { accountId: 'personal', modelType: 'deep_think' });
    expect(view.modelLabel).toBe('深度思考');
    expect(view.regenerateLimits).toBe('重新生成上限 3 次 · 修改上限 2 次');
    expect(view.inputLimit).toBe('单次输入上限 32,768 字');
  });

  it('传入已用次数时显示剩余/上限（口径：优先剩余）', () => {
    const view = composeQuotaView(state, {
      accountId: 'personal',
      regenerateUsed: 2,
      editUsed: 1,
      actionCountsEstimated: false,
    });
    expect(view.regenerateLimits).toBe('重新生成剩余 4/6 次 · 修改剩余 5/6 次');
    expect(view.regenerateUsed).toBe(2);
    expect(view.editUsed).toBe(1);
    expect(view.actionCountsEstimated).toBe(false);
  });

  it('已用次数超过上限时剩余归 0，不为负', () => {
    const view = composeQuotaView(state, {
      accountId: 'personal',
      regenerateUsed: 99,
      editUsed: 99,
    });
    expect(view.regenerateLimits).toBe('重新生成剩余 0/6 次 · 修改剩余 0/6 次');
  });

  it('只有一个口径有观测时仍退回上限文案（不把未知当 0）', () => {
    const view = composeQuotaView(state, { accountId: 'personal', regenerateUsed: 1 });
    expect(view.regenerateLimits).toBe('重新生成上限 6 次 · 修改上限 6 次');
    expect(view.actionCountsEstimated).toBe(false);
  });
});

describe('已用次数：请求识别与 history 校准', () => {
  it('classifyQuotaAction 识别 regenerate / edit 请求，其他为 null', () => {
    expect(classifyQuotaAction('https://chat.deepseek.com/api/v0/chat/regenerate')).toBe('regenerate');
    expect(classifyQuotaAction('https://chat.deepseek.com/api/v0/chat/edit_message')).toBe('edit');
    expect(classifyQuotaAction('https://chat.deepseek.com/api/v0/chat/completion')).toBeNull();
    expect(classifyQuotaAction('https://chat.deepseek.com/api/v0/chat/status')).toBeNull();
  });

  it('history 分支关系：同一 parent 下多条 assistant=重新生成，多条 user=修改', () => {
    // u1 -> a1（a1 有兄弟 a1'：一次重新生成）-> u2（u2 有兄弟 u2'：一次修改输入）
    const body = envelope({
      chat_messages: [
        { message_id: 'u1', parent_id: '', role: 'USER' },
        { message_id: 'a1', parent_id: 'u1', role: 'ASSISTANT' },
        { message_id: 'a1b', parent_id: 'u1', role: 'ASSISTANT' },
        { message_id: 'u2', parent_id: 'a1b', role: 'USER' },
        { message_id: 'u2b', parent_id: 'a1b', role: 'USER' },
        { message_id: 'a2', parent_id: 'u2b', role: 'ASSISTANT' },
      ],
    });
    expect(parseHistoryActionUsage(body)).toEqual({ regenerateUsed: 1, editUsed: 1 });
  });

  it('无分支时已用 0（history 有效即采纳，0 也是真值）', () => {
    const body = envelope({
      chat_messages: [
        { message_id: 'u1', parent_id: '', role: 'USER' },
        { message_id: 'a1', parent_id: 'u1', role: 'ASSISTANT' },
      ],
    });
    expect(parseHistoryActionUsage(body)).toEqual({ regenerateUsed: 0, editUsed: 0 });
  });

  it('history 空数组 / 缺 id / 坏 JSON 一律 null（调用方保留运行期计数）', () => {
    expect(parseHistoryActionUsage(envelope({ chat_messages: [] }))).toBeNull();
    expect(
      parseHistoryActionUsage(envelope({ chat_messages: [{ message_id: 'x' }] })),
    ).toBeNull();
    expect(parseHistoryActionUsage('not json')).toBeNull();
  });

  it('formatRegenerateLimits 直接调用：usage 全有才显示剩余', () => {
    const cfg: ModelQuotaConfig = {
      modelType: 'default',
      name: '快速模式',
      enabled: true,
      regenerateQuota: 5,
      editQuota: 5,
      inputCharacterLimit: 2621440,
      fileTokenLimit: null,
      fileTokenLimitWithThinking: null,
    };
    expect(formatRegenerateLimits(cfg, { regenerateUsed: 1, editUsed: 2 })).toBe(
      '重新生成剩余 4/5 次 · 修改剩余 3/5 次',
    );
    expect(formatRegenerateLimits(cfg, { regenerateUsed: 1, editUsed: null })).toBe(
      '重新生成上限 5 次 · 修改上限 5 次',
    );
    expect(formatRegenerateLimits(cfg)).toBe('重新生成上限 5 次 · 修改上限 5 次');
  });
});

describe('formatTrayTooltip / accountQuotaSuffix', () => {
  const state: QuotaState = {
    accountId: 'personal',
    updatedAt: 1791598000000,
    chatStatus: parseChatStatusResponse(CHAT_STATUS_BODY),
    modelConfigs: parseModelSettingsResponse(SETTINGS_BODY) ?? [],
  };

  it('tooltip 含账号、额度、输入上限与用量', () => {
    const view = composeQuotaView(state, { accountId: 'personal', sessionTokens: 73 });
    const tip = formatTrayTooltip(view, 'DeepSeek Chat');
    expect(tip.split('\n')[0]).toBe('DeepSeek Chat');
    expect(tip).toContain('账号：personal');
    expect(tip).toContain('单次输入上限');
    expect(tip).toContain('本会话已用 73 tokens');
  });

  it('v1.1.2：tooltip 不再出现重新生成/修改次数（用户要求整块去掉）', () => {
    const view = composeQuotaView(state, {
      accountId: 'personal',
      sessionTokens: 73,
      regenerateUsed: 2,
      editUsed: 1,
      actionCountsEstimated: false,
    });
    const tip = formatTrayTooltip(view, 'X');
    expect(tip).not.toContain('重新生成');
    expect(tip).not.toContain('修改上限');
    // 但字段仍然算得出来（数据通路保留，只是不展示）
    expect(view.regenerateLimits).toContain('重新生成剩余');
  });

  it('缓存账号在 tooltip 里标注', () => {
    const view = composeQuotaView(state, { accountId: 'work', fromCache: true });
    expect(formatTrayTooltip(view, 'X')).toContain('账号：work（缓存）');
  });

  it('账号菜单后缀：无缓存显示"未知"，有缓存标注', () => {
    expect(accountQuotaSuffix(null, false)).toBe('未知');
    expect(accountQuotaSuffix(state, false)).toContain('已耗尽');
    expect(accountQuotaSuffix(state, true)).toBe(`${describeQuotaStatus(state.chatStatus)} · 缓存`);
  });
});
