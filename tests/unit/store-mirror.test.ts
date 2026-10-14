/**
 * M1 · T3 单元测试：`src/store/mirror-store.ts`
 *
 * 覆盖验收标准（docs/M1-TASKS.md T3）：
 *  - 幂等写入（同一 messageId 重复 append 不产生重复记录）
 *  - 索引原子性（原子替换期间任意时刻读到的一定是完整 JSON）
 *  - 读回一致
 *  - 损坏 JSONL 行 / 非法对象安全跳过（告警但继续）
 *  - 路径穿越与非法输入被拒绝
 *
 * 纪律：不 import electron；全部数据写在 `node:os` 的 tmpdir() 下；测试结束清理。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ConversationMirror, MirrorMessage } from '../../src/shared/ipc-contract.ts';
import { messageId } from '../../src/shared/mirror-schema.ts';
import {
  INDEX_FILENAME,
  MirrorStore,
  isSafePathSegment,
  normalizeIndexEntry,
  sanitizeTitle,
  setBeforeAtomicRenameHookForTests,
  type MirrorLogEvent,
} from '../../src/store/mirror-store.ts';

const ACCOUNT = 'personal';
const CONV = 'conv-1';
const URL = 'https://chat.deepseek.com/a/chat/s/conv-1';
const T0 = 1791598000000;

let baseDir: string;
let warnings: MirrorLogEvent[];

function makeStore(dir = baseDir): MirrorStore {
  return new MirrorStore({
    baseDir: dir,
    logger: {
      warn(event) {
        warnings.push(event);
      },
    },
  });
}

function msg(seq: number, text: string, createdAt = T0 + seq, extra: Partial<MirrorMessage> = {}): MirrorMessage {
  return {
    id: messageId(CONV, seq, text),
    role: seq % 2 === 0 ? 'assistant' : 'user',
    text,
    createdAt,
    aiGenerated: true,
    ...extra,
  };
}

function append(store: MirrorStore, messages: MirrorMessage[], overrides: Record<string, unknown> = {}): void {
  store.appendTurn({
    accountId: ACCOUNT,
    conversationId: CONV,
    title: '测试会话',
    url: URL,
    messages,
    source: 'network',
    fidelity: 'full',
    ...overrides,
  });
}

function jsonlPath(accountId = ACCOUNT, conversationId = CONV): string {
  return join(baseDir, accountId, `${conversationId}.jsonl`);
}

function readJsonlLines(accountId = ACCOUNT, conversationId = CONV): string[] {
  return readFileSync(jsonlPath(accountId, conversationId), 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0);
}

function parseIndex(): { schemaVersion: unknown; conversations: unknown[] } {
  const parsed: unknown = JSON.parse(readFileSync(join(baseDir, INDEX_FILENAME), 'utf8'));
  expect(parsed).toBeTypeOf('object');
  return parsed as { schemaVersion: unknown; conversations: unknown[] };
}

function listTmpFiles(): string[] {
  return readdirSync(baseDir).filter((name) => name.startsWith('.tmp-'));
}

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'dsk-mirror-'));
  warnings = [];
});

afterEach(() => {
  setBeforeAtomicRenameHookForTests(null);
  if (existsSync(baseDir)) rmSync(baseDir, { recursive: true, force: true });
});

describe('MirrorStore 基本写入与读回', () => {
  it('写入一个会话并原样读回（读回一致）', () => {
    const store = makeStore();
    const messages = [msg(1, '你好'), msg(2, '你好，有什么可以帮你？')];
    const result = store.appendTurn({
      accountId: ACCOUNT,
      conversationId: CONV,
      title: '测试会话',
      url: URL,
      messages,
      source: 'network',
      fidelity: 'full',
      observedAt: T0 + 100,
    });

    expect(result.appended).toBe(2);
    expect(result.skipped).toBe(0);
    expect(existsSync(jsonlPath())).toBe(true);

    const read = store.readConversation(CONV);
    expect(read).not.toBeNull();
    expect(read?.messages.map((m) => m.text)).toEqual(['你好', '你好，有什么可以帮你？']);
    expect(read?.messages.every((m) => m.aiGenerated === true)).toBe(true);
    expect(read?.accountId).toBe(ACCOUNT);
    expect(read?.title).toBe('测试会话');
    expect(read?.source).toBe('network');
    expect(read?.fidelity).toBe('full');

    // 索引与日志条数一致
    const index = parseIndex();
    expect(index.schemaVersion).toBe(1);
    expect(index.conversations).toHaveLength(1);
    expect(store.listConversations()[0]?.messageCount).toBe(2);

    // 磁盘上确实是 JSONL（一行一条）
    expect(readJsonlLines()).toHaveLength(2);
    expect(warnings).toEqual([]);
  });

  it('空会话也能落盘并被索引（新建会话尚未发消息）', () => {
    const store = makeStore();
    const result = store.appendTurn({
      accountId: ACCOUNT,
      conversationId: CONV,
      url: URL,
      messages: [],
      source: 'dom',
      fidelity: 'partial',
      observedAt: T0,
    });

    expect(result.appended).toBe(0);
    const read = store.readConversation(CONV);
    expect(read?.messages).toEqual([]);
    expect(read?.title).toBe(`会话 ${CONV}`); // 无标题时给安全默认值
    expect(store.listConversations()[0]?.messageCount).toBe(0);
  });

  it('listConversations 按 updatedAt 倒序，readConversation 对未知 id 返回 null', () => {
    const store = makeStore();
    append(store, [msg(1, 'a', T0)]);
    store.appendTurn({
      accountId: ACCOUNT,
      conversationId: 'conv-2',
      title: '第二个',
      url: 'https://chat.deepseek.com/a/chat/s/conv-2',
      messages: [msg(1, 'b', T0 + 10_000)],
      source: 'dom',
      fidelity: 'partial',
    });

    expect(store.listConversations().map((c) => c.id)).toEqual(['conv-2', CONV]);
    expect(store.readConversation('nope')).toBeNull();
    expect(store.listConversationFiles(ACCOUNT)).toEqual(['conv-1', 'conv-2']);
  });
});

describe('幂等写入（同一 messageId 不产生重复记录）', () => {
  it('同一批消息重复 append → appended=0、磁盘不增行', () => {
    const store = makeStore();
    const messages = [msg(1, '第一句'), msg(2, '第二句'), msg(3, '第三句')];

    const first = store.appendTurn({
      accountId: ACCOUNT,
      conversationId: CONV,
      title: '测试会话',
      url: URL,
      messages,
      source: 'dom',
      fidelity: 'partial',
    });
    expect(first.appended).toBe(3);

    const second = store.appendTurn({
      accountId: ACCOUNT,
      conversationId: CONV,
      title: '测试会话',
      url: URL,
      messages,
      source: 'dom',
      fidelity: 'partial',
    });
    expect(second.appended).toBe(0);
    expect(second.skipped).toBe(3);
    expect(readJsonlLines()).toHaveLength(3);
    expect(store.readConversation(CONV)?.messages).toHaveLength(3);
    expect(store.listConversations()[0]?.messageCount).toBe(3);
  });

  it('同一批内的重复 id 只写一次；新消息继续追加', () => {
    const store = makeStore();
    const first = msg(1, '重复的消息');
    append(store, [first, first]);
    expect(readJsonlLines()).toHaveLength(1);

    append(store, [first, msg(2, '新消息')]);
    expect(readJsonlLines()).toHaveLength(2);
    expect(store.readConversation(CONV)?.messages.map((m) => m.text)).toEqual(['重复的消息', '新消息']);
  });

  it('重开 store（模拟重启）后仍然幂等 —— 幂等状态来自磁盘而非内存', () => {
    const store = makeStore();
    const messages = [msg(1, '甲'), msg(2, '乙')];
    append(store, messages);
    expect(readJsonlLines()).toHaveLength(2);

    const reopened = makeStore();
    const again = reopened.appendTurn({
      accountId: ACCOUNT,
      conversationId: CONV,
      title: '测试会话',
      url: URL,
      messages,
      source: 'network',
      fidelity: 'full',
    });
    expect(again.appended).toBe(0);
    expect(readJsonlLines()).toHaveLength(2);
    expect(reopened.readConversation(CONV)?.messages).toHaveLength(2);
  });

  it('相同文本的不同轮次（不同序号 → 不同 id）不会被误判为重复', () => {
    const store = makeStore();
    append(store, [msg(1, '再说一次')]);
    append(store, [msg(2, '再说一次')]);
    expect(readJsonlLines()).toHaveLength(2);
    const ids = store.readConversation(CONV)?.messages.map((m) => m.id) ?? [];
    expect(new Set(ids).size).toBe(2);
  });
});

describe('索引原子性', () => {
  it('原子替换：任意时刻读到的索引都是完整可解析的 JSON，且不留临时文件', () => {
    const store = makeStore();

    let indexReads = 0;
    let tmpFileSeen = 0;

    setBeforeAtomicRenameHookForTests(() => {
      // 该回调在"临时文件已写完、rename 尚未发生"之间触发：
      // 此刻读 index.json，读到的必须是**上一次完整写入**的内容（而不是半个文件）。
      // 第 1 次时 index.json 还从未存在过 —— 这本身就是原子性的表现（绝不会先出现半个文件）。
      expect(listTmpFiles().length).toBeGreaterThan(0);
      tmpFileSeen += 1;
      indexReads += 1;
      if (existsSync(join(baseDir, INDEX_FILENAME))) {
        const raw = readFileSync(join(baseDir, INDEX_FILENAME), 'utf8');
        const parsed = JSON.parse(raw) as { schemaVersion?: unknown; conversations?: unknown };
        // 只要文件存在，内容必须完整：合法 JSON + 版本号 + 会话数组
        // （不存在"写了一半"的中间态 —— 这正是原子替换要保证的）
        expect(parsed.schemaVersion).toBe(1);
        expect(Array.isArray(parsed.conversations)).toBe(true);
        expect((parsed.conversations as unknown[]).length).toBeGreaterThan(0);
      } else {
        // 第 1 次替换前，索引还从未存在过（而不是存在一个空壳）
        expect(indexReads).toBe(1);
      }
    });

    // 40 次 appendTurn ⇒ 40 次"写入临时文件 → 原子替换"
    for (let i = 1; i <= 40; i += 1) {
      const result = store.appendTurn({
        accountId: ACCOUNT,
        conversationId: CONV,
        title: '测试会话',
        url: URL,
        messages: [msg(i, `第 ${i} 条消息`)],
        source: 'network',
        fidelity: 'full',
      });
      expect(result.appended).toBe(1);
    }
    setBeforeAtomicRenameHookForTests(null);

    expect(tmpFileSeen).toBe(40);
    expect(indexReads).toBe(tmpFileSeen);
    expect(listTmpFiles()).toEqual([]);

    // 索引最终内容完整无误，且所有消息都真的落盘了（不是被幂等逻辑吃掉）
    const finalIndex = parseIndex();
    expect(finalIndex.conversations).toHaveLength(1);
    expect(store.listConversations()[0]?.messageCount).toBe(40);
    expect(readJsonlLines()).toHaveLength(40);
  });

  it('索引损坏 / 非法条目时安全降级（跳过坏项，不抛异常）', () => {
    const store = makeStore();
    append(store, [msg(1, 'x')]);

    // 手工把索引改坏：一个合法项 + 两个非法项
    const [firstEntry] = parseIndex().conversations as Record<string, unknown>[];
    const broken = {
      schemaVersion: 1,
      updatedAt: Date.now(),
      conversations: [
        { ...firstEntry, messageCount: 1 },
        { id: 'bad id with space', accountId: ACCOUNT, title: 't', url: URL, updatedAt: 1, messageCount: 1, source: 'dom', fidelity: 'partial' },
        { id: 'conv-9', accountId: ACCOUNT, title: 't', url: 'http://insecure/', updatedAt: 1, messageCount: 1, source: 'dom', fidelity: 'partial' },
      ],
    };
    writeFileSync(join(baseDir, INDEX_FILENAME), JSON.stringify(broken), 'utf8');

    const reopened = makeStore();
    expect(reopened.listConversations().map((c) => c.id)).toEqual([CONV]);
    expect(warnings.filter((w) => w.code === 'index-invalid')).toHaveLength(2);
  });

  it('索引整体不是 JSON 时按空索引处理，且能重新写入', () => {
    const store = makeStore();
    append(store, [msg(1, 'x')]);
    writeFileSync(join(baseDir, INDEX_FILENAME), '{ 这不是 JSON', 'utf8');

    const reopened = makeStore();
    expect(reopened.listConversations()).toEqual([]);
    expect(warnings.some((w) => w.code === 'index-invalid')).toBe(true);

    reopened.appendTurn({
      accountId: ACCOUNT,
      conversationId: 'conv-3',
      title: '重建',
      url: 'https://chat.deepseek.com/a/chat/s/conv-3',
      messages: [msg(1, 'y')],
      source: 'dom',
      fidelity: 'partial',
    });
    expect(JSON.parse(readFileSync(join(baseDir, INDEX_FILENAME), 'utf8'))).toBeTypeOf('object');
    expect(reopened.listConversations().map((c) => c.id)).toEqual(['conv-3']);
  });
});

describe('容错：损坏行与非法对象安全跳过', () => {
  it('损坏的 JSONL 行被跳过并告警，其余行照常读回', () => {
    const store = makeStore();
    append(store, [msg(1, '甲'), msg(2, '乙'), msg(3, '丙')]);

    const lines = readJsonlLines();
    const good = lines.map((line) => JSON.parse(line) as MirrorMessage);
    const target = jsonlPath();

    const payload = [
      JSON.stringify(good[0]),
      '{ 半条 JSON', // 1) 语法损坏
      '', // 2) 空行（正常，不计告警）
      '42', // 3) 合法 JSON 但不是消息对象
      JSON.stringify({ ...good[0], aiGenerated: false }), // 4) 缺 AI 标识 → R3 拒绝
      JSON.stringify(good[2]),
    ].join('\n');
    writeFileSync(target, `${payload}\n`, 'utf8');

    const read = store.readConversation(CONV);
    expect(read?.messages.map((m) => m.text)).toEqual(['甲', '丙']);
    expect(warnings.filter((w) => w.code === 'skipped-corrupt-line')).toHaveLength(1);
    expect(warnings.filter((w) => w.code === 'skipped-invalid-record')).toHaveLength(2);
    // 行号可定位（第 2 行是坏 JSON）
    expect(warnings.find((w) => w.code === 'skipped-corrupt-line')?.line).toBe(2);
  });

  it('整文件都是垃圾内容时返回空消息列表而不抛出', () => {
    const store = makeStore();
    mkdirSync(join(baseDir, ACCOUNT), { recursive: true });
    writeFileSync(jsonlPath(), 'garbage\n{"a":1}\n', 'utf8');
    const read = store.readConversation(CONV, { accountId: ACCOUNT });
    expect(read?.messages).toEqual([]);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('appendTurn 里单条非法消息被跳过，合法消息仍写入', () => {
    const store = makeStore();
    const bad = [
      { id: 'x', role: 'system', text: 's', createdAt: T0, aiGenerated: true },
      { id: '', role: 'user', text: 'empty id', createdAt: T0, aiGenerated: true },
      null,
      { id: 'y', role: 'assistant', text: 'no notice', createdAt: T0 },
      { id: 'z', role: 'assistant', text: 'ok', createdAt: T0, aiGenerated: true, reasoning: 42 },
    ] as unknown as MirrorMessage[];

    const result = store.appendTurn({
      accountId: ACCOUNT,
      conversationId: CONV,
      title: '混合输入',
      url: URL,
      messages: [...bad, msg(1, '合法消息')],
      source: 'dom',
      fidelity: 'partial',
    });

    expect(result.appended).toBe(1);
    expect(readJsonlLines()).toHaveLength(1);
    expect(store.readConversation(CONV)?.messages.map((m) => m.text)).toEqual(['合法消息']);
    expect(warnings.filter((w) => w.code === 'skipped-invalid-record')).toHaveLength(5);
  });
});

describe('输入拒绝（路径穿越 / 非法参数）', () => {
  const base = {
    accountId: ACCOUNT,
    conversationId: CONV,
    title: 't',
    url: URL,
    messages: [] as MirrorMessage[],
    source: 'dom' as const,
    fidelity: 'partial' as const,
  };

  it('isSafePathSegment 拒绝穿越与保留输入', () => {
    for (const bad of ['..', '../evil', 'a/b', 'a\\b', 'C:', '', ' ', 'a'.repeat(129), '.hidden', null, 7, {}]) {
      expect(isSafePathSegment(bad)).toBe(false);
    }
    for (const ok of ['personal', 'work-2', 'conv_1.x', 'A1']) {
      expect(isSafePathSegment(ok)).toBe(true);
    }
  });

  it('accountId / conversationId 非法 → 抛错且不落盘', () => {
    const store = makeStore();
    expect(() => store.appendTurn({ ...base, accountId: '../etc' })).toThrow(TypeError);
    expect(() => store.appendTurn({ ...base, conversationId: 'a/b' })).toThrow(TypeError);
    expect(() => store.appendTurn({ ...base, conversationId: '..' })).toThrow(TypeError);
    expect(existsSync(join(baseDir, INDEX_FILENAME))).toBe(false);
    expect(warnings.filter((w) => w.code === 'rejected-input').length).toBeGreaterThanOrEqual(3);
  });

  it('非 https 的 url / 非法 source / 非法 fidelity → 抛错', () => {
    const store = makeStore();
    expect(() => store.appendTurn({ ...base, url: 'http://chat.deepseek.com/' })).toThrow(TypeError);
    expect(() => store.appendTurn({ ...base, url: '' })).toThrow(TypeError);
    expect(() => store.appendTurn({ ...base, source: 'guess' as 'dom' })).toThrow(TypeError);
    expect(() => store.appendTurn({ ...base, fidelity: 'maybe' as 'full' })).toThrow(TypeError);
  });

  it('同一 conversationId 隶属两个账号 → 拒绝跨账号写入', () => {
    const store = makeStore();
    append(store, [msg(1, 'x')]);
    expect(() =>
      store.appendTurn({
        accountId: 'work',
        conversationId: CONV,
        title: 't',
        url: URL,
        messages: [],
        source: 'dom',
        fidelity: 'partial',
      }),
    ).toThrow(TypeError);
  });

  it('normalizeIndexEntry / sanitizeTitle 是纯函数且可安全拒绝', () => {
    expect(normalizeIndexEntry(null)).toBeNull();
    expect(normalizeIndexEntry({ id: 'x' })).toBeNull();
    expect(
      normalizeIndexEntry({
        id: 'x',
        accountId: 'a',
        title: 't',
        url: 'https://x.test/',
        updatedAt: 1,
        messageCount: 0,
        source: 'dom',
        fidelity: 'partial',
      })?.createdAt,
    ).toBe(1);
    expect(sanitizeTitle('  a   b\nc  ')).toBe('a b c');
    expect(sanitizeTitle('   ')).toBeNull();
    expect(sanitizeTitle(42)).toBeNull();
    expect(sanitizeTitle('x'.repeat(300))?.length).toBe(200);
  });
});

describe('一键清除本地数据', () => {
  it('clearAll 删除登记过的账号目录与索引，且不越界', () => {
    const store = makeStore();
    append(store, [msg(1, 'x')]);
    store.appendTurn({
      accountId: 'work',
      conversationId: 'conv-9',
      title: 'w',
      url: 'https://chat.deepseek.com/a/chat/s/conv-9',
      messages: [msg(1, 'y')],
      source: 'dom',
      fidelity: 'partial',
    });
    // 放一个不属于镜像的文件，确认清除动作不会误删 baseDir 下的其它内容
    writeFileSync(join(baseDir, 'keep-me.txt'), 'keep', 'utf8');

    const removed = store.clearAll();
    expect(removed).toBe(2);
    expect(existsSync(join(baseDir, ACCOUNT))).toBe(false);
    expect(existsSync(join(baseDir, 'work'))).toBe(false);
    expect(existsSync(join(baseDir, INDEX_FILENAME))).toBe(false);
    expect(existsSync(join(baseDir, 'keep-me.txt'))).toBe(true);
    expect(store.listConversations()).toEqual([]);
    expect(store.readConversation(CONV)).toBeNull();
  });

  it('clearAll 连索引里没有登记的孤儿目录、以及遗留的临时文件一起清掉', () => {
    const store = makeStore();
    append(store, [msg(1, 'x')]);
    // 模拟"索引被删/损坏后仍在磁盘上的归档"
    mkdirSync(join(baseDir, 'orphan-account'), { recursive: true });
    writeFileSync(join(baseDir, 'orphan-account', 'c9.jsonl'), `${JSON.stringify(msg(1, 'z'))}\n`, 'utf8');
    // 模拟崩溃残留的临时文件
    writeFileSync(join(baseDir, '.tmp-999-1.json'), '{}', 'utf8');

    const removed = store.clearAll();
    expect(removed).toBe(2);
    expect(existsSync(join(baseDir, 'orphan-account'))).toBe(false);
    expect(listTmpFiles()).toEqual([]);
    expect(existsSync(join(baseDir, ACCOUNT))).toBe(false);
  });
});

describe('类型层面的一致性（读回的对象必须过契约校验）', () => {
  it('读回结果满足 ConversationMirror 形状', () => {
    const store = makeStore();
    append(store, [
      msg(1, '问题', T0, { role: 'user' }),
      msg(2, '回答', T0 + 1, {
        role: 'assistant',
        reasoning: '先想一下',
        citations: [{ title: '来源', url: 'https://example.test/doc' }],
        attachments: [{ name: 'a.pdf', size: 1024 }],
      }),
    ]);
    const read = store.readConversation(CONV) as ConversationMirror;
    expect(read.messages[1]?.reasoning).toBe('先想一下');
    expect(read.messages[1]?.citations?.[0]?.url).toBe('https://example.test/doc');
    expect(read.messages[1]?.attachments?.[0]?.name).toBe('a.pdf');
    expect(Object.keys(read).sort()).toEqual(
      ['accountId', 'fidelity', 'id', 'messages', 'source', 'title', 'updatedAt', 'url'].sort(),
    );
  });
});
