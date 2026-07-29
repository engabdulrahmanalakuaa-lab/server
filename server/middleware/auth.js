/**
 * ═══════════════════════════════════════════════════════════════════════
 * Auth Middleware — التحقق من JWT + API Key
 * ═══════════════════════════════════════════════════════════════════════
 */

'use strict';

const jwt = require('jsonwebtoken');
const crypto = require('crypto');

// ─── القيم الافتراضية (يجب أن تتطابق مع lib/cloud-sync.js في التطبيق) ───
const DEFAULT_API_KEY = 'technologies_soft_pro_default_api_key_change_me_before_deploy';

// JWT_SECRET: إن لم يوجد نولّد واحداً عشوائياً (لكن سيتغيّر مع كل إعادة تشغيل!)
let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.trim() === '') {
    JWT_SECRET = crypto.randomBytes(64).toString('hex');
    console.warn('[auth] ⚠️  JWT_SECRET غير مضبوط — تم توليد قيمة عشوائية مؤقتة.');
    console.warn('[auth] ⚠️  الرموز (tokens) ستُبطَل مع كل إعادة تشغيل للسرفر.');
    console.warn('[auth] ⚠️  اضبط JWT_SECRET في Render → Environment للاستخدام الإنتاجي.');
} else {
    console.log('[auth] ✅ JWT_SECRET مضبوط بشكل صحيح');
}

// API_KEY: إن لم يوجد نستخدم القيمة الافتراضية (المطابقة للتطبيق)
let API_KEY = process.env.API_KEY;
if (!API_KEY || API_KEY.trim() === '') {
    API_KEY = DEFAULT_API_KEY;
    console.warn('[auth] ⚠️  API_KEY غير مضبوط في Environment — استخدام القيمة الافتراضية.');
    console.warn('[auth] ⚠️  يُنصح بضبط API_KEY خاص بك في Render → Environment قبل الإنتاج.');
} else {
    console.log('[auth] ✅ API_KEY مضبوط بشكل صحيح');
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

module.exports = { signDeviceToken, verifyDeviceToken, requireApiKey, requireAuth, API_KEY, JWT_SECRET };
