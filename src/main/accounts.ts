/**
 * 多账号：账号 id 的持久化与候选列表（主进程侧**纯逻辑**，可单测）。
 *
 * 隔离模型（重要）：
 *  - **登录态/缓存**按 Electron partition 隔离 —— `persist:dsk-<account>`（见 src/shared/brand.ts）；
 *  - **本地归档**按 `userData/mirror/<accountId>/` 隔离（MirrorStore 的 baseDir + accountId）；
 *  - 两者都用同一套 id 规则，因此不同账号的数据天然不互相污染。
 *
 * 为什么"切换 = 重启"：partition 在 app 启动时决定，运行时要换分区就得常驻多个 WebContentsView
 *（内存翻倍、视图管理复杂）。账号切换是低频操作，写配置 + 重启更简单也更不易出错。
 *
 * 安全：账号 id 会进入**文件路径**（归档目录）与**分区名**，因此统一按路径片段规则校验
 *（字母/数字开头、`[A-Za-z0-9._-]`、≤128、禁止 `..`）。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export const DEFAULT_ACCOUNT = 'personal';
/** 预置候选名：方便首次添加账号（真正的账号集合还会并入已有归档目录） */
export const SUGGESTED_ACCOUNTS = ['personal', 'work'] as const;

export function isSafeAccountId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_ID.test(value) && !value.includes('..');
}

export interface AccountState {
  /** 当前账号（配置里没有/非法 → null，由调用方回退到默认值） */
  current: string | null;
  /** 配置里记录过的账号（不含候选建议） */
  known: string[];
  /**
   * **显式删除过**的账号。
   *
   * 为什么需要：`SUGGESTED_ACCOUNTS`（personal / work）是预置候选，若删除时只从 `known` 里移除，
   * 下次 `listKnownAccounts()` 又会从预置候选（以及磁盘目录）把它们加回来 —— 用户看到的现象
   * 就是"删不掉默认账号"（真实反馈）。
   */
  removed: string[];
}

/** 宽容解析账号配置文件：坏数据一律忽略，绝不抛错。 */
export function parseAccountState(raw: unknown): AccountState {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { current: null, known: [], removed: [] };
  }
  const rec = raw as Record<string, unknown>;
  const current = isSafeAccountId(rec['current']) ? rec['current'] : null;
  const knownRaw = Array.isArray(rec['known']) ? rec['known'] : [];
  const known = [...new Set(knownRaw.filter(isSafeAccountId))].sort();
  const removedRaw = Array.isArray(rec['removed']) ? rec['removed'] : [];
  const removed = [...new Set(removedRaw.filter(isSafeAccountId))].sort();
  return { current, known, removed };
}

/** 读配置；文件不存在或损坏都返回空状态（调用方回退默认账号）。 */
export function readAccountState(filePath: string): AccountState {
  if (!existsSync(filePath)) return { current: null, known: [], removed: [] };
  try {
    return parseAccountState(JSON.parse(readFileSync(filePath, 'utf8')));
  } catch {
    return { current: null, known: [], removed: [] };
  }
}

/**
 * 原子写配置：先写同目录临时文件再 rename（读方永远看不到半个文件）。
 * 同时把 id 并入 `known`，便于下次在菜单里直接选到。
 */
export function writeCurrentAccount(filePath: string, id: string): AccountState {
  if (!isSafeAccountId(id)) throw new TypeError(`writeCurrentAccount: 非法账号 id：${String(id)}`);
  const prev = readAccountState(filePath);
  const state: AccountState = {
    current: id,
    known: [...new Set([...prev.known, id])].sort(),
    // 重新添加一个曾被删除的账号 → 从 removed 里摘掉
    removed: prev.removed.filter((r) => r !== id),
  };

  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  renameSync(tmp, filePath);
  return state;
}

/**
 * 候选账号：预置名 + 配置里记录过的 + **已有归档目录**（说明用过），去重排序。
 * 目录读取失败一律忽略（归档层问题不该影响账号菜单）。
 */
export function listKnownAccounts(mirrorDir: string, state?: AccountState): string[] {
  const fromDisk: string[] = [];
  try {
    // 只认**子目录**：`mirror/` 下还有 index.json 这类文件，不能被当成账号名
    //（踩坑记录：用户实测切换后 known 里混进了 "index.json"，还误建了 dsk-index.json 分区）
    for (const ent of readdirSync(mirrorDir, { withFileTypes: true })) {
      if (ent.isDirectory() && isSafeAccountId(ent.name)) fromDisk.push(ent.name);
    }
  } catch {
    /* 目录不存在/无权限：忽略 */
  }
  const removed = new Set(state?.removed ?? []);
  const all = new Set<string>([...SUGGESTED_ACCOUNTS, ...(state?.known ?? []), ...fromDisk]);
  return [...all].filter((id) => !removed.has(id)).sort();
}

/**
 * 从配置的 `known` 里移除一个账号（删除账号时调用）。
 * 若移除的正是 `current`，把 current 置空（调用方应保证不会删当前账号；这里只是兜底）。
 */
export function removeKnownAccount(filePath: string, id: string): AccountState {
  const prev = readAccountState(filePath);
  if (!isSafeAccountId(id)) return prev;
  const state: AccountState = {
    current: prev.current === id ? null : prev.current,
    known: prev.known.filter((k) => k !== id),
    // 记入 removed：否则预置候选 / 磁盘目录会把它又带回菜单（用户实测"删不掉"）
    removed: [...new Set([...prev.removed, id])].sort(),
  };
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  renameSync(tmp, filePath);
  return state;
}

/** 账号配置文件路径（放在 userData 根下，与 mirror/ 平级）。 */
export function accountFilePath(userDataDir: string): string {
  return join(userDataDir, 'account.json');
}
