import { describe, expect, it } from 'vitest';
import {
  assembleTurn,
  collectAccumulatedTokens,
  parseDeepSeekSse,
  parseSseDeltas,
  parseSseFrames,
  pickFirstString,
  pickStringAt,
  readFragments,
  structureFingerprint,
} from '../../src/session/sse-parser';

/** 构造一段 OpenAI 风格的 SSE 文本 */
function openAiStyle(chunks: string[], reasoning: string[] = []): string {
  const lines: string[] = [];
  for (const r of reasoning) {
    lines.push(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: r } }] })}`, '');
  }
  for (const c of chunks) {
    lines.push(`data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}`, '');
  }
  lines.push('data: [DONE]', '');
  return lines.join('\n');
}

describe('parseSseFrames', () => {
  it('按空行切分事件', () => {
    const frames = parseSseFrames('data: a\n\ndata: b\n\n');
    expect(frames.map((f) => f.data)).toEqual(['a', 'b']);
  });

  it('同一事件的多个 data 行以换行连接（SSE 规范）', () => {
    const frames = parseSseFrames('data: {"a":\ndata: 1}\n\n');
    expect(frames).toHaveLength(1);
    expect(frames[0]?.data).toBe('{"a":\n1}');
  });

  it('识别 event 字段', () => {
    const frames = parseSseFrames('event: message\ndata: x\n\n');
    expect(frames[0]?.event).toBe('message');
    expect(frames[0]?.data).toBe('x');
  });

  it('忽略注释与心跳行', () => {
    const frames = parseSseFrames(': keep-alive\n\ndata: y\n\n');
    expect(frames.map((f) => f.data)).toEqual(['y']);
  });

  it('字段名后可选一个空格（多空格则保留其余）', () => {
    expect(parseSseFrames('data:  two-spaces\n\n')[0]?.data).toBe(' two-spaces');
  });

  it('兼容 CRLF 与末尾无空行', () => {
    expect(parseSseFrames('data: a\r\n\r\ndata: b')[0]?.data).toBe('a');
    expect(parseSseFrames('data: a\r\n\r\ndata: b')[1]?.data).toBe('b');
  });

  it('空输入返回空数组', () => {
    expect(parseSseFrames('')).toEqual([]);
    expect(parseSseFrames(undefined as unknown as string)).toEqual([]);
  });
});

describe('pickStringAt / pickFirstString', () => {
  it('按路径取字符串', () => {
    const obj = { choices: [{ delta: { content: 'hi' } }] };
    expect(pickStringAt(obj, ['choices', 0, 'delta', 'content'])).toBe('hi');
  });

  it('路径不存在或类型不符时返回 null（不抛错）', () => {
    expect(pickStringAt({ a: 1 }, ['a', 'b'])).toBeNull();
    expect(pickStringAt(null, ['a'])).toBeNull();
    expect(pickStringAt({ a: { b: 42 } }, ['a', 'b'])).toBeNull(); // 数字不是字符串
  });

  it('按候选顺序返回第一个命中', () => {
    const obj = { text: 'fallback' };
    expect(pickFirstString(obj, [['choices', 0, 'delta', 'content'], ['text']])).toBe('fallback');
  });
});

describe('parseSseDeltas', () => {
  it('提取正文增量并识别结束标记', () => {
    const { deltas, skipped } = parseSseDeltas(openAiStyle(['你', '好']));
    expect(deltas.map((d) => d.text)).toEqual(['你', '好', '']);
    expect(deltas.at(-1)?.done).toBe(true);
    expect(skipped).toBe(0);
  });

  it('区分思考增量与正文增量', () => {
    const { deltas } = parseSseDeltas(openAiStyle(['答'], ['想', '了']));
    expect(deltas.filter((d) => d.reasoning).map((d) => d.reasoning)).toEqual(['想', '了']);
    expect(deltas.filter((d) => d.text).map((d) => d.text)).toEqual(['答']);
  });

  it('支持多种候选字段形态（content / v / response / text）', () => {
    const raw = [
      `data: ${JSON.stringify({ content: 'a' })}`,
      `data: ${JSON.stringify({ v: 'b' })}`,
      `data: ${JSON.stringify({ response: 'c' })}`,
      `data: ${JSON.stringify({ text: 'd' })}`,
      '',
    ].join('\n\n');
    const { deltas } = parseSseDeltas(raw);
    expect(deltas.map((d) => d.text).join('')).toBe('abcd');
  });

  it('非 JSON 帧被安全跳过，不影响其余帧', () => {
    const raw = ['data: not-json', 'data: {"content":"ok"}', ''].join('\n\n');
    const { deltas, skipped } = parseSseDeltas(raw);
    expect(deltas.map((d) => d.text)).toEqual(['ok']);
    expect(skipped).toBe(1);
  });

  it('不含文本字段的 JSON 帧计入 skipped（不猜内容）', () => {
    const raw = `data: ${JSON.stringify({ ping: 1 })}`;
    const { deltas, skipped } = parseSseDeltas(raw);
    expect(deltas).toHaveLength(0);
    expect(skipped).toBe(1);
  });

  it('空输入不抛错', () => {
    expect(parseSseDeltas('')).toEqual({ deltas: [], skipped: 0 });
  });
});

describe('assembleTurn', () => {
  it('把增量拼成完整回答，含思考与结束标记', () => {
    const turn = assembleTurn(openAiStyle(['你', '好', '！'], ['先想一下']));
    expect(turn.text).toBe('你好！');
    expect(turn.reasoning).toBe('先想一下');
    expect(turn.done).toBe(true);
    expect(turn.skipped).toBe(0);
  });

  it('没有结束标记时 done=false（流可能被中断）', () => {
    const raw = `data: ${JSON.stringify({ content: '半' })}`;
    expect(assembleTurn(raw).done).toBe(false);
    expect(assembleTurn(raw).text).toBe('半');
  });

  it('空流返回空结果', () => {
    const turn = assembleTurn('');
    expect(turn.text).toBe('');
    expect(turn.done).toBe(false);
    expect(turn.frames).toBe(0);
  });
});

describe('structureFingerprint（诊断用，不含内容）', () => {
  it('只输出键路径与类型，且不包含任何文本内容', () => {
    const raw = openAiStyle(['秘密内容'], ['秘密思考']);
    const fp = structureFingerprint(raw);
    expect(fp.dataFrames).toBe(2);
    expect(fp.keys).toContain('choices[].delta.content');
    expect(fp.keys).toContain('choices[].delta.reasoning_content');
    const dump = JSON.stringify(fp);
    expect(dump).not.toContain('秘密内容');
    expect(dump).not.toContain('秘密思考');
  });

  it('非 JSON 帧不计入 dataFrames', () => {
    const fp = structureFingerprint('data: not-json\n\ndata: [DONE]\n\n');
    expect(fp.dataFrames).toBe(0);
  });
});

describe('结束标记：通用层也要认 event: close', () => {
  it('event: close 且 data 为空时仍判为结束（原实现只看 data，会漏掉）', () => {
    const { deltas } = parseSseDeltas('event: close\ndata: {}\n\n');
    expect(deltas.some((d) => d.done)).toBe(true);
  });

  it('无 event 字段时仍能用 [DONE] 判定', () => {
    const { deltas } = parseSseDeltas('data: [DONE]\n\n');
    expect(deltas.some((d) => d.done)).toBe(true);
  });
});

describe('parseDeepSeekSse（按真实样本校准）', () => {
  /** 合成一段 DeepSeek 风格流：ready →（可选 THINK 阶段）→ 正文增量 → close */
  function deepSeekStyle(deltas: string[], thinking: string[] = []): string {
    const lines: string[] = [];
    lines.push('event: ready', `data: ${JSON.stringify({ request_message_id: 1 })}`, '');
    if (thinking.length > 0) {
      lines.push(
        `data: ${JSON.stringify({
          v: { response: { role: 'ASSISTANT', status: 'WIP', fragments: [{ type: 'THINK', content: '' }] } },
        })}`,
        '',
      );
      for (const t of thinking) lines.push(`data: ${JSON.stringify({ v: t })}`, '');
      // 切到正文阶段
      lines.push(
        `data: ${JSON.stringify({ v: { response: { fragments: [{ type: 'RESPONSE', content: '' }] } } })}`,
        '',
      );
    }
    for (const d of deltas) lines.push(`data: ${JSON.stringify({ v: d })}`, '');
    lines.push('event: close', 'data: {}', '');
    return lines.join('\n');
  }

  it('逐字增量拼成正文，event: close 作为结束标记', () => {
    const turn = parseDeepSeekSse(deepSeekStyle(['你', '好', '！']));
    expect(turn.text).toBe('你好！');
    expect(turn.done).toBe(true);
    expect(turn.counts.ready).toBe(1);
    expect(turn.counts.close).toBe(1);
    expect(turn.counts['text-delta']).toBe(3);
  });

  it('按 fragments.type=THINK 把增量归入思考，切换后归入正文', () => {
    const turn = parseDeepSeekSse(deepSeekStyle(['答'], ['想', '了']));
    expect(turn.thinking).toBe('想了');
    expect(turn.text).toBe('答');
  });

  it('没有 close 事件时 done=false（流可能中断）', () => {
    const raw = `data: ${JSON.stringify({ v: '半' })}`;
    expect(parseDeepSeekSse(raw).done).toBe(false);
    expect(parseDeepSeekSse(raw).text).toBe('半');
  });

  it('识别 ready / update_session / title 事件', () => {
    // 注意：SSE 以**空行**分隔事件；若用 '\n' 连接会把所有行并成同一个事件
    const raw = [
      'event: ready',
      'data: {}',
      'event: update_session',
      'data: {}',
      'event: title',
      'data: {}',
      'event: close',
      'data: {}',
      '',
    ].join('\n\n');
    const turn = parseDeepSeekSse(raw);
    expect(turn.counts.ready).toBe(1);
    expect(turn.counts.session).toBe(1);
    expect(turn.counts.title).toBe(1);
    expect(turn.done).toBe(true);
  });

  it('提取联网搜索引用并按 url 去重', () => {
    const frame = {
      v: [{ v: [{ result: { url: 'https://example.com/a', title: 'T', snippet: 'S', site_name: 'N' } }] }],
      o: 'BATCH',
    };
    const raw = [`data: ${JSON.stringify(frame)}`, `data: ${JSON.stringify(frame)}`, 'event: close', 'data: {}', ''].join(
      '\n\n',
    );
    const turn = parseDeepSeekSse(raw);
    expect(turn.citations).toHaveLength(1);
    expect(turn.citations[0]?.siteName).toBe('N');
    expect(turn.citations[0]?.url).toBe('https://example.com/a');
  });

  it('非 http(s) 的 result.url 不被当作引用', () => {
    const frame = { v: [{ result: { url: 'notaurl', title: 'T' } }] };
    const turn = parseDeepSeekSse(`data: ${JSON.stringify(frame)}`);
    expect(turn.citations).toHaveLength(0);
  });

  it('坏帧被跳过而不影响其余帧', () => {
    const raw = ['data: not-json', `data: ${JSON.stringify({ v: 'ok' })}`, 'event: close', 'data: {}', ''].join('\n\n');
    const turn = parseDeepSeekSse(raw);
    expect(turn.text).toBe('ok');
    expect(turn.skipped).toBe(1);
  });

  it('空输入不抛错', () => {
    const turn = parseDeepSeekSse('');
    expect(turn.text).toBe('');
    expect(turn.done).toBe(false);
    expect(turn.skipped).toBe(0);
  });
});

describe('阶段归属与快照优先（真实样本发现的 bug 的回归测试）', () => {
  it('同一快照同时含 THINK 与 RESPONSE 时，阶段必须切到正文', () => {
    // 真实样本 resume_stream #3：frags=[THINK(len=566) RESPONSE(len=1326)]
    // 原实现用 `some(THINK)` 优先判定 → 永远停在思考 → 归档出现"正文=0字/思考=359字"
    const raw = [
      `data: ${JSON.stringify({
        v: {
          response: {
            status: 'WIP',
            fragments: [
              { type: 'THINK', content: '想', stage_id: 1 },
              { type: 'RESPONSE', content: '答', stage_id: 1 },
            ],
          },
        },
      })}`,
      `data: ${JSON.stringify({ v: '正' })}`,
      `data: ${JSON.stringify({ v: '文' })}`,
      'event: close',
      'data: {}',
      '',
    ].join('\n\n');
    const turn = parseDeepSseSseSafe(raw);
    expect(turn.text).toContain('正文'); // 增量归到正文（修复前会归到思考）
    expect(turn.thinking).toBe('想'); // 快照里的思考片段
  });

  it('快照内容比增量拼接更完整时采用快照', () => {
    const long = '二'.repeat(50);
    const raw = [
      `data: ${JSON.stringify({ v: { response: { fragments: [{ type: 'RESPONSE', content: long }] } } })}`,
      `data: ${JSON.stringify({ v: '短' })}`,
      '',
    ].join('\n\n');
    const turn = parseDeepSseSseSafe(raw);
    expect(turn.text).toBe(long);
    expect(turn.text.length).toBe(50);
  });

  it('嵌套数组（BATCH 形态）里的片段也能被读到', () => {
    const raw = `data: ${JSON.stringify({ o: 'BATCH', v: [{ type: 'RESPONSE', content: '嵌套正文' }] })}`;
    expect(parseDeepSseSseSafe(raw).text).toBe('嵌套正文');
  });

  it('readFragments 递归收集，且不深入片段对象内部', () => {
    const found = readFragments({
      v: { response: { fragments: [{ type: 'THINK', content: 'a', nested: { type: 'X', content: 'b' } }] } },
    });
    expect(found).toEqual([{ type: 'THINK', content: 'a' }]);
  });
  it('流状态标记（{"v":"FINISHED"}）不并入正文，只计数', () => {
    const raw = [
      `data: ${JSON.stringify({ v: '正文' })}`,
      `data: ${JSON.stringify({ v: 'FINISHED' })}`,
      `data: ${JSON.stringify({ v: 'WIP' })}`,
      'event: close',
      'data: {}',
      '',
    ].join('\n\n');
    const turn = parseDeepSseSseSafe(raw);
    expect(turn.text).toBe('正文');
    expect(turn.counts.status).toBe(2);
    expect(turn.counts['text-delta']).toBe(1);
  });

  it('状态词只是正文的一部分时**不**被误过滤（只有整帧等于状态词才算）', () => {
    const raw = `data: ${JSON.stringify({ v: 'FINISHED 是我的口头禅' })}`;
    expect(parseDeepSseSseSafe(raw).text).toBe('FINISHED 是我的口头禅');
    expect(parseDeepSseSseSafe(raw).counts.status).toBe(0);
  });
});

/** 小包装，保持测试里调用点简洁 */
function parseDeepSseSseSafe(raw: string) {
  return parseDeepSeekSse(raw);
}

/**
 * 本会话累计 token（`accumulated_token_usage`）。
 *
 * 回归背景（2026-11-17 用户实测"token 恒为 0"）：站点流结束时发的**不是快照帧**，
 * 而是路径补丁帧 —— `{"p":"response","o":"BATCH","v":[{"p":"accumulated_token_usage","v":110}]}`，
 * 键 `p` 是被改的字段名、`v` 才是值。旧实现只认 `key === 'accumulated_token_usage'`，
 * 于是只读到流式过程中的 `0`，终值全被丢掉。
 */
describe('累计 token：快照帧与路径补丁帧都要认', () => {
  it('快照写法（键就是字段名）', () => {
    const raw = `data: ${JSON.stringify({ v: { response: { accumulated_token_usage: 42 } } })}`;
    expect(parseDeepSseSseSafe(raw).accumulatedTokens).toBe(42);
  });

  it('路径补丁写法（BATCH 帧，p/v 两段）—— 曾经漏读的真凶', () => {
    const raw = `data: ${JSON.stringify({
      p: 'response',
      o: 'BATCH',
      v: [{ p: 'accumulated_token_usage', v: 110 }, { p: 'quasi_status', v: 'FINISHED' }],
    })}`;
    expect(parseDeepSseSseSafe(raw).accumulatedTokens).toBe(110);
  });

  it('流式过程中的 0 不会盖掉后面出现的终值', () => {
    const raw = [
      `data: ${JSON.stringify({ v: { response: { status: 'WIP', accumulated_token_usage: 0 } } })}`,
      `data: ${JSON.stringify({ p: 'response', o: 'BATCH', v: [{ p: 'accumulated_token_usage', v: 640 }] })}`,
      'event: close',
      'data: {}',
      '',
    ].join('\n\n');
    expect(parseDeepSseSseSafe(raw).accumulatedTokens).toBe(640);
  });

  it('完全没这个字段时是 null，不是 0（0 表示"真的用了 0"，含义不同）', () => {
    const raw = `data: ${JSON.stringify({ v: '没有 token 字段的一帧' })}`;
    expect(parseDeepSseSseSafe(raw).accumulatedTokens).toBeNull();
  });

  it('camelCase 写法（history 归一化后的形状）也认', () => {
    expect(collectAccumulatedTokens({ accumulatedTokenUsage: 9 })).toBe(9);
    expect(collectAccumulatedTokens({ v: [{ p: 'accumulatedTokenUsage', v: 12 }] })).toBe(12);
  });
});
