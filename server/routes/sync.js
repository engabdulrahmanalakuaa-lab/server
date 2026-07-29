/**
 * ═══════════════════════════════════════════════════════════════════════
 * Sync Routes — رفع/سحب سجلات المزامنة
 * ═══════════════════════════════════════════════════════════════════════
 *
 * POST /api/sync/push
 *   Headers: Authorization: Bearer <token>
 *   Body:    { batch_id, records: [{ table_name, record_key, record_data, local_updated_at?, is_deleted? }, ...] }
 *   Returns: { success, batch_id, upserted, deleted, duration_ms }
 *
 * GET /api/sync/pull?since=<ISO>&table=<name>
 *   Headers: Authorization: Bearer <token>
 *   Returns: { success, records: [...], server_time }
 *
 * GET /api/sync/status
 *   Returns: { success, last_sync_at, total_syncs, tables: [...] }
 *
 * DELETE /api/sync/wipe   (خطير — لأغراض إعادة تعيين فقط)
 *   Headers: Authorization: Bearer <token> + X-Confirm: WIPE-<device_id>
 * ═══════════════════════════════════════════════════════════════════════
 */

'use strict';

const express = require('express');
const crypto = require('crypto');
const { query, transaction } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

/**
 * حساب SHA-256 لبيانات الصف
 */
function hashRecord(data) {
    return crypto.createHash('sha256')
        .update(JSON.stringify(data))
        .digest('hex');
}

/**
 * POST /api/sync/push — رفع مجموعة سجلات
 * كل رفع = batch واحد. نستخدم transaction لضمان الذرية.
 */
