'use strict';
const crypto = require('crypto');

/**
 * توليد مفتاح تفعيل بصيغة XXXX-XXXX-XXXX-XXXX
 */
function generateActivationKey() {
    const bytes = crypto.randomBytes(8); // 8 bytes = 16 hex chars
    const hex = bytes.toString('hex').toUpperCase();
    return `${hex.substring(0,4)}-${hex.substring(4,8)}-${hex.substring(8,12)}-${hex.substring(12,16)}`;
}

/**
 * تحويل duration_days → ISO expiry date
 */
function computeExpiryDate(days, fromDate) {
    const start = fromDate ? new Date(fromDate) : new Date();
    const expiry = new Date(start.getTime() + days * 24 * 60 * 60 * 1000);
    return expiry.toISOString();
}

/**
 * حساب فترة السماح (grace period) بالأيام حسب مدة الترخيص
 */
function computeGracePeriodDays(durationDays) {
    if (durationDays <= 1) return 0;      // يومي
    if (durationDays <= 7) return 3;      // أسبوعي
    if (durationDays <= 31) return 7;     // شهري
    if (durationDays <= 366) return 15;   // سنوي
    return 30;                             // أكثر من سنة
}

/**
 * ملخّص للإحصائيات
 */
function safeString(v, max = 500) {
    if (v === null || v === undefined) return '';
    return String(v).substring(0, max);
}

module.exports = {
    generateActivationKey,
    computeExpiryDate,
    computeGracePeriodDays,
    safeString
};
