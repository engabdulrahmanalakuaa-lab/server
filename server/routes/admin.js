'use strict';
const express = require('express');
const router = express.Router();
const db = require('../db');
const { generateActivationKey, computeExpiryDate, safeString } = require('../lib/utils');

// Dashboard stats
router.get('/dashboard', async (req, res) => {
    try {
        const c1 = await db.prepare('SELECT COUNT(*) c FROM clients').get();
        const c2 = await db.prepare("SELECT COUNT(*) c FROM activation_keys WHERE status='active'").get();
        const c3 = await db.prepare("SELECT COUNT(*) c FROM activation_keys WHERE status='used'").get();
        const c4 = await db.prepare("SELECT COUNT(*) c FROM activation_keys WHERE status='revoked'").get();
        const c5 = await db.prepare("SELECT COUNT(*) c FROM licenses WHERE status='active'").get();
        const c6 = await db.prepare("SELECT COUNT(*) c FROM licenses WHERE status='expired'").get();
        const c7 = await db.prepare("SELECT COUNT(*) c FROM licenses WHERE status='revoked'").get();
        const c8 = await db.prepare("SELECT COUNT(*) c FROM license_events WHERE created_at >= NOW() - INTERVAL '24 hours'").get();

        const stats = {
            clients_count: parseInt(c1.c || 0),
            keys_active: parseInt(c2.c || 0),
            keys_used: parseInt(c3.c || 0),
            keys_revoked: parseInt(c4.c || 0),
            licenses_active: parseInt(c5.c || 0),
            licenses_expired: parseInt(c6.c || 0),
            licenses_revoked: parseInt(c7.c || 0),
            events_last_24h: parseInt(c8.c || 0)
        };

        const recentEvents = await db.prepare(`
            SELECT e.*, l.machine_id 
            FROM license_events e 
            LEFT JOIN licenses l ON e.license_id = l.id 
            ORDER BY e.created_at DESC LIMIT 10
        `).all();

        stats.recent_events = recentEvents;
        return res.json(stats);
    } catch (e) {
        console.error('[Admin Dashboard Error]:', e);
        return res.status(500).json({ error: e.message });
    }
});

// Clients List
router.get('/clients', async (req, res) => {
    try {
        const rows = await db.prepare("SELECT * FROM clients ORDER BY id DESC").all();
        return res.json(rows);
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

router.post('/clients', async (req, res) => {
    try {
        const { client_name, client_phone, client_email, country, city, address, notes } = req.body || {};
        if (!client_name) return res.status(400).json({ error: 'client_name required' });

        const r = await db.prepare(`
            INSERT INTO clients (client_name, client_phone, client_email, country, city, address, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id
        `).run(client_name, client_phone, client_email, country, city, address, notes);

        return res.json({ ok: true, id: r.lastInsertRowid });
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

// Activation Keys List
router.get('/keys', async (req, res) => {
    try {
        const rows = await db.prepare(`
            SELECT k.*, c.client_name 
            FROM activation_keys k 
            LEFT JOIN clients c ON k.client_id = c.id 
            ORDER BY k.id DESC
        `).all();
        return res.json(rows);
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

router.post('/keys', async (req, res) => {
    try {
        const { client_id, business_type, invoice_template, duration_days, max_activations, notes } = req.body || {};
        if (!business_type || !invoice_template) {
            return res.status(400).json({ error: 'missing_fields' });
        }
        const keyCode = generateActivationKey();
        const days = parseInt(duration_days) || 30;
        const maxDev = parseInt(max_activations) || 1;

        const r = await db.prepare(`
            INSERT INTO activation_keys (activation_key, client_id, business_type, invoice_template, duration_days, max_activations, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id
        `).run(keyCode, client_id || null, business_type, invoice_template, days, maxDev, notes);

        return res.json({ ok: true, id: r.lastInsertRowid, activation_key: keyCode });
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

// Licenses List
router.get('/licenses', async (req, res) => {
    try {
        const rows = await db.prepare(`
            SELECT l.*, c.client_name, k.activation_key 
            FROM licenses l 
            LEFT JOIN clients c ON l.client_id = c.id 
            LEFT JOIN activation_keys k ON l.activation_key_id = k.id 
            ORDER BY l.id DESC
        `).all();
        return res.json(rows);
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

router.post('/licenses/:id/extend', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const { days } = req.body || {};
        if (!days || days <= 0) return res.status(400).json({ error: 'invalid_days' });

        const lic = await db.prepare("SELECT * FROM licenses WHERE id=?").get(id);
        if (!lic) return res.status(404).json({ error: 'not_found' });

        const newExpiry = computeExpiryDate(Number(days), lic.expires_at);
        await db.prepare("UPDATE licenses SET expires_at=?, duration_days=duration_days+?, updated_at=CURRENT_TIMESTAMP WHERE id=?")
          .run(newExpiry, Number(days), id);

        return res.json({ ok: true, expires_at: newExpiry });
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

router.get('/events', async (req, res) => {
    try {
        const licenseId = req.query.license_id ? parseInt(req.query.license_id) : null;
        const limit = Math.min(Number(req.query.limit) || 200, 1000);
        const rows = licenseId
            ? await db.prepare("SELECT * FROM license_events WHERE license_id=? ORDER BY id DESC LIMIT ?").all(licenseId, limit)
            : await db.prepare("SELECT * FROM license_events ORDER BY id DESC LIMIT ?").all(limit);
        return res.json(rows);
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

module.exports = router;
