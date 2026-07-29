-- ═══════════════════════════════════════════════════════════════════════
-- تقنيات سوفت Pro — Cloud Sync Server Schema (Neon PostgreSQL)
-- ═══════════════════════════════════════════════════════════════════════
-- الاستراتيجية:
--   بدلاً من نسخ 83 جدولاً من SQLite (وربطها بمخطط صارم قد يكسر أي تحديث)،
--   نستخدم "Universal Sync Store" — جدول واحد يحتفظ بكل صف كـ JSONB
--   مع اسم الجدول ومفتاحه الأساسي. هذا يعطينا:
--     • مرونة كاملة (أي تغيير في هيكل SQLite لا يحتاج migration في السيرفر)
--     • أداء ممتاز مع فهارس JSONB / GIN
--     • دعم استعلامات متقدمة (بحث داخل JSON)
--     • نسخ احتياطي كامل + استعادة بمفتاح واحد
-- ═══════════════════════════════════════════════════════════════════════

-- ─── (1) الأجهزة المسجّلة ───
-- كل تثبيت للتطبيق = جهاز واحد، له JWT خاص
CREATE TABLE IF NOT EXISTS devices (
    id             BIGSERIAL PRIMARY KEY,
    device_id      TEXT UNIQUE NOT NULL,           -- UUID يولّده التطبيق (fingerprint)
    device_name    TEXT,                            -- اسم الجهاز (مثل: DESKTOP-ABC)
    company_id     BIGINT DEFAULT 1,                -- شركة الجهاز (multi-tenant future)
    api_key_hash   TEXT NOT NULL,                   -- bcrypt hash للـ API key
    last_seen_at   TIMESTAMPTZ,
    last_sync_at   TIMESTAMPTZ,
    total_syncs    BIGINT NOT NULL DEFAULT 0,
    is_active      BOOLEAN NOT NULL DEFAULT TRUE,
    meta           JSONB DEFAULT '{}'::JSONB,       -- بيانات إضافية (OS, version, ...)
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_devices_company     ON devices(company_id);
CREATE INDEX IF NOT EXISTS idx_devices_last_seen   ON devices(last_seen_at DESC);

-- ─── (2) سجلات المزامنة (Universal Sync Store) ───
-- كل صف = صف واحد من قاعدة بيانات محلية (أي جدول)
CREATE TABLE IF NOT EXISTS sync_records (
    id             BIGSERIAL PRIMARY KEY,
    device_id      TEXT NOT NULL,                  -- الجهاز الذي أرسل الصف
    company_id     BIGINT NOT NULL DEFAULT 1,
    table_name     TEXT NOT NULL,                  -- اسم الجدول في SQLite
    record_key     TEXT NOT NULL,                  -- مفتاح الصف (id عادةً، قد يكون مركّب)
    record_data    JSONB NOT NULL,                 -- الصف كامل كـ JSON
    record_hash    TEXT NOT NULL,                  -- SHA-256 للتحقق من التغيير
    operation      TEXT NOT NULL DEFAULT 'upsert', -- upsert | delete
    local_updated_at TIMESTAMPTZ,                  -- طابع زمني محلي (من التطبيق)
    server_received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    sync_batch_id  UUID,                            -- مجموعة الرفع الواحدة
    is_deleted     BOOLEAN NOT NULL DEFAULT FALSE,
    UNIQUE (company_id, table_name, record_key)
);

CREATE INDEX IF NOT EXISTS idx_sync_records_device      ON sync_records(device_id);
CREATE INDEX IF NOT EXISTS idx_sync_records_company     ON sync_records(company_id);
CREATE INDEX IF NOT EXISTS idx_sync_records_table       ON sync_records(table_name);
CREATE INDEX IF NOT EXISTS idx_sync_records_updated     ON sync_records(server_received_at DESC);
CREATE INDEX IF NOT EXISTS idx_sync_records_batch       ON sync_records(sync_batch_id);
-- فهرس JSONB (GIN) للبحث السريع داخل البيانات
CREATE INDEX IF NOT EXISTS idx_sync_records_data_gin    ON sync_records USING GIN(record_data);

-- ─── (3) سجل عمليات المزامنة (Audit) ───
CREATE TABLE IF NOT EXISTS sync_log (
    id             BIGSERIAL PRIMARY KEY,
    device_id      TEXT NOT NULL,
    company_id     BIGINT NOT NULL DEFAULT 1,
    batch_id       UUID NOT NULL,
    operation_type TEXT NOT NULL,                  -- 'sync_push' | 'sync_pull' | 'backup' | 'restore'
    tables_count   INTEGER NOT NULL DEFAULT 0,
    records_count  INTEGER NOT NULL DEFAULT 0,
    payload_bytes  BIGINT NOT NULL DEFAULT 0,
    duration_ms    INTEGER,
    status         TEXT NOT NULL DEFAULT 'success', -- success | partial | failed
    error_message  TEXT,
    client_ip      TEXT,
    user_agent     TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sync_log_device    ON sync_log(device_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sync_log_company   ON sync_log(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sync_log_batch     ON sync_log(batch_id);

-- ─── (4) النسخ الاحتياطية الكاملة (Snapshots) ───
-- كل نسخة احتياطية كاملة تُضغط وتُخزّن كـ BYTEA (gzipped JSON)
CREATE TABLE IF NOT EXISTS backups (
    id             BIGSERIAL PRIMARY KEY,
    device_id      TEXT NOT NULL,
    company_id     BIGINT NOT NULL DEFAULT 1,
    backup_type    TEXT NOT NULL DEFAULT 'full',   -- full | incremental | manual
    tables_included TEXT[],                        -- قائمة الجداول المشمولة
    total_records  BIGINT NOT NULL DEFAULT 0,
    size_bytes     BIGINT NOT NULL DEFAULT 0,
    compressed_bytes BIGINT,
    checksum_sha256 TEXT NOT NULL,
    payload_gzip   BYTEA NOT NULL,                 -- الحمل مضغوطاً (gzip)
    app_version    TEXT,
    notes          TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_backups_device     ON backups(device_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_backups_company    ON backups(company_id, created_at DESC);

-- ─── (5) إعدادات عامة للسيرفر ───
CREATE TABLE IF NOT EXISTS server_settings (
    key            TEXT PRIMARY KEY,
    value          JSONB NOT NULL,
    description    TEXT,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- إعداد الإصدار
INSERT INTO server_settings (key, value, description)
VALUES ('schema_version', '"1.0.0"'::JSONB, 'إصدار مخطط قاعدة البيانات')
ON CONFLICT (key) DO NOTHING;

INSERT INTO server_settings (key, value, description)
VALUES ('deployed_at', to_jsonb(NOW()::TEXT), 'وقت آخر نشر')
ON CONFLICT (key) DO UPDATE SET value = to_jsonb(NOW()::TEXT), updated_at = NOW();

-- ─── (6) Trigger لتحديث updated_at تلقائياً ───
CREATE OR REPLACE FUNCTION _touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS devices_touch_updated_at ON devices;
CREATE TRIGGER devices_touch_updated_at
    BEFORE UPDATE ON devices
    FOR EACH ROW EXECUTE FUNCTION _touch_updated_at();

-- ═══════════════════════════════════════════════════════════════════════
-- نهاية المخطط
-- ═══════════════════════════════════════════════════════════════════════
