# تقنيات سوفت Pro v5.7.0 — خادم الترخيص (Render.com)

خادم Node.js/Express متكامل يُدير التراخيص السحابية لنظام **تقنيات سوفت Pro** المحاسبي، ويعمل على منصة **Render.com**.

## المكوّنات

| المكوّن | الوصف | المسار |
|---|---|---|
| **API عام** | تفعيل وتحديث التراخيص للأجهزة | `/api/*` |
| **API إداري** | إدارة العملاء والمفاتيح والتراخيص | `/api/admin/*` (Basic Auth) |
| **لوحة الإدارة** | Bootstrap 5 RTL - Dashboard + جداول | `/admin` (Basic Auth) |
| **بوابة العميل** | التحقق العام من صلاحية المفتاح | `/web` |
| **WebSocket** | تحديثات لحظية للوحة | `/ws` |

## التشغيل المحلي

```bash
# 1. تنصيب الاعتمادات
npm install

# 2. نسخ ملف البيئة
cp .env.example .env
# ثم عدّل .env — أهم قيمة: JWT_SECRET (يجب أن تطابق التي في تطبيق سطح المكتب)

# 3. تهيئة قاعدة البيانات
npm run init:db

# 4. (اختياري) ملء ببيانات تجريبية
npm run seed

# 5. تشغيل الخادم
npm start
# أو مع إعادة تحميل تلقائية:
npm run dev
```

الخادم يعمل افتراضياً على `http://localhost:10000`

## النشر على Render.com

### الخطوة 1 - إنشاء الخدمة

