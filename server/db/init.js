/**
 * تهيئة قاعدة بيانات Neon — يُشغَّل عند بدء السيرفر
 * (وأيضاً يمكن استدعاؤه يدوياً: npm run init-db)
 */

'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { pool } = require('./index');

const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

async function initDatabase(silent = false) {
    if (!silent) console.log('[db-init] بدء تهيئة قاعدة البيانات...');
    const schemaSql = fs.readFileSync(SCHEMA_PATH, 'utf8');
    const client = await pool.connect();
    try {
        await client.query(schemaSql);
        if (!silent) console.log('[db-init] ✅ تم إنشاء/تحديث جميع الجداول والفهارس.');

        // فحص الجداول الموجودة
        const r = await client.query(`
            SELECT table_name FROM information_schema.tables
            WHERE table_schema = 'public'
            ORDER BY table_name
        `);
        if (!silent) {
            console.log('[db-init] الجداول الموجودة (' + r.rows.length + '):');
            for (const row of r.rows) console.log('  • ' + row.table_name);
        }
        return { success: true, tables: r.rows.map(r => r.table_name) };
    } catch (err) {
        console.error('[db-init] ❌ فشل تهيئة قاعدة البيانات:', err.message);
        throw err;
    } finally {
        client.release();
    }
}

if (require.main === module) {
    // مشغّل مستقل
    initDatabase()
        .then(() => process.exit(0))
        .catch(err => { console.error(err); process.exit(1); });
}

module.exports = { initDatabase };
