'use strict';
/**
 * ═══════════════════════════════════════════════════════════════════════
 * تقنيات سوفت Pro - Seed Data (PostgreSQL / Neon)
 * ═══════════════════════════════════════════════════════════════════════
 *  npm run seed
 *  يعمل بأمان مع ON CONFLICT DO NOTHING (لا يكرر البيانات)
 * ═══════════════════════════════════════════════════════════════════════
 */
require('dotenv').config();

const db = require('./index');
const { generateActivationKey } = require('../lib/utils');
const crypto = require('crypto');

async function main() {
    console.log('====================================================');
    console.log('  Seeding Neon PostgreSQL with sample data...');
    console.log('====================================================');

    // تطبيق schema أولاً
    await db.initSchema();

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

    const clientIds = {};
    for (const c of sampleClients) {
        // ابحث أولاً
        const existing = await db.query('SELECT id FROM ts_clients WHERE client_name = $1', [c.client_name]);
        if (existing.rows.length > 0) {
            clientIds[c.client_name] = existing.rows[0].id;
            continue;
        }
        const r = await db.query(`
            INSERT INTO ts_clients (client_name, client_phone, client_email, country, city, address, notes)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING id
        `, [c.client_name, c.client_phone, c.client_email, c.country, c.city, c.address, c.notes]);
        clientIds[c.client_name] = r.rows[0].id;
    }
    console.log(`✓ Clients ready: ${Object.keys(clientIds).length}`);

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
        { client: null, business: 'exchange_office',
          template: 'remittance_a5', days: 90, max: 1, notes: 'مفتاح صرافة تجريبي' },
        { client: null, business: 'electricity_station',
          template: 'electricity_a5', days: 365, max: 1, notes: 'مفتاح كهرباء تجريبي' },
        { client: null, business: 'fertilizer_shop',
          template: 'receipt_80mm', days: 30, max: 1, notes: 'أسمدة - شهري تجريبي' }
    ];

    // حذف المفاتيح التجريبية غير المستخدمة (بناءً على notes) لإعادة التوليد
    const noteList = sampleKeys.map(k => k.notes);
    await db.query(
        `DELETE FROM ts_activation_keys WHERE notes = ANY($1::text[]) AND used_activations = 0`,
        [noteList]
    );

    const createdKeys = [];
    for (const sk of sampleKeys) {
        let key = null;
        for (let i = 0; i < 20; i++) {
            const candidate = generateActivationKey();
            const dup = await db.query('SELECT id FROM ts_activation_keys WHERE activation_key=$1', [candidate]);
            if (dup.rows.length === 0) { key = candidate; break; }
        }
        if (!key) continue;
        const cid = sk.client ? (clientIds[sk.client] || null) : null;
        await db.query(`
            INSERT INTO ts_activation_keys
            (activation_key, client_id, business_type, invoice_template,
             duration_days, max_activations, notes, status)
            VALUES ($1, $2, $3, $4, $5, $6, $7, 'active')
        `, [key, cid, sk.business, sk.template, sk.days, sk.max, sk.notes]);
        createdKeys.push({ key, ...sk });
    }

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
    const existing = await db.query('SELECT id FROM ts_admin_users WHERE username=$1', [adminUsername]);
    if (existing.rows.length === 0) {
        const passwordPlain = process.env.ADMIN_PASSWORD || 'admin123';
        const hash = crypto.createHash('sha256').update(passwordPlain).digest('hex');
        await db.query(`
            INSERT INTO ts_admin_users (username, password_hash, full_name, role)
            VALUES ($1, $2, $3, 'admin')
        `, [adminUsername, hash, 'System Administrator']);
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

    await db.close();
    process.exit(0);
}

main().catch(err => {
    console.error('[seed] ❌', err);
    process.exit(1);
});
