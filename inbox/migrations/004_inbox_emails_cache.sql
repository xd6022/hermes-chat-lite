-- 004: 消息中心 · 邮件缓存表（2026-09-28）
--
-- 为什么有这张表（反转 2026-09-24 的"邮件不落库"）：
--   09-24 的口径是"邮件打开看一眼"⇒ 页面实时直读 IMAP。副作用是每次点开都要真连一次 IMAP
--   （~1.3s，且轮询就撞风控），也没法离线看/翻历史。
--   09-28 改成：**定时拉取（交易日 9–15 每整点）+ 页面刷新按钮** 把邮件落到这张表，
--   页面只读缓存（瞬时、离线可读）。实时性不再依赖邮箱 —— 要动手的提醒走消息中心（inbox_messages）。
--
-- 仍然守住的底线：
--   · IMAP 一律 `readonly=True`（绝不动邮箱的已读状态）
--   · 只缓存"自己发的"通知（`INBOX_MAIL_SENDER`，默认 xd602201@163.com）—— 沿用既有过滤，不新增
--   · **绝不存原始 HTML**（XSS 红线）—— body 是去标签后的纯文本
--   · 不存附件，只存数量
--
-- 状态：已在 hermes_stock 应用（2026-09-28）。重复执行安全（IF NOT EXISTS）。

CREATE TABLE IF NOT EXISTS inbox_emails (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  message_id VARCHAR(191) NOT NULL COMMENT '邮件 Message-ID（去重键；163 的 IMAP UID 会变，不能当键）',
  uid VARCHAR(64) NOT NULL DEFAULT '' COMMENT '最近一次拉取时的 IMAP UID（仅参考）',
  from_name VARCHAR(191) NOT NULL DEFAULT '',
  from_addr VARCHAR(191) NOT NULL DEFAULT '',
  to_addr VARCHAR(255) NOT NULL DEFAULT '',
  subject VARCHAR(255) NOT NULL DEFAULT '',
  occurred_at DATETIME NOT NULL COMMENT '邮件头 Date（北京时间）',
  body MEDIUMTEXT COMMENT '去标签后的纯文本正文（绝不存原始 HTML —— XSS 红线）',
  body_len INT UNSIGNED NOT NULL DEFAULT 0,
  attachment_count INT UNSIGNED NOT NULL DEFAULT 0,
  fetched_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '最近一次从 IMAP 拉到它的时刻',
  PRIMARY KEY (id),
  UNIQUE KEY uk_message_id (message_id),
  KEY idx_occurred (occurred_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='消息中心·邮件缓存（页面只读这张表，不再实时连 IMAP）';
