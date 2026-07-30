'use strict';
/**
 * ═══════════════════════════════════════════════════════════════════════
 * Admin API - إدارة العملاء والمفاتيح والتراخيص (PostgreSQL / Neon)
 * ═══════════════════════════════════════════════════════════════════════
 */
const express = require('express');
const router = express.Router();
const { query, transaction } = require('../db');
const { generateActivationKey, computeExpiryDate, safeString } = require('../lib/utils');

// helper — التأكد أن التاريخ يعود ISO string
function toIso(v) {
    if (!v) return null;
    if (v instanceof Date) return v.toISOString();
    return String(v);
}

// helper — تحويل صفوف التاريخ إلى ISO
function normalizeDates(rows, fields = ['created_at', 'updated_at', 'expires_at', 'issued_at', 'last_heartbeat_at', 'revoked_at']) {
    return rows.map(r => {
        const out = { ...r };
        for (const f of fields) if (out[f]) out[f] = toIso(out[f]);
        return out;
    });
}

// ============================================================
// GET /api/admin/dashboard - إحصائيات عامة
// ============================================================
router.get('/dashboard', async (req, res) => {
    try {
        const [
            clientsCnt, keysActive, keysUsed, keysRevoked,
            licActive, licExpired, licRevoked, events24h,
            recentEvents, byBusiness
        ] = await Promise.all([
            query("SELECT COUNT(*)::int c FROM ts_clients"),
            query("SELECT COUNT(*)::int c FROM ts_activation_keys WHERE status='active'"),
            query("SELECT COUNT(*)::int c FROM ts_activation_keys WHERE status='used'"),
            query("SELECT COUNT(*)::int c FROM ts_activation_keys WHERE status='revoked'"),
            query("SELECT COUNT(*)::int c FROM ts_licenses WHERE status='active'"),
            query("SELECT COUNT(*)::int c FROM ts_licenses WHERE status='expired'"),
            query("SELECT COUNT(*)::int c FROM ts_licenses WHERE status='revoked'"),
            query("SELECT COUNT(*)::int c FROM ts_license_events WHERE created_at >= NOW() - INTERVAL '24 hours'"),
            query(`
                SELECT e.*, l.machine_id as lic_machine, c.client_name
                FROM ts_license_events e
                LEFT JOIN ts_licenses l ON l.id = e.license_id
                LEFT JOIN ts_clients c ON c.id = l.client_id
                ORDER BY e.id DESC LIMIT 15
            `),
            query(`
                SELECT business_type, COUNT(*)::int c FROM ts_licenses
                WHERE status='active' GROUP BY business_type
            `)
        ]);

        const stats = {
            clients_count:    clientsCnt.rows[0].c,
            keys_active:      keysActive.rows[0].c,
            keys_used:        keysUsed.rows[0].c,
            keys_revoked:     keysRevoked.rows[0].c,
            licenses_active:  licActive.rows[0].c,
            licenses_expired: licExpired.rows[0].c,
            licenses_revoked: licRevoked.rows[0].c,
            events_last_24h:  events24h.rows[0].c,
            recent_events:    normalizeDates(recentEvents.rows),
            by_business_type: byBusiness.rows
        };
        return res.json(stats);
    } catch (e) {
        console.error('[dashboard]', e);
        return res.status(500).json({ error: e.message });
    }
});

