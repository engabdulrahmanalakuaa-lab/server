'use strict';
/**
 * ═══════════════════════════════════════════════════════════════════════
 * قاعدة البيانات - PostgreSQL / Neon
 * ═══════════════════════════════════════════════════════════════════════
 * يستخدم pg.Pool مع SSL. متغيّر DATABASE_URL يجب أن يكون مضبوطاً
 * على Render → Environment، وإلا يستخدم .env المحلي.
 * ═══════════════════════════════════════════════════════════════════════
 */
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

if (!process.env.DATABASE_URL) {
    console.warn('[db] ⚠️  DATABASE_URL غير مضبوط — الاتصال سيفشل');
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    ssl: { rejectUnauthorized: false } // Neon pooler
});

pool.on('error', (err) => {
    console.error('[db] Unexpected pool error:', err.message);
});

/**
 * تنفيذ استعلام
 */
async function query(text, params) {
    return pool.query(text, params);
}

/**
 * معاملة مع callback يستقبل client
 */
async function transaction(callback) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await callback(client);
        await client.query('COMMIT');
        return result;
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        throw err;
    } finally {
        client.release();
    }
}

/**
 * تطبيق الـ schema (idempotent + tolerant لصلاحيات)
 *
 * ملاحظة: إذا كانت الجداول موجودة أصلاً ومملوكة لـ role آخر (مثل neondb_owner)،
 * فأن CREATE TABLE IF NOT EXISTS ستفشل بخطأ 'must be owner' على PostgreSQL.
 * في هذه الحالة نتحقق فقط أن الجداول موجودة ونستمر — لأن CREATE INDEX IF NOT EXISTS
 * أيضاً تحتاج ملكية. الحل: نتحقق من وجود كل جدول ونتجاهل خطأ الصلاحية.
 */
async function initSchema() {
    const REQUIRED_TABLES = ['ts_clients', 'ts_activation_keys', 'ts_licenses', 'ts_license_events', 'ts_admin_users', 'ts_stats_cache'];

    // 1) هل الجداول موجودة أصلاً؟
    const existing = await pool.query(
        `SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename = ANY($1::text[])`,
        [REQUIRED_TABLES]
    );
    const existingNames = new Set(existing.rows.map(r => r.tablename));
    const missing = REQUIRED_TABLES.filter(t => !existingNames.has(t));

    if (missing.length === 0) {
        console.log('[db] ✅ all required tables already exist on Neon');
        return;
    }

    // 2) هناك جداول ناقصة — نحاول تطبيق الـ schema
    const schemaPath = path.join(__dirname, 'schema.sql');
    const sql = fs.readFileSync(schemaPath, 'utf8');
    try {
        await pool.query(sql);
        console.log('[db] ✅ schema applied on Neon PostgreSQL');
    } catch (err) {
        // إذا كان الخطأ بسبب صلاحيات (owner)، نتحقق أن الجداول ما زالت موجودة
        if (err.code === '42501') {
            const recheck = await pool.query(
                `SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename = ANY($1::text[])`,
                [REQUIRED_TABLES]
            );
            const foundNames = new Set(recheck.rows.map(r => r.tablename));
            const stillMissing = REQUIRED_TABLES.filter(t => !foundNames.has(t));
            if (stillMissing.length === 0) {
                console.warn('[db] ⚠️  schema.sql skipped (permission denied), but all tables exist — continuing');
                return;
            }
            console.error('[db] ❌ permission denied AND missing tables:', stillMissing.join(', '));
            console.error('[db] ❌ Please use a DATABASE_URL with owner privileges (neondb_owner)');
        }
        throw err;
    }
}

/**
 * فحص الصحة
 */
async function healthCheck() {
    try {
        const r = await pool.query('SELECT version() as version, NOW() as now');
        return { ok: true, version: r.rows[0].version, now: r.rows[0].now };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

/**
 * إغلاق البركة
 */
async function close() {
    await pool.end();
}

module.exports = { pool, query, transaction, initSchema, healthCheck, close };
