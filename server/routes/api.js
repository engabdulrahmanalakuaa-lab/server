'use strict';
/**
 * ═══════════════════════════════════════════════════════════════════════
 * API Endpoints لعملاء الديسكتوب (PostgreSQL / Neon)
 * ═══════════════════════════════════════════════════════════════════════
 *  POST /api/activate    - تفعيل جديد
 *  POST /api/heartbeat   - تحديث دوري
 *  POST /api/verify-key  - تحقق عام (للواجهة الويب)
 *  GET  /api/health      - فحص الحالة
 * ═══════════════════════════════════════════════════════════════════════
 */
const express = require('express');
const router = express.Router();
const { query, transaction } = require('../db');
const { signJwt, verifyJwt } = require('../lib/jwt');
const { computeExpiryDate, safeString } = require('../lib/utils');

const JWT_SECRET = process.env.JWT_SECRET || 'ts-pro-v5.7.0-shared-secret-2025-abdulrahman-al-akwa';

// Helper: تسجيل حدث
async function logEvent(licenseId, eventType, req, details) {
    try {
        await query(`
            INSERT INTO ts_license_events (license_id, event_type, machine_id, fingerprint, ip_address, user_agent, details)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [
            licenseId || null,
            String(eventType),
            safeString(details && details.machine_id, 128) || null,
            safeString(details && details.fingerprint, 128) || null,
            safeString(req.ip || req.headers['x-forwarded-for'] || '', 64) || null,
            safeString(req.headers['user-agent'] || '', 256) || null,
            details ? JSON.stringify(details).substring(0, 1000) : null
        ]);
    } catch (e) {
        console.error('[logEvent]', e.message);
    }
}

function buildPayload(key, license) {
    return {
        v: '5.7.0',
        client_id: license.client_id || null,
        client_name: license.client_name || null,
        client_phone: license.client_phone || null,
        client_email: license.client_email || null,
        machine_id: license.machine_id,
        business_type: license.business_type || key.business_type,
        invoice_template: license.invoice_template || key.invoice_template,
        issued_at: toIso(license.issued_at),
        expires_at: toIso(license.expires_at),
        duration_days: license.duration_days,
        license_id: license.id,
        server_time: new Date().toISOString()
    };
}

// helper — التأكد أن التاريخ يعود ISO string
function toIso(v) {
    if (!v) return null;
    if (v instanceof Date) return v.toISOString();
    return String(v);
}

// ============================================================
// GET /api/health
// ============================================================
router.get('/health', async (req, res) => {
    try {
        const r = await query('SELECT COUNT(*)::int as c FROM ts_licenses');
        return res.json({
            ok: true,
            server: 'ts-pro-license-server',
            version: '5.7.0',
            db: 'PostgreSQL/Neon',
            licenses_total: r.rows[0].c,
            server_time: new Date().toISOString()
        });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
    }
});

// ============================================================
// POST /api/activate
// ============================================================
router.post('/activate', async (req, res) => {
    const { activation_key, machine_id, fingerprint, client_version } = req.body || {};
    if (!activation_key || !machine_id) {
        return res.status(400).json({ error: 'missing_fields' });
    }

    try {
        // 1) البحث عن المفتاح
        const keyR = await query(
            "SELECT * FROM ts_activation_keys WHERE LOWER(activation_key) = LOWER($1)",
            [String(activation_key).trim()]
        );
        const key = keyR.rows[0];

        if (!key) {
            await logEvent(null, 'error', req, { reason: 'invalid_key', activation_key });
            return res.status(404).json({ error: 'invalid_activation_key' });
        }
        if (key.status === 'revoked') {
            await logEvent(null, 'error', req, { reason: 'key_revoked', activation_key });
            return res.status(403).json({ error: 'key_revoked' });
        }
        if (key.status === 'expired') {
            return res.status(403).json({ error: 'key_expired' });
        }
        if (key.expires_at && new Date(key.expires_at).getTime() < Date.now()) {
            await query("UPDATE ts_activation_keys SET status='expired' WHERE id=$1", [key.id]);
            return res.status(403).json({ error: 'key_expired' });
        }

        // 2) هل هذا الجهاز مُفعّل مسبقاً بنفس المفتاح؟
        const existR = await query(
            "SELECT * FROM ts_licenses WHERE activation_key_id = $1 AND machine_id = $2 AND status = 'active'",
            [key.id, String(machine_id)]
        );
        const existing = existR.rows[0];

        if (existing) {
            // نجدد JWT فقط دون خصم عدّاد
            const now = new Date();
            await query(
                `UPDATE ts_licenses SET last_heartbeat_at = $1, updated_at = $2,
                 fingerprint = COALESCE($3, fingerprint), client_version = $4 WHERE id = $5`,
                [now, now, fingerprint || null, client_version || null, existing.id]
            );
            // اقرأ بيانات العميل
            const richR = await query(`
                SELECT l.*, c.client_name, c.client_phone, c.client_email
                FROM ts_licenses l LEFT JOIN ts_clients c ON c.id = l.client_id
                WHERE l.id = $1
            `, [existing.id]);
            const lic = richR.rows[0];
            const payload = buildPayload(key, lic);
            const token = signJwt(payload, JWT_SECRET);
            await logEvent(existing.id, 'activation', req, { machine_id, fingerprint, refreshed: true });
            return res.json({ token, payload });
        }

        // 3) هل استُنفدت التفعيلات؟
        if (key.used_activations >= key.max_activations) {
            await logEvent(null, 'error', req, { reason: 'max_activations_reached', activation_key });
            return res.status(403).json({ error: 'max_activations_reached' });
        }

        // 4) إنشاء ترخيص جديد ضمن معاملة
        const issuedAt = new Date();
        const expiresAt = new Date(issuedAt.getTime() + key.duration_days * 24 * 60 * 60 * 1000);

        const licenseId = await transaction(async (client) => {
            const ins = await client.query(`
                INSERT INTO ts_licenses
                (activation_key_id, client_id, machine_id, fingerprint, business_type, invoice_template,
                 issued_at, expires_at, duration_days, last_heartbeat_at, client_version, status)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'active')
                RETURNING id
            `, [
                key.id, key.client_id || null,
                String(machine_id), fingerprint || null,
                key.business_type, key.invoice_template,
                issuedAt, expiresAt, key.duration_days, issuedAt,
                client_version || null
            ]);
            await client.query(
                "UPDATE ts_activation_keys SET used_activations = used_activations + 1 WHERE id = $1",
                [key.id]
            );
            // إن استُنفدت، نضع الحالة used
            if (key.used_activations + 1 >= key.max_activations) {
                await client.query("UPDATE ts_activation_keys SET status='used' WHERE id=$1", [key.id]);
            }
            return ins.rows[0].id;
        });

        // 5) قراءة الترخيص + بيانات العميل
        const licR = await query(`
            SELECT l.*, c.client_name, c.client_phone, c.client_email
            FROM ts_licenses l LEFT JOIN ts_clients c ON c.id = l.client_id
            WHERE l.id = $1
        `, [licenseId]);
        const lic = licR.rows[0];

        const payload = buildPayload(key, lic);
        const token = signJwt(payload, JWT_SECRET);
        await logEvent(licenseId, 'activation', req, { machine_id, fingerprint, new: true });

        return res.json({ token, payload });
    } catch (e) {
        console.error('[activate]', e);
        await logEvent(null, 'error', req, { reason: 'exception', message: e.message });
        return res.status(500).json({ error: 'internal_error', message: e.message });
    }
});

// ============================================================
// POST /api/heartbeat
// ============================================================
router.post('/heartbeat', async (req, res) => {
    const { token, machine_id, fingerprint, client_version } = req.body || {};
    if (!token) return res.status(400).json({ error: 'missing_token' });

    const v = verifyJwt(token, JWT_SECRET);
    if (!v.valid) {
        await logEvent(null, 'error', req, { reason: 'jwt_invalid', jwt_error: v.error });
        return res.status(401).json({ error: 'invalid_token', reason: v.error });
    }

    try {
        const licR = await query(`
            SELECT l.*, c.client_name, c.client_phone, c.client_email
            FROM ts_licenses l LEFT JOIN ts_clients c ON c.id = l.client_id
            WHERE l.id = $1
        `, [v.payload.license_id]);
        const lic = licR.rows[0];

        if (!lic) return res.status(404).json({ error: 'license_not_found' });
        if (lic.status === 'revoked') return res.status(403).json({ error: 'license_revoked' });
        if (lic.status === 'frozen') return res.status(403).json({ error: 'license_frozen' });

        const now = Date.now();
        const expiresAt = new Date(lic.expires_at).getTime();
        if (now > expiresAt) {
            await query("UPDATE ts_licenses SET status='expired' WHERE id=$1", [lic.id]);
            return res.status(403).json({ error: 'license_expired' });
        }

        // تحقق أن machine_id يطابق
        if (machine_id && String(machine_id) !== lic.machine_id) {
            await logEvent(lic.id, 'error', req, { reason: 'machine_mismatch', expected: lic.machine_id, got: machine_id });
            return res.status(403).json({ error: 'machine_mismatch' });
        }

        const nowDate = new Date();
        await query(`
            UPDATE ts_licenses
            SET last_heartbeat_at = $1, heartbeat_count = heartbeat_count + 1,
                updated_at = $2, fingerprint = COALESCE($3, fingerprint),
                client_version = COALESCE($4, client_version)
            WHERE id = $5
        `, [nowDate, nowDate, fingerprint || null, client_version || null, lic.id]);

        await logEvent(lic.id, 'heartbeat', req, { machine_id });

        // نُصدر توكن جديد (تجديد)
        const keyR = await query("SELECT * FROM ts_activation_keys WHERE id=$1", [lic.activation_key_id]);
        const key = keyR.rows[0];
        const payload = buildPayload(key, lic);
        const newToken = signJwt(payload, JWT_SECRET);
        return res.json({ token: newToken, payload });
    } catch (e) {
        console.error('[heartbeat]', e);
        return res.status(500).json({ error: 'internal_error', message: e.message });
    }
});

// ============================================================
// POST /api/verify-key - تحقق عام (للواجهة الويب فقط)
// يعرض معلومات المفتاح دون تعديل عدّاد التفعيلات.
// ============================================================
router.post('/verify-key', async (req, res) => {
    const { activation_key } = req.body || {};
    if (!activation_key) return res.status(400).json({ error: 'missing_key' });
    try {
        const keyR = await query(`
            SELECT k.id, k.activation_key, k.business_type, k.invoice_template,
                   k.duration_days, k.max_activations, k.used_activations,
                   k.status as key_status, k.expires_at as key_expires_at, k.created_at,
                   c.client_name, c.client_phone
            FROM ts_activation_keys k
            LEFT JOIN ts_clients c ON c.id = k.client_id
            WHERE LOWER(k.activation_key) = LOWER($1)
        `, [String(activation_key).trim()]);
        const key = keyR.rows[0];

        if (!key) {
            await logEvent(null, 'verify_failed', req, { reason: 'key_not_found' });
            return res.status(404).json({ error: 'key_not_found' });
        }

        // بيانات ترخيص نشط مرتبط (إن وجد)
        const activeR = await query(`
            SELECT id, machine_id, issued_at, expires_at, status,
                   last_heartbeat_at, heartbeat_count
            FROM ts_licenses
            WHERE activation_key_id = $1 AND status IN ('active', 'frozen', 'expired')
            ORDER BY id DESC LIMIT 1
        `, [key.id]);
        const activeLicense = activeR.rows[0];

        // احسب days_left والحالة المشتقة
        let daysLeft = null;
        let derivedStatus = key.key_status;
        if (activeLicense && activeLicense.expires_at) {
            const diff = new Date(activeLicense.expires_at).getTime() - Date.now();
            daysLeft = Math.ceil(diff / (24 * 60 * 60 * 1000));
            if (activeLicense.status === 'frozen') derivedStatus = 'frozen';
            else if (daysLeft < 0) derivedStatus = 'expired';
            else derivedStatus = 'active';
        }

        await logEvent(activeLicense ? activeLicense.id : null, 'verify_ok', req, {
            activation_key: String(activation_key).trim().substring(0, 4) + '****'
        });

        return res.json({
            activation_key: key.activation_key,
            business_type: key.business_type,
            invoice_template: key.invoice_template,
            duration_days: key.duration_days,
            max_activations: key.max_activations,
            used_activations: key.used_activations,
            key_status: key.key_status,
            derived_status: derivedStatus,
            key_expires_at: toIso(key.key_expires_at),
            client_name: key.client_name,
            client_phone: key.client_phone
                ? String(key.client_phone).replace(/\d(?=\d{4})/g, '*')
                : null,
            created_at: toIso(key.created_at),
            license: activeLicense ? {
                issued_at: toIso(activeLicense.issued_at),
                expires_at: toIso(activeLicense.expires_at),
                status: activeLicense.status,
                last_heartbeat_at: toIso(activeLicense.last_heartbeat_at),
                heartbeat_count: activeLicense.heartbeat_count,
                days_left: daysLeft,
                machine_id_masked: activeLicense.machine_id
                    ? activeLicense.machine_id.substring(0, 8) + '...' + activeLicense.machine_id.slice(-4)
                    : null
            } : null
        });
    } catch (e) {
        console.error('[verify-key]', e);
        return res.status(500).json({ error: 'internal_error' });
    }
});

module.exports = router;
