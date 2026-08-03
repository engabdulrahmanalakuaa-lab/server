-- ============================================================
-- تقنيات سوفت Pro - License Server Schema (PostgreSQL / Neon)
-- ============================================================
-- ملاحظة: نستخدم بادئة "ts_" لتجنّب التعارض مع أي جداول قديمة
-- في نفس قاعدة البيانات (مملوكة لأدوار أخرى).
-- ============================================================

-- جدول العملاء
CREATE TABLE IF NOT EXISTS ts_clients (
    id            SERIAL PRIMARY KEY,
    client_name   TEXT NOT NULL,
    client_phone  TEXT,
    client_email  TEXT,
    country       TEXT,
    city          TEXT,
    address       TEXT,
    notes         TEXT,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ts_clients_phone ON ts_clients(client_phone);
CREATE INDEX IF NOT EXISTS idx_ts_clients_email ON ts_clients(client_email);

-- جدول مفاتيح التفعيل (تُصدر قبل التفعيل)
CREATE TABLE IF NOT EXISTS ts_activation_keys (
    id                SERIAL PRIMARY KEY,
    activation_key    TEXT NOT NULL UNIQUE,
    client_id         INTEGER REFERENCES ts_clients(id) ON DELETE SET NULL,
    business_type     TEXT NOT NULL,
    invoice_template  TEXT NOT NULL,
    duration_days     INTEGER NOT NULL,
    max_activations   INTEGER DEFAULT 1,
    used_activations  INTEGER DEFAULT 0,
    status            TEXT DEFAULT 'active',
    created_at        TIMESTAMPTZ DEFAULT NOW(),
    expires_at        TIMESTAMPTZ,
    notes             TEXT
);
CREATE INDEX IF NOT EXISTS idx_ts_akeys_status ON ts_activation_keys(status);
CREATE INDEX IF NOT EXISTS idx_ts_akeys_client ON ts_activation_keys(client_id);

-- جدول التراخيص المُفعّلة
CREATE TABLE IF NOT EXISTS ts_licenses (
    id                  SERIAL PRIMARY KEY,
    activation_key_id   INTEGER NOT NULL REFERENCES ts_activation_keys(id) ON DELETE CASCADE,
    client_id           INTEGER REFERENCES ts_clients(id) ON DELETE SET NULL,
    machine_id          TEXT NOT NULL,
    fingerprint         TEXT,
    business_type       TEXT NOT NULL,
    invoice_template    TEXT NOT NULL,
    issued_at           TIMESTAMPTZ NOT NULL,
    expires_at          TIMESTAMPTZ NOT NULL,
    duration_days       INTEGER NOT NULL,
    last_heartbeat_at   TIMESTAMPTZ,
    heartbeat_count     INTEGER DEFAULT 0,
    client_version      TEXT,
    status              TEXT DEFAULT 'active',
    revoked_at          TIMESTAMPTZ,
    revoked_reason      TEXT,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ts_licenses_machine ON ts_licenses(machine_id);
CREATE INDEX IF NOT EXISTS idx_ts_licenses_status ON ts_licenses(status);
CREATE INDEX IF NOT EXISTS idx_ts_licenses_expires ON ts_licenses(expires_at);
CREATE INDEX IF NOT EXISTS idx_ts_licenses_akey ON ts_licenses(activation_key_id);

-- v6.8.0: أعمدة كود إعادة تعيين كلمة المرور (Password Reset Code)
-- يتم إضافتها إن لم تكن موجودة (متوافقة مع قواعد بيانات قديمة)
ALTER TABLE ts_licenses ADD COLUMN IF NOT EXISTS reset_code TEXT;
ALTER TABLE ts_licenses ADD COLUMN IF NOT EXISTS reset_code_expires_at TIMESTAMPTZ;
ALTER TABLE ts_licenses ADD COLUMN IF NOT EXISTS reset_code_used_at TIMESTAMPTZ;
ALTER TABLE ts_licenses ADD COLUMN IF NOT EXISTS reset_code_generated_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_ts_licenses_reset_code ON ts_licenses(reset_code) WHERE reset_code IS NOT NULL;

-- جدول سجل الأحداث (audit)
CREATE TABLE IF NOT EXISTS ts_license_events (
    id           SERIAL PRIMARY KEY,
    license_id   INTEGER REFERENCES ts_licenses(id) ON DELETE SET NULL,
    event_type   TEXT NOT NULL,
    machine_id   TEXT,
    fingerprint  TEXT,
    ip_address   TEXT,
    user_agent   TEXT,
    details      JSONB,
    created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ts_events_license ON ts_license_events(license_id);
CREATE INDEX IF NOT EXISTS idx_ts_events_type ON ts_license_events(event_type);
CREATE INDEX IF NOT EXISTS idx_ts_events_created ON ts_license_events(created_at DESC);

-- جدول المستخدمين الإداريين
CREATE TABLE IF NOT EXISTS ts_admin_users (
    id             SERIAL PRIMARY KEY,
    username       TEXT NOT NULL UNIQUE,
    password_hash  TEXT NOT NULL,
    full_name      TEXT,
    role           TEXT DEFAULT 'admin',
    is_active      BOOLEAN DEFAULT TRUE,
    last_login_at  TIMESTAMPTZ,
    created_at     TIMESTAMPTZ DEFAULT NOW()
);

-- جدول إحصائيات (cache)
CREATE TABLE IF NOT EXISTS ts_stats_cache (
    key         TEXT PRIMARY KEY,
    value       TEXT,
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);
