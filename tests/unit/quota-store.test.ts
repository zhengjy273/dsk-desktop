/**
 * 单元测试：`src/store/quota-store.ts`
 *
 * 覆盖：
 *  - 按账号隔离落盘（`<baseDir>/<account>.json`）；
 *  - 磁盘回填（新实例能读到旧数据 —— 这是"其余账号显示缓存"的基础）；
 *  - 部分更新语义（chat/status 与 model_configs 互不覆盖）；
 *  - 损坏文件 / 非法账号 id / 路径穿越被安全处理；
 *  - `remove` 后不再返回旧数据。
 *
 * 纪律：不 import electron；数据写在 `node:os` 的 tmpdir() 下；结束清理。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  QuotaStore,
  isSafeAccountId,
  parseQuotaStateFile,
  parseSessionTokensFile,
  sessionEntriesNeedRepair,
} from '../../src/store/quota-store.ts';
import type { ChatStatus, ModelQuotaConfig } from '../../src/session/quota-parser.ts';

let baseDir: string;
let warnings: string[];

function makeStore(dir = baseDir): QuotaStore {
  return new QuotaStore({
    baseDir: dir,
    logger: { warn: (m) => warnings.push(m) },
  });
}

const STATUS: ChatStatus = {
  generatedAt: 1791598000000,
  isMuted: false,
  muteUntil: 0,
  muteMsg: null,
  quotas: [{ modelType: 'default', isExhausted: false, resetAt: 0, msg: null, alertTitle: null, alertDescription: null }],
};

const CONFIGS: ModelQuotaConfig[] = [
  {
    modelType: 'default',
    name: 'V4.1 Flash',
    enabled: true,
    regenerateQuota: 6,
    editQuota: 6,
    inputCharacterLimit: 40960,
    fileTokenLimit: null,
    fileTokenLimitWithThinking: null,
  },
];

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'dsk-quota-'));
  warnings = [];
});

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

describe('isSafeAccountId', () => {
  it('接受常规账号 id', () => {
    expect(isSafeAccountId('personal')).toBe(true);
    expect(isSafeAccountId('work-2')).toBe(true);
    expect(isSafeAccountId('a.b_c')).toBe(true);
  });

  it('拒绝路径穿越与非法字符', () => {
    expect(isSafeAccountId('../evil')).toBe(false);
    expect(isSafeAccountId('a/b')).toBe(false);
    expect(isSafeAccountId('a\\b')).toBe(false);
    expect(isSafeAccountId('')).toBe(false);
    expect(isSafeAccountId('.hidden')).toBe(false);
    expect(isSafeAccountId('-x')).toBe(false);
    expect(isSafeAccountId('a'.repeat(200))).toBe(false);
  });

  it('拒绝非字符串', () => {
    expect(isSafeAccountId(null)).toBe(false);
    expect(isSafeAccountId(42)).toBe(false);
    expect(isSafeAccountId({})).toBe(false);
  });
});

describe('QuotaStore：写入与读取', () => {
  it('applyChatStatus 落盘到 <baseDir>/<account>.json', () => {
    const store = makeStore();
    store.applyChatStatus('personal', STATUS);
    const file = join(baseDir, 'personal.json');
    expect(existsSync(file)).toBe(true);
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { accountId: string; chatStatus: unknown };
    expect(raw.accountId).toBe('personal');
    expect(raw.chatStatus).toMatchObject({ generatedAt: 1791598000000 });
  });

  it('账号之间互相隔离', () => {
    const store = makeStore();
    store.applyChatStatus('personal', STATUS);
    store.applyModelConfigs('work', CONFIGS);
    expect(store.get('personal')?.modelConfigs).toEqual([]);
    expect(store.get('work')?.chatStatus).toBeNull();
  });

  it('新实例从磁盘回填（"其余账号显示缓存"的基础）', () => {
    makeStore().applyChatStatus('work', STATUS);
    const fresh = makeStore();
    const state = fresh.get('work');
    expect(state?.chatStatus?.generatedAt).toBe(1791598000000);
  });

  it('没有缓存返回 null（调用方显示"未知"）', () => {
    expect(makeStore().get('nobody')).toBeNull();
  });
});

describe('QuotaStore：部分更新语义', () => {
  it('applyModelConfigs 不覆盖已有 chatStatus', () => {
    const store = makeStore();
    store.applyChatStatus('personal', STATUS);
    store.applyModelConfigs('personal', CONFIGS);
    const state = store.get('personal');
    expect(state?.chatStatus?.generatedAt).toBe(1791598000000);
    expect(state?.modelConfigs).toHaveLength(1);
  });

  it('applyChatStatus 不覆盖已有 modelConfigs', () => {
    const store = makeStore();
    store.applyModelConfigs('personal', CONFIGS);
    store.applyChatStatus('personal', STATUS);
    expect(store.get('personal')?.modelConfigs[0]?.name).toBe('V4.1 Flash');
  });

  it('每次更新都会刷新 updatedAt', () => {
    const store = makeStore();
    const first = store.applyChatStatus('personal', STATUS).updatedAt;
    expect(first).toBeGreaterThan(0);
  });
});

describe('QuotaStore：损坏与非法输入', () => {
  it('损坏 JSON 视为无缓存并告警（不抛错）', () => {
    const file = join(baseDir, 'broken.json');
    writeFileSync(file, '{ this is not json', 'utf8');
    const store = makeStore();
    expect(store.get('broken')).toBeNull();
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('缓存文件里 accountId 与文件名不符时丢弃', () => {
    const file = join(baseDir, 'liar.json');
    writeFileSync(file, JSON.stringify({ accountId: 'someone-else', updatedAt: 1 }), 'utf8');
    expect(makeStore().get('liar')).toBeNull();
  });

  it('缓存文件里 accountId 非法时丢弃', () => {
    const file = join(baseDir, 'bad.json');
    writeFileSync(file, JSON.stringify({ accountId: '../evil', updatedAt: 1 }), 'utf8');
    expect(makeStore().get('bad')).toBeNull();
  });

  it('filePath 拒绝非法账号 id（防路径穿越）', () => {
    const store = makeStore();
    expect(() => store.filePath('../evil')).toThrow(TypeError);
    expect(() => store.filePath('a/b')).toThrow(TypeError);
  });

  it('目录不存在时自动创建', () => {
    const nested = join(baseDir, 'deep', 'nested');
    const store = makeStore(nested);
    store.applyChatStatus('personal', STATUS);
    expect(existsSync(join(nested, 'personal.json'))).toBe(true);
  });

  it('目录不可写时只告警、不影响内存态', () => {
    // 用一个"是文件而不是目录"的路径，强制 mkdir 失败
    const fileAsDir = join(baseDir, 'not-a-dir');
    writeFileSync(fileAsDir, 'x', 'utf8');
    const store = makeStore(fileAsDir);
    const state = store.applyChatStatus('personal', STATUS);
    expect(state.chatStatus?.generatedAt).toBe(1791598000000);
    expect(warnings.length).toBeGreaterThan(0);
  });
});

describe('QuotaStore：remove', () => {
  it('删除后内存与磁盘都不再返回旧数据', () => {
    const store = makeStore();
    store.applyChatStatus('work', STATUS);
    store.remove('work');
    expect(store.get('work')).toBeNull();
  });

  it('删除是真的删文件，不是写空文件（否则下次读到的是"缓存损坏"）', () => {
    const store = makeStore();
    store.applyChatStatus('work', STATUS);
    store.setSessionTokens('work', 'conv-a', 123);
    const stateFile = join(baseDir, 'work.json');
    const sessionsFile = join(baseDir, 'work.sessions.json');
    expect(existsSync(stateFile)).toBe(true);
    expect(existsSync(sessionsFile)).toBe(true);

    store.remove('work');

    expect(existsSync(stateFile)).toBe(false);
    expect(existsSync(sessionsFile)).toBe(false);
    // 关键：新实例读回来是 null（而不是解析空文件失败后留下告警）
    const fresh = makeStore();
    expect(fresh.get('work')).toBeNull();
    expect(fresh.getSessionTokens('work', 'conv-a')).toBeNull();
  });

  it('删除不存在的账号不抛错', () => {
    const store = makeStore();
    expect(() => store.remove('ghost')).not.toThrow();
  });
});

describe('QuotaStore：clearAll（托盘「清除本地归档数据…」一并清额度）', () => {
  it('删掉所有账号的 json，并清空内存', () => {
    const store = makeStore();
    store.applyChatStatus('personal', STATUS);
    store.applyChatStatus('work', STATUS);
    store.setSessionTokens('personal', 'conv-a', 100);
    store.setSessionActions('work', 'conv-b', { regenerateUsed: 2, editUsed: 1 });

    const removed = store.clearAll();

    expect(removed).toBe(4); // 2 个账号各 1 份 state + 1 份 sessions
    expect(store.get('personal')).toBeNull();
    expect(store.get('work')).toBeNull();
    expect(store.getSessionTokens('personal', 'conv-a')).toBeNull();
    expect(store.getSessionActions('work', 'conv-b')).toBeNull();
    expect(existsSync(join(baseDir, 'personal.json'))).toBe(false);
    expect(existsSync(join(baseDir, 'work.sessions.json'))).toBe(false);
  });

  it('目录不存在时返回 0 不抛错', () => {
    const store = makeStore(join(baseDir, 'not-created-yet'));
    expect(store.clearAll()).toBe(0);
  });

  it('只删自己写的那两种文件名，别把 account.json 等外来文件一起删掉', () => {
    // baseDir 一旦被配错（比如指到 userData 根目录），"凡是 .json 都删"会误删账号配置。
    const store = makeStore();
    store.applyChatStatus('personal', STATUS);
    writeFileSync(join(baseDir, 'account.json'), '{"current":"personal"}', 'utf8');
    writeFileSync(join(baseDir, 'unrelated.json'), '{"x":1}', 'utf8');
    writeFileSync(join(baseDir, 'notes.txt'), 'hello', 'utf8');

    const removed = store.clearAll();

    expect(removed).toBe(1); // 只有 personal.json
    expect(existsSync(join(baseDir, 'personal.json'))).toBe(false);
    // 这三个都不该被动
    expect(existsSync(join(baseDir, 'account.json'))).toBe(true);
    expect(existsSync(join(baseDir, 'unrelated.json'))).toBe(true);
    expect(existsSync(join(baseDir, 'notes.txt'))).toBe(true);
  });
});

describe('parseQuotaStateFile', () => {
  it('宽容解析：缺失字段用安全默认值', () => {
    const parsed = parseQuotaStateFile({ accountId: 'personal' });
    expect(parsed).not.toBeNull();
    expect(parsed?.updatedAt).toBe(0);
    expect(parsed?.chatStatus).toBeNull();
    expect(parsed?.modelConfigs).toEqual([]);
  });

  it('非法输入返回 null', () => {
    expect(parseQuotaStateFile(null)).toBeNull();
    expect(parseQuotaStateFile('x')).toBeNull();
    expect(parseQuotaStateFile({})).toBeNull();
  });

  it('modelConfigs 里的坏项被跳过，好的保留', () => {
    const parsed = parseQuotaStateFile({
      accountId: 'personal',
      modelConfigs: [
        'garbage',
        { modelType: 'default', regenerateQuota: 6, editQuota: 6, inputCharacterLimit: 100 },
      ],
    });
    expect(parsed?.modelConfigs).toHaveLength(1);
    expect(parsed?.modelConfigs[0]?.regenerateQuota).toBe(6);
  });
});

/**
 * 会话 token 缓存 —— 存在的原因：
 * `history_messages` 命中服务端缓存时返回**空** `chat_messages`（实测常见），
 * 此时拿不到用量；但用户切回旧会话时仍应看到上次已知值。
 */
