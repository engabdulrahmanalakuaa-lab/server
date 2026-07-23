'use strict';

const { Pool } = require('pg');

// الاتصال بقاعدة بيانات Neon عبر متغير البيئة DATABASE_URL
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false // مطلوب لاتصالات SSL في Neon
    }
});

pool.on('error', (err) => {
    console.error('[Neon PG Error]: خطأ غير متوقع في العميل:', err);
});

/**
 * تهيئة جداول قاعدة البيانات تلقائياً في Neon
 */
async function initDb() {
    try {
        const client = await pool.connect();
        try {
            // 1. جدول العملاء clients
            await client.query(`
                CREATE TABLE IF NOT EXISTS clients (
                    id SERIAL PRIMARY KEY,
                    name VARCHAR(255) NOT NULL,
                    phone VARCHAR(50),
                    notes TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
            `);

            // 2. جدول مفاتيح التفعيل activation_keys
            await client.query(`
                CREATE TABLE IF NOT EXISTS activation_keys (
                    id SERIAL PRIMARY KEY,
                    key_code VARCHAR(100) UNIQUE NOT NULL,
                    client_id INT REFERENCES clients(id) ON DELETE CASCADE,
                    business_type VARCHAR(100),
                    template VARCHAR(100),
                    duration_days INT NOT NULL,
                    max_devices INT DEFAULT 1,
                    is_used BOOLEAN DEFAULT FALSE,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
            `);

            // 3. جدول التراخيص المفعلة licenses
            await client.query(`
                CREATE TABLE IF NOT EXISTS licenses (
                    id SERIAL PRIMARY KEY,
                    key_code VARCHAR(100) NOT NULL,
                    client_id INT,
                    machine_id TEXT NOT NULL,
                    jwt_token TEXT,
                    status VARCHAR(50) DEFAULT 'active',
                    last_heartbeat_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    heartbeat_count INT DEFAULT 1,
                    expires_at TIMESTAMP NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
            `);

            // 4. سجل الأحداث license_events
            await client.query(`
                CREATE TABLE IF NOT EXISTS license_events (
                    id SERIAL PRIMARY KEY,
                    license_id INT,
                    event_type VARCHAR(50),
                    details TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
            `);

            // 5. مستخدمو الإدارة admin_users
            await client.query(`
                CREATE TABLE IF NOT EXISTS admin_users (
                    id SERIAL PRIMARY KEY,
                    username VARCHAR(100) UNIQUE NOT NULL,
                    password_hash TEXT NOT NULL,
                    role VARCHAR(50) DEFAULT 'admin',
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
            `);

            console.log('[✓] تم الاتصال بسحابة Neon PostgreSQL وتهيئة جميع الجداول بنجاح');
        } finally {
            client.release();
        }
    } catch (err) {
        console.error('[✗] خطأ أثناء إنشاء جداول Neon:', err.message);
    }
}

// تشغيل دالة التهيئة عند بدء التشغيل
initDb();

module.exports = {
    pool,
    query: (text, params) => pool.query(text, params),
    getOne: async (text, params) => {
        const res = await pool.query(text, params);
        return res.rows[0] || null;
    },
    getAll: async (text, params) => {
        const res = await pool.query(text, params);
        return res.rows;
    }
};
