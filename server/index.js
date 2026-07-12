'use strict';
/**
 * ========================================================================
 * تقنيات سوفت Pro v5.7.0 - License Server (Render.com)
 * ========================================================================
 *  - Express API (activate + heartbeat)
 *  - Admin Panel (HTTP Basic Auth)
 *  - React Web App (Static)
 *  - WebSocket (realtime dashboard)
 * ========================================================================
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
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

// Rate Limiting للـ API
app.use('/api/', rateLimit());

// ---------------- Public API (client-facing) ----------------
app.use('/api', apiRoutes);

// ---------------- Admin API (protected) ----------------
app.use('/api/admin', adminAuth, adminRoutes);

// ---------------- Admin Panel (static + protected) ----------------
app.use('/admin', adminAuth, express.static(path.join(__dirname, '..', 'admin', 'public')));

// ---------------- Web App (React SPA, public) ----------------
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
    </style>
</head>
<body>
    <div class="card">
        <h1>🔐 تقنيات سوفت Pro - خادم الترخيص</h1>
        <p style="font-size:18px; opacity:0.9;">الإصدار 5.7.0 - يعمل على Render.com</p>

        <div class="info">
            <h3>📡 نقاط النهاية (Endpoints)</h3>
            <ul>
                <li><code>POST /api/activate</code> — تفعيل ترخيص جديد</li>
                <li><code>POST /api/heartbeat</code> — تحديث دوري</li>
                <li><code>GET /api/health</code> — فحص الحالة</li>
                <li><code>/admin</code> — لوحة الإدارة (تحتاج مصادقة)</li>
                <li><code>/web</code> — الواجهة الويب للعملاء</li>
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
    // Basic Auth عبر query param أو header
    const url = new URL(req.url, `http://${req.headers.host}`);
    const auth = url.searchParams.get('auth') || req.headers.authorization;
    // ملاحظة: التحقق مبسّط هنا. في الإنتاج يمكن استخدام token JWT
    wsClients.add(ws);
    ws.on('close', () => wsClients.delete(ws));
    ws.on('error', () => wsClients.delete(ws));
    ws.send(JSON.stringify({ type: 'welcome', server: 'ts-pro-license', time: new Date().toISOString() }));
});

// جمع لقطة إحصائيات كاملة مطابقة لـ /api/admin/dashboard
function collectDashboardStats() {
    const stats = {
        clients_count: db.prepare('SELECT COUNT(*) c FROM clients').get().c,
        keys_active: db.prepare("SELECT COUNT(*) c FROM activation_keys WHERE status='active'").get().c,
        keys_used: db.prepare("SELECT COUNT(*) c FROM activation_keys WHERE status='used'").get().c,
        keys_revoked: db.prepare("SELECT COUNT(*) c FROM activation_keys WHERE status='revoked'").get().c,
        licenses_active: db.prepare("SELECT COUNT(*) c FROM licenses WHERE status='active'").get().c,
        licenses_expired: db.prepare("SELECT COUNT(*) c FROM licenses WHERE status='expired'").get().c,
        licenses_revoked: db.prepare("SELECT COUNT(*) c FROM licenses WHERE status='revoked'").get().c,
        events_last_24h: db.prepare("SELECT COUNT(*) c FROM license_events WHERE created_at >= datetime('now','-24 hours')").get().c,
        recent_events: db.prepare(`
            SELECT e.*, l.machine_id as lic_machine, c.client_name
            FROM license_events e
            LEFT JOIN licenses l ON l.id = e.license_id
            LEFT JOIN clients c ON c.id = l.client_id
            ORDER BY e.id DESC LIMIT 15
        `).all(),
        by_business_type: db.prepare(`
            SELECT business_type, COUNT(*) c FROM licenses
            WHERE status='active' GROUP BY business_type
        `).all()
    };
    return stats;
}

// دفع أحداث للـ WS كل 10 ثواني (heartbeat + إحصائيات كاملة)
setInterval(() => {
    if (wsClients.size === 0) return;
    try {
        const payload = {
            type: 'stats',
            time: new Date().toISOString(),
            data: collectDashboardStats()
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

server.listen(PORT, HOST, () => {
    console.log('========================================================');
    console.log('  تقنيات سوفت Pro v5.7.0 - License Server');
    console.log('  Environment:', process.env.NODE_ENV || 'development');
    console.log('  Listening:', `http://${HOST}:${PORT}`);
    console.log('  DB path:', db.DB_PATH);
    console.log('  Endpoints:');
    console.log('    - POST /api/activate');
    console.log('    - POST /api/heartbeat');
    console.log('    - GET  /api/health');
    console.log('    - GET  /admin (protected)');
    console.log('    - GET  /web');
    console.log('    - WS   /ws');
    console.log('========================================================');
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('[server] SIGTERM received, closing...');
    server.close(() => process.exit(0));
});
