/**
 * ═══════════════════════════════════════════════════════════════════════
 * Backup Routes — النسخ الاحتياطية الكاملة (Snapshots)
 * ═══════════════════════════════════════════════════════════════════════
 *
 * POST /api/backup/upload
 *   Body: { app_version?, tables_included?, notes?, payload_base64_gzip }
 *   يستقبل نسخة احتياطية كاملة مضغوطة (gzip)
 *
 * GET /api/backup/list
 *   يُرجع قائمة النسخ الاحتياطية (بدون الحمل)
 *
 * GET /api/backup/:id/download
 *   يُنزّل نسخة احتياطية محددة (base64 gzip)
 *
 * DELETE /api/backup/:id
 *   يحذف نسخة احتياطية
 *
 * DELETE /api/backup/prune?keep=10
 *   يحذف النسخ القديمة ويحتفظ بأحدث N نسخة
 * ═══════════════════════════════════════════════════════════════════════
 */

'use strict';

const express = require('express');
const crypto = require('crypto');
const zlib = require('zlib');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

/**
 * POST /api/backup/upload
 * body.payload_base64_gzip = base64(gzip(JSON.stringify(fullBackup)))
 */
router.post('/upload', requireAuth, async (req, res) => {
    try {
        const { device_id, company_id } = req.device;
        const {
            app_version,
            tables_included,
            notes,
            payload_base64_gzip,
            backup_type
        } = req.body || {};

        if (!payload_base64_gzip || typeof payload_base64_gzip !== 'string') {
            return res.status(400).json({
                success: false,
                error: 'payload_base64_gzip مطلوب'
            });
        }

        // تحويل base64 إلى Buffer
        const payloadBuffer = Buffer.from(payload_base64_gzip, 'base64');
        const compressedSize = payloadBuffer.length;

        // نتحقق من الحمل: نحسب حجمه الأصلي بعد فك الضغط + عدد السجلات
        let originalSize = 0;
        let totalRecords = 0;
        try {
            const decompressed = zlib.gunzipSync(payloadBuffer);
            originalSize = decompressed.length;
            const parsed = JSON.parse(decompressed.toString('utf8'));
            if (parsed && typeof parsed === 'object') {
                for (const tbl of Object.keys(parsed)) {
                    if (Array.isArray(parsed[tbl])) totalRecords += parsed[tbl].length;
                }
            }
        } catch (err) {
            return res.status(400).json({
                success: false,
                error: 'الحمل ليس gzip صالحاً أو JSON صالحاً: ' + err.message
            });
        }

        const checksum = crypto.createHash('sha256').update(payloadBuffer).digest('hex');

        const r = await query(`
            INSERT INTO backups
                (device_id, company_id, backup_type, tables_included, total_records,
                 size_bytes, compressed_bytes, checksum_sha256, payload_gzip,
                 app_version, notes)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            RETURNING id, created_at
        `, [
            device_id,
            company_id,
            backup_type || 'full',
            Array.isArray(tables_included) ? tables_included : null,
            totalRecords,
            originalSize,
            compressedSize,
            checksum,
            payloadBuffer,
            app_version || null,
            notes || null
        ]);

        return res.json({
            success: true,
            backup_id: r.rows[0].id,
            created_at: r.rows[0].created_at,
            total_records: totalRecords,
            size_bytes: originalSize,
            compressed_bytes: compressedSize,
            compression_ratio: originalSize > 0 ? (compressedSize / originalSize).toFixed(3) : null,
            checksum_sha256: checksum
        });
    } catch (err) {
        console.error('[backup/upload] error:', err.message);
        return res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * GET /api/backup/list
 */
router.get('/list', requireAuth, async (req, res) => {
    try {
        const { company_id } = req.device;
        const limit = Math.min(parseInt(req.query.limit) || 50, 200);

        const r = await query(`
            SELECT id, device_id, backup_type, tables_included, total_records,
                   size_bytes, compressed_bytes, checksum_sha256,
                   app_version, notes, created_at
            FROM backups
            WHERE company_id = $1
            ORDER BY created_at DESC
            LIMIT $2
        `, [company_id, limit]);

        return res.json({
            success: true,
            count: r.rows.length,
            backups: r.rows
        });
    } catch (err) {
        console.error('[backup/list] error:', err.message);
        return res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * GET /api/backup/:id/download
 * يُرجع payload_base64_gzip للنسخة المحددة
 */
router.get('/:id/download', requireAuth, async (req, res) => {
    try {
        const { company_id } = req.device;
        const id = parseInt(req.params.id);
        if (!Number.isInteger(id) || id <= 0) {
            return res.status(400).json({ success: false, error: 'id غير صالح' });
        }

        const r = await query(`
            SELECT id, device_id, backup_type, tables_included, total_records,
                   size_bytes, compressed_bytes, checksum_sha256, payload_gzip,
                   app_version, notes, created_at
            FROM backups
            WHERE id = $1 AND company_id = $2
        `, [id, company_id]);

        if (r.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'النسخة غير موجودة' });
        }
        const bk = r.rows[0];
        const payloadBase64 = bk.payload_gzip.toString('base64');

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
                payload_base64_gzip: payloadBase64
            }
        });
    } catch (err) {
        console.error('[backup/download] error:', err.message);
        return res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * DELETE /api/backup/:id
 */
router.delete('/:id', requireAuth, async (req, res) => {
    try {
        const { company_id } = req.device;
        const id = parseInt(req.params.id);
        if (!Number.isInteger(id) || id <= 0) {
            return res.status(400).json({ success: false, error: 'id غير صالح' });
        }

        const r = await query(
            'DELETE FROM backups WHERE id = $1 AND company_id = $2 RETURNING id',
            [id, company_id]
        );
        if (r.rowCount === 0) {
            return res.status(404).json({ success: false, error: 'النسخة غير موجودة' });
        }
        return res.json({ success: true, deleted_id: id });
    } catch (err) {
        console.error('[backup/delete] error:', err.message);
        return res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * DELETE /api/backup/prune?keep=10
 * يحذف النسخ القديمة ويُبقي أحدث N نسخة (حماية مساحة Neon)
 */
router.delete('/prune/old', requireAuth, async (req, res) => {
    try {
        const { company_id } = req.device;
        const keep = Math.max(1, Math.min(parseInt(req.query.keep) || 10, 100));

        const r = await query(`
            DELETE FROM backups
            WHERE company_id = $1
              AND id NOT IN (
                  SELECT id FROM backups
                  WHERE company_id = $1
                  ORDER BY created_at DESC
                  LIMIT $2
              )
            RETURNING id
        `, [company_id, keep]);

        return res.json({
            success: true,
            deleted_count: r.rowCount,
            kept: keep
        });
    } catch (err) {
        console.error('[backup/prune] error:', err.message);
        return res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;
