'use strict';
const express = require('express');
const router = express.Router();
const db = require('../db');
const { signJwt, verifyJwt } = require('../lib/jwt');
const { computeExpiryDate, safeString } = require('../lib/utils');

const JWT_SECRET = process.env.JWT_SECRET || 'ts-pro-v5.7.0-shared-secret-2025-abdulrahman-al-akwa';

async function logEvent(licenseId, eventType, req, details) {
    try {
        await db.prepare(`
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

router.get('/health', async (req, res) => {
    return res.json({ status: 'ok', time: new Date().toISOString() });
});

router.post('/activate', async (req, res) => {
    try {
        const { activation_key, machine_id, fingerprint, client_version } = req.body || {};
        if (!activation_key || !machine_id) {
            return res.status(400).json({ success: false, error: 'missing_parameters' });
        }

        const key = await db.prepare("SELECT * FROM activation_keys WHERE activation_key=?").get(activation_key);
        if (!key) {
            return res.status(404).json({ success: false, error: 'invalid_activation_key' });
        }

        if (key.status !== 'active' && key.status !== 'used') {
            return res.status(400).json({ success: false, error: 'key_not_active' });
        }

        let license = await db.prepare("SELECT * FROM licenses WHERE activation_key_id=? AND machine_id=?").get(key.id, machine_id);

        if (!license) {
            if (key.used_activations >= key.max_activations) {
                return res.status(400).json({ success: false, error: 'max_devices_reached' });
            }

            const issuedAt = new Date().toISOString();
            const expiresAt = computeExpiryDate(key.duration_days);

            const r = await db.prepare(`
                INSERT INTO licenses (activation_key_id, client_id, machine_id, fingerprint, business_type, invoice_template, issued_at, expires_at, duration_days, client_version, status)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active') RETURNING id
            `).run(key.id, key.client_id, machine_id, fingerprint || null, key.business_type, key.invoice_template, issuedAt, expiresAt, key.duration_days, client_version || null);

            const licenseId = r.lastInsertRowid;
            await db.prepare("UPDATE activation_keys SET used_activations = used_activations + 1, status = 'used' WHERE id = ?").run(key.id);

            license = await db.prepare("SELECT * FROM licenses WHERE id = ?").get(licenseId);
            await logEvent(licenseId, 'activate', req, { machine_id, fingerprint, client_version });
        }

        const token = signJwt({
            license_id: license.id,
            machine_id: license.machine_id,
            business_type: license.business_type,
            expires_at: license.expires_at
        }, JWT_SECRET);

        return res.json({
            success: true,
            token,
            license: {
                business_type: license.business_type,
                invoice_template: license.invoice_template,
                expires_at: license.expires_at,
                duration_days: license.duration_days
            }
        });
    } catch (e) {
        console.error('[activate error]:', e);
        return res.status(500).json({ success: false, error: e.message });
    }
});

router.post('/heartbeat', async (req, res) => {
    try {
        const { token, machine_id } = req.body || {};
        if (!token) return res.status(401).json({ success: false, error: 'no_token' });

        const payload = verifyJwt(token, JWT_SECRET);
        if (!payload || !payload.license_id) {
            return res.status(401).json({ success: false, error: 'invalid_token' });
        }

        const license = await db.prepare("SELECT * FROM licenses WHERE id=?").get(payload.license_id);
        if (!license || license.status !== 'active') {
            return res.status(403).json({ success: false, error: 'license_inactive' });
        }

        const now = new Date().toISOString();
        await db.prepare(`
            UPDATE licenses 
            SET last_heartbeat_at = ?, heartbeat_count = heartbeat_count + 1, updated_at = CURRENT_TIMESTAMP 
            WHERE id = ?
        `).run(now, license.id);

        return res.json({ success: true, server_time: now });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

router.post('/verify-key', async (req, res) => {
    try {
        const { activation_key } = req.body || {};
        if (!activation_key) return res.status(400).json({ error: 'missing_key' });

        const key = await db.prepare(`
            SELECT k.*, c.client_name, c.client_phone 
            FROM activation_keys k 
            LEFT JOIN clients c ON k.client_id = c.id 
            WHERE k.activation_key = ?
        `).get(activation_key);

        if (!key) return res.status(404).json({ error: 'not_found' });

        const activeLicense = await db.prepare("SELECT * FROM licenses WHERE activation_key_id=? ORDER BY id DESC LIMIT 1").get(key.id);

        return res.json({
            activation_key: key.activation_key,
            business_type: key.business_type,
            status: key.status,
            client_name: key.client_name,
            license: activeLicense ? { expires_at: activeLicense.expires_at, status: activeLicense.status } : null
        });
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

module.exports = router;
