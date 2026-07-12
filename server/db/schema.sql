-- ============================================================
-- تقنيات سوفت Pro v5.7.0 - License Server Schema
-- ============================================================

-- جدول العملاء
CREATE TABLE IF NOT EXISTS clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_name TEXT NOT NULL,
    client_phone TEXT,
    client_email TEXT,
    country TEXT,
    city TEXT,
    address TEXT,
    notes TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_clients_phone ON clients(client_phone);
CREATE INDEX IF NOT EXISTS idx_clients_email ON clients(client_email);

-- جدول مفاتيح التفعيل (تُصدر قبل التفعيل)
CREATE TABLE IF NOT EXISTS activation_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    activation_key TEXT NOT NULL UNIQUE,
    client_id INTEGER,
    business_type TEXT NOT NULL,
    invoice_template TEXT NOT NULL,
    duration_days INTEGER NOT NULL,
    max_activations INTEGER DEFAULT 1,
    used_activations INTEGER DEFAULT 0,
    status TEXT DEFAULT 'active', -- active | used | revoked | expired
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    expires_at TEXT,
    notes TEXT,
    FOREIGN KEY (client_id) REFERENCES clients(id)
);
CREATE INDEX IF NOT EXISTS idx_activation_keys_status ON activation_keys(status);
CREATE INDEX IF NOT EXISTS idx_activation_keys_client ON activation_keys(client_id);

-- جدول التراخيص المُفعّلة
CREATE TABLE IF NOT EXISTS licenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    activation_key_id INTEGER NOT NULL,
    client_id INTEGER,
    machine_id TEXT NOT NULL,
    fingerprint TEXT,
    business_type TEXT NOT NULL,
    invoice_template TEXT NOT NULL,
    issued_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    duration_days INTEGER NOT NULL,
    last_heartbeat_at TEXT,
    heartbeat_count INTEGER DEFAULT 0,
    client_version TEXT,
    status TEXT DEFAULT 'active', -- active | expired | revoked | frozen
    revoked_at TEXT,
    revoked_reason TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (activation_key_id) REFERENCES activation_keys(id),
    FOREIGN KEY (client_id) REFERENCES clients(id)
);
CREATE INDEX IF NOT EXISTS idx_licenses_machine ON licenses(machine_id);
CREATE INDEX IF NOT EXISTS idx_licenses_status ON licenses(status);
CREATE INDEX IF NOT EXISTS idx_licenses_expires ON licenses(expires_at);

-- جدول سجل الأحداث (audit)
CREATE TABLE IF NOT EXISTS license_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    license_id INTEGER,
    event_type TEXT NOT NULL, -- activation | heartbeat | expiry | revoke | error
    machine_id TEXT,
    fingerprint TEXT,
    ip_address TEXT,
    user_agent TEXT,
    details TEXT, -- JSON
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (license_id) REFERENCES licenses(id)
);
CREATE INDEX IF NOT EXISTS idx_events_license ON license_events(license_id);
CREATE INDEX IF NOT EXISTS idx_events_type ON license_events(event_type);
CREATE INDEX IF NOT EXISTS idx_events_created ON license_events(created_at);

-- جدول المستخدمين الإداريين (Admin Panel)
CREATE TABLE IF NOT EXISTS admin_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    full_name TEXT,
    role TEXT DEFAULT 'admin', -- admin | operator
    is_active INTEGER DEFAULT 1,
    last_login_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- جدول إحصائيات (cache)
CREATE TABLE IF NOT EXISTS stats_cache (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
