'use strict';
/**
 * ═══════════════════════════════════════════════════════════════════════
 * تقنيات سوفت Pro — Cloud Backup & Device API (v6.9.3)
 * ═══════════════════════════════════════════════════════════════════════
 * نقاط النهاية المخصّصة لعميل النسخ الاحتياطي السحابي (lib/cloud-sync.js):
 *
 *   GET  /ping                 - إيقاظ الخادم (Render cold-start) + فحص حياة
 *   POST /api/auth/register    - تسجيل جهاز جديد وإصدار JWT جهاز (device token)
 *   POST /api/auth/refresh     - تجديد JWT الجهاز
 *   POST /api/backup/upload    - رفع نسخة احتياطية كاملة (تُحذف السابقة تلقائياً)
 *   GET  /api/restore/latest   - جلب آخر نسخة احتياطية للجهاز
 *
 * المصادقة:
 *   - /api/auth/register يستخدم X-API-Key (مشترك، يطابق API_KEY على السيرفر)
 *   - بقية النقاط تستخدم Authorization: Bearer <device-jwt>
 *
 * التخزين: Neon PostgreSQL — جدول ts_device_backups (نسخة واحدة فقط لكل جهاز).
 * ═══════════════════════════════════════════════════════════════════════
 */
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { query } = require('../db');
const { signJwt, verifyJwt } = require('../lib/jwt');
const { safeString } = require('../lib/utils');

/* ───────────────────────────── الأسرار والإعدادات ───────────────────────────── */

// سرّ توقيع JWT — نفس سرّ التراخيص (إلزامي عبر البيئة، fail-fast مطبّق في api.js أصلاً)
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || String(JWT_SECRET).trim().length < 16) {
    console.error('[FATAL] JWT_SECRET غير مضبوط (backup routes). توقف الخادم.');
    process.exit(1);
}

// API Key المشترك مع العميل — يجب أن يطابق DEFAULTS.apiKey في lib/cloud-sync.js
// القيمة الافتراضية تطابق العميل حتى يعمل دون إعداد إضافي، لكن يُنصح بتغييرها عبر البيئة.
const API_KEY = process.env.API_KEY || 'technologies_soft_pro_default_api_key_change_me_before_deploy';

// مدة صلاحية توكن الجهاز (30 يوماً — يُجدّد تلقائياً من العميل قبل 3 أيام)
const DEVICE_TOKEN_TTL_SEC = 30 * 24 * 60 * 60;

// حدّ حجم النسخة الاحتياطية المضغوطة (Base64) — 40 ميجابايت
const MAX_BACKUP_BASE64_LEN = 40 * 1024 * 1024;

/* ───────────────────────────── تهيئة الجدول (idempotent) ───────────────────────────── */
let _schemaReady = false;
async function ensureBackupSchema() {
    if (_schemaReady) return;
    // نسخة احتياطية واحدة فقط لكل جهاز → device_id فريد (UNIQUE) مع UPSERT
    await query(`
        CREATE TABLE IF NOT EXISTS ts_device_backups (
            id                  BIGSERIAL PRIMARY KEY,
            device_id           TEXT NOT NULL UNIQUE,
            device_name         TEXT,
            license_id          INTEGER,
            app_version         TEXT,
            backup_type         TEXT,
            tables_included     JSONB,
            total_records       INTEGER,
            size_bytes          INTEGER,
            compressed_bytes    INTEGER,
            payload_base64_gzip TEXT NOT NULL,
            notes               TEXT,
            created_at          TIMESTAMPTZ DEFAULT NOW(),
            updated_at          TIMESTAMPTZ DEFAULT NOW()
        )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_ts_dev_backups_device ON ts_device_backups(device_id)`);
    _schemaReady = true;
}

/* ───────────────────────────── أدوات مساعدة ───────────────────────────── */

function toIso(v) {
    if (!v) return null;
    if (v instanceof Date) return v.toISOString();
    return String(v);
}

// مصادقة X-API-Key (للتسجيل فقط)
function requireApiKey(req, res, next) {
    const provided = req.headers['x-api-key'] || req.headers['X-API-Key'] || '';
    const a = Buffer.from(String(provided), 'utf8');
    const b = Buffer.from(String(API_KEY), 'utf8');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return res.status(401).json({ success: false, error: 'invalid_api_key' });
    }
    next();
}

