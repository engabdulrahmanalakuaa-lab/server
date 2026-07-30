'use strict';
/**
 * Basic Auth بسيط للـ Admin Panel
 * يقارن ضد ADMIN_USERNAME + ADMIN_PASSWORD من env
 */
const crypto = require('crypto');

function timingSafeEqualStr(a, b) {
    const ba = Buffer.from(a || '', 'utf8');
    const bb = Buffer.from(b || '', 'utf8');
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
}

function adminAuth(req, res, next) {
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Basic ')) {
        res.set('WWW-Authenticate', 'Basic realm="TS Pro Admin"');
        return res.status(401).json({ error: 'unauthorized' });
    }
    try {
        const decoded = Buffer.from(auth.substring(6), 'base64').toString('utf8');
        const idx = decoded.indexOf(':');
        if (idx < 0) return res.status(401).json({ error: 'invalid_credentials' });
        const user = decoded.substring(0, idx);
        const pass = decoded.substring(idx + 1);
        const expectedUser = process.env.ADMIN_USERNAME || 'admin';
        const expectedPass = process.env.ADMIN_PASSWORD || 'admin';
        if (!timingSafeEqualStr(user, expectedUser) || !timingSafeEqualStr(pass, expectedPass)) {
            res.set('WWW-Authenticate', 'Basic realm="TS Pro Admin"');
            return res.status(401).json({ error: 'invalid_credentials' });
        }
        req.adminUser = user;
        next();
    } catch (e) {
        res.set('WWW-Authenticate', 'Basic realm="TS Pro Admin"');
        return res.status(401).json({ error: 'invalid_credentials' });
    }
}

module.exports = adminAuth;
