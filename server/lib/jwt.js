'use strict';
/**
 * JWT self-implementation (HS256) — يجب أن يتطابق تماماً مع
 * lib/license.js في مشروع الديسكتوب.
 */
const crypto = require('crypto');

function base64url(input) {
    let b = Buffer.isBuffer(input) ? input : Buffer.from(input);
    return b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function base64urlDecode(input) {
    let s = String(input).replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    return Buffer.from(s, 'base64');
}

function signJwt(payload, secret) {
    const header = { alg: 'HS256', typ: 'JWT' };
    const encHeader = base64url(JSON.stringify(header));
    const encPayload = base64url(JSON.stringify(payload));
    const signingInput = encHeader + '.' + encPayload;
    const sig = crypto.createHmac('sha256', secret).update(signingInput).digest();
    const encSig = base64url(sig);
    return signingInput + '.' + encSig;
}

function verifyJwt(token, secret) {
    if (!token || typeof token !== 'string') return { valid: false, error: 'no_token' };
    const parts = token.split('.');
    if (parts.length !== 3) return { valid: false, error: 'invalid_format' };
    const [encHeader, encPayload, encSig] = parts;
    const signingInput = encHeader + '.' + encPayload;
    const expected = crypto.createHmac('sha256', secret).update(signingInput).digest();
    const actual = base64urlDecode(encSig);
    if (expected.length !== actual.length) return { valid: false, error: 'signature_length' };
    if (!crypto.timingSafeEqual(expected, actual)) return { valid: false, error: 'signature_mismatch' };
    let payload;
    try {
        payload = JSON.parse(base64urlDecode(encPayload).toString('utf8'));
    } catch (e) {
        return { valid: false, error: 'invalid_payload' };
    }
    return { valid: true, payload };
}

module.exports = { signJwt, verifyJwt };
