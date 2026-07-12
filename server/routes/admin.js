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

module.exports = router;
