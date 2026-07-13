-- ============================================================
-- تقنيات سوفت Pro v5.7.6 - License Server Schema
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
    business_type TEXT,   -- v5.7.6: النشاط الافتراضي للعميل (قابل للتغيير)
    invoice_template TEXT, -- v5.7.6: قالب الفاتورة الافتراضي
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

-- ============================================================
-- v5.7.6: جداول جديدة للميزات الإدارية المتقدمة
-- ============================================================

-- رموز إعادة تعيين كلمة المرور (One-Time Reset Tokens)
CREATE TABLE IF NOT EXISTS reset_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT NOT NULL UNIQUE,
    machine_id TEXT,          -- الجهاز المسموح استخدام الرمز عليه (اختياري)
    client_id INTEGER,        -- العميل المرتبط
    license_id INTEGER,       -- الترخيص المرتبط (اختياري)
    temp_password TEXT NOT NULL, -- كلمة المرور المؤقتة التي ستُطبق
    used INTEGER DEFAULT 0,
    used_at TEXT,
    used_by_ip TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    expires_at TEXT NOT NULL,
    created_by TEXT,          -- الأدمن الذي أنشأ الرمز
    notes TEXT,
    FOREIGN KEY (client_id) REFERENCES clients(id),
    FOREIGN KEY (license_id) REFERENCES licenses(id)
);
CREATE INDEX IF NOT EXISTS idx_reset_tokens_token ON reset_tokens(token);
CREATE INDEX IF NOT EXISTS idx_reset_tokens_expires ON reset_tokens(expires_at);

-- إشعارات مُرسَلة للعملاء (تظهر عند heartbeat التالي)
CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER,         -- إن كان NULL يُرسل لكل العملاء
    license_id INTEGER,        -- إن كان NULL يُرسل لكل تراخيص العميل
    machine_id TEXT,           -- إن كان NULL يُرسل لكل الأجهزة
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    severity TEXT DEFAULT 'info', -- info | warning | danger | success
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    expires_at TEXT,           -- بعد هذا التاريخ لا تُرسل
    delivered_count INTEGER DEFAULT 0,
    last_delivered_at TEXT,
    created_by TEXT,
    FOREIGN KEY (client_id) REFERENCES clients(id),
    FOREIGN KEY (license_id) REFERENCES licenses(id)
);
CREATE INDEX IF NOT EXISTS idx_notifications_client ON notifications(client_id);
CREATE INDEX IF NOT EXISTS idx_notifications_license ON notifications(license_id);

-- إثبات تسليم الإشعارات (لتجنّب إعادة الإرسال)
CREATE TABLE IF NOT EXISTS notification_deliveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    notification_id INTEGER NOT NULL,
    license_id INTEGER,
    machine_id TEXT,
    delivered_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(notification_id, machine_id),
    FOREIGN KEY (notification_id) REFERENCES notifications(id)
);
CREATE INDEX IF NOT EXISTS idx_deliveries_notif ON notification_deliveries(notification_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_machine ON notification_deliveries(machine_id);

-- إحصائيات استخدام العميل (تُملأ من التطبيق عبر heartbeat.usage)
CREATE TABLE IF NOT EXISTS client_usage_stats (
    license_id INTEGER PRIMARY KEY,
    invoices_month INTEGER DEFAULT 0,
    sales_total_month REAL DEFAULT 0,
    products_count INTEGER DEFAULT 0,
    users_count INTEGER DEFAULT 0,
    last_activity_at TEXT,
    reported_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (license_id) REFERENCES licenses(id)
);
