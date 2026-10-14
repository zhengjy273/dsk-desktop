# M1 任务卡（Agent Teams 分工基线）

> 依据 [PLAN.md](../PLAN.md) §4.2 / §6.3 / §7。**写作用域互斥**：每个任务只能改自己作用域内的文件。
> `src/shared/**` 与 `package.json` **只由 Lead 修改**；其他任务需要新增依赖或改契约时向 Lead 提请求。

## 全局纪律（每个任务启动语都要带上）

1. 不逆向站点接口、不读取账号凭据、不破坏站点 AI 生成标识（PLAN §1.3 R1–R3）。
2. 自动化测试只打 `fixtures/mock-chat`，禁止登录真实账号（DD-10）。
3. 增强层任何失败都必须**降级而非崩溃**：特性开关 + 选择器注册表 + `try/catch`（DD-05）+ 全局熔断（DD-14）。
4. 不向页面暴露任何主进程能力（无特权 preload，DD-13）；`contextIsolation: true`、`nodeIntegration: false`。
5. 改动前先读 `src/shared/ipc-contract.ts`；改动后跑自己的 Gate。

---

## T0 契约层 — 状态：**已完成**（Lead）

**交付物**：`src/shared/{brand.ts,ipc-contract.ts,mirror-schema.ts,selectors.json}`、`tsconfig.json`
**验收**：`pnpm typecheck` 通过；`pnpm test` 中 `mirror-schema` 全绿；`selectors.json` 区分 `verified` / `text-match` / `unverified`。
**后续**：契约变更只走 Lead；T2 补齐 `selectors.json` 的 `unverified` 项（在 V3 发消息后探测）。

---

## T1 外壳与窗口 — 负责人 `shell-agent`

**写作用域**：`src/main/**`、`src/shell-ui/**`、`src/tabbar/**`
**依赖**：T0

**交付物**
- `src/main/app.ts`：单实例锁、生命周期、`app.setAppUserModelId(INTERNAL_APP_ID)`。
- `src/main/windows/main.ts`：`BaseWindow + WebContentsView`；**resize 时手动同步 bounds**（已知坑）。
- `src/main/tray.ts`：托盘常驻，菜单含「新建会话 / 迷你窗 / 置顶 / 退出」。
- `src/main/shortcuts.ts`：`globalShortcut` 唤起（默认 `CommandOrControl+Shift+D`），可配置。
- `src/main/theme.ts`：`nativeTheme.themeSource = 'system'`，变更广播给外壳与页面。
- `src/main/notifications.ts`：仅在窗口失焦且本轮结束时通知（DD-07）。
- `src/tabbar/`：多会话标签，上限 8，后台标签节流，关闭即销毁视图。
- `src/shell-ui/`：标签栏 / 迷你窗 / 设置页（轻量 TS + 原生 DOM）。

**验收标准**
- [ ] 冷启动到可输入 < 3s；托盘图标出现；快捷键从任意应用唤起并聚焦输入框
- [ ] 置顶生效；迷你窗可拖动、可输入、可切回主窗
- [ ] 系统深浅色切换时页面与外壳同步跟随（无需注入 CSS 猜色）
- [ ] 失焦收到完成通知、聚焦时不打扰；通知在 Windows 通知中心可归组
- [ ] 单实例锁：重复启动唤起已有窗口
- [ ] `pnpm typecheck` 通过；控制台无未捕获异常

> **范围变更（2026-10-10，用户决定）**：原交付物中的「多会话标签 / 标签栏」**已取消** ——
> 它与站点自带的侧边栏功能重复、占内存、且引入大量状态（实测连续出过：并发加载被限流 → 新标签黑屏、
> 误报完成通知、视图可见性异常）。
> **T1 最终形态**：单会话视图（`src/main/content-view.ts`，占满窗口）+ 托盘 + 全局快捷键 + 迷你窗
> + 完成通知 + 主题跟随 + 代理 + 导出。相关文件 `src/main/tabs.ts`、`src/shell-ui/tabbar.html`、
> `src/shell-ui/preload.cjs` 已删除。

---

## T2 会话与注入 — 负责人 `inject-agent`

**写作用域**：`src/session/**`、`src/inject/**`（+ 经 Lead 同意后补 `src/shared/selectors.json` 的实测值）
**依赖**：T0

**交付物**
- `src/session/manager.ts`：`persist:dsk-<accountId>` 分区生命周期；「清除登录态」= 清分区。
- `src/session/fingerprint.ts`：UA 改写 + **补发与 `navigator.userAgentData` 自洽的 `Sec-CH-UA*`**（M0 已实证 Electron 默认不发这组头；**不要**伪造 `Google Chrome` 品牌）。
- `src/session/proxy.ts`：`session.setProxy` + 连通性探测；凭据用 `safeStorage`。
- `src/inject/preload.ts` + `enhancer.ts`：隔离世界注入；只操作 DOM 与样式；**不得隐藏任何 AI 生成标识**。
- `src/inject/guard.ts`：全局熔断（`--no-enhance` / 设置项）。
- `src/session/network-mirror.ts`（主通道，DD-06）：`webContents.debugger` 累积 SSE 字节，产出 `fidelity: 'full'` 的镜像。
- `src/session/dom-mirror.ts`（兜底）：`MutationObserver`，产出 `fidelity: 'partial'`。