router.post('/push', requireAuth, async (req, res) => {
    const start = Date.now();
    try {
        const { device_id, company_id } = req.device;
        const body = req.body || {};
        const batchId = body.batch_id || crypto.randomUUID();
        const records = Array.isArray(body.records) ? body.records : [];

        if (records.length === 0) {
            return res.json({
                success: true,
                batch_id: batchId,
                upserted: 0,
                deleted: 0,
                duration_ms: Date.now() - start,
                note: 'لا سجلات للمزامنة'
            });
        }

        // حد أقصى 5000 سجل لكل رفعة (لحماية Neon Free)
        if (records.length > 5000) {
            return res.status(413).json({
                success: false,
                error: 'حد أقصى 5000 سجل لكل رفعة. قسّم الرفع.',
                received: records.length
            });
        }

        let upserted = 0, deleted = 0;
        const tablesTouched = new Set();
        let totalBytes = 0;

        await transaction(async (client) => {
            const upsertStmt = `
                INSERT INTO sync_records
                    (device_id, company_id, table_name, record_key, record_data,
                     record_hash, operation, local_updated_at, sync_batch_id, is_deleted)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                ON CONFLICT (company_id, table_name, record_key) DO UPDATE SET
                    record_data      = EXCLUDED.record_data,
                    record_hash      = EXCLUDED.record_hash,
                    operation        = EXCLUDED.operation,
                    local_updated_at = EXCLUDED.local_updated_at,
                    sync_batch_id    = EXCLUDED.sync_batch_id,
                    is_deleted       = EXCLUDED.is_deleted,
                    device_id        = EXCLUDED.device_id,
                    server_received_at = NOW()
            `;

            for (const rec of records) {
                if (!rec || typeof rec !== 'object') continue;
                const tableName = String(rec.table_name || '').trim();
                const recordKey = String(rec.record_key || '').trim();
                if (!tableName || !recordKey) continue;

                // validation: table_name يجب أن يكون snake_case فقط
                if (!/^[a-z][a-z0-9_]{0,63}$/.test(tableName)) {
                    continue; // نتخطى بدلاً من الرفض الكلي
                }

                const isDeleted = rec.is_deleted === true;
                const operation = isDeleted ? 'delete' : 'upsert';
                const recordData = rec.record_data || {};
                const recordHash = hashRecord(recordData);
                const localUpdatedAt = rec.local_updated_at || null;

                await client.query(upsertStmt, [
                    device_id,
                    company_id,
                    tableName,
                    recordKey,
                    JSON.stringify(recordData),
                    recordHash,
                    operation,
                    localUpdatedAt,
                    batchId,
                    isDeleted
                ]);

                if (isDeleted) deleted++; else upserted++;
                tablesTouched.add(tableName);
                totalBytes += JSON.stringify(recordData).length;
            }

            // تحديث معلومات الجهاز
            await client.query(`
                UPDATE devices
                SET last_seen_at = NOW(),
                    last_sync_at = NOW(),
                    total_syncs  = total_syncs + 1
                WHERE device_id = $1
            `, [device_id]);

            // سجل العملية
            await client.query(`
                INSERT INTO sync_log
                    (device_id, company_id, batch_id, operation_type,
                     tables_count, records_count, payload_bytes, duration_ms,
                     status, client_ip, user_agent)
                VALUES ($1, $2, $3, 'sync_push', $4, $5, $6, $7, 'success', $8, $9)
            `, [
                device_id, company_id, batchId,
                tablesTouched.size, records.length, totalBytes,
                Date.now() - start,
                req.ip || null,
                (req.headers['user-agent'] || '').slice(0, 200)
            ]);
        });

        return res.json({
            success: true,
            batch_id: batchId,
            upserted,
            deleted,
            tables_touched: Array.from(tablesTouched),
            duration_ms: Date.now() - start
        });
    } catch (err) {
        console.error('[sync/push] error:', err.message);
        // سجّل الفشل
        try {
            await query(`
                INSERT INTO sync_log
                    (device_id, company_id, batch_id, operation_type, status, error_message)
                VALUES ($1, $2, $3, 'sync_push', 'failed', $4)
            `, [
                req.device?.device_id || 'unknown',
                req.device?.company_id || 1,
                crypto.randomUUID(),
                err.message.slice(0, 500)
            ]);
        } catch (_) {}
        return res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * GET /api/sync/pull?since=<ISO>&table=<name>&limit=<n>
 * يسحب السجلات المُحدَّثة منذ وقت معين (للاستعادة عند إعادة التثبيت).
 */
router.get('/pull', requireAuth, async (req, res) => {
    try {
        const { company_id } = req.device;
        const since = req.query.since ? new Date(String(req.query.since)) : null;
        const tableFilter = req.query.table ? String(req.query.table) : null;
        const limit = Math.min(parseInt(req.query.limit) || 1000, 5000);

        const params = [company_id];
        let whereClause = 'company_id = $1';
        if (since && !isNaN(since.getTime())) {
            params.push(since.toISOString());
            whereClause += ' AND server_received_at > $' + params.length;
        }
        if (tableFilter && /^[a-z][a-z0-9_]{0,63}$/.test(tableFilter)) {
            params.push(tableFilter);
            whereClause += ' AND table_name = $' + params.length;
        }
        params.push(limit);

        const sql = `
            SELECT table_name, record_key, record_data, record_hash, operation,
                   local_updated_at, server_received_at, is_deleted
            FROM sync_records
            WHERE ${whereClause}
            ORDER BY server_received_at ASC
            LIMIT $${params.length}
        `;
        const r = await query(sql, params);

        return res.json({
            success: true,
            server_time: new Date().toISOString(),
            count: r.rows.length,
            records: r.rows
        });
    } catch (err) {
        console.error('[sync/pull] error:', err.message);
        return res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * GET /api/sync/status — إحصائيات الجهاز
 */
router.get('/status', requireAuth, async (req, res) => {
    try {
        const { device_id, company_id } = req.device;

        const deviceR = await query(`
            SELECT last_seen_at, last_sync_at, total_syncs
            FROM devices WHERE device_id = $1
        `, [device_id]);

        const tablesR = await query(`
            SELECT table_name,
                   COUNT(*) AS records_count,
                   MAX(server_received_at) AS last_sync,
                   SUM(CASE WHEN is_deleted THEN 1 ELSE 0 END) AS deleted_count
            FROM sync_records
            WHERE company_id = $1
            GROUP BY table_name
            ORDER BY table_name
        `, [company_id]);

        const totalR = await query(`
            SELECT COUNT(*) AS total_records,
                   pg_size_pretty(pg_total_relation_size('sync_records')) AS storage_size
            FROM sync_records
            WHERE company_id = $1
        `, [company_id]);

        return res.json({
            success: true,
            device: deviceR.rows[0] || null,
            total_records: parseInt(totalR.rows[0]?.total_records || 0),
            storage_size: totalR.rows[0]?.storage_size || '0 bytes',
            tables: tablesR.rows
        });
    } catch (err) {
        console.error('[sync/status] error:', err.message);
        return res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * DELETE /api/sync/wipe — إعادة تعيين كامل (خطير)
 * يتطلب Header: X-Confirm: WIPE-<device_id>
 */
router.delete('/wipe', requireAuth, async (req, res) => {
    try {
        const { device_id, company_id } = req.device;
        const confirm = req.headers['x-confirm'];
        if (confirm !== 'WIPE-' + device_id) {
            return res.status(400).json({
                success: false,
                error: 'X-Confirm header يجب أن يساوي WIPE-<device_id>'
            });
        }

        const r = await query(
            'DELETE FROM sync_records WHERE company_id = $1 RETURNING id',
            [company_id]
        );

        return res.json({
            success: true,
            deleted_count: r.rowCount,
            message: 'تم مسح جميع سجلات المزامنة لهذه الشركة'
        });
    } catch (err) {
        console.error('[sync/wipe] error:', err.message);
        return res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;
