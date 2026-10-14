import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_ACCOUNT,
  SUGGESTED_ACCOUNTS,
  accountFilePath,
  isSafeAccountId,
  listKnownAccounts,
  parseAccountState,
  readAccountState,
  removeKnownAccount,
  writeCurrentAccount,
} from '../../src/main/accounts';

describe('isSafeAccountId（防路径穿越）', () => {
  it('接受常规账号名', () => {
    expect(isSafeAccountId('personal')).toBe(true);
    expect(isSafeAccountId('work-2')).toBe(true);
    expect(isSafeAccountId('a.b_c')).toBe(true);
  });

  it('拒绝危险或非法形状', () => {
    expect(isSafeAccountId('')).toBe(false);
    expect(isSafeAccountId('-leading')).toBe(false);
    expect(isSafeAccountId('.hidden')).toBe(false);
    expect(isSafeAccountId('../evil')).toBe(false);
    expect(isSafeAccountId('a/b')).toBe(false);
    expect(isSafeAccountId('a\\b')).toBe(false);
    expect(isSafeAccountId('a'.repeat(129))).toBe(false);
    expect(isSafeAccountId(42)).toBe(false);
    expect(isSafeAccountId(null)).toBe(false);
  });
});

describe('parseAccountState（宽容解析）', () => {
  it('正常解析', () => {
    expect(parseAccountState({ current: 'work', known: ['personal', 'work'] })).toEqual({
      current: 'work',
      known: ['personal', 'work'],
      removed: [],
    });
  });

  it('坏数据一律忽略（非法 current / known 项 / 非对象）', () => {
    expect(parseAccountState(null)).toEqual({ current: null, known: [], removed: [] });
    expect(parseAccountState('x')).toEqual({ current: null, known: [], removed: [] });
    expect(parseAccountState({ current: '../evil', known: ['ok', '../bad', 42] })).toEqual({
      current: null,
      known: ['ok'],
      removed: [],
    });
    // removed 同样要宽容解析（去重 + 滤掉非法值）
    expect(parseAccountState({ removed: ['work', 'work', '../bad', 1] }).removed).toEqual(['work']);
  });

  it('known 去重并排序', () => {
    expect(parseAccountState({ known: ['b', 'a', 'b'] }).known).toEqual(['a', 'b']);
  });
});

describe('readAccountState / writeCurrentAccount（原子写 + 回读）', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('文件不存在 → 空状态（调用方回退默认账号）', () => {
    dir = mkdtempSync(join(tmpdir(), 'dsk-acc-'));
    expect(readAccountState(accountFilePath(dir))).toEqual({ current: null, known: [], removed: [] });
  });

  it('损坏文件 → 空状态，不抛错', () => {
    dir = mkdtempSync(join(tmpdir(), 'dsk-acc-'));
    const file = accountFilePath(dir);
    writeFileSync(file, '{ not json', 'utf8');
    expect(readAccountState(file)).toEqual({ current: null, known: [], removed: [] });
  });

  it('写入后可回读，并把 id 并入 known（自动建父目录）', () => {
    dir = mkdtempSync(join(tmpdir(), 'dsk-acc-'));
    const file = join(dir, 'nested', 'account.json');
    const state = writeCurrentAccount(file, 'work');
    expect(state.current).toBe('work');
    expect(state.known).toContain('work');
    expect(readAccountState(file).current).toBe('work');
  });

  it('写入不会残留临时文件', () => {
    dir = mkdtempSync(join(tmpdir(), 'dsk-acc-'));
    const file = accountFilePath(dir);
    writeCurrentAccount(file, 'personal');
    writeCurrentAccount(file, 'work');
    expect(readFileSync(file, 'utf8')).toContain('"current": "work"');
    expect(() => readFileSync(`${file}.tmp`, 'utf8')).toThrow();
  });

  it('非法 id 直接拒绝（抛出，不写盘）', () => {
    dir = mkdtempSync(join(tmpdir(), 'dsk-acc-'));
    const file = accountFilePath(dir);
    expect(() => writeCurrentAccount(file, '../evil')).toThrow(TypeError);
    expect(readAccountState(file).current).toBeNull();
  });
});

describe('listKnownAccounts（候选合并去重）', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('合并：预置名 + 配置 known + 已有归档目录，去重排序', () => {
    dir = mkdtempSync(join(tmpdir(), 'dsk-mirror-'));
    mkdirSync(join(dir, 'from-disk'), { recursive: true });
    const list = listKnownAccounts(dir, { current: null, known: ['custom'], removed: [] });
    expect(list).toContain(DEFAULT_ACCOUNT);
    expect(list).toContain('work');
    expect(list).toContain('custom');
    expect(list).toContain('from-disk');
    expect(list).toEqual([...list].sort());
    expect(SUGGESTED_ACCOUNTS.every((s) => list.includes(s))).toBe(true);
  });

  it('删除过的账号不会再出现在候选里（真实 bug：默认账号 work/personal 删不掉）', () => {
    dir = mkdtempSync(join(tmpdir(), 'dsk-mirror-'));
    // personal / work 是预置候选：只从 known 移除压不住它们，必须靠 removed
    const state = { current: null, known: [], removed: ['work'] };
    const list = listKnownAccounts(dir, state);
    expect(list).not.toContain('work');
    expect(list).toContain('personal');

    // 走真实删除流程：removeKnownAccount 应把 id 记入 removed
    const file = join(dir, 'account.json');
    writeCurrentAccount(file, 'personal');
    removeKnownAccount(file, 'work');
    expect(readAccountState(file).removed).toContain('work');
    expect(listKnownAccounts(dir, readAccountState(file))).not.toContain('work');

    // 重新添加时应从 removed 里摘掉
    writeCurrentAccount(file, 'work');
    expect(readAccountState(file).removed).not.toContain('work');
  });

  it('mirror/ 下的**文件**（如 index.json）不会被当成账号', () => {
    dir = mkdtempSync(join(tmpdir(), 'dsk-mirror-'));
    mkdirSync(join(dir, 'realacc'), { recursive: true });
    writeFileSync(join(dir, 'index.json'), '{}', 'utf8');
    const list = listKnownAccounts(dir);
    expect(list).not.toContain('index.json');
    expect(list).toContain('realacc');
  });

  it('目录不存在也不抛错（只返回预置名与配置里的）', () => {
    const list = listKnownAccounts(join(tmpdir(), 'dsk-not-exist-xyz'));
    expect(list).toContain(DEFAULT_ACCOUNT);
  });
});
