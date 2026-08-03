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

/**
 * v6.8.0: توليد كود إعادة تعيين كلمة المرور — 8 خانات هجينة (أرقام+أحرف كبيرة، بدون 0/O/I/1 لتجنّب الالتباس)
 * مثال: A3F7-K9M2
 */
function generateResetCode() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // بدون 0/O/I/1
    const buf = crypto.randomBytes(8);
    let out = '';
    for (let i = 0; i < 8; i++) {
        out += alphabet[buf[i] % alphabet.length];
    }
    return `${out.substring(0, 4)}-${out.substring(4, 8)}`;
}

/**
 * v6.8.0: قائمة أنواع الأنشطة المدعومة (server-side validation)
 */
const VALID_BUSINESS_TYPES = new Set([
    // المطاعم والمأكولات
    'restaurant', 'cafe', 'fastfood', 'buffet', 'cloud_kitchen', 'bakery',
    // الصحة
    'pharmacy', 'vet_pharmacy', 'hospital', 'clinic', 'radiology', 'lab',
    // التجزئة والمحلات
    'supermarket', 'electronics', 'jewelry', 'perfume', 'clothing', 'bookstore', 'general_store', 'mall',
    // الخدمات
    'car_service', 'mobile_service', 'gym', 'training_center', 'law_office',
    // الصناعة والمقاولات
    'construction_materials', 'contracting', 'engineering', 'factory', 'concrete_factory',
    // الزراعة والطاقة والمالية
    'fertilizer_shop', 'fuel_station', 'electricity_station', 'exchange_office'
]);

const VALID_INVOICE_TEMPLATES = new Set([
    'receipt_80mm', 'remittance_a5', 'construction_a4', 'electricity_a5'
]);

module.exports = {
    generateActivationKey,
    computeExpiryDate,
    computeGracePeriodDays,
    safeString,
    generateResetCode,
    VALID_BUSINESS_TYPES,
    VALID_INVOICE_TEMPLATES
};
