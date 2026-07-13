'use strict';
/**
 * Admin API - إدارة العملاء والمفاتيح والتراخيص
 */
const express = require('express');
const router = express.Router();
const db = require('../db');
const { generateActivationKey, computeExpiryDate, safeString } = require('../lib/utils');

// ============================================================
// GET /api/admin/dashboard - إحصائيات عامة
// ============================================================
router.get('/dashboard', (req, res) => {
    try {
        const stats = {
            clients_count: db.prepare('SELECT COUNT(*) c FROM clients').get().c,
            keys_active: db.prepare("SELECT COUNT(*) c FROM activation_keys WHERE status='active'").get().c,
            keys_used: db.prepare("SELECT COUNT(*) c FROM activation_keys WHERE status='used'").get().c,
            keys_revoked: db.prepare("SELECT COUNT(*) c FROM activation_keys WHERE status='revoked'").get().c,
            licenses_active: db.prepare("SELECT COUNT(*) c FROM licenses WHERE status='active'").get().c,
            licenses_expired: db.prepare("SELECT COUNT(*) c FROM licenses WHERE status='expired'").get().c,
            licenses_revoked: db.prepare("SELECT COUNT(*) c FROM licenses WHERE status='revoked'").get().c,
            events_last_24h: db.prepare("SELECT COUNT(*) c FROM license_events WHERE created_at >= datetime('now','-24 hours')").get().c
        };
        // last 10 events
        stats.recent_events = db.prepare(`
            SELECT e.*, l.machine_id as lic_machine, c.client_name
            FROM license_events e
            LEFT JOIN licenses l ON l.id = e.license_id
            LEFT JOIN clients c ON c.id = l.client_id
            ORDER BY e.id DESC LIMIT 15
        `).all();
        // licenses by business type
        stats.by_business_type = db.prepare(`
            SELECT business_type, COUNT(*) c FROM licenses
            WHERE status='active' GROUP BY business_type
        `).all();
        return res.json(stats);
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

// ============================================================
// Clients CRUD
// ============================================================
router.get('/clients', (req, res) => {
    try {
        const rows = db.prepare(`
            SELECT c.*,
                (SELECT COUNT(*) FROM licenses WHERE client_id=c.id AND status='active') as active_licenses,
                (SELECT COUNT(*) FROM activation_keys WHERE client_id=c.id) as total_keys
            FROM clients c ORDER BY c.id DESC
        `).all();
        return res.json(rows);
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

router.post('/clients', (req, res) => {
    const { client_name, client_phone, client_email, country, city, address, notes } = req.body || {};
    if (!client_name || !String(client_name).trim()) {
        return res.status(400).json({ error: 'client_name_required' });
    }
    try {
        const r = db.prepare(`
            INSERT INTO clients (client_name, client_phone, client_email, country, city, address, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
            safeString(client_name, 200),
            safeString(client_phone, 50),
            safeString(client_email, 200),
            safeString(country, 100),
            safeString(city, 100),
            safeString(address, 500),
            safeString(notes, 1000)
        );
        return res.json({ id: r.lastInsertRowid });
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

router.put('/clients/:id', (req, res) => {
    const id = parseInt(req.params.id);
    const { client_name, client_phone, client_email, country, city, address, notes } = req.body || {};
    try {
        db.prepare(`
            UPDATE clients SET client_name=?, client_phone=?, client_email=?,
                country=?, city=?, address=?, notes=?, updated_at=CURRENT_TIMESTAMP
            WHERE id=?
        `).run(
            safeString(client_name, 200),
            safeString(client_phone, 50),
            safeString(client_email, 200),
            safeString(country, 100),
            safeString(city, 100),
            safeString(address, 500),
            safeString(notes, 1000),
            id
        );
        return res.json({ ok: true });
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

router.delete('/clients/:id', (req, res) => {
    const id = parseInt(req.params.id);
    try {
        // منع الحذف إذا يوجد تراخيص نشطة
        const active = db.prepare("SELECT COUNT(*) c FROM licenses WHERE client_id=? AND status='active'").get(id);
        if (active.c > 0) {
            return res.status(400).json({ error: 'has_active_licenses' });
        }
        db.prepare("DELETE FROM clients WHERE id=?").run(id);
        return res.json({ ok: true });
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

// ============================================================
// Activation Keys
// ============================================================
router.get('/keys', (req, res) => {
    try {
        const rows = db.prepare(`
            SELECT k.*, c.client_name, c.client_phone
            FROM activation_keys k LEFT JOIN clients c ON c.id = k.client_id
            ORDER BY k.id DESC LIMIT 500
        `).all();
        return res.json(rows);
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

router.post('/keys', (req, res) => {
    const {
        client_id, business_type, invoice_template,
        duration_days, max_activations, expires_at, notes
    } = req.body || {};
    if (!business_type || !invoice_template || !duration_days) {
        return res.status(400).json({ error: 'missing_fields' });
    }
    try {
        // توليد مفتاح فريد (نتحقق من التكرار)
        let key;
        for (let i = 0; i < 20; i++) {
            key = generateActivationKey();
            const dup = db.prepare("SELECT id FROM activation_keys WHERE activation_key=?").get(key);
            if (!dup) break;
            key = null;
        }
        if (!key) return res.status(500).json({ error: 'key_generation_failed' });

        const r = db.prepare(`
            INSERT INTO activation_keys
            (activation_key, client_id, business_type, invoice_template,
             duration_days, max_activations, expires_at, notes, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')
        `).run(
            key,
            client_id || null,
            safeString(business_type, 50),
            safeString(invoice_template, 50),
            Number(duration_days) || 30,
            Number(max_activations) || 1,
            expires_at || null,
            safeString(notes, 500)
        );
        return res.json({ id: r.lastInsertRowid, activation_key: key });
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

router.post('/keys/:id/revoke', (req, res) => {
    const id = parseInt(req.params.id);
    try {
        db.prepare("UPDATE activation_keys SET status='revoked' WHERE id=?").run(id);
        return res.json({ ok: true });
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

// ============================================================
// Licenses
// ============================================================
router.get('/licenses', (req, res) => {
    try {
        const rows = db.prepare(`
            SELECT l.*, c.client_name, c.client_phone, k.activation_key
            FROM licenses l
            LEFT JOIN clients c ON c.id = l.client_id
            LEFT JOIN activation_keys k ON k.id = l.activation_key_id
            ORDER BY l.id DESC LIMIT 500
        `).all();
        return res.json(rows);
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

router.post('/licenses/:id/revoke', (req, res) => {
    const id = parseInt(req.params.id);
    const { reason } = req.body || {};
    try {
        db.prepare(`
            UPDATE licenses SET status='revoked', revoked_at=CURRENT_TIMESTAMP,
                revoked_reason=?, updated_at=CURRENT_TIMESTAMP
            WHERE id=?
        `).run(safeString(reason, 500), id);
        return res.json({ ok: true });
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

router.post('/licenses/:id/freeze', (req, res) => {
    const id = parseInt(req.params.id);
    try {
        db.prepare("UPDATE licenses SET status='frozen', updated_at=CURRENT_TIMESTAMP WHERE id=?").run(id);
        return res.json({ ok: true });
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

router.post('/licenses/:id/unfreeze', (req, res) => {
    const id = parseInt(req.params.id);
    try {
        db.prepare("UPDATE licenses SET status='active', updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='frozen'").run(id);
        return res.json({ ok: true });
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

router.post('/licenses/:id/extend', (req, res) => {
    const id = parseInt(req.params.id);
    const { days } = req.body || {};
    if (!days || days <= 0) return res.status(400).json({ error: 'invalid_days' });
    try {
        const lic = db.prepare("SELECT * FROM licenses WHERE id=?").get(id);
        if (!lic) return res.status(404).json({ error: 'not_found' });
        const newExpiry = computeExpiryDate(Number(days), lic.expires_at);
        db.prepare("UPDATE licenses SET expires_at=?, duration_days=duration_days+?, updated_at=CURRENT_TIMESTAMP WHERE id=?")
          .run(newExpiry, Number(days), id);
        return res.json({ ok: true, expires_at: newExpiry });
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

// ============================================================
// Events
// ============================================================
router.get('/events', (req, res) => {
    const licenseId = req.query.license_id ? parseInt(req.query.license_id) : null;
    const limit = Math.min(Number(req.query.limit) || 200, 1000);
    try {
        const rows = licenseId
            ? db.prepare("SELECT * FROM license_events WHERE license_id=? ORDER BY id DESC LIMIT ?").all(licenseId, limit)
            : db.prepare("SELECT * FROM license_events ORDER BY id DESC LIMIT ?").all(limit);
        return res.json(rows);
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

// ============================================================
// v5.7.6 — الميزات الإدارية المتقدمة (6 ميزات)
// ============================================================

/**
 * Helper: توليد رمز إعادة تعيين آمن (16 حرف hex بشكل XXXX-XXXX-XXXX-XXXX)
 */
function _generateResetToken() {
    const crypto = require('crypto');
    const hex = crypto.randomBytes(8).toString('hex').toUpperCase();
    return `${hex.substring(0,4)}-${hex.substring(4,8)}-${hex.substring(8,12)}-${hex.substring(12,16)}`;
}

/**
 * Helper: توليد كلمة مرور مؤقتة (10 أحرف قابلة للقراءة)
 */
function _generateTempPassword() {
    const crypto = require('crypto');
    // بدون أحرف مربكة (0/O, 1/I/l)
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    const bytes = crypto.randomBytes(10);
    let out = '';
    for (let i = 0; i < 10; i++) out += chars[bytes[i] % chars.length];
    return out;
}

// ============================================================
// الميزة 1: POST /api/admin/generate-reset-token
// إنشاء رمز إعادة تعيين كلمة المرور
// ============================================================
router.post('/generate-reset-token', (req, res) => {
    const { client_id, license_id, machine_id, notes, custom_temp_password, expires_in_hours } = req.body || {};
    if (!client_id && !license_id && !machine_id) {
        return res.status(400).json({ error: 'must_specify_target', message: 'حدد client_id أو license_id أو machine_id' });
    }
    try {
        // استنتاج machine_id/license_id من client_id إن لم يُحدَّد
        let targetMachine = machine_id || null;
        let targetLicense = license_id || null;
        let targetClient = client_id || null;

        if (targetLicense && !targetMachine) {
            const lic = db.prepare("SELECT machine_id, client_id FROM licenses WHERE id=?").get(targetLicense);
            if (lic) {
                targetMachine = lic.machine_id;
                targetClient = targetClient || lic.client_id;
            }
        } else if (targetClient && !targetMachine) {
            // أحدث ترخيص نشط لهذا العميل
            const lic = db.prepare(`
                SELECT id, machine_id FROM licenses
                WHERE client_id=? AND status='active'
                ORDER BY id DESC LIMIT 1
            `).get(targetClient);
            if (lic) {
                targetMachine = lic.machine_id;
                targetLicense = lic.id;
            }
        }

        // توليد رمز فريد
        let token;
        for (let i = 0; i < 20; i++) {
            token = _generateResetToken();
            const dup = db.prepare("SELECT id FROM reset_tokens WHERE token=?").get(token);
            if (!dup) break;
            token = null;
        }
        if (!token) return res.status(500).json({ error: 'token_generation_failed' });

        const tempPass = custom_temp_password && String(custom_temp_password).length >= 6
            ? String(custom_temp_password).substring(0, 32)
            : _generateTempPassword();

        const hours = Math.min(Math.max(Number(expires_in_hours) || 24, 1), 24 * 7);
        const expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();

        const r = db.prepare(`
            INSERT INTO reset_tokens
            (token, machine_id, client_id, license_id, temp_password, expires_at, created_by, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            token,
            targetMachine,
            targetClient,
            targetLicense,
            tempPass,
            expiresAt,
            req.adminUser || 'admin',
            safeString(notes, 500)
        );

        return res.json({
            ok: true,
            id: r.lastInsertRowid,
            token,
            temp_password: tempPass,
            expires_at: expiresAt,
            machine_id: targetMachine,
            license_id: targetLicense
        });
    } catch (e) {
        console.error('[generate-reset-token]', e);
        return res.status(500).json({ error: e.message });
    }
});

// GET /api/admin/reset-tokens - قائمة الرموز
router.get('/reset-tokens', (req, res) => {
    const clientId = req.query.client_id ? parseInt(req.query.client_id) : null;
    try {
        const sql = `
            SELECT rt.*, c.client_name, c.client_phone
            FROM reset_tokens rt
            LEFT JOIN clients c ON c.id = rt.client_id
            ${clientId ? 'WHERE rt.client_id = ?' : ''}
            ORDER BY rt.id DESC LIMIT 200
        `;
        const rows = clientId
            ? db.prepare(sql).all(clientId)
            : db.prepare(sql).all();
        return res.json(rows);
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

// ============================================================
// الميزة 2: POST /api/admin/update-business-type
// تغيير نوع النشاط لترخيص عميل (يُطبَّق في heartbeat التالي)
// ============================================================
router.post('/update-business-type', (req, res) => {
    const { license_id, business_type, invoice_template } = req.body || {};
    if (!license_id || !business_type) {
        return res.status(400).json({ error: 'missing_fields' });
    }
    try {
        const lic = db.prepare("SELECT * FROM licenses WHERE id=?").get(Number(license_id));
        if (!lic) return res.status(404).json({ error: 'license_not_found' });

        const oldType = lic.business_type;
        const oldTemplate = lic.invoice_template;

        db.prepare(`
            UPDATE licenses
            SET business_type=?,
                invoice_template=?,
                updated_at=CURRENT_TIMESTAMP
            WHERE id=?
        `).run(
            String(business_type).substring(0, 50),
            invoice_template ? String(invoice_template).substring(0, 50) : oldTemplate,
            lic.id
        );

        // تسجيل حدث
        db.prepare(`
            INSERT INTO license_events (license_id, event_type, machine_id, details)
            VALUES (?, 'business_type_change', ?, ?)
        `).run(
            lic.id,
            lic.machine_id,
            JSON.stringify({
                previous: oldType,
                current: business_type,
                previous_template: oldTemplate,
                new_template: invoice_template || oldTemplate,
                by: req.adminUser
            })
        );

        return res.json({
            ok: true,
            license_id: lic.id,
            previous: oldType,
            current: business_type,
            message: 'تم التحديث - سيُطبَّق على العميل في heartbeat التالي'
        });
    } catch (e) {
        console.error('[update-business-type]', e);
        return res.status(500).json({ error: e.message });
    }
});

// ============================================================
// الميزة 3: POST /api/admin/toggle-license
// تعليق أو إعادة تفعيل ترخيص (منفصل عن revoke)
// ============================================================
router.post('/toggle-license/:id', (req, res) => {
    const id = parseInt(req.params.id);
    const { suspend, reason } = req.body || {};
    try {
        const lic = db.prepare("SELECT id, suspended, machine_id FROM licenses WHERE id=?").get(id);
        if (!lic) return res.status(404).json({ error: 'license_not_found' });

        const newState = suspend === false ? 0 : (suspend === true ? 1 : (lic.suspended ? 0 : 1));
        const nowIso = new Date().toISOString();

        if (newState === 1) {
            db.prepare(`
                UPDATE licenses
                SET suspended=1, suspended_at=?, suspended_reason=?, suspended_by=?, updated_at=?
                WHERE id=?
            `).run(nowIso, safeString(reason, 500), req.adminUser || 'admin', nowIso, id);
            db.prepare(`
                INSERT INTO license_events (license_id, event_type, machine_id, details)
                VALUES (?, 'suspend', ?, ?)
            `).run(id, lic.machine_id, JSON.stringify({ reason, by: req.adminUser }));
            return res.json({ ok: true, suspended: true, action: 'suspended' });
        } else {
            db.prepare(`
                UPDATE licenses
                SET suspended=0, suspended_at=NULL, suspended_reason=NULL, updated_at=?
                WHERE id=?
            `).run(nowIso, id);
            db.prepare(`
                INSERT INTO license_events (license_id, event_type, machine_id, details)
                VALUES (?, 'unsuspend', ?, ?)
            `).run(id, lic.machine_id, JSON.stringify({ by: req.adminUser }));
            return res.json({ ok: true, suspended: false, action: 'unsuspended' });
        }
    } catch (e) {
        console.error('[toggle-license]', e);
        return res.status(500).json({ error: e.message });
    }
});

// ============================================================
// الميزة 4: GET /api/admin/client-devices/:client_id
// عرض جميع الأجهزة (التراخيص) لعميل معين
// ============================================================
router.get('/client-devices/:client_id', (req, res) => {
    const clientId = parseInt(req.params.client_id);
    if (!clientId) return res.status(400).json({ error: 'missing_client_id' });
    try {
        const client = db.prepare("SELECT * FROM clients WHERE id=?").get(clientId);
        if (!client) return res.status(404).json({ error: 'client_not_found' });

        const devices = db.prepare(`
            SELECT
                l.id, l.machine_id, l.fingerprint, l.business_type, l.invoice_template,
                l.issued_at, l.expires_at, l.last_heartbeat_at, l.heartbeat_count,
                l.client_version, l.status, l.suspended, l.suspended_reason, l.suspended_at,
                l.revoked_at, l.revoked_reason, l.last_ip,
                k.activation_key,
                (SELECT COUNT(*) FROM license_events WHERE license_id=l.id) AS events_count
            FROM licenses l
            LEFT JOIN activation_keys k ON k.id = l.activation_key_id
            WHERE l.client_id = ?
            ORDER BY l.id DESC
        `).all(clientId);

        return res.json({ client, devices });
    } catch (e) {
        console.error('[client-devices]', e);
        return res.status(500).json({ error: e.message });
    }
});

// ============================================================
// الميزة 5: POST /api/admin/send-notification
// إرسال إشعار لعميل/جهاز
// ============================================================
router.post('/send-notification', (req, res) => {
    const { client_id, license_id, machine_id, title, body, severity, expires_in_days } = req.body || {};
    if (!body || !String(body).trim()) return res.status(400).json({ error: 'body_required' });
    try {
        const validSev = ['info', 'warning', 'danger', 'success'];
        const sev = validSev.includes(severity) ? severity : 'info';
        let expAt = null;
        const days = Number(expires_in_days);
        if (days > 0) {
            expAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
        } else {
            // افتراضي: 30 يوم
            expAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
        }

        const r = db.prepare(`
            INSERT INTO notifications
            (client_id, license_id, machine_id, title, body, severity, expires_at, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            client_id ? Number(client_id) : null,
            license_id ? Number(license_id) : null,
            machine_id ? String(machine_id).substring(0, 128) : null,
            safeString(title, 200) || 'إشعار',
            safeString(body, 2000),
            sev,
            expAt,
            req.adminUser || 'admin'
        );
        return res.json({ ok: true, id: r.lastInsertRowid, expires_at: expAt });
    } catch (e) {
        console.error('[send-notification]', e);
        return res.status(500).json({ error: e.message });
    }
});

// GET /api/admin/notifications - قائمة الإشعارات مع عدّاد التسليم
router.get('/notifications', (req, res) => {
    const clientId = req.query.client_id ? parseInt(req.query.client_id) : null;
    try {
        const sql = `
            SELECT
                n.*,
                c.client_name,
                (SELECT COUNT(*) FROM notification_deliveries nd WHERE nd.notification_id = n.id) AS delivered_count,
                CASE
                    WHEN n.machine_id IS NOT NULL THEN 1
                    WHEN n.license_id IS NOT NULL THEN 1
                    WHEN n.client_id IS NOT NULL THEN
                        (SELECT COUNT(*) FROM licenses lic WHERE lic.client_id = n.client_id AND lic.status='active')
                    ELSE
                        (SELECT COUNT(*) FROM licenses lic WHERE lic.status='active')
                END AS target_count
            FROM notifications n
            LEFT JOIN clients c ON c.id = n.client_id
            ${clientId ? 'WHERE n.client_id = ? OR n.client_id IS NULL' : ''}
            ORDER BY n.id DESC LIMIT 200
        `;
        const rows = clientId
            ? db.prepare(sql).all(clientId)
            : db.prepare(sql).all();
        return res.json(rows);
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

// DELETE /api/admin/notifications/:id - حذف إشعار
router.delete('/notifications/:id', (req, res) => {
    const id = parseInt(req.params.id);
    try {
        db.prepare("DELETE FROM notifications WHERE id=?").run(id);
        return res.json({ ok: true });
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

// ============================================================
// الميزة 6: GET /api/admin/client-stats/:client_id
// إحصائيات استخدام العميل
// ============================================================
router.get('/client-stats/:client_id', (req, res) => {
    const clientId = parseInt(req.params.client_id);
    if (!clientId) return res.status(400).json({ error: 'missing_client_id' });
    try {
        const client = db.prepare("SELECT * FROM clients WHERE id=?").get(clientId);
        if (!client) return res.status(404).json({ error: 'client_not_found' });

        // إجمالي التراخيص
        const licStats = db.prepare(`
            SELECT
                COUNT(*) AS total,
                SUM(CASE WHEN status='active' AND (suspended IS NULL OR suspended=0) THEN 1 ELSE 0 END) AS active,
                SUM(CASE WHEN suspended=1 THEN 1 ELSE 0 END) AS suspended,
                SUM(CASE WHEN status='expired' THEN 1 ELSE 0 END) AS expired,
                SUM(CASE WHEN status='revoked' THEN 1 ELSE 0 END) AS revoked,
                MAX(last_heartbeat_at) AS last_heartbeat_at
            FROM licenses WHERE client_id=?
        `).get(clientId);

        // إحصائيات الاستخدام المُجمّعة
        const usageAggregate = db.prepare(`
            SELECT
                SUM(invoices_month) AS invoices_month,
                SUM(sales_total_month) AS sales_total_month,
                SUM(products_count) AS products_count,
                SUM(users_count) AS users_count,
                MAX(last_activity_at) AS last_activity_at,
                MAX(reported_at) AS reported_at
            FROM client_usage_stats us
            INNER JOIN licenses l ON l.id = us.license_id
            WHERE l.client_id = ?
        `).get(clientId);

        // إحصائيات الاستخدام لكل جهاز
        const usageStats = db.prepare(`
            SELECT
                l.machine_id,
                l.business_type,
                us.invoices_month  AS invoice_count,
                us.sales_total_month AS sales_total,
                us.products_count,
                us.users_count,
                us.last_activity_at,
                us.reported_at
            FROM client_usage_stats us
            INNER JOIN licenses l ON l.id = us.license_id
            WHERE l.client_id = ?
            ORDER BY us.reported_at DESC
        `).all(clientId);

        // آخر الأحداث (مع تفصيل لعرض الأجهزة)
        const recentEvents = db.prepare(`
            SELECT e.id, e.event_type, e.machine_id, e.ip_address, e.created_at, e.details
            FROM license_events e
            INNER JOIN licenses l ON l.id = e.license_id
            WHERE l.client_id = ?
            ORDER BY e.id DESC LIMIT 20
        `).all(clientId);

        return res.json({
            client,
            licenses: licStats || {},
            usage: usageAggregate || {},
            usage_stats: usageStats,
            recent_events: recentEvents
        });
    } catch (e) {
        console.error('[client-stats]', e);
        return res.status(500).json({ error: e.message });
    }
});

module.exports = router;
