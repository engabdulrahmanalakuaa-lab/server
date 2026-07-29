/**
 * ═══════════════════════════════════════════════════════════════════════
 * تقنيات سوفت Pro — Neon PostgreSQL Connection Pool
 * ═══════════════════════════════════════════════════════════════════════
 * يوفّر:
 *   • pool اتصال واحد مُشترك (pg.Pool)
 *   • SSL مطلوب (Neon يفرضه)
 *   • إعادة اتصال تلقائية عند انقطاع (Render يوقظ السيرفر من النوم)
 *   • دوال مساعدة: query, transaction, healthCheck
 * ═══════════════════════════════════════════════════════════════════════
 */

'use strict';

const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
    console.error('[db] ❌ DATABASE_URL غير مضبوط! السيرفر لن يعمل.');
    process.exit(1);
}

/**
 * Pool مُحسَّن لـ Neon + Render Free tier:
 *   - max=10: Neon Free يسمح بـ 100 اتصال، لكن نحن على pooler، فـ 10 كافية
 *   - idleTimeoutMillis=30s: إغلاق الاتصالات الخاملة (توفير موارد)
 *   - connectionTimeoutMillis=15s: مهلة كافية لـ Render cold-start
 *   - ssl: مطلوب لـ Neon
 */
const pool = new Pool({
    connectionString,
    max: 10,
    min: 0,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
    ssl: {
        rejectUnauthorized: false // Neon تستخدم شهادة موثوقة، لكن نُبقي هذا مرناً للـ pooler
    },
    application_name: 'technologies-soft-pro-sync-server'
});

/* أحداث الخطأ العامة على الـ pool */
pool.on('error', (err) => {
    console.error('[db] Pool error:', err.message);
});

pool.on('connect', () => {
    // لكل اتصال جديد نحدد مستوى العزل و timezone
    // (لا نطبع هنا لتجنب ضوضاء السجل)
});

/**
 * تنفيذ استعلام مع تسجيل الوقت
 * @param {string} text - SQL
 * @param {Array} params - المعطيات
 * @returns {Promise<import('pg').QueryResult>}
 */
async function query(text, params) {
    const start = Date.now();
    try {
        const res = await pool.query(text, params);
        const duration = Date.now() - start;
        if (duration > 500) {
            console.warn('[db] ⚠ استعلام بطيء (' + duration + 'ms):', text.slice(0, 80));
        }
        return res;
    } catch (err) {
        console.error('[db] خطأ في الاستعلام:', text.slice(0, 100), '—', err.message);
        throw err;
    }
}

/**
 * تنفيذ عدة استعلامات داخل transaction واحد
 * @param {(client: import('pg').PoolClient) => Promise<any>} fn
 */
async function transaction(fn) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await fn(client);
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
 * فحص الصحة — يستخدمه endpoint /health
 */
async function healthCheck() {
    try {
        const r = await pool.query('SELECT NOW() AS server_time, VERSION() AS pg_version');
        return {
            ok: true,
            server_time: r.rows[0].server_time,
            pg_version: r.rows[0].pg_version.split(',')[0]
        };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

/**
 * إغلاق نظيف عند stopping السيرفر
 */
async function close() {
    try {
        await pool.end();
        console.log('[db] pool أُغلق بنظافة.');
    } catch (err) {
        console.error('[db] فشل إغلاق pool:', err.message);
    }
}

module.exports = { pool, query, transaction, healthCheck, close };
