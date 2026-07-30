# تقنيات سوفت Pro - License Server v5.7.0

خادم إدارة تراخيص متكامل للتطبيق المكتبي، يعمل على **Render.com** ويستخدم **Neon PostgreSQL** كقاعدة بيانات دائمة (لا تضيع البيانات عند نوم Render).

## 🎯 المميزات

- 🔑 إصدار مفاتيح تفعيل (بصيغة `XXXX-XXXX-XXXX-XXXX`)
- 👥 إدارة العملاء (CRUD كامل)
- 📜 تفعيل التراخيص + التحقق منها (activate/heartbeat)
- ❄️ تجميد/إلغاء تجميد/إلغاء التراخيص
- ⏰ تمديد مدة الترخيص
- 📊 لوحة إحصائيات + Dashboard
- 🌐 واجهة ويب عامة للتحقق من المفاتيح (`/web`)
- 🎛️ لوحة إدارة محمية بـ Basic Auth (`/admin`)
- 📡 WebSocket للتحديثات الحيّة (`/ws`)
- 📝 سجل أحداث كامل (audit trail)
- 🚦 Rate limiting (60 طلب/دقيقة افتراضياً)
- 🐘 **Neon PostgreSQL** — قاعدة بيانات دائمة، لا تتأثر بنوم Render

## 📋 المتطلبات

- Node.js 18+
- حساب Neon مجاني: https://console.neon.tech/
- حساب Render مجاني: https://dashboard.render.com/

## 🚀 النشر على Render (خطوة بخطوة)

### 1) رفع الكود على GitHub

```bash
cd license-server
git init
git add .
git commit -m "Initial: License server v5.7.0 with Neon"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/license-server.git
git push -u origin main
```

### 2) الحصول على Connection String من Neon

1. اذهب إلى https://console.neon.tech/
2. أنشئ مشروع جديد (أو استخدم موجود)
3. **Dashboard → Connection Details → Connection string**
4. انسخ الرابط (يبدأ بـ `postgresql://`)

### 3) إنشاء الخدمة على Render

1. اذهب إلى https://dashboard.render.com/
2. **New +** → **Blueprint**
3. اختر مستودع GitHub الذي رفعت إليه
4. Render سيقرأ `render.yaml` تلقائياً

### 4) ضبط متغيّرات البيئة السرّية

في لوحة Render → **Environment**، أضف:

| المفتاح | القيمة |
|---|---|
| `DATABASE_URL` | رابط Neon الذي نسخته |
| `ADMIN_PASSWORD` | كلمة مرور قوية للوحة الأدمن |
| `JWT_SECRET` | (اختياري) تركه على القيمة الافتراضية يعمل — لكن يجب أن يطابق `lib/security-native.js` في الديسكتوب |

### 5) Deploy!

اضغط **Manual Deploy → Deploy latest commit**. بعد ~2 دقيقة زُر:

```
https://YOUR-SERVICE.onrender.com/api/health
```

يجب أن ترى:
```json
{
  "ok": true,
  "server": "ts-pro-license-server",
  "version": "5.7.0",
  "db": "PostgreSQL/Neon",
  "licenses_total": 0,
  "server_time": "..."
}
```

### 6) (اختياري) ملء بيانات تجريبية

من Render → **Shell**:
```bash
npm run seed
```

هذا سينشئ 5 عملاء + 8 مفاتيح تفعيل تجريبية.

## 🖥️ التطوير المحلي

```bash
# 1) استنساخ + تثبيت
git clone https://github.com/YOUR_USERNAME/license-server.git
cd license-server
npm install

# 2) إنشاء .env
cp .env.example .env
# افتح .env وأضف DATABASE_URL من Neon

# 3) اختبار الاتصال
npm run test:db

# 4) (اختياري) ملء بيانات تجريبية
npm run seed

# 5) تشغيل
npm start
# أو للتطوير مع hot-reload:
npm run dev
```

الروابط المحلية:
- الرئيسي: http://localhost:10000/
- الأدمن: http://localhost:10000/admin (admin / كلمة المرور من .env)
- الويب: http://localhost:10000/web
- الصحة: http://localhost:10000/api/health

## 📡 API Reference

### Public API (للتطبيق المكتبي)

