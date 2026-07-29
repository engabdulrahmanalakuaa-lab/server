/**
 * اختبار سريع للاتصال بـ Neon PostgreSQL
 * الاستخدام: npm test
 */

'use strict';

require('dotenv').config();

(async () => {
    try {
        console.log('[test] بدء اختبار الاتصال...');
        console.log('[test] DATABASE_URL: ' + (process.env.DATABASE_URL || '').replace(/:[^:@]+@/, ':***@'));

        const { healthCheck, close } = require('./db');
        const hc = await healthCheck();

        if (hc.ok) {
            console.log('[test] ✅ الاتصال ناجح');
            console.log('[test]    Server time: ' + hc.server_time);
            console.log('[test]    PG Version:  ' + hc.pg_version);
        } else {
            console.log('[test] ❌ فشل الاتصال: ' + hc.error);
            process.exit(1);
        }

        // فحص الجداول
        const { query } = require('./db');
        const r = await query(`
            SELECT table_name FROM information_schema.tables
            WHERE table_schema = 'public' ORDER BY table_name
        `);
        console.log('[test] الجداول (' + r.rows.length + '): ' + r.rows.map(x => x.table_name).join(', '));

        await close();
        process.exit(0);
    } catch (err) {
        console.error('[test] ❌ خطأ:', err.message);
        process.exit(1);
    }
})();
