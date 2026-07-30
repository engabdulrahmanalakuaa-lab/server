'use strict';
/**
 * ═══════════════════════════════════════════════════════════════════════
 * تقنيات سوفت Pro v5.7.0 - License Server (Render.com + Neon)
 * ═══════════════════════════════════════════════════════════════════════
 *  - Express API (activate + heartbeat + verify-key)
 *  - Admin Panel (HTTP Basic Auth)
 *  - Web App (Static)
 *  - WebSocket (realtime dashboard)
 *  - قاعدة بيانات دائمة: Neon PostgreSQL
 * ═══════════════════════════════════════════════════════════════════════
 */
require('dotenv').config();

const express = require('express');
const path = require('path');
const http = require('http');
const cors = require('cors');
const { WebSocketServer } = require('ws');

const db = require('./db');
const apiRoutes = require('./routes/api');
const adminRoutes = require('./routes/admin');
const adminAuth = require('./middleware/adminAuth');
const rateLimit = require('./middleware/rateLimit');

const app = express();
const server = http.createServer(app);

// ---------------- Middlewares ----------------
app.set('trust proxy', 1); // على Render خلف proxy
app.use(cors({
    origin: (process.env.CORS_ORIGINS || '*').split(',').map(s => s.trim())
}));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false, limit: '2mb' }));

// Rate Limiting للـ API
app.use('/api/', rateLimit());

// ---------------- Public API (client-facing) ----------------
app.use('/api', apiRoutes);

// ---------------- Admin API (protected) ----------------
app.use('/api/admin', adminAuth, adminRoutes);

// ---------------- Admin Panel (static + protected) ----------------
app.use('/admin', adminAuth, express.static(path.join(__dirname, '..', 'admin', 'public')));

// ---------------- Web App (public) ----------------
app.use('/web', express.static(path.join(__dirname, '..', 'web', 'public')));
app.get('/web/*', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'web', 'public', 'index.html'));
});

// ---------------- Root ----------------
app.get('/', (req, res) => {
    res.type('html').send(`<!doctype html>
<html lang="ar" dir="rtl">
<head>
    <meta charset="utf-8">
    <title>تقنيات سوفت Pro - خادم الترخيص</title>
    <style>
        body { font-family: system-ui, sans-serif; background: linear-gradient(135deg, #2c3e50, #3498db); color: white; margin: 0; padding: 40px; }
        .card { max-width: 800px; margin: 0 auto; background: rgba(255,255,255,0.1); padding: 40px; border-radius: 16px; backdrop-filter: blur(10px); }
        h1 { margin-top: 0; font-size: 36px; }
        .info { background: rgba(255,255,255,0.15); padding: 20px; border-radius: 12px; margin: 20px 0; }
        .info h3 { margin: 0 0 12px; }
        .link { display: inline-block; padding: 12px 24px; background: white; color: #2c3e50; text-decoration: none; border-radius: 8px; margin: 8px; font-weight: bold; }
        code { background: rgba(0,0,0,0.3); padding: 2px 8px; border-radius: 4px; }
        .badge { display: inline-block; background: #27ae60; padding: 4px 12px; border-radius: 20px; font-size: 14px; }
    </style>
</head>
<body>
    <div class="card">
        <h1>🔐 تقنيات سوفت Pro - خادم الترخيص</h1>
        <p style="font-size:18px; opacity:0.9;">
            الإصدار 5.7.0 - يعمل على Render.com
            <span class="badge">🐘 Neon PostgreSQL</span>
        </p>

        <div class="info">
            <h3>📡 نقاط النهاية (Endpoints)</h3>
            <ul>
                <li><code>POST /api/activate</code> — تفعيل ترخيص جديد</li>
                <li><code>POST /api/heartbeat</code> — تحديث دوري</li>
                <li><code>POST /api/verify-key</code> — تحقق عام من مفتاح</li>
                <li><code>GET /api/health</code> — فحص الحالة</li>
                <li><code>/admin</code> — لوحة الإدارة (تحتاج مصادقة)</li>
                <li><code>/web</code> — الواجهة الويب للعملاء</li>
                <li><code>/ws</code> — WebSocket للتحديثات الحيّة</li>
            </ul>
        </div>

        <div>
            <a class="link" href="/admin">🛠️ لوحة الإدارة</a>
            <a class="link" href="/web">🌐 الواجهة الويب</a>
            <a class="link" href="/api/health">💓 فحص الحالة</a>
        </div>

        <p style="margin-top:30px; opacity:0.8; text-align:center;">
            📞 التواصل مع إدارة نظام تقنيات سوفت المحاسبي +967 773579486
        </p>
    </div>
</body>
</html>`);
});

// ---------------- 404 ----------------
app.use((req, res) => res.status(404).json({ error: 'not_found', path: req.path }));

// ---------------- Error handler ----------------
app.use((err, req, res, next) => {
    console.error('[error]', err);
    res.status(500).json({ error: 'internal_server_error', message: err.message });
});

