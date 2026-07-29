# تقنيات سوفت Pro — Cloud Sync Server

سيرفر مزامنة سحابي لتطبيق **تقنيات سوفت Pro** (Electron Desktop).
يعمل على **Render** ويحفظ البيانات على **Neon PostgreSQL** بحيث لا تضيع أبداً حتى لو دخل حساب Render مجاناً في وضع النوم.

- 🌐 **الرابط العام**: <https://server-1-dcrb.onrender.com>
- 🗄️ **قاعدة البيانات**: Neon PostgreSQL (eu-central-1)
- 🔒 **الأمان**: JWT + API Key + bcrypt + Rate Limiting + Helmet
- 🔄 **المزامنة**: كل 5 دقائق تلقائياً + عند إغلاق التطبيق

---

## 🏗️ المعمارية

```
┌─────────────────────┐        HTTPS (JSON)        ┌───────────────────┐        pg SSL         ┌──────────────────┐
│  Electron Desktop   │  ─────────────────────►    │   Render (Node)   │  ────────────────►    │  Neon Postgres   │
│  (SQLite محلياً)     │  ◄─────────────────────    │  Express Sync API │  ◄────────────────    │  (المصدر الدائم) │
└─────────────────────┘                            └───────────────────┘                       └──────────────────┘
      offline-first                                  قد ينام (مجاني)                            دائم لا ينام
```

- التطبيق يعمل بـ **SQLite محلياً** (سريع، بدون إنترنت).
- **كل 5 دقائق** يرفع التغييرات إلى Render → Neon.
- **عند إغلاق التطبيق** يرفع دفعة أخيرة قبل الخروج.
- إذا نام Render، أول ping يُوقظه ثم يستكمل السحب.
- **Neon هو المصدر الوحيد للحقيقة الدائمة** — Render مجرد بوابة.

---

## 🚀 النشر على Render (خطوات مفصلة)

### 1) رفع المستودع إلى GitHub

```bash
cd webapp-server
git init
git add .
git commit -m "Initial commit: Cloud Sync Server"
git remote add origin https://github.com/YOUR_USER/technologies-soft-pro-server.git
git push -u origin main
```

### 2) إنشاء الخدمة في Render

**الطريقة السريعة (Blueprint)**:
1. اذهب إلى <https://dashboard.render.com/> → **New** → **Blueprint**
2. اربط مستودع GitHub الذي رفعت عليه الكود
3. Render سيقرأ `render.yaml` وينشئ الخدمة تلقائياً
4. سيطلب منك **DATABASE_URL** و **API_KEY** — أدخلها من `.env`

**الطريقة اليدوية (Web Service)**:
1. **New** → **Web Service** → اربط GitHub
2. اختر Region: **Frankfurt (EU Central)** (قريب من Neon)
3. Runtime: **Node**
4. Build Command: `npm install`
5. Start Command: `npm start`
6. Plan: **Free**
7. أضف Environment Variables (انظر القسم التالي)

### 3) متغيرات البيئة على Render

في **Environment** بلوحة Render أضف:

| المفتاح | القيمة | ملاحظات |
|---|---|---|
| `DATABASE_URL` | `postgresql://authenticator:npg_KmX1PEDIU6eV@ep-damp-morning-aswkb2hz-pooler.c-4.eu-central-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require` | من Neon Console |
| `NODE_ENV` | `production` | |
| `PORT` | `10000` | Render يستخدم هذا داخلياً |
| `JWT_SECRET` | *مُولَّد عشوائياً — 64 حرف* | استخدم `openssl rand -hex 32` |
| `API_KEY` | *مفتاح مشترك مع التطبيق* | تضعه في cloud-sync.js أيضاً |
| `PUBLIC_URL` | `https://server-1-dcrb.onrender.com` | |
| `CORS_ORIGINS` | `*` | |
| `MAX_BODY_SIZE` | `50mb` | للنسخ الاحتياطية الكبيرة |

### 4) تحقق من العمل

```bash
curl https://server-1-dcrb.onrender.com/health
```

يجب أن يُرجع:
```json
{
  "ok": true,
  "service": "technologies-soft-pro-sync-server",
  "database": { "ok": true, "pg_version": "PostgreSQL 17..." },
  ...
}
```

---

## 📡 REST API

جميع المسارات (عدا `/`, `/health`, `/ping`) تتطلب Header:
`Authorization: Bearer <JWT_TOKEN>`

### Auth

#### `POST /api/auth/register`
تسجيل جهاز جديد وإصدار JWT.
```
Headers: X-API-Key: <API_KEY>
Body:    { "device_id": "abc-uuid", "device_name": "DESKTOP-1", "company_id": 1 }
```

