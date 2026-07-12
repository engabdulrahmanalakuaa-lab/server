'use strict';
/**
 * Rate Limiter بسيط في الذاكرة (لا يحتاج Redis)
 * كافٍ لخادم واحد على Render Free/Starter
 */
const buckets = new Map();

function rateLimit(options = {}) {
    const windowMs = options.windowMs || Number(process.env.RATE_LIMIT_WINDOW_MS) || 60000;
    const max = options.max || Number(process.env.RATE_LIMIT_MAX) || 60;
    return function (req, res, next) {
        const ip = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
        const key = String(ip).split(',')[0].trim();
        const now = Date.now();
        let b = buckets.get(key);
        if (!b || now - b.start > windowMs) {
            b = { start: now, count: 0 };
            buckets.set(key, b);
        }
        b.count++;
        if (b.count > max) {
            res.set('Retry-After', String(Math.ceil((b.start + windowMs - now) / 1000)));
            return res.status(429).json({ error: 'rate_limit_exceeded' });
        }
        next();
    };
}

// تنظيف دوري
setInterval(() => {
    const now = Date.now();
    const windowMs = Number(process.env.RATE_LIMIT_WINDOW_MS) || 60000;
    for (const [k, v] of buckets.entries()) {
        if (now - v.start > windowMs * 2) buckets.delete(k);
    }
}, 5 * 60 * 1000).unref();

module.exports = rateLimit;