// مصادقة توكن الجهاز (Bearer) — يضع req.device = { device_id, ... }
function requireDeviceToken(req, res, next) {
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ')) {
        return res.status(401).json({ success: false, error: 'missing_token' });
    }
    const token = auth.substring(7).trim();
    const v = verifyJwt(token, JWT_SECRET);
    if (!v.valid) {
        return res.status(401).json({ success: false, error: 'invalid_token', reason: v.error });
    }
    // توكن الجهاز يجب أن يحمل نوع 'device' و device_id
    if (!v.payload || v.payload.typ !== 'device' || !v.payload.device_id) {
        return res.status(401).json({ success: false, error: 'not_device_token' });
    }
    // تحقق من انتهاء الصلاحية
    if (v.payload.exp && v.payload.exp * 1000 < Date.now()) {
        return res.status(401).json({ success: false, error: 'token_expired' });
    }
    req.device = v.payload;
    next();
}

function issueDeviceToken(deviceId, deviceName, licenseId) {
    const nowSec = Math.floor(Date.now() / 1000);
    return signJwt({
        typ: 'device',
        device_id: String(deviceId),
        device_name: deviceName || null,
        license_id: licenseId || null,
        iat: nowSec,
        exp: nowSec + DEVICE_TOKEN_TTL_SEC
    }, JWT_SECRET);
}

/* ═══════════════════════════════════════════════════════════════════════
   GET /ping — إيقاظ + فحص حياة (يُستدعى من startAutoSync في العميل)
   يُركَّب على الجذر (خارج /api) في index.js.
   ═══════════════════════════════════════════════════════════════════════ */
function pingHandler(req, res) {
    res.json({ ok: true, pong: true, server_time: new Date().toISOString() });
}

/* ═══════════════════════════════════════════════════════════════════════
   POST /api/auth/register — تسجيل جهاز وإصدار توكن
   Body: { device_id, device_name, company_id?, meta? }
   Header: X-API-Key
   Response: { success:true, token }
   ═══════════════════════════════════════════════════════════════════════ */
router.post('/auth/register', requireApiKey, async (req, res) => {
    try {
        const body = req.body || {};
        const deviceId = safeString(body.device_id, 128);
        const deviceName = safeString(body.device_name, 200) || null;
        if (!deviceId) {
            return res.status(400).json({ success: false, error: 'missing_device_id' });
        }
        // نصدر توكن جهاز مباشرة — لا حاجة لجدول أجهزة منفصل؛
        // الجهاز يُعرَّف ضمنياً عند أول رفع نسخة احتياطية (ts_device_backups.device_id).
        const token = issueDeviceToken(deviceId, deviceName, null);
        return res.json({ success: true, token, device_id: deviceId });
    } catch (e) {
        console.error('[auth/register]', e);
        return res.status(500).json({ success: false, error: 'internal_error', message: e.message });
    }
});

/* ═══════════════════════════════════════════════════════════════════════
   POST /api/auth/refresh — تجديد توكن الجهاز
   Header: Authorization: Bearer <old-token>
   Response: { success:true, token }
   ═══════════════════════════════════════════════════════════════════════ */
router.post('/auth/refresh', requireDeviceToken, async (req, res) => {
    try {
        const d = req.device;
        const token = issueDeviceToken(d.device_id, d.device_name, d.license_id);
        return res.json({ success: true, token, device_id: d.device_id });
    } catch (e) {
        console.error('[auth/refresh]', e);
        return res.status(500).json({ success: false, error: 'internal_error', message: e.message });
    }
});

/* ═══════════════════════════════════════════════════════════════════════
   POST /api/backup/upload — رفع نسخة احتياطية كاملة
   Header: Authorization: Bearer <device-token>
   Body: { app_version, backup_type, tables_included[], notes, payload_base64_gzip }
   السلوك: UPSERT على device_id → النسخة الجديدة تحلّ محلّ السابقة
            (أي أن السابقة تُحذف فعلياً — نسخة واحدة فقط لكل جهاز).
   Response: { success:true, backup_id, created_at }
   ═══════════════════════════════════════════════════════════════════════ */