#### `POST /api/auth/refresh`
تجديد الرمز.

#### `GET /api/auth/me`
معلومات الجهاز الحالي.

### Sync

#### `POST /api/sync/push`
رفع تغييرات (حد أقصى 5000 صف لكل رفعة).
```json
{
  "batch_id": "uuid-optional",
  "records": [
    {
      "table_name": "orders",
      "record_key": "1523",
      "record_data": { "id": 1523, "total": 250.0, ... },
      "local_updated_at": "2026-07-29T10:30:00Z",
      "is_deleted": false
    }
  ]
}
```

#### `GET /api/sync/pull?since=<ISO>&table=<name>&limit=1000`
سحب السجلات المُحدَّثة منذ وقت معين.

#### `GET /api/sync/status`
إحصائيات الجهاز والجداول.

#### `DELETE /api/sync/wipe`
مسح كل سجلات الشركة (يتطلب `X-Confirm: WIPE-<device_id>`).

### Backup

#### `POST /api/backup/upload`
رفع نسخة احتياطية كاملة (gzipped JSON).
```json
{
  "app_version": "6.6.0",
  "backup_type": "full",
  "tables_included": ["orders","products",...],
  "notes": "auto-backup",
  "payload_base64_gzip": "H4sIA..."
}
```

#### `GET /api/backup/list?limit=50`
قائمة النسخ الاحتياطية.

#### `GET /api/backup/:id/download`
تنزيل نسخة احتياطية محددة.

#### `DELETE /api/backup/:id`
حذف نسخة.

#### `DELETE /api/backup/prune/old?keep=10`
مسح النسخ القديمة والاحتفاظ بأحدث N.

### Restore

#### `GET /api/restore/latest`
أحدث نسخة احتياطية كاملة.

#### `GET /api/restore/all-records?table=<optional>`
كل السجلات الحية (بديل عن Snapshot).

---

## 🗄️ مخطط قاعدة البيانات (Neon)

### الاستراتيجية الذكية

بدلاً من نسخ **83 جدولاً** من SQLite، نستخدم **Universal Sync Store**:
- جدول واحد `sync_records` يخزّن كل صف كـ **JSONB**.
- مفهرس بـ **GIN** للبحث السريع داخل JSON.
- أي تغيير في هيكل SQLite لا يحتاج migration في السيرفر ✨

### الجداول

| الجدول | الغرض |
|---|---|
| `devices` | كل تثبيت للتطبيق = صف واحد (JWT، آخر مزامنة) |
| `sync_records` | Universal store لكل الصفوف — `(company_id, table_name, record_key)` مفتاح فريد |
| `sync_log` | Audit trail لكل رفعة |
| `backups` | نسخ احتياطية كاملة مضغوطة (BYTEA) |
| `server_settings` | إعدادات السيرفر |

---

## 🔒 الأمان

- ✅ **HTTPS مفروض** (Render + Neon)
- ✅ **JWT** بعمر 30 يوم (قابل للتجديد)
- ✅ **API Key** لتسجيل الأجهزة الأول
- ✅ **bcrypt** لتجزئة أي كلمة سر
- ✅ **Helmet** — HTTP headers أمنية
- ✅ **Rate Limiting** — 300 طلب / دقيقة
- ✅ **SQL Injection**: كل الاستعلامات باستخدام parameterized queries
- ✅ **Body Size Limit**: 50MB (للنسخ الاحتياطية) + validation صارم
- ✅ **CORS** قابل للضبط
- ✅ **`trust proxy`** — يتعامل مع Cloudflare بشكل صحيح

---

## 🧪 التشغيل محلياً

```bash
cd webapp-server
cp .env.example .env
# عدّل .env بمعطيات Neon
npm install
npm run init-db     # مرة واحدة — ينشئ الجداول
npm start           # يبدأ السيرفر على :10000
```

اختبار:
```bash
curl http://localhost:10000/health
```

---

## 📊 تكلفة صفرية

- **Render Free**: 750 ساعة/شهر (كافية جداً)
- **Neon Free**: 0.5 GB تخزين + 190 ساعة حاسوب/شهر
- التطبيق مصمم لتقليل استهلاك Neon (batching + compression + prune)

---

## 🛠️ الأدوات

- `npm start` — تشغيل السيرفر
- `npm run dev` — تشغيل مع reload تلقائي
- `npm run init-db` — تهيئة قاعدة البيانات (idempotent)
- `npm test` — فحص الاتصال بـ Neon

---

## 📝 الرخصة

Proprietary — تقنيات سوفت — م/ عبدالرحمن الاكوع
