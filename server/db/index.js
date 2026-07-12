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

// تطبيق الـ schema
function initSchema() {
    const schemaPath = path.join(__dirname, 'schema.sql');
    const sql = fs.readFileSync(schemaPath, 'utf8');
    db.exec(sql);
    console.log('[db] schema applied at', DB_PATH);
}

initSchema();

module.exports = db;
module.exports.DB_PATH = DB_PATH;
