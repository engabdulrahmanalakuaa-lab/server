'use strict';
/**
 * قاعدة البيانات - SQLite (better-sqlite3)
 * على Render يُفضّل ربط Persistent Disk بمسار /data
 */
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', '..', 'data', 'license.db');

// إنشاء المجلد إن لم يكن موجوداً
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

/**
 * v5.7.6: إضافة عمود بأمان (لا يفشل إن كان العمود موجوداً مسبقاً)
 */
function safeAlter(table, column, definition) {
    try {
        // فحص وجود العمود عبر PRAGMA table_info
        const cols = db.prepare(`PRAGMA table_info(${table})`).all();
        if (cols.some(c => c.name === column)) return; // موجود
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
        console.log(`[db] safeAlter added: ${table}.${column}`);
    } catch (e) {
        // اطبع تحذير فقط إذا لم يكن السبب "duplicate"
        const msg = e && e.message || String(e);
        if (!/duplicate column|already exists/i.test(msg)) {
            console.warn(`[db] safeAlter ${table}.${column} failed:`, msg);
        }
    }
}

// تطبيق الـ schema
function initSchema() {
    const schemaPath = path.join(__dirname, 'schema.sql');
    const sql = fs.readFileSync(schemaPath, 'utf8');
    db.exec(sql);

    // v5.7.6: ترقية الأعمدة على القواعد الموجودة (لا يفشل إن كانت جديدة)
    safeAlter('clients', 'business_type', 'TEXT');
    safeAlter('clients', 'invoice_template', 'TEXT');
    safeAlter('licenses', 'suspended', "INTEGER DEFAULT 0"); // تعليق مؤقت (منفصل عن revoked)
    safeAlter('licenses', 'suspended_at', 'TEXT');
    safeAlter('licenses', 'suspended_reason', 'TEXT');
    safeAlter('licenses', 'suspended_by', 'TEXT');
    safeAlter('licenses', 'ip_address', 'TEXT');
    safeAlter('licenses', 'user_agent', 'TEXT');
    safeAlter('licenses', 'last_ip', 'TEXT');

    console.log('[db] schema applied at', DB_PATH);
}

initSchema();

module.exports = db;
module.exports.DB_PATH = DB_PATH;
module.exports.safeAlter = safeAlter;
