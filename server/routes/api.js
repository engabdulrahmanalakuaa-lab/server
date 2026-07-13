'use strict';
/**
 * API endpoints لعملاء الديسكتوب
 *  POST /api/activate  - تفعيل جديد
 *  POST /api/heartbeat - تحديث دوري
 *  GET  /api/health    - فحص الحالة
 */
const express = require('express');
const router = express.Router();
const db = require('../db');
const { signJwt, verifyJwt } = require('../lib/jwt');
const { computeExpiryDate, safeString } = require('../lib/utils');

const JWT_SECRET = process.env.JWT_SECRET || 'ts-pro-v5.7.0-shared-secret-2025-abdulrahman-al-akwa';

// Helper: تسجيل حدث
function logEvent(licenseId, eventType, req, details) {
    try {
        db.prepare(`
            INSERT INTO license_events (license_id, event_type, machine_id, fingerprint, ip_address, user_agent, details)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
            licenseId || null,
            String(eventType),
            safeString(details && details.machine_id, 128),
            safeString(details && details.fingerprint, 128),
            safeString(req.ip || req.headers['x-forwarded-for'] || '', 64),
            safeString(req.headers['user-agent'] || '', 256),
            details ? JSON.stringify(details).substring(0, 1000) : null
        );
    } catch (e) {
        console.error('[logEvent]', e.message);
    }
}

// ============================================================
// GET /api/health
// ============================================================
router.get('/health', (req, res) => {
    try {
        const row = db.prepare('SELECT COUNT(*) as c FROM licenses').get();
        return res.json({
            ok: true,
            server: 'ts-pro-license-server',
            version: '5.7.0',
            licenses_total: row.c,
            server_time: new Date().toISOString()
        });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
    }
});

// ============================================================
// POST /api/activate
// ============================================================
router.post('/activate', (req, res) => {
    const { activation_key, machine_id, fingerprint, client_version } = req.body || {};
    if (!activation_key || !machine_id) {
        return res.status(400).json({ error: 'missing_fields' });
    }

    try {
        // 1) البحث عن المفتاح
        const key = db.prepare(
            "SELECT * FROM activation_keys WHERE activation_key = ? COLLATE NOCASE"
        ).get(String(activation_key).trim());

        if (!key) {
            logEvent(null, 'error', req, { reason: 'invalid_key', activation_key });
            return res.status(404).json({ error: 'invalid_activation_key' });
        }
        if (key.status === 'revoked') {
            logEvent(null, 'error', req, { reason: 'key_revoked', activation_key });
            return res.status(403).json({ error: 'key_revoked' });
        }
        if (key.status === 'expired') {
            return res.status(403).json({ error: 'key_expired' });
        }
        if (key.expires_at && new Date(key.expires_at).getTime() < Date.now()) {
            db.prepare("UPDATE activation_keys SET status='expired' WHERE id=?").run(key.id);
            return res.status(403).json({ error: 'key_expired' });
        }

        // 2) هل هذا الجهاز مُفعّل مسبقاً بنفس المفتاح؟
        const existing = db.prepare(
            "SELECT * FROM licenses WHERE activation_key_id = ? AND machine_id = ? AND status = 'active'"
        ).get(key.id, String(machine_id));

        if (existing) {
            // نجدد JWT فقط دون خصم عدّاد
            const now = new Date().toISOString();
            const payload = buildPayload(key, existing);
            const token = signJwt(payload, JWT_SECRET);
            db.prepare(
                "UPDATE licenses SET last_heartbeat_at = ?, updated_at = ?, fingerprint = COALESCE(?, fingerprint), client_version = ? WHERE id = ?"
            ).run(now, now, fingerprint || null, client_version || null, existing.id);
            logEvent(existing.id, 'activation', req, { machine_id, fingerprint, refreshed: true });
            return res.json({ token, payload });
        }

        // 3) هل استُنفدت التفعيلات؟
        if (key.used_activations >= key.max_activations) {
            logEvent(null, 'error', req, { reason: 'max_activations_reached', activation_key });
            return res.status(403).json({ error: 'max_activations_reached' });
        }

        // 4) إنشاء ترخيص جديد
        const issuedAt = new Date().toISOString();
        const expiresAt = computeExpiryDate(key.duration_days, issuedAt);
        const tx = db.transaction(() => {
            const insLic = db.prepare(`
                INSERT INTO licenses
                (activation_key_id, client_id, machine_id, fingerprint, business_type, invoice_template,
                 issued_at, expires_at, duration_days, last_heartbeat_at, client_version, status)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
            `);
            const r = insLic.run(
                key.id, key.client_id || null,
                String(machine_id), fingerprint || null,
                key.business_type, key.invoice_template,
                issuedAt, expiresAt, key.duration_days, issuedAt,
                client_version || null
            );
            db.prepare("UPDATE activation_keys SET used_activations = used_activations + 1 WHERE id = ?").run(key.id);
            // إن استُنفدت، نضع الحالة used
            if (key.used_activations + 1 >= key.max_activations) {
                db.prepare("UPDATE activation_keys SET status='used' WHERE id=?").run(key.id);
            }
            return r.lastInsertRowid;
        });
        const licenseId = tx();

        // 5) قراءة الترخيص + بيانات العميل
        const lic = db.prepare(`
            SELECT l.*, c.client_name, c.client_phone, c.client_email
            FROM licenses l LEFT JOIN clients c ON c.id = l.client_id
            WHERE l.id = ?
        `).get(licenseId);

        const payload = buildPayload(key, lic);
        const token = signJwt(payload, JWT_SECRET);
        logEvent(licenseId, 'activation', req, { machine_id, fingerprint, new: true });

        return res.json({ token, payload });
    } catch (e) {
        console.error('[activate]', e);
        logEvent(null, 'error', req, { reason: 'exception', message: e.message });
        return res.status(500).json({ error: 'internal_error', message: e.message });
    }
});

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
        issued_at: license.issued_at,
        expires_at: license.expires_at,
        duration_days: license.duration_days,
        license_id: license.id,
        server_time: new Date().toISOString()
    };
}

// ============================================================
// POST /api/heartbeat  (v5.7.6: يُرجع الإشعارات + تحديث النشاط)
// ============================================================
router.post('/heartbeat', (req, res) => {
    const { token, machine_id, fingerprint, client_version, usage } = req.body || {};
    if (!token) return res.status(400).json({ error: 'missing_token' });

    const v = verifyJwt(token, JWT_SECRET);
    if (!v.valid) {
        logEvent(null, 'error', req, { reason: 'jwt_invalid', jwt_error: v.error });
        return res.status(401).json({ error: 'invalid_token', reason: v.error });
    }

    try {
        const lic = db.prepare(`
            SELECT l.*, c.client_name, c.client_phone, c.client_email
            FROM licenses l LEFT JOIN clients c ON c.id = l.client_id
            WHERE l.id = ?
        `).get(v.payload.license_id);

        if (!lic) return res.status(404).json({ error: 'license_not_found' });
        if (lic.status === 'revoked') return res.status(403).json({ error: 'license_revoked' });
        if (lic.status === 'frozen') return res.status(403).json({ error: 'license_frozen' });
        // v5.7.6: تعليق مؤقت (منفصل عن revoke/frozen)
        if (lic.suspended === 1) {
            logEvent(lic.id, 'error', req, { reason: 'license_suspended' });
            return res.status(403).json({ error: 'license_suspended', message: 'تم تعليق الترخيص، يرجى التواصل مع الدعم' });
        }

        const now = Date.now();
        const expiresAt = new Date(lic.expires_at).getTime();
        if (now > expiresAt) {
            db.prepare("UPDATE licenses SET status='expired' WHERE id=?").run(lic.id);
            return res.status(403).json({ error: 'license_expired' });
        }

        // تحقق أن machine_id يطابق
        if (machine_id && String(machine_id) !== lic.machine_id) {
            logEvent(lic.id, 'error', req, { reason: 'machine_mismatch', expected: lic.machine_id, got: machine_id });
            return res.status(403).json({ error: 'machine_mismatch' });
        }

        const nowIso = new Date().toISOString();
        const clientIp = safeString(req.ip || req.headers['x-forwarded-for'] || '', 64);
        db.prepare(`
            UPDATE licenses
            SET last_heartbeat_at = ?, heartbeat_count = heartbeat_count + 1,
                updated_at = ?, fingerprint = COALESCE(?, fingerprint),
                client_version = COALESCE(?, client_version),
                last_ip = COALESCE(?, last_ip)
            WHERE id = ?
        `).run(nowIso, nowIso, fingerprint || null, client_version || null, clientIp || null, lic.id);

        // v5.7.6: تسجيل إحصائيات الاستخدام إن أرسلها العميل
        if (usage && typeof usage === 'object') {
            try {
                db.prepare(`
                    INSERT INTO client_usage_stats (license_id, invoices_month, sales_total_month, products_count, users_count, last_activity_at, reported_at)
                    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                    ON CONFLICT(license_id) DO UPDATE SET
                        invoices_month = excluded.invoices_month,
                        sales_total_month = excluded.sales_total_month,
                        products_count = excluded.products_count,
                        users_count = excluded.users_count,
                        last_activity_at = excluded.last_activity_at,
                        reported_at = CURRENT_TIMESTAMP
                `).run(
                    lic.id,
                    Number(usage.invoices_month) || 0,
                    Number(usage.sales_total_month) || 0,
                    Number(usage.products_count) || 0,
                    Number(usage.users_count) || 0,
                    usage.last_activity_at || nowIso
                );
            } catch (statsErr) {
                console.warn('[heartbeat.usage]', statsErr.message);
            }
        }

        logEvent(lic.id, 'heartbeat', req, { machine_id });

        // v5.7.6: جلب الإشعارات المُعلّقة (لم تُسلّم بعد لهذا الجهاز)
        let notifications = [];
        try {
            const rawNotifs = db.prepare(`
                SELECT n.id, n.title, n.body, n.severity, n.expires_at, n.created_at
                FROM notifications n
                LEFT JOIN notification_deliveries d
                    ON d.notification_id = n.id AND d.machine_id = ?
                WHERE d.id IS NULL
                  AND (n.expires_at IS NULL OR n.expires_at > ?)
                  AND (n.client_id IS NULL OR n.client_id = ?)
                  AND (n.license_id IS NULL OR n.license_id = ?)
                  AND (n.machine_id IS NULL OR n.machine_id = ?)
                ORDER BY n.id ASC
                LIMIT 20
            `).all(machine_id || '', nowIso, lic.client_id, lic.id, machine_id || '');

            notifications = rawNotifs.map(n => ({
                id: n.id,
                title: n.title,
                body: n.body,
                severity: n.severity || 'info',
                expires_at: n.expires_at,
                created_at: n.created_at
            }));

            // تسجيل التسليم لكل إشعار سيُرسل الآن
            const markDelivery = db.prepare(`
                INSERT OR IGNORE INTO notification_deliveries (notification_id, license_id, machine_id, delivered_at)
                VALUES (?, ?, ?, ?)
            `);
            const bumpNotif = db.prepare(`
                UPDATE notifications SET delivered_count = delivered_count + 1, last_delivered_at = ? WHERE id = ?
            `);
            const tx = db.transaction(() => {
                for (const n of rawNotifs) {
                    markDelivery.run(n.id, lic.id, machine_id || '', nowIso);
                    bumpNotif.run(nowIso, n.id);
                }
            });
            tx();
        } catch (notifErr) {
            console.warn('[heartbeat.notifs]', notifErr.message);
        }

        // نُصدر توكن جديد (تجديد) — يعكس أي تغيير في business_type/invoice_template
        const key = db.prepare("SELECT * FROM activation_keys WHERE id=?").get(lic.activation_key_id);
        const payload = buildPayload(key, lic);
        const newToken = signJwt(payload, JWT_SECRET);

        // v5.7.6: هل تغيّر النشاط عن الإصدار السابق؟ (نقارن بـ v.payload القديمة)
        let business_type_update = null;
        try {
            const oldType = v.payload && v.payload.business_type;
            if (oldType && oldType !== lic.business_type) {
                business_type_update = {
                    previous: oldType,
                    current: lic.business_type,
                    invoice_template: lic.invoice_template
                };
            }
        } catch(_) {}

        return res.json({
            token: newToken,
            payload,
            notifications,
            business_type_update
        });
    } catch (e) {
        console.error('[heartbeat]', e);
        return res.status(500).json({ error: 'internal_error', message: e.message });
    }
});

// ============================================================
// v5.7.6: POST /api/verify-reset-token
// يتحقق من رمز الاستعادة ويُرجع كلمة المرور المؤقتة للعميل
// ============================================================
router.post('/verify-reset-token', (req, res) => {
    const { reset_token, machine_id } = req.body || {};
    if (!reset_token) return res.status(400).json({ ok: false, error: 'missing_token' });

    try {
        const token = String(reset_token).trim();
        const row = db.prepare("SELECT * FROM reset_tokens WHERE token = ? COLLATE NOCASE").get(token);
        if (!row) {
            logEvent(null, 'reset_token_invalid', req, { token: token.substring(0, 6) + '****' });
            return res.status(404).json({ ok: false, error: 'invalid_token' });
        }
        if (row.used === 1) {
            logEvent(null, 'reset_token_used', req, { token_id: row.id });
            return res.status(403).json({ ok: false, error: 'token_already_used' });
        }
        if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
            logEvent(null, 'reset_token_expired', req, { token_id: row.id });
            return res.status(403).json({ ok: false, error: 'expired' });
        }
        // إن كان الرمز مرتبطاً بجهاز معين، تحقق من التطابق
        if (row.machine_id && machine_id && String(row.machine_id) !== String(machine_id)) {
            logEvent(null, 'reset_token_machine_mismatch', req, {
                token_id: row.id,
                expected: row.machine_id,
                got: machine_id
            });
            return res.status(403).json({ ok: false, error: 'machine_mismatch' });
        }

        // تسجيل الاستخدام (One-Time!)
        const clientIp = safeString(req.ip || req.headers['x-forwarded-for'] || '', 64);
        db.prepare(`
            UPDATE reset_tokens
            SET used = 1, used_at = CURRENT_TIMESTAMP, used_by_ip = ?
            WHERE id = ?
        `).run(clientIp, row.id);

        logEvent(row.license_id || null, 'reset_token_consumed', req, {
            token_id: row.id,
            client_id: row.client_id,
            machine_id
        });

        return res.json({
            ok: true,
            temp_password: row.temp_password,
            must_change: true,
            message: 'الرمز صالح - قم بتسجيل الدخول بكلمة المرور المؤقتة ثم غيّرها فوراً'
        });
    } catch (e) {
        console.error('[verify-reset-token]', e);
        return res.status(500).json({ ok: false, error: 'internal_error' });
    }
});

// ============================================================
// POST /api/verify-key - تحقق عام (للواجهة الويب فقط)
// يعرض معلومات المفتاح دون تعديل عدّاد التفعيلات.
// ============================================================
router.post('/verify-key', (req, res) => {
    const { activation_key } = req.body || {};
    if (!activation_key) return res.status(400).json({ error: 'missing_key' });
    try {
        const key = db.prepare(`
            SELECT k.id, k.activation_key, k.business_type, k.invoice_template,
                   k.duration_days, k.max_activations, k.used_activations,
                   k.status as key_status, k.expires_at as key_expires_at, k.created_at,
                   c.client_name, c.client_phone
            FROM activation_keys k
            LEFT JOIN clients c ON c.id = k.client_id
            WHERE k.activation_key = ? COLLATE NOCASE
        `).get(String(activation_key).trim());

        if (!key) {
            logEvent(null, 'verify_failed', req, { reason: 'key_not_found' });
            return res.status(404).json({ error: 'key_not_found' });
        }

        // بيانات ترخيص نشط مرتبط (إن وجد)
        const activeLicense = db.prepare(`
            SELECT id, machine_id, issued_at, expires_at, status,
                   last_heartbeat_at, heartbeat_count
            FROM licenses
            WHERE activation_key_id = ? AND status IN ('active', 'frozen', 'expired')
            ORDER BY id DESC LIMIT 1
        `).get(key.id);

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

        logEvent(activeLicense ? activeLicense.id : null, 'verify_ok', req, {
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
            key_expires_at: key.key_expires_at,
            client_name: key.client_name,
            client_phone: key.client_phone
                ? String(key.client_phone).replace(/\d(?=\d{4})/g, '*')
                : null,
            created_at: key.created_at,
            license: activeLicense ? {
                issued_at: activeLicense.issued_at,
                expires_at: activeLicense.expires_at,
                status: activeLicense.status,
                last_heartbeat_at: activeLicense.last_heartbeat_at,
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
