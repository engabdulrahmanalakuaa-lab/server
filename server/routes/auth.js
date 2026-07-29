/**
 * ═══════════════════════════════════════════════════════════════════════
 * Auth Routes — تسجيل الأجهزة وإصدار JWT
 * ═══════════════════════════════════════════════════════════════════════
 *
 * POST /api/auth/register
 *   Headers: X-API-Key: <shared_api_key>
 *   Body:    { device_id, device_name?, company_id?, meta? }
 *   Returns: { success, token, device: {...} }
 *
 * POST /api/auth/refresh
 *   Headers: Authorization: Bearer <old_token>
 *   Returns: { success, token }
 *
 * GET /api/auth/me
 *   Headers: Authorization: Bearer <token>
 *   Returns: { success, device: {...} }
 * ═══════════════════════════════════════════════════════════════════════
 */

'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const { query } = require('../db');
const { signDeviceToken, requireApiKey, requireAuth, API_KEY } = require('../middleware/auth');

const router = express.Router();

/**
 * POST /api/auth/register
 * يسجّل جهازاً جديداً أو يُحدّث الموجود ويُرجع JWT له.
 */
router.post('/register', requireApiKey, async (req, res) => {
    try {
        const { device_id, device_name, company_id, meta } = req.body || {};

        if (!device_id || typeof device_id !== 'string' || device_id.length < 8) {
            return res.status(400).json({ success: false, error: 'device_id مطلوب (≥ 8 حرف)' });
        }

        const companyId = Number.isInteger(company_id) ? company_id : 1;
        const apiKeyHash = await bcrypt.hash(API_KEY, 10);

        // UPSERT
        const result = await query(`
            INSERT INTO devices (device_id, device_name, company_id, api_key_hash, meta, last_seen_at)
            VALUES ($1, $2, $3, $4, $5, NOW())
            ON CONFLICT (device_id) DO UPDATE SET
                device_name    = EXCLUDED.device_name,
                company_id     = EXCLUDED.company_id,
                meta           = EXCLUDED.meta,
                last_seen_at   = NOW(),
                is_active      = TRUE,
                updated_at     = NOW()
            RETURNING id, device_id, device_name, company_id, created_at, last_seen_at
        `, [device_id, device_name || null, companyId, apiKeyHash, meta || {}]);

        const device = result.rows[0];
        const token = signDeviceToken({
            device_id: device.device_id,
            company_id: device.company_id,
            iat_source: 'register'
        });

        return res.json({
            success: true,
            token,
            device
        });
    } catch (err) {
        console.error('[auth/register] error:', err.message);
        return res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * POST /api/auth/refresh
 * يُصدر رمزاً جديداً للجهاز الحالي (تجديد الجلسة).
 */
router.post('/refresh', requireAuth, async (req, res) => {
    try {
        const { device_id, company_id } = req.device;
        // نتأكد أن الجهاز لا يزال active
        const r = await query(
            'SELECT is_active FROM devices WHERE device_id = $1',
            [device_id]
        );
        if (r.rows.length === 0 || !r.rows[0].is_active) {
            return res.status(403).json({ success: false, error: 'الجهاز غير نشط أو محذوف' });
        }

        // تحديث last_seen
        await query(
            'UPDATE devices SET last_seen_at = NOW() WHERE device_id = $1',
            [device_id]
        );

        const token = signDeviceToken({
            device_id,
            company_id,
            iat_source: 'refresh'
        });
        return res.json({ success: true, token });
    } catch (err) {
        console.error('[auth/refresh] error:', err.message);
        return res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * GET /api/auth/me
 * معلومات الجهاز الحالي.
 */
router.get('/me', requireAuth, async (req, res) => {
    try {
        const { device_id } = req.device;
        const r = await query(`
            SELECT id, device_id, device_name, company_id, last_seen_at, last_sync_at,
                   total_syncs, is_active, meta, created_at, updated_at
            FROM devices
            WHERE device_id = $1
        `, [device_id]);

        if (r.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'الجهاز غير موجود' });
        }
        return res.json({ success: true, device: r.rows[0] });
    } catch (err) {
        console.error('[auth/me] error:', err.message);
        return res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;
