CREATE TABLE IF NOT EXISTS risk_control_counters (
  subject_type ENUM('user', 'ip') NOT NULL COMMENT '限流主体类型',
  subject_key VARCHAR(128) NOT NULL COMMENT '限流主体标识，用户 ID 或 IP',
  bucket_start TIMESTAMP(3) NOT NULL COMMENT '限流窗口起始时间',
  window_seconds INT UNSIGNED NOT NULL COMMENT '窗口长度秒数',
  request_count INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '窗口内请求次数',
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (subject_type, subject_key, bucket_start),
  KEY idx_risk_control_counters_updated (updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='图片任务风控原子限流计数器';
