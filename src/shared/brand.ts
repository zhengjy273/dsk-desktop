/**
 * 品牌常量 —— 单一真源，改名只需改这里。
 *
 * ⚠️ 合规记录（R4 明示例外，D-01）：应用名为「DeepSeek Chat」，与《DeepSeek 用户协议》6.2
 *    （不得擅自使用 "DeepSeek" 商标/名称/LOGO/URL 等显著品牌特征）存在冲突。
 *    当前适用范围：仅本机自用、不公开分发、不商业使用、不申请商标/域名，暴露面仅限本人设备。
 *    **触发条件**：一旦考虑公开分发，首个公开构建之前必须改 DISPLAY_NAME 并更换图标，
 *    同时保持 INTERNAL_APP_ID / 安装包名 / 更新源等内部标识不含品牌特征（现已如此）。
 */
export const DISPLAY_NAME = 'DeepSeek Chat';

/** 内部标识：刻意不含品牌特征，避免随安装包/更新源外泄。 */
export const INTERNAL_APP_ID = 'com.local.dskdesktop';
export const INTERNAL_PRODUCT_NAME = 'dsk-desktop';

/** 目标站点（唯一允许加载的来源，DD-13）。 */
export const SITE_ORIGIN = 'https://chat.deepseek.com';

/** 会话分区前缀：每个身份一个，天然隔离登录态（DD-02）。 */
export const PARTITION_PREFIX = 'persist:dsk-';
