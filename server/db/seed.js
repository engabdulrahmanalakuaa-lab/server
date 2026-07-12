'use strict';
/**
 * ============================================================
 * تقنيات سوفت Pro v5.7.0 - Seed Data
 * ============================================================
 * ملء قاعدة البيانات ببيانات تجريبية للتطوير:
 *   - 5 عملاء افتراضيين
 *   - 8 مفاتيح تفعيل (بأنشطة وقوالب متنوعة)
 *   - مستخدم إداري افتراضي (إذا لم يوجد)
 *
 * الاستخدام:  npm run seed
 * ملاحظة: يعمل بأمان مع INSERT OR IGNORE (لا يكرر البيانات)
 */
const db = require('./index');
const { generateActivationKey, computeExpiryDate } = require('../lib/utils');
const crypto = require('crypto');

console.log('====================================================');
console.log('  Seeding database with sample data...');
console.log('  DB path:', db.DB_PATH);
console.log('====================================================');

// ============================================================
// 1) عملاء تجريبيون
// ============================================================
const sampleClients = [
    {
        client_name: 'مؤسسة الأمل التجارية',
        client_phone: '+967-777-100200',
        client_email: 'amal@example.com',
        country: 'اليمن', city: 'صنعاء',
        address: 'شارع الزبيري - جوار جامع الشعب',
        notes: 'عميل مميز - قطاع السوبرماركت'
    },
    {
        client_name: 'صيدلية النور',
        client_phone: '+967-778-333444',
        client_email: 'noor@example.com',
        country: 'اليمن', city: 'عدن',
        address: 'شارع المعلا',
        notes: 'صيدلية 24 ساعة'
    },
    {
        client_name: 'مطعم الشام الأصيل',
        client_phone: '+967-771-555666',
        client_email: 'sham@example.com',
        country: 'اليمن', city: 'تعز',
        address: 'حي الحصب',
        notes: 'مطعم شرقي'
    },
    {
        client_name: 'محطة النخيل للوقود',
        client_phone: '+967-770-777888',
        client_email: 'nakhil@example.com',
        country: 'اليمن', city: 'الحديدة',
        address: 'الطريق الدولي',
        notes: 'محطة وقود كبيرة'
    },
    {
        client_name: 'مصنع الاتحاد للخرسانة',
        client_phone: '+967-773-999000',
        client_email: 'union@example.com',
        country: 'اليمن', city: 'إب',
        address: 'المنطقة الصناعية',
        notes: 'مصنع خرسانة جاهزة'
    }
];

const insertClient = db.prepare(`
    INSERT OR IGNORE INTO clients
    (client_name, client_phone, client_email, country, city, address, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const findClient = db.prepare('SELECT id FROM clients WHERE client_name = ?');

const clientIds = {};
db.transaction(() => {
    for (const c of sampleClients) {
        insertClient.run(c.client_name, c.client_phone, c.client_email,
            c.country, c.city, c.address, c.notes);
        const row = findClient.get(c.client_name);
        if (row) clientIds[c.client_name] = row.id;
    }
})();

console.log(`✓ Clients inserted: ${Object.keys(clientIds).length}`);

// ============================================================
// 2) مفاتيح تفعيل تجريبية
// ============================================================
const sampleKeys = [
    { client: 'مؤسسة الأمل التجارية', business: 'supermarket',
      template: 'receipt_80mm', days: 365, max: 1, notes: 'ترخيص سنوي' },
    { client: 'صيدلية النور', business: 'pharmacy',
      template: 'receipt_80mm', days: 30, max: 2, notes: 'شهري - جهازين' },
    { client: 'مطعم الشام الأصيل', business: 'restaurant',
      template: 'receipt_80mm', days: 180, max: 3, notes: '6 شهور - 3 أجهزة' },
    { client: 'محطة النخيل للوقود', business: 'fuel_station',
      template: 'receipt_80mm', days: 365, max: 1, notes: 'سنوي - محطة وقود' },
    { client: 'مصنع الاتحاد للخرسانة', business: 'concrete_factory',
      template: 'construction_a4', days: 730, max: 2, notes: 'سنتين - مصنع' },
    // مفاتيح تجريبية بدون عميل محدد
    { client: null, business: 'exchange_office',
      template: 'remittance_a5', days: 90, max: 1, notes: 'مفتاح صرافة تجريبي' },
    { client: null, business: 'electricity_station',
      template: 'electricity_a5', days: 365, max: 1, notes: 'مفتاح كهرباء تجريبي' },
    { client: null, business: 'fertilizer_shop',
      template: 'receipt_80mm', days: 30, max: 1, notes: 'أسمدة - شهري تجريبي' }
];

// حذف المفاتيح التجريبية السابقة (بناءً على notes)
db.prepare("DELETE FROM activation_keys WHERE notes IN (" +
    sampleKeys.map(k => '?').join(',') + ") AND used_activations = 0"
).run(...sampleKeys.map(k => k.notes));

const insertKey = db.prepare(`
    INSERT INTO activation_keys
    (activation_key, client_id, business_type, invoice_template,
     duration_days, max_activations, notes, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'active')
`);

const createdKeys = [];
db.transaction(() => {
    for (const sk of sampleKeys) {
        // ضمان مفتاح فريد
        let key = null;
        for (let i = 0; i < 20; i++) {
            const candidate = generateActivationKey();
            const dup = db.prepare("SELECT id FROM activation_keys WHERE activation_key=?").get(candidate);
            if (!dup) { key = candidate; break; }
        }
        if (!key) continue;
        const cid = sk.client ? (clientIds[sk.client] || null) : null;
        insertKey.run(key, cid, sk.business, sk.template, sk.days, sk.max, sk.notes);
        createdKeys.push({ key, ...sk });
    }
})();

console.log(`✓ Activation keys inserted: ${createdKeys.length}`);
console.log('');
console.log('  Sample keys (save these for testing):');
console.log('  ------------------------------------------------------');
createdKeys.forEach((k, i) => {
    const client = k.client || '(بدون عميل)';
    console.log(`  ${(i+1).toString().padStart(2)}. ${k.key} — ${k.business.padEnd(20)} — ${client}`);
});
console.log('  ------------------------------------------------------');

// ============================================================
// 3) مستخدم إداري افتراضي (اختياري - للسجلات)
// ============================================================
const adminUsername = process.env.ADMIN_USERNAME || 'admin';
const existing = db.prepare('SELECT id FROM admin_users WHERE username=?').get(adminUsername);
if (!existing) {
    const passwordPlain = process.env.ADMIN_PASSWORD || 'admin123';
    const hash = crypto.createHash('sha256').update(passwordPlain).digest('hex');
    db.prepare(`
        INSERT INTO admin_users (username, password_hash, full_name, role)
        VALUES (?, ?, ?, 'admin')
    `).run(adminUsername, hash, 'System Administrator');
    console.log(`✓ Admin user created: ${adminUsername}`);
    console.log(`  Note: password stored as SHA-256 hash for reference only.`);
    console.log(`  Actual authentication uses Basic Auth from .env`);
} else {
    console.log(`  Admin user already exists: ${adminUsername}`);
}

console.log('');
console.log('====================================================');
console.log('  Seeding completed successfully.');
console.log('====================================================');
console.log('  Login:');
console.log(`    Admin panel:  http://localhost:${process.env.PORT || 10000}/admin`);
console.log(`    Username:     ${process.env.ADMIN_USERNAME || 'admin'}`);
console.log(`    Password:     (from .env ADMIN_PASSWORD)`);
console.log('====================================================');