// ============================================================
// WebSocket - realtime dashboard
// ============================================================
const wss = new WebSocketServer({ server, path: '/ws' });
const wsClients = new Set();

wss.on('connection', (ws, req) => {
    // ملاحظة: التحقق مبسّط هنا. Admin Panel محمي بـ Basic Auth أصلاً.
    wsClients.add(ws);
    ws.on('close', () => wsClients.delete(ws));
    ws.on('error', () => wsClients.delete(ws));
    ws.send(JSON.stringify({
        type: 'welcome',
        server: 'ts-pro-license',
        time: new Date().toISOString()
    }));
});

// جمع لقطة إحصائيات كاملة مطابقة لـ /api/admin/dashboard
async function collectDashboardStats() {
    const [
        clientsCnt, keysActive, keysUsed, keysRevoked,
        licActive, licExpired, licRevoked, events24h,
        recentEvents, byBusiness
    ] = await Promise.all([
        db.query("SELECT COUNT(*)::int c FROM ts_clients"),
        db.query("SELECT COUNT(*)::int c FROM ts_activation_keys WHERE status='active'"),
        db.query("SELECT COUNT(*)::int c FROM ts_activation_keys WHERE status='used'"),
        db.query("SELECT COUNT(*)::int c FROM ts_activation_keys WHERE status='revoked'"),
        db.query("SELECT COUNT(*)::int c FROM ts_licenses WHERE status='active'"),
        db.query("SELECT COUNT(*)::int c FROM ts_licenses WHERE status='expired'"),
        db.query("SELECT COUNT(*)::int c FROM ts_licenses WHERE status='revoked'"),
        db.query("SELECT COUNT(*)::int c FROM ts_license_events WHERE created_at >= NOW() - INTERVAL '24 hours'"),
        db.query(`
            SELECT e.*, l.machine_id as lic_machine, c.client_name
            FROM ts_license_events e
            LEFT JOIN ts_licenses l ON l.id = e.license_id
            LEFT JOIN ts_clients c ON c.id = l.client_id
            ORDER BY e.id DESC LIMIT 15
        `),
        db.query(`
            SELECT business_type, COUNT(*)::int c FROM ts_licenses
            WHERE status='active' GROUP BY business_type
        `)
    ]);
    return {
        clients_count:    clientsCnt.rows[0].c,
        keys_active:      keysActive.rows[0].c,
        keys_used:        keysUsed.rows[0].c,
        keys_revoked:     keysRevoked.rows[0].c,
        licenses_active:  licActive.rows[0].c,
        licenses_expired: licExpired.rows[0].c,
        licenses_revoked: licRevoked.rows[0].c,
        events_last_24h:  events24h.rows[0].c,
        recent_events:    recentEvents.rows,
        by_business_type: byBusiness.rows
    };
}

// دفع أحداث للـ WS كل 10 ثواني (heartbeat + إحصائيات كاملة)
setInterval(async () => {
    if (wsClients.size === 0) return;
    try {
        const payload = {
            type: 'stats',
            time: new Date().toISOString(),
            data: await collectDashboardStats()
        };
        const msg = JSON.stringify(payload);
        wsClients.forEach(ws => {
            try { if (ws.readyState === 1) ws.send(msg); } catch (_) {}
        });
    } catch (e) {
        console.error('[ws-broadcast]', e.message);
    }
}, 10 * 1000).unref();

// ============================================================
// Startup
// ============================================================
const PORT = process.env.PORT || 10000;
const HOST = process.env.HOST || '0.0.0.0';

async function bootstrap() {
    try {
        console.log('[boot] Initializing Neon PostgreSQL...');
        await db.initSchema();
        const h = await db.healthCheck();
        if (h.ok) {
            console.log('[boot] ✅ Neon connected:', h.version);
        } else {
            console.error('[boot] ❌ Neon connection failed:', h.error);
            process.exit(1);
        }

        server.listen(PORT, HOST, () => {
            console.log('╔══════════════════════════════════════════════════════════════╗');
            console.log('║  تقنيات سوفت Pro v5.7.0 - License Server                      ║');
            console.log('║  Database: Neon PostgreSQL (persistent, never sleeps)         ║');
            console.log('╚══════════════════════════════════════════════════════════════╝');
            console.log('  Environment:', process.env.NODE_ENV || 'development');
            console.log('  Listening:  ', `http://${HOST}:${PORT}`);
            console.log('  Endpoints:');
            console.log('    POST /api/activate');
            console.log('    POST /api/heartbeat');
            console.log('    POST /api/verify-key');
            console.log('    GET  /api/health');
            console.log('    GET  /admin (protected)');
            console.log('    GET  /web');
            console.log('    WS   /ws');
            console.log('════════════════════════════════════════════════════════════════');
        });
    } catch (err) {
        console.error('[boot] ❌ fatal:', err.message);
        process.exit(1);
    }
}

bootstrap();

// Graceful shutdown
function shutdown(signal) {
    console.log(`[server] ${signal} received, closing...`);
    server.close(async () => {
        try { await db.close(); } catch (_) {}
        process.exit(0);
    });
    // failsafe
    setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
