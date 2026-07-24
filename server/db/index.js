'use strict';
const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;
const pool = new Pool({
    connectionString: connectionString,
    ssl: { rejectUnauthorized: false }
});

pool.on('error', (err) => {
    console.error('❌ [Neon PG Error]:', err);
});

// تهيئة الجداول تلقائياً عند التشغيل
async function initSchema() {
    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');

        await client.query(`
            CREATE TABLE IF NOT EXISTS clients (
                id SERIAL PRIMARY KEY,
                client_name VARCHAR(200) NOT NULL,
                client_phone VARCHAR(50),
                client_email VARCHAR(200),
                country VARCHAR(100),
                city VARCHAR(100),
                address VARCHAR(500),
                notes VARCHAR(1000),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS activation_keys (
                id SERIAL PRIMARY KEY,
                activation_key VARCHAR(100) UNIQUE NOT NULL,
                client_id INT REFERENCES clients(id) ON DELETE SET NULL,
                business_type VARCHAR(50) NOT NULL,
                invoice_template VARCHAR(50) NOT NULL,
                duration_days INT DEFAULT 30,
                max_activations INT DEFAULT 1,
                used_activations INT DEFAULT 0,
                expires_at TIMESTAMP,
                status VARCHAR(20) DEFAULT 'active',
                notes VARCHAR(500),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS licenses (
                id SERIAL PRIMARY KEY,
                activation_key_id INT REFERENCES activation_keys(id) ON DELETE CASCADE,
                client_id INT REFERENCES clients(id) ON DELETE SET NULL,
                machine_id VARCHAR(128) NOT NULL,
                fingerprint VARCHAR(128),
                business_type VARCHAR(50),
                invoice_template VARCHAR(50),
                issued_at TIMESTAMP NOT NULL,
                expires_at TIMESTAMP NOT NULL,
                duration_days INT NOT NULL,
                last_heartbeat_at TIMESTAMP,
                heartbeat_count INT DEFAULT 1,
                client_version VARCHAR(50),
                status VARCHAR(20) DEFAULT 'active',
                revoked_at TIMESTAMP,
                revoked_reason VARCHAR(500),
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS license_events (
                id SERIAL PRIMARY KEY,
                license_id INT REFERENCES licenses(id) ON DELETE SET NULL,
                event_type VARCHAR(50) NOT NULL,
                machine_id VARCHAR(128),
                fingerprint VARCHAR(128),
                ip_address VARCHAR(64),
                user_agent VARCHAR(256),
                details TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS admin_users (
                id SERIAL PRIMARY KEY,
                username VARCHAR(100) UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                role VARCHAR(50) DEFAULT 'admin',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await client.query('COMMIT');
        console.log('✅ [Neon PG] تم تهيئة الجداول بنجاح');
    } catch (err) {
        if (client) await client.query('ROLLBACK');
        console.error('❌ [Neon Schema Error]:', err.message);
    } finally {
        if (client) client.release();
    }
}

initSchema();

function translateSql(sql) {
    let index = 0;
    return sql.replace(/\?/g, () => {
        index++;
        return `$${index}`;
    });
}

const dbWrapper = {
    pool,
    query: (text, params) => pool.query(text, params),
    prepare: (sql) => {
        const pgSql = translateSql(sql);
        return {
            get: async (...params) => {
                const res = await pool.query(pgSql, params);
                return res.rows[0] || null;
            },
            all: async (...params) => {
                const res = await pool.query(pgSql, params);
                return res.rows;
            },
            run: async (...params) => {
                const res = await pool.query(pgSql, params);
                return {
                    changes: res.rowCount,
                    lastInsertRowid: res.rows && res.rows[0] && res.rows[0].id ? res.rows[0].id : null
                };
            }
        };
    }
};

module.exports = dbWrapper;
