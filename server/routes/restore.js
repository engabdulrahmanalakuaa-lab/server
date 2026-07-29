/**
 * ═══════════════════════════════════════════════════════════════════════
 * Restore Routes — الاستعادة الكاملة عند إعادة التثبيت
 * ═══════════════════════════════════════════════════════════════════════
 *
 * GET /api/restore/latest
 *   يُرجع أحدث نسخة احتياطية كاملة (payload_base64_gzip)
 *
 * GET /api/restore/all-records?table=<name>
 *   يُرجع كل سجلات المزامنة (بديل عن Snapshot) — أثقل لكنه دائماً محدَّث
 * ═══════════════════════════════════════════════════════════════════════
 */

'use strict';

const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

/**
 * GET /api/restore/latest
 * يُرجع أحدث backup منشور لهذه الشركة (مع الحمل الكامل base64).
 */
router.get('/latest', requireAuth, async (req, res) => {
    try {
        const { company_id } = req.device;
        const r = await query(`
            SELECT id, device_id, backup_type, tables_included, total_records,
                   size_bytes, compressed_bytes, checksum_sha256, payload_gzip,
                   app_version, notes, created_at
            FROM backups
            WHERE company_id = $1
            ORDER BY created_at DESC
            LIMIT 1
        `, [company_id]);

        if (r.rows.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'لا توجد نسخة احتياطية على السيرفر بعد'
            });
        }
        const bk = r.rows[0];
        return res.json({
            success: true,
            backup: {
                id: bk.id,
                device_id: bk.device_id,
                backup_type: bk.backup_type,
                tables_included: bk.tables_included,
                total_records: bk.total_records,
                size_bytes: bk.size_bytes,
                compressed_bytes: bk.compressed_bytes,
                checksum_sha256: bk.checksum_sha256,
                app_version: bk.app_version,
                notes: bk.notes,
                created_at: bk.created_at,
                payload_base64_gzip: bk.payload_gzip.toString('base64')
            }
        });
    } catch (err) {
        console.error('[restore/latest] error:', err.message);
        return res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * GET /api/restore/all-records
 * يبني نسخة احتياطية حية من جدول sync_records — يعطي كل السجلات في شكل تجميعي.
 * يُستخدم عندما لا توجد Snapshot متاحة، أو عند الحاجة لاستعادة أحدث حالة.
 *
 * Response:
 *   {
 *     success: true,
 *     server_time: '...',
 *     total_records: N,
 *     tables: { table1: [row1, row2, ...], table2: [...] }
 *   }
 */
router.get('/all-records', requireAuth, async (req, res) => {
    try {
        const { company_id } = req.device;
        const tableFilter = req.query.table ? String(req.query.table) : null;

        const params = [company_id];
        let whereClause = 'company_id = $1 AND is_deleted = FALSE';
        if (tableFilter && /^[a-z][a-z0-9_]{0,63}$/.test(tableFilter)) {
            params.push(tableFilter);
            whereClause += ' AND table_name = $' + params.length;
        }

        const r = await query(`
            SELECT table_name, record_key, record_data, local_updated_at, server_received_at
            FROM sync_records
            WHERE ${whereClause}
            ORDER BY table_name, record_key
        `, params);

        // جمّع حسب الجدول
        const tables = {};
        for (const row of r.rows) {
            if (!tables[row.table_name]) tables[row.table_name] = [];
            tables[row.table_name].push({
                key: row.record_key,
                data: row.record_data,
                local_updated_at: row.local_updated_at,
                server_received_at: row.server_received_at
            });
        }

        return res.json({
            success: true,
            server_time: new Date().toISOString(),
            total_records: r.rows.length,
            tables_count: Object.keys(tables).length,
            tables
        });
    } catch (err) {
        console.error('[restore/all-records] error:', err.message);
        return res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;
