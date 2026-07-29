/**
 * ═══════════════════════════════════════════════════════════════════════
 * تقنيات سوفت Pro — Cloud Sync Server (Entry Point)
 * ═══════════════════════════════════════════════════════════════════════
 * سيرفر Express يعمل على Render + Neon PostgreSQL
 *
 * التشغيل محلياً:
 *   npm install
 *   npm run init-db   (مرة واحدة فقط)
 *   npm start
 *
 * النشر على Render:
 *   1) ارفع المستودع إلى GitHub
 *   2) اربطه بـ Render (Node service)
 *   3) في Environment أضف DATABASE_URL + JWT_SECRET + API_KEY
 *   4) Build command:  npm install
 *   5) Start command:  npm start
 * ═══════════════════════════════════════════════════════════════════════
 */

'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const morgan = require('morgan');

const { pool, healthCheck, close } = require('./db');
const { initDatabase } = require('./db/init');

const authRoutes = require('./routes/auth');
const syncRoutes = require('./routes/sync');
const backupRoutes = require('./routes/backup');
const restoreRoutes = require('./routes/restore');

const PORT = parseInt(process.env.PORT) || 10000;
const PUBLIC_URL = process.env.PUBLIC_URL || 'https://server-1-dcrb.onrender.com';
const NODE_ENV = process.env.NODE_ENV || 'production';
const MAX_BODY_SIZE = process.env.MAX_BODY_SIZE || '50mb';

const app = express();

/* ─── ثقة بـ Proxy (Render خلف Cloudflare) ─── */
app.set('trust proxy', 1);

/* ─── Security Headers ─── */
app.use(helmet({
    contentSecurityPolicy: false, // API فقط — لا HTML
    crossOriginResourcePolicy: { policy: 'cross-origin' }
}));

/* ─── Compression ─── */
app.use(compression());

/* ─── CORS ─── */
const corsOrigins = (process.env.CORS_ORIGINS || '*').split(',').map(s => s.trim());
app.use(cors({
    origin: corsOrigins.includes('*') ? true : corsOrigins,
    credentials: false,
    maxAge: 86400
}));

/* ─── JSON body parser (حجم كبير للنسخ الاحتياطية) ─── */
app.use(express.json({ limit: MAX_BODY_SIZE }));
app.use(express.urlencoded({ extended: true, limit: MAX_BODY_SIZE }));

/* ─── Logging ─── */
if (NODE_ENV !== 'test') {
    app.use(morgan(NODE_ENV === 'production' ? 'tiny' : 'dev'));
}

/* ─── Rate Limiting ─── */
const limiter = rateLimit({
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60_000,
    max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'تجاوزت الحد المسموح من الطلبات، حاول لاحقاً.' }
});
app.use('/api/', limiter);

/* ═══════════════════════════════════════════════════════════════════════
   Endpoints
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * GET / — صفحة ترحيب
 */
app.get('/', (req, res) => {
    res.json({
        name: 'تقنيات سوفت Pro — Cloud Sync Server',
        version: '1.0.0',
        status: 'running',
        environment: NODE_ENV,
        public_url: PUBLIC_URL,
        endpoints: {
            health:  'GET  /health',
            auth:    'POST /api/auth/register | POST /api/auth/refresh | GET /api/auth/me',
            sync:    'POST /api/sync/push | GET /api/sync/pull | GET /api/sync/status',
            backup:  'POST /api/backup/upload | GET /api/backup/list | GET /api/backup/:id/download',
            restore: 'GET  /api/restore/latest | GET /api/restore/all-records'
        },
        docs: 'https://github.com/YOUR_ORG/technologies-soft-pro-server'
    });
});

/**
 * GET /health — فحص الصحة (يستخدمه Render + العميل)
 */
app.get('/health', async (req, res) => {
    const dbCheck = await healthCheck();
    const status = dbCheck.ok ? 200 : 503;
    res.status(status).json({
        ok: dbCheck.ok,
        service: 'technologies-soft-pro-sync-server',
        version: '1.0.0',
        uptime_seconds: Math.floor(process.uptime()),
        node_version: process.version,
        memory_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
        database: dbCheck,
        timestamp: new Date().toISOString()
    });
});

/**
 * GET /ping — استيقاظ سريع للـ warmup (يستخدمه العميل قبل sync)
 */
app.get('/ping', (req, res) => {
    res.json({ pong: true, t: Date.now() });
});

/* Mount API routes */
app.use('/api/auth', authRoutes);
app.use('/api/sync', syncRoutes);
app.use('/api/backup', backupRoutes);
app.use('/api/restore', restoreRoutes);

/* 404 */
app.use((req, res) => {
    res.status(404).json({
        success: false,
        error: 'المسار غير موجود',
        path: req.originalUrl
    });
});

/* Error handler */
app.use((err, req, res, next) => {
    console.error('[server-error]', err.message, err.stack);
    if (err.type === 'entity.too.large') {
        return res.status(413).json({
            success: false,
            error: 'حجم الحمل كبير جداً. الحد الأقصى: ' + MAX_BODY_SIZE
        });
    }
    if (err instanceof SyntaxError && 'body' in err) {
        return res.status(400).json({
            success: false,
            error: 'JSON غير صالح: ' + err.message
        });
    }
    res.status(500).json({
        success: false,
        error: NODE_ENV === 'production' ? 'خطأ في السيرفر' : err.message
    });
});

/* ═══════════════════════════════════════════════════════════════════════
   بدء التشغيل
   ═══════════════════════════════════════════════════════════════════════ */

async function bootstrap() {
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║  تقنيات سوفت Pro — Cloud Sync Server v1.0.0                 ║');
    console.log('╚══════════════════════════════════════════════════════════════╝');
    console.log('  Environment: ' + NODE_ENV);
    console.log('  Public URL:  ' + PUBLIC_URL);
    console.log('  Port:        ' + PORT);
    console.log('');

    // تهيئة قاعدة البيانات (idempotent — يُنفَّذ في كل بدء تشغيل)
    try {
        console.log('[boot] تهيئة قاعدة البيانات...');
        await initDatabase(true);
        console.log('[boot] ✅ قاعدة البيانات جاهزة');
    } catch (err) {
        console.error('[boot] ❌ فشل تهيئة قاعدة البيانات:', err.message);
        console.error('       تحقق من DATABASE_URL وأن Neon متاح.');
        process.exit(1);
    }

    // فحص صحة الاتصال
    const hc = await healthCheck();
    if (!hc.ok) {
        console.error('[boot] ❌ فشل فحص صحة قاعدة البيانات:', hc.error);
        process.exit(1);
    }
    console.log('[boot] ✅ Neon PostgreSQL متصل: ' + hc.pg_version);

    const server = app.listen(PORT, '0.0.0.0', () => {
        console.log('[boot] 🚀 السيرفر يستمع على المنفذ ' + PORT);
        console.log('[boot] 🌐 ' + PUBLIC_URL);
        console.log('');
    });

    /* Graceful shutdown */
    const shutdown = async (signal) => {
        console.log('\n[shutdown] استقبال ' + signal + ' — إغلاق نظيف...');
        server.close(async () => {
            await close();
            console.log('[shutdown] ✅ تم');
            process.exit(0);
        });
        // إجبار الإغلاق بعد 15 ثانية
        setTimeout(() => process.exit(1), 15_000).unref();
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
}

bootstrap().catch(err => {
    console.error('[boot] خطأ فادح:', err);
    process.exit(1);
});