**验收标准**
- [ ] 分区隔离：两个账号互不串号；重启后仍登录（复用 `--session=main` 方式验证）
- [ ] 开/关增强层各跑 20 轮，功能一致；**AI 生成标识在两种状态下存在性与可见性一致**
- [ ] `selectors.json` 中所有 `unverified` 项在真实页面（已登录 + 有消息）补齐实测值，并标注命中率
- [ ] 选择器失配时：核心聊天不中断，仅在 diagnostics 上报
- [ ] 网络通道能解析出完整会话（含深度思考段落与引用），与页面显示一致
- [ ] 代码中不存在读取 `input`/`textarea` 值或 storage token 的路径（静态检查 + 评审签字）

---

## T3 归档与导出 — 负责人 `data-agent`

**写作用域**：`src/store/**`、`src/features/**`
**依赖**：T0（只读 T2 的**契约**，不读其实现）

**交付物**
- `src/store/mirror-store.ts`：追加式 JSONL + 原子重写 `index.json`；幂等写入（`messageId`）。
- `src/store/migrations/`：版本化迁移（参照 DSH 会话日志 v0→v4 的做法）。
- `src/store/search.ts`：全文检索（先用内存索引，体量上来后迁 SQLite FTS5）。
- `src/features/export/markdown.ts`：标题/时间/角色/代码围栏/列表/公式；**强制写入「本内容由 AI 生成」标识与来源**（DD-15）。
- `src/features/export/json.ts`、`ai-notice.ts`。

**验收标准**
- [ ] 导出 100 条消息 < 2s；Markdown 在 Typora/VSCode 渲染正确
- [ ] 导出的每一份产物都含 AI 生成标识（自动化断言，不允许裸导出）
- [ ] 同一会话重复镜像不产生重复记录（幂等测试）
- [ ] 全部单元测试通过，`store`/`export` 覆盖率 ≥ 70%
- [ ] 「一键清除本地数据」可用

---

## T4 打包与更新 — 负责人 `build-agent`

**写作用域**：`electron-builder.yml`、`scripts/**`（**不含** `scripts/launch.mjs` 与 `setup-electron.mjs`，那两个归 Lead）、`.npmrc`
**依赖**：T1

**交付物**
- `electron-builder.yml`：`nsis` + `portable`，`asar: true`，**自制图标**（R4：不得使用官方素材）。
- `scripts/pack.mjs`：一键打包 + 产物校验。
- 自动更新：本地版本检查（D-02 仅自用，无需 GitHub Releases）。
- 首次运行引导页：写明「非官方、仅本地自用」，并说明 SmartScreen 告警原因。

**验收标准**
- [ ] `pnpm pack` 产物在干净环境启动：可登录、可对话、可导出
- [ ] 安装包与更新源中**不含** DeepSeek 品牌特征（R4 自检）
- [ ] 卸载不残留用户数据（或明确询问是否保留）

---

## T5 夹具与回归 — 负责人 `test-agent`

**写作用域**：`tests/**`、`fixtures/**`、`.dsh/skills/**`
**依赖**：T0

**交付物**
- `fixtures/mock-chat/index.html`：**已完成**（支持 `?demo=1` 预填消息、`?stream=1` 自动流式、AI 标识节点、模式按钮、`generating-indicator`）。
- `tests/unit/**`：`mirror-schema`（**已完成**）、`export` golden、`fingerprint` UA 断言、`selectors` 命中率。
- `tests/smoke/**`：Playwright `_electron` 启动 → 载入 mock → 断言注入生效 / 导出产物 / **标识保留**。
- `.dsh/skills/dsk-enhancer/SKILL.md`：把注入三铁律、选择器更新五步、验证命令、红线 R1–R8 固化成 DSH 技能。

**验收标准**
- [ ] `pnpm test` 全绿；`pnpm smoke` 通过且**不访问真实站点**
- [ ] mock 站点能覆盖：登录页、会话页、流式、AI 标识、模式按钮、空会话
- [ ] 站点改版时的"抢修流程"可执行：复现 → 改夹具 → 改注册表 → 证明降级不崩 → 输出对照表

---

## 依赖与调度

```
T0(已完成) ─┬─→ T1 外壳 ──→ T4 打包
            ├─→ T2 会话与注入
            ├─→ T3 归档导出
            └─→ T5 夹具回归（可与 T1/T2/T3 并行）
```

- 同一时刻**不超过 3 个 writer**。
- 每个任务完成前必须跑自己的 Gate，并在完成报告里给出：改动文件清单、执行过的命令与结果、未解决项、已知限制。
- Lead 在所有任务完成后执行 PLAN §7.4 的 G1–G7 总验收（含人工外观验收：「结构检查不等于外观检查」）。