// ============================================================
// Clients CRUD
// ============================================================
router.get('/clients', async (req, res) => {
    try {
        const r = await query(`
            SELECT c.*,
                (SELECT COUNT(*)::int FROM ts_licenses WHERE client_id=c.id AND status='active') as active_licenses,
                (SELECT COUNT(*)::int FROM ts_activation_keys WHERE client_id=c.id) as total_keys
            FROM ts_clients c ORDER BY c.id DESC
        `);
        return res.json(normalizeDates(r.rows));
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

router.post('/clients', async (req, res) => {
    const { client_name, client_phone, client_email, country, city, address, notes } = req.body || {};
    if (!client_name || !String(client_name).trim()) {
        return res.status(400).json({ error: 'client_name_required' });
    }
    try {
        const r = await query(`
            INSERT INTO ts_clients (client_name, client_phone, client_email, country, city, address, notes)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING id
        `, [
            safeString(client_name, 200),
            safeString(client_phone, 50) || null,
            safeString(client_email, 200) || null,
            safeString(country, 100) || null,
            safeString(city, 100) || null,
            safeString(address, 500) || null,
            safeString(notes, 1000) || null
        ]);
        return res.json({ id: r.rows[0].id });
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

router.put('/clients/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    const { client_name, client_phone, client_email, country, city, address, notes } = req.body || {};
    try {
        await query(`
            UPDATE ts_clients SET client_name=$1, client_phone=$2, client_email=$3,
                country=$4, city=$5, address=$6, notes=$7, updated_at=NOW()
            WHERE id=$8
        `, [
            safeString(client_name, 200),
            safeString(client_phone, 50) || null,
            safeString(client_email, 200) || null,
            safeString(country, 100) || null,
            safeString(city, 100) || null,
            safeString(address, 500) || null,
            safeString(notes, 1000) || null,
            id
        ]);
        return res.json({ ok: true });
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

router.delete('/clients/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    try {
        // منع الحذف إذا يوجد تراخيص نشطة
        const active = await query("SELECT COUNT(*)::int c FROM ts_licenses WHERE client_id=$1 AND status='active'", [id]);
        if (active.rows[0].c > 0) {
            return res.status(400).json({ error: 'has_active_licenses' });
        }
        await query("DELETE FROM ts_clients WHERE id=$1", [id]);
        return res.json({ ok: true });
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

// ============================================================
// Activation Keys
// ============================================================
router.get('/keys', async (req, res) => {
    try {
        const r = await query(`
            SELECT k.*, c.client_name, c.client_phone
            FROM ts_activation_keys k LEFT JOIN ts_clients c ON c.id = k.client_id
            ORDER BY k.id DESC LIMIT 500
        `);
        return res.json(normalizeDates(r.rows));
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

router.post('/keys', async (req, res) => {
    const {
        client_id, business_type, invoice_template,
        duration_days, max_activations, expires_at, notes
    } = req.body || {};
    if (!business_type || !invoice_template || !duration_days) {
        return res.status(400).json({ error: 'missing_fields' });
    }
    try {
        // توليد مفتاح فريد (نتحقق من التكرار)
        let key = null;
        for (let i = 0; i < 20; i++) {
            const candidate = generateActivationKey();
            const dup = await query("SELECT id FROM ts_activation_keys WHERE activation_key=$1", [candidate]);
            if (dup.rows.length === 0) { key = candidate; break; }
        }
        if (!key) return res.status(500).json({ error: 'key_generation_failed' });

        const r = await query(`
            INSERT INTO ts_activation_keys
            (activation_key, client_id, business_type, invoice_template,
             duration_days, max_activations, expires_at, notes, status)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active')
            RETURNING id
        `, [
            key,
            client_id || null,
            safeString(business_type, 50),
            safeString(invoice_template, 50),
            Number(duration_days) || 30,
            Number(max_activations) || 1,
            expires_at ? new Date(expires_at) : null,
            safeString(notes, 500) || null
        ]);
        return res.json({ id: r.rows[0].id, activation_key: key });
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

router.post('/keys/:id/revoke', async (req, res) => {
    const id = parseInt(req.params.id);
    try {
        await query("UPDATE ts_activation_keys SET status='revoked' WHERE id=$1", [id]);
        return res.json({ ok: true });
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

// ============================================================
// Licenses
// ============================================================
router.get('/licenses', async (req, res) => {
    try {
        const r = await query(`
            SELECT l.*, c.client_name, c.client_phone, k.activation_key
            FROM ts_licenses l
            LEFT JOIN ts_clients c ON c.id = l.client_id
            LEFT JOIN ts_activation_keys k ON k.id = l.activation_key_id
            ORDER BY l.id DESC LIMIT 500
        `);
        return res.json(normalizeDates(r.rows));
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

router.post('/licenses/:id/revoke', async (req, res) => {
    const id = parseInt(req.params.id);
    const { reason } = req.body || {};
    try {
        await query(`
            UPDATE ts_licenses SET status='revoked', revoked_at=NOW(),
                revoked_reason=$1, updated_at=NOW()
            WHERE id=$2
        `, [safeString(reason, 500) || null, id]);
        return res.json({ ok: true });
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

router.post('/licenses/:id/freeze', async (req, res) => {
    const id = parseInt(req.params.id);
    try {
        await query("UPDATE ts_licenses SET status='frozen', updated_at=NOW() WHERE id=$1", [id]);
        return res.json({ ok: true });
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

router.post('/licenses/:id/unfreeze', async (req, res) => {
    const id = parseInt(req.params.id);
    try {
        await query("UPDATE ts_licenses SET status='active', updated_at=NOW() WHERE id=$1 AND status='frozen'", [id]);
        return res.json({ ok: true });
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

router.post('/licenses/:id/extend', async (req, res) => {
    const id = parseInt(req.params.id);
    const { days } = req.body || {};
    if (!days || days <= 0) return res.status(400).json({ error: 'invalid_days' });
    try {
        const licR = await query("SELECT * FROM ts_licenses WHERE id=$1", [id]);
        const lic = licR.rows[0];
        if (!lic) return res.status(404).json({ error: 'not_found' });
        const currentExpiry = new Date(lic.expires_at);
        const newExpiry = new Date(currentExpiry.getTime() + Number(days) * 24 * 60 * 60 * 1000);
        await query(
            "UPDATE ts_licenses SET expires_at=$1, duration_days=duration_days+$2, updated_at=NOW() WHERE id=$3",
            [newExpiry, Number(days), id]
        );
        return res.json({ ok: true, expires_at: newExpiry.toISOString() });
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

// ============================================================
// Events
// ============================================================
router.get('/events', async (req, res) => {
    const licenseId = req.query.license_id ? parseInt(req.query.license_id) : null;
    const limit = Math.min(Number(req.query.limit) || 200, 1000);
    try {
        const r = licenseId
            ? await query("SELECT * FROM ts_license_events WHERE license_id=$1 ORDER BY id DESC LIMIT $2", [licenseId, limit])
            : await query("SELECT * FROM ts_license_events ORDER BY id DESC LIMIT $1", [limit]);
        return res.json(normalizeDates(r.rows, ['created_at']));
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

module.exports = router;
