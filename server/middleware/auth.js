/**
 * ═══════════════════════════════════════════════════════════════════════
 * Auth Middleware — التحقق من JWT + API Key
 * ═══════════════════════════════════════════════════════════════════════
 */

'use strict';

const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
const API_KEY = process.env.API_KEY;

if (!JWT_SECRET) {
    console.error('[auth] ❌ JWT_SECRET غير مضبوط!');
    process.exit(1);
}
if (!API_KEY) {
    console.error('[auth] ❌ API_KEY غير مضبوط!');
    process.exit(1);
}

/**
 * توليد token جديد لجهاز مُسجَّل
 */
function signDeviceToken(payload) {
    return jwt.sign(payload, JWT_SECRET, {
        expiresIn: process.env.JWT_EXPIRES_IN || '30d',
        issuer: 'technologies-soft-pro'
    });
}

/**
 * التحقق من token
 */
function verifyDeviceToken(token) {
    try {
        return { ok: true, payload: jwt.verify(token, JWT_SECRET) };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

/**
 * Middleware — يتطلب API Key صحيح (للتسجيل الأولي)
 * Header: X-API-Key: <API_KEY>
 */
function requireApiKey(req, res, next) {
    const provided = req.headers['x-api-key'];
    if (!provided) {
        return res.status(401).json({ success: false, error: 'X-API-Key header مفقود' });
    }
    if (provided !== API_KEY) {
        return res.status(403).json({ success: false, error: 'API Key غير صحيح' });
    }
    next();
}

/**
 * Middleware — يتطلب JWT صحيح (للعمليات المُصادَق عليها)
 * Header: Authorization: Bearer <TOKEN>
 */
function requireAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ success: false, error: 'Authorization header مفقود' });
    }
    const token = authHeader.slice(7).trim();
    const result = verifyDeviceToken(token);
    if (!result.ok) {
        return res.status(401).json({ success: false, error: 'رمز غير صالح: ' + result.error });
    }
    req.device = result.payload; // { device_id, company_id, ... }
    next();
}

module.exports = { signDeviceToken, verifyDeviceToken, requireApiKey, requireAuth };