router.post('/backup/upload', requireDeviceToken, async (req, res) => {
    try {
        await ensureBackupSchema();
        const body = req.body || {};
        const payload = body.payload_base64_gzip;
        if (!payload || typeof payload !== 'string') {
            return res.status(400).json({ success: false, error: 'missing_payload' });
        }
        if (payload.length > MAX_BACKUP_BASE64_LEN) {
            return res.status(413).json({ success: false, error: 'payload_too_large',
                max_bytes: MAX_BACKUP_BASE64_LEN });
        }

        const deviceId = String(req.device.device_id);
        const deviceName = req.device.device_name || null;
        const licenseId = req.device.license_id || null;
        const appVersion = safeString(body.app_version, 40) || null;
        const backupType = safeString(body.backup_type, 40) || 'full';
        const notes = safeString(body.notes, 500) || null;
        const tablesIncluded = Array.isArray(body.tables_included) ? body.tables_included : [];
        const totalRecords = Number.isFinite(body.total_records) ? body.total_records : null;
        const sizeBytes = Number.isFinite(body.size_bytes) ? body.size_bytes : null;
        const compressedBytes = Buffer.byteLength(payload, 'utf8');

        // UPSERT — النسخة الجديدة تستبدل القديمة تماماً (delete-previous-after-upload)
        const r = await query(`
            INSERT INTO ts_device_backups
                (device_id, device_name, license_id, app_version, backup_type,
                 tables_included, total_records, size_bytes, compressed_bytes,
                 payload_base64_gzip, notes, created_at, updated_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, NOW(), NOW())
            ON CONFLICT (device_id) DO UPDATE SET
                device_name         = EXCLUDED.device_name,
                license_id          = EXCLUDED.license_id,
                app_version         = EXCLUDED.app_version,
                backup_type         = EXCLUDED.backup_type,
                tables_included     = EXCLUDED.tables_included,
                total_records       = EXCLUDED.total_records,
                size_bytes          = EXCLUDED.size_bytes,
                compressed_bytes    = EXCLUDED.compressed_bytes,
                payload_base64_gzip = EXCLUDED.payload_base64_gzip,
                notes               = EXCLUDED.notes,
                created_at          = NOW(),
                updated_at          = NOW()
            RETURNING id, created_at
        `, [
            deviceId, deviceName, licenseId, appVersion, backupType,
            JSON.stringify(tablesIncluded), totalRecords, sizeBytes, compressedBytes,
            payload, notes
        ]);

        const row = r.rows[0];
        return res.json({
            success: true,
            backup_id: row.id,
            created_at: toIso(row.created_at),
            compressed_bytes: compressedBytes
        });
    } catch (e) {
        console.error('[backup/upload]', e);
        return res.status(500).json({ success: false, error: 'internal_error', message: e.message });
    }
});

/* ═══════════════════════════════════════════════════════════════════════
   GET /api/restore/latest — جلب آخر نسخة احتياطية للجهاز
   Header: Authorization: Bearer <device-token>
   Response: { success:true, backup: { id, created_at, total_records,
               tables_included, payload_base64_gzip } }  أو 404
   ═══════════════════════════════════════════════════════════════════════ */
router.get('/restore/latest', requireDeviceToken, async (req, res) => {
    try {
        await ensureBackupSchema();
        const deviceId = String(req.device.device_id);
        const r = await query(`
            SELECT id, device_name, app_version, backup_type, tables_included,
                   total_records, size_bytes, compressed_bytes,
                   payload_base64_gzip, notes, created_at
            FROM ts_device_backups
            WHERE device_id = $1
            ORDER BY created_at DESC
            LIMIT 1
        `, [deviceId]);

        const b = r.rows[0];
        if (!b) {
            return res.status(404).json({ success: false, error: 'no_backup_found' });
        }
        return res.json({
            success: true,
            backup: {
                id: b.id,
                created_at: toIso(b.created_at),
                app_version: b.app_version,
                backup_type: b.backup_type,
                tables_included: b.tables_included || [],
                total_records: b.total_records,
                size_bytes: b.size_bytes,
                compressed_bytes: b.compressed_bytes,
                notes: b.notes,
                payload_base64_gzip: b.payload_base64_gzip
            }
        });
    } catch (e) {
        console.error('[restore/latest]', e);
        return res.status(500).json({ success: false, error: 'internal_error', message: e.message });
    }
});

module.exports = { router, pingHandler, ensureBackupSchema };