1. سجّل الدخول إلى [render.com](https://render.com)
2. اضغط **New +** → **Web Service**
3. اربط GitHub repository أو ارفع الكود مباشرة
4. الإعدادات:
   - **Environment**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: `Free` (للتجربة) أو `Starter` (للإنتاج)

### الخطوة 2 - متغيرات البيئة

أضف في تبويب **Environment**:

| المتغير | القيمة | ملاحظة |
|---|---|---|
| `JWT_SECRET` | `ts-pro-v5.7.0-shared-secret-2025-abdulrahman-al-akwa` | **يجب** أن يطابق desktop app |
| `ADMIN_USERNAME` | `admin` | اسم مستخدم لوحة الإدارة |
| `ADMIN_PASSWORD` | *(قوي - 20 حرف على الأقل)* | كلمة مرور لوحة الإدارة |
| `NODE_ENV` | `production` | |
| `CORS_ORIGINS` | `*` | أو أصول محددة مفصولة بفواصل |
| `DB_PATH` | `/data/license.db` | يتطلب Persistent Disk |

### الخطوة 3 - Persistent Disk (مهم!)

لأن SQLite تحتاج تخزيناً دائماً:
1. في **Disks** أضف قرصاً جديداً
2. **Name**: `db-storage`
3. **Mount Path**: `/data`
4. **Size**: `1 GB` (كافٍ للبدء)

### الخطوة 4 - التحقق من التشغيل

بعد النشر:
- افتح: `https://YOUR-APP.onrender.com/` → صفحة الترحيب
- افتح: `https://YOUR-APP.onrender.com/api/health` → JSON بحالة الخادم
- افتح: `https://YOUR-APP.onrender.com/admin` → يطلب Basic Auth
- افتح: `https://YOUR-APP.onrender.com/web` → بوابة العميل

## نقاط النهاية (API)

### API عام (client-facing)

#### `POST /api/activate`
تفعيل مفتاح ترخيص جديد على جهاز.

**Request:**
```json
{
  "activation_key": "XXXX-XXXX-XXXX-XXXX",
  "machine_id": "sha256-composite-fingerprint",
  "fingerprint": "same-or-different-hash",
  "client_version": "5.7.0"
}
```

**Response:**
```json
{
  "token": "eyJhbGc...JWT...",
  "payload": {
    "v": "5.7.0",
    "license_id": 123,
    "machine_id": "...",
    "business_type": "restaurant",
    "invoice_template": "receipt_80mm",
    "issued_at": "2025-01-15T10:00:00.000Z",
    "expires_at": "2025-02-14T10:00:00.000Z",
    "duration_days": 30
  }
}
```

#### `POST /api/heartbeat`
تحديث دوري (نبضة قلب) - يجدّد JWT.

**Request:**
```json
{
  "token": "current-jwt",
  "machine_id": "same-fingerprint",
  "fingerprint": "hash",
  "client_version": "5.7.0"
}
```

**Response:** توكن جديد مُجدَّد.

#### `POST /api/verify-key`
تحقق عام من صلاحية مفتاح (للواجهة الويب).

**Request:** `{ "activation_key": "XXXX-XXXX-XXXX-XXXX" }`

**Response:** معلومات المفتاح والترخيص (بدون تعديل).

#### `GET /api/health`
فحص حالة الخادم.

### API إداري (`/api/admin`)
جميعها تحتاج Basic Auth. راجع `server/routes/admin.js`.

- `GET /dashboard` - إحصاءات عامة
- `GET/POST/PUT/DELETE /clients` - إدارة العملاء
- `GET/POST /keys` + `POST /keys/:id/revoke`
- `GET /licenses` + `POST /licenses/:id/{revoke,freeze,unfreeze,extend}`
- `GET /events`

## الأمان

- **JWT HS256** بمُصادقة `timingSafeEqual` (لا مكتبة خارجية)
- **Basic Auth** للوحة الإدارة (timing-safe)
- **Rate Limiting** 60 طلب/دقيقة على `/api/*`
- **CORS** قابل للتخصيص عبر `CORS_ORIGINS`
- **SQL Injection** محميّ 100% بـ prepared statements
- **JWT_SECRET** يجب أن يطابق desktop app (وإلا فشل التوقيع)

## بنية المجلدات

```
webapp-render/
├── server/
│   ├── index.js              # نقطة الدخول - Express + WS
│   ├── db/
│   │   ├── index.js          # قاعدة البيانات - better-sqlite3
│   │   ├── schema.sql        # هيكل الجداول (6 جداول)
│   │   └── seed.js           # بيانات تجريبية
│   ├── lib/
│   │   ├── jwt.js            # HS256 (بدون مكتبة خارجية)
│   │   └── utils.js          # generateActivationKey, computeExpiryDate
│   ├── middleware/
│   │   ├── adminAuth.js      # Basic Auth
│   │   └── rateLimit.js      # 60/دقيقة
│   └── routes/
│       ├── api.js            # /activate /heartbeat /verify-key /health
│       └── admin.js          # /clients /keys /licenses /events /dashboard
├── admin/
│   └── public/
│       ├── index.html        # Bootstrap 5 RTL - 5 tabs
│       └── app.js            # Fetch + WebSocket + CRUD
├── web/
│   └── public/
│       ├── index.html        # صفحة تحقق العميل
│       └── app.js            # منطق التحقق
├── package.json
├── .env.example
└── README.md
```

## قاعدة البيانات

**6 جداول:**
1. `clients` - العملاء
2. `activation_keys` - مفاتيح التفعيل (قبل الاستخدام)
3. `licenses` - التراخيص المُفعّلة
4. `license_events` - سجل الأحداث (audit)
5. `admin_users` - مستخدمو الإدارة
6. `stats_cache` - كاش الإحصائيات

جميع الجداول مفهرسة بأعمدة البحث الشائعة.

## سيناريو الاستخدام الكامل

1. **الإدارة** → لوحة `/admin` → إنشاء عميل جديد
2. **الإدارة** → إنشاء مفتاح تفعيل (يختار النشاط + القالب + المدة + عدد الأجهزة)
3. **العميل** يستلم المفتاح (بصيغة `XXXX-XXXX-XXXX-XXXX`)
4. **العميل** → في تطبيق سطح المكتب → معالج الإعداد → إدخال المفتاح
5. Desktop → `POST /api/activate` → يرد بـ JWT + بيانات الترخيص
6. Desktop → يحفظ الترخيص محلياً (بصمة جهاز + JWT)
7. Desktop → كل 24 ساعة → `POST /api/heartbeat` → تجديد
8. عند انقطاع الإنترنت → فترة سماح (grace period) تلقائية:
   - يومي: 0 أيام | أسبوعي: 3 أيام | شهري: 7 أيام | سنوي: 15 يوم | أكثر: 30 يوم

## استكشاف الأخطاء

**"invalid_activation_key"** - المفتاح غير موجود أو محذوف
**"key_revoked"** - أُلغي من لوحة الإدارة
**"key_expired"** - تجاوز `key_expires_at`
**"max_activations_reached"** - استُنفدت التفعيلات المسموحة
**"machine_mismatch"** - محاولة heartbeat من جهاز مختلف
**"invalid_token"** - JWT مُبدّل أو JWT_SECRET غير متطابق
**"license_revoked"** / **"license_frozen"** / **"license_expired"** - حالة الترخيص

## التواصل

📞 **التواصل مع إدارة نظام تقنيات سوفت المحاسبي +967 773579486**

---
© 2025 تقنيات سوفت Pro - جميع الحقوق محفوظة