describe('会话 token 缓存', () => {
  it('写入后能读回，并按账号隔离', () => {
    const store = makeStore();
    store.setSessionTokens('personal', 'conv-a', 1590);
    expect(store.getSessionTokens('personal', 'conv-a')).toBe(1590);
    expect(store.getSessionTokens('work', 'conv-a')).toBeNull();
  });

  it('不同会话互不影响', () => {
    const store = makeStore();
    store.setSessionTokens('personal', 'conv-a', 100);
    store.setSessionTokens('personal', 'conv-b', 200);
    expect(store.getSessionTokens('personal', 'conv-a')).toBe(100);
    expect(store.getSessionTokens('personal', 'conv-b')).toBe(200);
  });

  it('落盘后新实例能读回（切会话时靠这个兜底）', () => {
    makeStore().setSessionTokens('personal', 'conv-a', 4321);
    expect(makeStore().getSessionTokens('personal', 'conv-a')).toBe(4321);
  });

  it('数值未变化时不重复落盘', () => {
    const store = makeStore();
    store.setSessionTokens('personal', 'conv-a', 100);
    const file = store.sessionFilePath('personal');
    const before = readFileSync(file, 'utf8');
    store.setSessionTokens('personal', 'conv-a', 100);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('非法会话 id / 负数 / NaN 一律忽略，不落盘', () => {
    const store = makeStore();
    store.setSessionTokens('personal', '../evil', 100);
    store.setSessionTokens('personal', 'conv-a', -1);
    store.setSessionTokens('personal', 'conv-a', Number.NaN);
    expect(store.getSessionTokens('personal', 'conv-a')).toBeNull();
  });

  it('坏文件当作无缓存，不抛错', () => {
    const store = makeStore();
    mkdirSync(baseDir, { recursive: true });
    writeFileSync(store.sessionFilePath('personal'), '{ not json', 'utf8');
    expect(store.getSessionTokens('personal', 'conv-a')).toBeNull();
  });

  it('带 UTF-8 BOM 的文件也能读（PowerShell/记事本改过的缓存）', () => {
    const store = makeStore();
    mkdirSync(baseDir, { recursive: true });
    const body = JSON.stringify({ accountId: 'personal', entries: { 'conv-a': { tokens: 99, updatedAt: 1 } } });
    writeFileSync(store.sessionFilePath('personal'), `\ufeff${body}`, 'utf8');
    expect(store.getSessionTokens('personal', 'conv-a')).toBe(99);
  });

  it('磁盘上的坏 updatedAt 会被回写修正（v1.1.5 BUG-2：读路径让文件自愈）', async () => {
    const store = makeStore();
    mkdirSync(baseDir, { recursive: true });
    const bad = 134393759974646800; // Windows FILETIME 100ns 计数，实测坏值
    writeFileSync(
      store.sessionFilePath('personal'),
      JSON.stringify({ accountId: 'personal', entries: { 'conv-a': { tokens: 42, updatedAt: bad } } }),
      'utf8',
    );
    // 读的时候已清洗成毫秒；关键是磁盘上不能继续留着坏值
    expect(store.getSessionTokens('personal', 'conv-a')).toBe(42);
    // N20：自愈写盘排在当前调用栈之后（读路径不做同步 I/O），等一个 setImmediate 再核对磁盘。
    await new Promise<void>((resolve) => setImmediate(resolve));
    const after = JSON.parse(readFileSync(store.sessionFilePath('personal'), 'utf8')) as {
      entries: Record<string, { tokens?: number; updatedAt?: number }>;
    };
    expect(after.entries['conv-a']?.tokens).toBe(42);
    expect(after.entries['conv-a']?.updatedAt).toBeLessThanOrEqual(4e12);
  });

  it('sessionEntriesNeedRepair：正常值不触发回写，脏值触发', () => {
    expect(
      sessionEntriesNeedRepair(
        { accountId: 'personal', entries: { 'conv-a': { updatedAt: 1 } } },
        { 'conv-a': { tokens: 1, updatedAt: 1 } },
      ),
    ).toBe(false);
    expect(
      sessionEntriesNeedRepair(
        { accountId: 'personal', entries: { 'conv-a': { updatedAt: 134393759974646800 } } },
        { 'conv-a': { updatedAt: 1763400000000 } },
      ),
    ).toBe(true);
    // N19：磁盘上有、解析后被丢弃的无效条目也算需要修复（否则永久滞留）
    expect(
      sessionEntriesNeedRepair(
        { accountId: 'personal', entries: { 'conv-dropped': { updatedAt: 3 } } },
        {},
      ),
    ).toBe(true);
    // N33：`__proto__` 这类原型链键必须被当作"不在 entries 里"（`in` 会恒为 true）
    expect(
      sessionEntriesNeedRepair(
        { accountId: 'personal', entries: JSON.parse('{"__proto__":{"updatedAt":3}}') },
        {},
      ),
    ).toBe(true);
    expect(sessionEntriesNeedRepair(null, {})).toBe(false);
  });

  it('文件里 accountId 与文件名不符时丢弃', () => {
    const store = makeStore();
    mkdirSync(baseDir, { recursive: true });
    writeFileSync(
      store.sessionFilePath('personal'),
      JSON.stringify({ accountId: 'someone-else', entries: { 'conv-a': { tokens: 1, updatedAt: 1 } } }),
      'utf8',
    );
    expect(store.getSessionTokens('personal', 'conv-a')).toBeNull();
  });

  it('超过上限时淘汰最旧的记录', () => {
    const store = makeStore();
    for (let i = 0; i < 205; i += 1) {
      store.setSessionTokens('personal', `conv-${i}`, i + 1);
    }
    const raw = JSON.parse(readFileSync(store.sessionFilePath('personal'), 'utf8')) as {
      entries: Record<string, unknown>;
    };
    expect(Object.keys(raw.entries).length).toBeLessThanOrEqual(200);
    // 最新的那条一定还在
    expect(store.getSessionTokens('personal', 'conv-204')).toBe(205);
  });

  it('remove 会连会话缓存一起清掉', () => {
    const store = makeStore();
    store.setSessionTokens('personal', 'conv-a', 100);
    store.remove('personal');
    expect(store.getSessionTokens('personal', 'conv-a')).toBeNull();
  });
});

describe('会话已用次数缓存（重启后不能归零）', () => {
  it('写入后能读回，且与 token 共用同一份会话缓存', () => {
    const store = makeStore();
    store.setSessionTokens('personal', 'conv-a', 1590);
    store.setSessionActions('personal', 'conv-a', { regenerateUsed: 2, editUsed: 1 });
    expect(store.getSessionActions('personal', 'conv-a')).toEqual({ regenerateUsed: 2, editUsed: 1 });
    expect(store.getSessionTokens('personal', 'conv-a')).toBe(1590);
  });

  it('先写次数再写 token，次数不被覆盖', () => {
    const store = makeStore();
    store.setSessionActions('personal', 'conv-a', { regenerateUsed: 3, editUsed: 0 });
    store.setSessionTokens('personal', 'conv-a', 777);
    expect(store.getSessionActions('personal', 'conv-a')).toEqual({ regenerateUsed: 3, editUsed: 0 });
    expect(store.getSessionTokens('personal', 'conv-a')).toBe(777);
  });

  it('先写 token 再写次数，token 不被覆盖成 0', () => {
    const store = makeStore();
    store.setSessionTokens('personal', 'conv-a', 777);
    store.setSessionActions('personal', 'conv-a', { regenerateUsed: 1, editUsed: 4 });
    expect(store.getSessionTokens('personal', 'conv-a')).toBe(777);
    expect(store.getSessionActions('personal', 'conv-a')).toEqual({ regenerateUsed: 1, editUsed: 4 });
  });

  it('新实例能读回（重开应用不归零）', () => {
    makeStore().setSessionActions('personal', 'conv-a', { regenerateUsed: 2, editUsed: 3 });
    expect(makeStore().getSessionActions('personal', 'conv-a')).toEqual({
      regenerateUsed: 2,
      editUsed: 3,
    });
  });

  it('没观测过的会话返回 null（不用 0 假装知道）', () => {
    expect(makeStore().getSessionActions('personal', 'conv-none')).toBeNull();
  });

  it('负数归 0、非法 id 忽略', () => {
    const store = makeStore();
    store.setSessionActions('personal', 'conv-a', { regenerateUsed: -5, editUsed: -1 });
    expect(store.getSessionActions('personal', 'conv-a')).toEqual({ regenerateUsed: 0, editUsed: 0 });
    store.setSessionActions('personal', '../evil', { regenerateUsed: 1, editUsed: 1 });
    expect(store.getSessionActions('personal', '../evil')).toBeNull();
  });

  it('坏数据被宽容跳过，不污染其它字段', () => {
    const parsed = parseSessionTokensFile({
      accountId: 'personal',
      entries: {
        'conv-a': { tokens: 10, updatedAt: 1, regenerateUsed: 'x', editUsed: 2 },
        'conv-b': { updatedAt: 2, regenerateUsed: 1 },
        'conv-c': { updatedAt: 3 },
      },
    });
    expect(parsed?.entries['conv-a']).toEqual({ tokens: 10, updatedAt: 1, editUsed: 2 });
    // 只有次数没有 token 也是合法记录
    expect(parsed?.entries['conv-b']).toEqual({ updatedAt: 2, regenerateUsed: 1 });
    // 什么都没有的条目直接丢弃
    expect(parsed?.entries['conv-c']).toBeUndefined();
  });
});

describe('parseSessionTokensFile', () => {
  it('宽容解析：坏条目被跳过', () => {
    const parsed = parseSessionTokensFile({
      accountId: 'personal',
      entries: {
        'conv-a': { tokens: 10, updatedAt: 1 },
        'conv-b': { tokens: 'x' },
        '../evil': { tokens: 5, updatedAt: 1 },
        'conv-c': 'garbage',
      },
    });
    expect(parsed?.entries).toEqual({ 'conv-a': { tokens: 10, updatedAt: 1 } });
  });

  it('非法输入返回 null', () => {
    expect(parseSessionTokensFile(null)).toBeNull();
    expect(parseSessionTokensFile({ accountId: 'personal' })).toBeNull();
    expect(parseSessionTokensFile({ entries: {} })).toBeNull();
  });

  it('天文数字的 updatedAt 被纠偏（实测出现过 FILETIME 量级 134393759974646800）', () => {
    const before = Date.now();
    const parsed = parseSessionTokensFile({
      accountId: 'personal',
      entries: {
        // 实测那条坏数据：Windows FILETIME 的 100ns 计数，比毫秒大 4 个数量级
        'conv-bad': { tokens: 652, updatedAt: 134393759974646800 },
        'conv-zero': { tokens: 5, updatedAt: 0 },
      },
    });
    const bad = parsed?.entries['conv-bad']?.updatedAt ?? 0;
    const zero = parsed?.entries['conv-zero']?.updatedAt ?? 0;
    // 不能保留天文数字：它在"按 updatedAt 升序淘汰最旧"里永远排最后，缓存上限会失效
    expect(bad).toBeLessThan(4e12);
    expect(bad).toBeGreaterThanOrEqual(before);
    expect(zero).toBeGreaterThanOrEqual(before);
    // token 值本身不受影响
    expect(parsed?.entries['conv-bad']?.tokens).toBe(652);
  });

  it('正常毫秒时间戳原样保留（不擅自做单位换算）', () => {
    const parsed = parseSessionTokensFile({
      accountId: 'personal',
      entries: { 'conv-a': { tokens: 1, updatedAt: 1791598000000 } },
    });
    expect(parsed?.entries['conv-a']?.updatedAt).toBe(1791598000000);
  });
});