#### `POST /api/activate`
تفعيل ترخيص جديد أو تجديد ترخيص موجود.
```json
Request:
{
  "activation_key": "ABCD-1234-EFGH-5678",
  "machine_id": "unique-machine-id",
  "fingerprint": "optional-hw-fingerprint",
  "client_version": "6.6.0"
}

Response:
{
  "token": "eyJhbGc...",
  "payload": {
    "v": "5.7.0",
    "license_id": 42,
    "business_type": "supermarket",
    "expires_at": "2026-07-29T...",
    "duration_days": 365,
    ...
  }
}
```

#### `POST /api/heartbeat`
تحديث دوري + تجديد التوكن.
```json
Request:
{
  "token": "eyJhbGc...",
  "machine_id": "...",
  "client_version": "6.6.0"
}

Response: نفس شكل /api/activate
```

#### `POST /api/verify-key`
تحقق عام (للويب) بدون تفعيل.
```json
Request: { "activation_key": "ABCD-..." }
Response: تفاصيل المفتاح والترخيص المرتبط (إن وجد)
```

#### `GET /api/health`
فحص الحالة العام.

### Admin API (محمي بـ Basic Auth)

جميع الطلبات تحتاج `Authorization: Basic base64(username:password)` أو استخدم لوحة `/admin`.

| Method | Path | الوصف |
|---|---|---|
| GET  | `/api/admin/dashboard` | إحصائيات شاملة |
| GET  | `/api/admin/clients` | قائمة العملاء |
| POST | `/api/admin/clients` | إنشاء عميل |
| PUT  | `/api/admin/clients/:id` | تعديل عميل |
| DELETE | `/api/admin/clients/:id` | حذف عميل |
| GET  | `/api/admin/keys` | قائمة مفاتيح التفعيل |
| POST | `/api/admin/keys` | إصدار مفتاح جديد |
| POST | `/api/admin/keys/:id/revoke` | إلغاء مفتاح |
| GET  | `/api/admin/licenses` | قائمة التراخيص |
| POST | `/api/admin/licenses/:id/revoke` | إلغاء ترخيص |
| POST | `/api/admin/licenses/:id/freeze` | تجميد ترخيص |
| POST | `/api/admin/licenses/:id/unfreeze` | إلغاء التجميد |
| POST | `/api/admin/licenses/:id/extend` | تمديد ترخيص (`{days: 30}`) |
| GET  | `/api/admin/events` | سجل الأحداث |

### WebSocket

- Path: `/ws`
- يرسل رسالة `{type:'stats', data:{...}}` كل 10 ثواني (dashboard مباشر)

## 🗄️ بنية قاعدة البيانات

- **clients** — العملاء
- **activation_keys** — مفاتيح التفعيل
- **licenses** — التراخيص المُصدرة
- **license_events** — سجل الأحداث (JSONB)
- **admin_users** — للسجلات فقط (المصادقة الفعلية من `.env`)
- **stats_cache** — cache الإحصائيات

## 🔒 الأمان

- Admin Panel محمي بـ **HTTP Basic Auth** + `timingSafeEqual`
- Rate Limiting افتراضي: **60 طلب/دقيقة** لكل IP
- SSL مُفعّل تلقائياً لـ Neon (`rejectUnauthorized:false` لكن SSL/TLS ما زال يُتفاوض عليه)
- JWT للتراخيص باستخدام HMAC-SHA256 (نفس المفتاح على السرفر والديسكتوب)
- Foreign keys + Cascade للنزاهة المرجعية

## 🐛 استكشاف الأخطاء

**السرفر لا يبدأ**: تأكّد أن `DATABASE_URL` صحيح في Render → Environment.

**`ECONNREFUSED` مع Neon**: تحقق من أن رابط Neon يبدأ بـ `postgresql://` وينتهي بـ `?sslmode=require`.

**Admin panel يطلب كلمة مرور مرة أخرى**: هذا سلوك المتصفح الطبيعي — تفتح مرة واحدة والمتصفح يحفظ الجلسة.

**قاعدة البيانات فارغة بعد النشر**: طبيعي — استخدم Admin Panel لإنشاء عملاء ومفاتيح، أو `npm run seed` من Render Shell.

## 📞 دعم

- التطوير: م/ عبدالرحمن الاكوع
- التواصل: +967 773579486
- License: Proprietary
