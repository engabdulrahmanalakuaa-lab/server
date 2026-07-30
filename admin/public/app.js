/**
 * لوحة الإدارة - تقنيات سوفت Pro v5.7.0
 * ================================================
 * يتصل بـ /api/admin/* endpoints عبر Basic Auth (المتصفح يرسله تلقائياً بعد أول تسجيل دخول)
 * ويستقبل تحديثات الإحصاءات الحية عبر WebSocket على /ws
 */
'use strict';

// ============================================================
// Configuration & Globals
// ============================================================
const API_BASE = '/api/admin';
let clientsCache = [];
let keysCache = [];
let licensesCache = [];
let eventsCache = [];
let currentTab = 'tab-dashboard';
let ws = null;
let wsReconnectTimer = null;
let refreshTimer = null;

// ============================================================
// Utility Helpers
// ============================================================
function esc(v) {
    if (v === null || v === undefined) return '';
    return String(v)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function num(v) {
    const n = Number(v);
    return isFinite(n) ? n.toLocaleString('en-US') : '0';
}

function fmtDate(v) {
    if (!v) return '-';
    try {
        const d = new Date(v.replace(' ', 'T') + (v.endsWith('Z') ? '' : 'Z'));
        if (isNaN(d.getTime())) return esc(v);
        return d.toLocaleString('ar-EG', {
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit'
        });
    } catch (_) { return esc(v); }
}

function fmtDateOnly(v) {
    if (!v) return '-';
    try {
        const d = new Date(v.replace(' ', 'T') + (v.endsWith('Z') ? '' : 'Z'));
        if (isNaN(d.getTime())) return esc(v);
        return d.toLocaleDateString('ar-EG');
    } catch (_) { return esc(v); }
}

function daysUntil(v) {
    if (!v) return null;
    try {
        const d = new Date(v.replace(' ', 'T') + (v.endsWith('Z') ? '' : 'Z'));
        if (isNaN(d.getTime())) return null;
        const diff = d.getTime() - Date.now();
        return Math.ceil(diff / (24 * 60 * 60 * 1000));
    } catch (_) { return null; }
}

function toast(msg, type) {
    type = type || 'info';
    const bgMap = {
        success: '#27ae60', error: '#e74c3c',
        info: '#3498db', warning: '#f39c12'
    };
    const div = document.createElement('div');
    div.style.cssText = `
        position:fixed; top:80px; left:50%; transform:translateX(-50%);
        background:${bgMap[type] || bgMap.info}; color:white; padding:12px 24px;
        border-radius:8px; box-shadow:0 4px 12px rgba(0,0,0,0.2); z-index:9999;
        font-weight:bold; direction:rtl; max-width:80%;
    `;
    div.textContent = msg;
    document.body.appendChild(div);
    setTimeout(() => { div.style.opacity = '0'; div.style.transition = 'opacity 0.3s'; }, 2500);
    setTimeout(() => { if (div.parentNode) div.parentNode.removeChild(div); }, 3000);
}

async function apiFetch(path, options) {
    options = options || {};
    options.credentials = 'same-origin';
    options.headers = Object.assign(
        { 'Content-Type': 'application/json' },
        options.headers || {}
    );
    if (options.body && typeof options.body !== 'string') {
        options.body = JSON.stringify(options.body);
    }
    const url = path.startsWith('http') ? path : (API_BASE + path);
    let res;
    try {
        res = await fetch(url, options);
    } catch (e) {
        throw new Error('network_error: ' + e.message);
    }
    let data = null;
    const txt = await res.text();
    try { data = txt ? JSON.parse(txt) : {}; } catch (_) { data = { raw: txt }; }
    if (!res.ok) {
        const msg = (data && data.error) ? data.error : ('HTTP ' + res.status);
        const err = new Error(msg);
        err.status = res.status;
        err.data = data;
        throw err;
    }
    return data;
}

// ============================================================
// Business type & template labels
// ============================================================
const BUSINESS_LABELS = {
    // المطاعم والمأكولات
    restaurant: 'مطعم',
    cafe: 'مقهى',
    fastfood: 'مطعم وجبات سريعة',
    buffet: 'بوفيه',
    cloud_kitchen: 'مطعم سحابي',
    bakery: 'مخبز',
    // الصحة
    pharmacy: 'صيدلية',
    vet_pharmacy: 'صيدلية بيطرية',
    hospital: 'مستشفى',
    clinic: 'عيادة',
    radiology: 'مركز أشعة',
    lab: 'مختبر طبي',
    // التجزئة والمحلات
    supermarket: 'سوبرماركت',
    electronics: 'محل إلكترونيات',
    jewelry: 'محل مجوهرات',
    perfume: 'محل عطور',
    clothing: 'محل ملابس',
    bookstore: 'مكتبة',
    general_store: 'محل تجاري عام',
    mall: 'مول تجاري',
    // الخدمات
    car_service: 'مركز صيانة سيارات',
    mobile_service: 'مركز صيانة جوالات',
    gym: 'صالة رياضية',
    training_center: 'مركز تدريب',
    law_office: 'مكتب محاماة',
    // الصناعة والمقاولات
    construction_materials: 'مواد بناء',
    contracting: 'شركة مقاولات',
    engineering: 'مكتب هندسي',
    factory: 'مصنع صغير',
    concrete_factory: 'مصنع بلوك وخرسانة',
    // الزراعة والطاقة والمالية
    fertilizer_shop: 'محل أسمدة ومبيدات',
    fuel_station: 'محطة وقود',
    electricity_station: 'محطة كهرباء',
    exchange_office: 'محل صرافة وحوالات'
};
const TEMPLATE_LABELS = {
    receipt_80mm: 'حراري 80مم', remittance_a5: 'حوالة A5',
    construction_a4: 'إنشاءات A4', electricity_a5: 'كهرباء A5'
};
function bizLabel(k) { return BUSINESS_LABELS[k] || k || '-'; }
function tmplLabel(k) { return TEMPLATE_LABELS[k] || k || '-'; }

const STATUS_LABELS = {
    active: 'نشط', used: 'مستخدم', revoked: 'ملغى',
    expired: 'منتهي', frozen: 'مجمّد', pending: 'قيد الانتظار'
};
function statusBadge(status) {
    const label = STATUS_LABELS[status] || status || '-';
    const cls = 'status-' + (status || 'active');
    return `<span class="badge-status ${esc(cls)}">${esc(label)}</span>`;
}

// ============================================================
// Dashboard
// ============================================================
async function loadDashboard() {
    try {
        const data = await apiFetch('/dashboard');
        renderStatCards(data);
        renderByBusiness(data.by_business_type || []);
        renderRecentEvents(data.recent_events || []);
    } catch (e) {
        console.error('dashboard error:', e);
        toast('فشل تحميل الإحصاءات: ' + e.message, 'error');
    }
}

function renderStatCards(s) {
    const cards = [
        { label: 'العملاء', num: s.clients_count, icon: 'users', color: '#3498db' },
        { label: 'مفاتيح نشطة', num: s.keys_active, icon: 'key', color: '#27ae60' },
        { label: 'مفاتيح مستخدمة', num: s.keys_used, icon: 'check-double', color: '#16a085' },
        { label: 'تراخيص فعّالة', num: s.licenses_active, icon: 'id-card', color: '#2ecc71' },
        { label: 'تراخيص منتهية', num: s.licenses_expired, icon: 'clock', color: '#f39c12' },
        { label: 'تراخيص ملغاة', num: s.licenses_revoked, icon: 'ban', color: '#e74c3c' },
        { label: 'مفاتيح ملغاة', num: s.keys_revoked, icon: 'times-circle', color: '#95a5a6' },
        { label: 'أحداث 24س', num: s.events_last_24h, icon: 'bell', color: '#9b59b6' }
    ];
    document.getElementById('stats-cards').innerHTML = cards.map(c => `
        <div class="col-md-3 col-sm-6">
            <div class="stat-card d-flex justify-content-between align-items-center">
                <div>
                    <div class="stat-num">${num(c.num || 0)}</div>
                    <div class="stat-label">${esc(c.label)}</div>
                </div>
                <div class="stat-icon" style="color:${c.color}"><i class="fas fa-${c.icon}"></i></div>
            </div>
        </div>
    `).join('');
}

function renderByBusiness(rows) {
    const tbody = document.querySelector('#by-business-table tbody');
    if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="2" class="text-center text-muted">لا توجد تراخيص نشطة</td></tr>';
        return;
    }
    tbody.innerHTML = rows.map(r => `
        <tr>
            <td>${esc(bizLabel(r.business_type))}</td>
            <td class="text-end"><strong>${num(r.c)}</strong></td>
        </tr>
    `).join('');
}

function renderRecentEvents(rows) {
    const tbody = document.querySelector('#recent-events-table tbody');
    if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="3" class="text-center text-muted">لا توجد أحداث</td></tr>';
        return;
    }
    tbody.innerHTML = rows.slice(0, 8).map(r => `
        <tr>
            <td style="font-size:11px">${fmtDate(r.created_at)}</td>
            <td><span class="badge bg-secondary">${esc(r.event_type)}</span></td>
            <td style="font-size:12px">${esc(r.client_name || r.lic_machine || '-')}</td>
        </tr>
    `).join('');
}

// ============================================================
// Clients
// ============================================================
async function loadClients() {
    try {
        clientsCache = await apiFetch('/clients');
        renderClients();
        // update client select in key modal
        populateClientSelect();
    } catch (e) {
        console.error('clients error:', e);
        toast('فشل تحميل العملاء: ' + e.message, 'error');
    }
}

function renderClients() {
    const tbody = document.getElementById('clients-tbody');
    if (!clientsCache.length) {
        tbody.innerHTML = '<tr><td colspan="8" class="text-center text-muted py-3">لا يوجد عملاء بعد</td></tr>';
        return;
    }
    tbody.innerHTML = clientsCache.map(c => `
        <tr>
            <td>${c.id}</td>
            <td><strong>${esc(c.client_name)}</strong>${c.city ? '<br><small class="text-muted">' + esc(c.city) + '</small>' : ''}</td>
            <td>${esc(c.client_phone || '-')}</td>
            <td>${esc(c.client_email || '-')}</td>
            <td>${esc(c.country || '-')}</td>
            <td class="text-center">${num(c.total_keys || 0)}</td>
            <td class="text-center"><span class="badge bg-success">${num(c.active_licenses || 0)}</span></td>
            <td>
                <button class="btn btn-sm btn-outline-primary" onclick="showClientForm(${c.id})" title="تعديل">
                    <i class="fas fa-edit"></i>
                </button>
                <button class="btn btn-sm btn-outline-danger" onclick="deleteClient(${c.id})" title="حذف">
                    <i class="fas fa-trash"></i>
                </button>
            </td>
        </tr>
    `).join('');
}

function populateClientSelect() {
    const sel = document.getElementById('key-client-id');
    if (!sel) return;
    sel.innerHTML = '<option value="">-- بدون عميل --</option>' +
        clientsCache.map(c => `<option value="${c.id}">${esc(c.client_name)}${c.client_phone ? ' — ' + esc(c.client_phone) : ''}</option>`).join('');
}

function showClientForm(id) {
    document.getElementById('client-id').value = id || '';
    if (id) {
        const c = clientsCache.find(x => x.id === id);
        if (!c) return toast('لم يتم العثور على العميل', 'error');
        document.getElementById('client-name').value = c.client_name || '';
        document.getElementById('client-phone').value = c.client_phone || '';
        document.getElementById('client-email').value = c.client_email || '';
        document.getElementById('client-country').value = c.country || '';
        document.getElementById('client-city').value = c.city || '';
        document.getElementById('client-address').value = c.address || '';
        document.getElementById('client-notes').value = c.notes || '';
    } else {
        ['client-name','client-phone','client-email','client-country','client-city','client-address','client-notes']
            .forEach(id => { document.getElementById(id).value = ''; });
    }
    bootstrap.Modal.getOrCreateInstance(document.getElementById('clientModal')).show();
}

async function saveClient() {
    const id = document.getElementById('client-id').value;
    const payload = {
        client_name: document.getElementById('client-name').value.trim(),
        client_phone: document.getElementById('client-phone').value.trim(),
        client_email: document.getElementById('client-email').value.trim(),
        country: document.getElementById('client-country').value.trim(),
        city: document.getElementById('client-city').value.trim(),
        address: document.getElementById('client-address').value.trim(),
        notes: document.getElementById('client-notes').value.trim()
    };
    if (!payload.client_name) {
        toast('اسم العميل مطلوب', 'warning');
        return;
    }
    try {
        if (id) {
            await apiFetch('/clients/' + id, { method: 'PUT', body: payload });
            toast('تم تحديث العميل بنجاح', 'success');
        } else {
            await apiFetch('/clients', { method: 'POST', body: payload });
            toast('تم إضافة العميل بنجاح', 'success');
        }
        bootstrap.Modal.getInstance(document.getElementById('clientModal')).hide();
        loadClients();
    } catch (e) {
        toast('فشل الحفظ: ' + e.message, 'error');
    }
}

async function deleteClient(id) {
    if (!confirm('هل أنت متأكد من حذف هذا العميل؟')) return;
    try {
        await apiFetch('/clients/' + id, { method: 'DELETE' });
        toast('تم حذف العميل', 'success');
        loadClients();
    } catch (e) {
        if (e.message === 'has_active_licenses') {
            toast('لا يمكن الحذف: يوجد تراخيص نشطة مرتبطة بهذا العميل', 'warning');
        } else {
            toast('فشل الحذف: ' + e.message, 'error');
        }
    }
}

// ============================================================
// Keys
// ============================================================
async function loadKeys() {
    try {
        keysCache = await apiFetch('/keys');
        renderKeys();
    } catch (e) {
        console.error('keys error:', e);
        toast('فشل تحميل المفاتيح: ' + e.message, 'error');
    }
}

function renderKeys() {
    const tbody = document.getElementById('keys-tbody');
    if (!keysCache.length) {
        tbody.innerHTML = '<tr><td colspan="9" class="text-center text-muted py-3">لا توجد مفاتيح</td></tr>';
        return;
    }
    tbody.innerHTML = keysCache.map(k => `
        <tr>
            <td>${k.id}</td>
            <td><span class="key-cell">${esc(k.activation_key)}</span></td>
            <td>${esc(k.client_name || '-')}${k.client_phone ? '<br><small class="text-muted">' + esc(k.client_phone) + '</small>' : ''}</td>
            <td>${esc(bizLabel(k.business_type))}</td>
            <td><small>${esc(tmplLabel(k.invoice_template))}</small></td>
            <td class="text-center">${num(k.duration_days)} يوم</td>
            <td class="text-center">${num(k.activations_count || 0)} / ${num(k.max_activations || 1)}</td>
            <td>${statusBadge(k.status)}</td>
            <td>
                ${k.status === 'active' ? `
                    <button class="btn btn-sm btn-outline-warning" onclick="revokeKey(${k.id})" title="إلغاء">
                        <i class="fas fa-ban"></i>
                    </button>
                ` : ''}
                <button class="btn btn-sm btn-outline-secondary" onclick="copyKeyValue('${esc(k.activation_key)}')" title="نسخ">
                    <i class="fas fa-copy"></i>
                </button>
            </td>
        </tr>
    `).join('');
}

function showKeyForm() {
    if (!clientsCache.length) {
        // ensure clients loaded first
        loadClients().then(() => showKeyForm());
        return;
    }
    populateClientSelect();
    document.getElementById('key-max-activations').value = 1;
    document.getElementById('key-notes').value = '';
    document.getElementById('key-duration-days').value = '30';
    document.getElementById('key-business-type').selectedIndex = 0;
    document.getElementById('key-invoice-template').selectedIndex = 0;
    bootstrap.Modal.getOrCreateInstance(document.getElementById('keyModal')).show();
}

async function saveKey() {
    const payload = {
        client_id: document.getElementById('key-client-id').value || null,
        business_type: document.getElementById('key-business-type').value,
        invoice_template: document.getElementById('key-invoice-template').value,
        duration_days: parseInt(document.getElementById('key-duration-days').value, 10) || 30,
        max_activations: parseInt(document.getElementById('key-max-activations').value, 10) || 1,
        notes: document.getElementById('key-notes').value.trim()
    };
    if (!payload.business_type || !payload.invoice_template || !payload.duration_days) {
        toast('يرجى تعبئة الحقول المطلوبة', 'warning');
        return;
    }
    try {
        const r = await apiFetch('/keys', { method: 'POST', body: payload });
        bootstrap.Modal.getInstance(document.getElementById('keyModal')).hide();
        // show generated key
        document.getElementById('generated-key').textContent = r.activation_key;
        bootstrap.Modal.getOrCreateInstance(document.getElementById('showKeyModal')).show();
        loadKeys();
        loadDashboard();
    } catch (e) {
        toast('فشل إنشاء المفتاح: ' + e.message, 'error');
    }
}

async function revokeKey(id) {
    if (!confirm('هل أنت متأكد من إلغاء هذا المفتاح؟ لن يمكن استخدامه للتفعيل مرة أخرى.')) return;
    try {
        await apiFetch('/keys/' + id + '/revoke', { method: 'POST' });
        toast('تم إلغاء المفتاح', 'success');
        loadKeys();
    } catch (e) {
        toast('فشل الإلغاء: ' + e.message, 'error');
    }
}

function copyGeneratedKey() {
    const key = document.getElementById('generated-key').textContent;
    copyKeyValue(key);
}

function copyKeyValue(key) {
    if (!key) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(key)
            .then(() => toast('تم نسخ المفتاح: ' + key, 'success'))
            .catch(() => fallbackCopy(key));
    } else {
        fallbackCopy(key);
    }
}

function fallbackCopy(text) {
    try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        toast('تم النسخ: ' + text, 'success');
    } catch (e) {
        toast('تعذر النسخ - انسخ يدوياً: ' + text, 'warning');
    }
}

// ============================================================
// Licenses
// ============================================================
async function loadLicenses() {
    try {
        licensesCache = await apiFetch('/licenses');
        renderLicenses();
    } catch (e) {
        console.error('licenses error:', e);
        toast('فشل تحميل التراخيص: ' + e.message, 'error');
    }
}

function renderLicenses() {
    const tbody = document.getElementById('licenses-tbody');
    if (!licensesCache.length) {
        tbody.innerHTML = '<tr><td colspan="9" class="text-center text-muted py-3">لا توجد تراخيص مُفعّلة</td></tr>';
        return;
    }
    tbody.innerHTML = licensesCache.map(l => {
        const days = daysUntil(l.expires_at);
        let expClass = '';
        let expText = fmtDateOnly(l.expires_at);
        if (days !== null) {
            if (days < 0) { expClass = 'text-danger'; expText += ` (منتهي منذ ${Math.abs(days)} يوم)`; }
            else if (days <= 7) { expClass = 'text-warning'; expText += ` (${days} يوم)`; }
            else { expText += ` (${days} يوم)`; }
        }
        const mid = l.machine_id ? (l.machine_id.length > 16 ? l.machine_id.substring(0, 16) + '…' : l.machine_id) : '-';
        return `
            <tr>
                <td>${l.id}</td>
                <td>${esc(l.client_name || '-')}</td>
                <td><small class="text-muted" title="${esc(l.machine_id || '')}">${esc(mid)}</small></td>
                <td>${esc(bizLabel(l.business_type))}</td>
                <td><small>v${esc(l.version || '-')}</small></td>
                <td class="${expClass}"><small>${expText}</small></td>
                <td><small>${fmtDate(l.last_heartbeat_at)}</small></td>
                <td>${statusBadge(l.status)}</td>
                <td>
                    ${l.status === 'active' ? `
                        <button class="btn btn-sm btn-outline-warning" onclick="freezeLicense(${l.id})" title="تجميد">
                            <i class="fas fa-snowflake"></i>
                        </button>
                    ` : ''}
                    ${l.status === 'frozen' ? `
                        <button class="btn btn-sm btn-outline-info" onclick="unfreezeLicense(${l.id})" title="فك التجميد">
                            <i class="fas fa-fire"></i>
                        </button>
                    ` : ''}
                    ${l.status !== 'revoked' ? `
                        <button class="btn btn-sm btn-outline-primary" onclick="extendLicense(${l.id})" title="تمديد">
                            <i class="fas fa-clock"></i>
                        </button>
                        <button class="btn btn-sm btn-outline-danger" onclick="revokeLicense(${l.id})" title="إلغاء">
                            <i class="fas fa-ban"></i>
                        </button>
                    ` : ''}
                </td>
            </tr>
        `;
    }).join('');
}

async function freezeLicense(id) {
    if (!confirm('تجميد الترخيص سيمنع الجهاز من الاتصال مؤقتاً. متابعة؟')) return;
    try {
        await apiFetch('/licenses/' + id + '/freeze', { method: 'POST' });
        toast('تم تجميد الترخيص', 'success');
        loadLicenses();
    } catch (e) {
        toast('فشل التجميد: ' + e.message, 'error');
    }
}

async function unfreezeLicense(id) {
    try {
        await apiFetch('/licenses/' + id + '/unfreeze', { method: 'POST' });
        toast('تم فك تجميد الترخيص', 'success');
        loadLicenses();
    } catch (e) {
        toast('فشل فك التجميد: ' + e.message, 'error');
    }
}

async function revokeLicense(id) {
    const reason = prompt('سبب الإلغاء (اختياري):');
    if (reason === null) return; // cancelled
    if (!confirm('هل أنت متأكد من إلغاء هذا الترخيص نهائياً؟')) return;
    try {
        await apiFetch('/licenses/' + id + '/revoke', { method: 'POST', body: { reason: reason || '' } });
        toast('تم إلغاء الترخيص', 'success');
        loadLicenses();
        loadDashboard();
    } catch (e) {
        toast('فشل الإلغاء: ' + e.message, 'error');
    }
}

async function extendLicense(id) {
    const daysStr = prompt('كم يوماً تريد إضافته للترخيص؟', '30');
    if (daysStr === null) return;
    const days = parseInt(daysStr, 10);
    if (!days || days <= 0) {
        toast('يرجى إدخال عدد أيام صالح', 'warning');
        return;
    }
    try {
        const r = await apiFetch('/licenses/' + id + '/extend', { method: 'POST', body: { days: days } });
        toast('تم التمديد. الانتهاء الجديد: ' + fmtDateOnly(r.expires_at), 'success');
        loadLicenses();
    } catch (e) {
        toast('فشل التمديد: ' + e.message, 'error');
    }
}

// ============================================================
// Events
// ============================================================
async function loadEvents() {
    try {
        eventsCache = await apiFetch('/events?limit=300');
        renderEvents();
    } catch (e) {
        console.error('events error:', e);
        toast('فشل تحميل الأحداث: ' + e.message, 'error');
    }
}

function renderEvents() {
    const tbody = document.getElementById('events-tbody');
    if (!eventsCache.length) {
        tbody.innerHTML = '<tr><td colspan="7" class="text-center text-muted py-3">لا توجد أحداث</td></tr>';
        return;
    }
    tbody.innerHTML = eventsCache.map(e => {
        let details = '-';
        if (e.details) {
            try {
                const d = typeof e.details === 'string' ? JSON.parse(e.details) : e.details;
                details = Object.keys(d).slice(0, 3).map(k => `${k}=${d[k]}`).join(', ');
            } catch (_) {
                details = String(e.details).substring(0, 60);
            }
        }
        const mid = e.machine_id ? (e.machine_id.length > 12 ? e.machine_id.substring(0, 12) + '…' : e.machine_id) : '-';
        return `
            <tr>
                <td>${e.id}</td>
                <td style="font-size:11px">${fmtDate(e.created_at)}</td>
                <td><span class="badge bg-secondary">${esc(e.event_type)}</span></td>
                <td><small>${e.license_id || '-'}</small></td>
                <td><small class="text-muted" title="${esc(e.machine_id || '')}">${esc(mid)}</small></td>
                <td><small>${esc(e.ip_address || '-')}</small></td>
                <td><small class="text-muted">${esc(details)}</small></td>
            </tr>
        `;
    }).join('');
}

// ============================================================
// WebSocket - Live Updates
// ============================================================
function connectWebSocket() {
    if (ws && ws.readyState === WebSocket.OPEN) return;
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = proto + '//' + window.location.host + '/ws';
    try {
        ws = new WebSocket(wsUrl);
    } catch (e) {
        console.error('WebSocket construction error:', e);
        scheduleReconnect();
        return;
    }
    ws.onopen = () => {
        document.getElementById('ws-indicator').classList.add('connected');
        document.getElementById('ws-status').textContent = 'متصل';
        if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
    };
    ws.onmessage = (evt) => {
        try {
            const msg = JSON.parse(evt.data);
            if (msg.type === 'stats' && msg.data) {
                // silent refresh of stat cards if on dashboard
                if (currentTab === 'tab-dashboard') {
                    renderStatCards(msg.data);
                    if (msg.data.by_business_type) renderByBusiness(msg.data.by_business_type);
                    if (msg.data.recent_events) renderRecentEvents(msg.data.recent_events);
                }
            } else if (msg.type === 'event') {
                // new event - if on events tab, refresh
                if (currentTab === 'tab-events') loadEvents();
            }
        } catch (e) {
            console.warn('ws message parse:', e);
        }
    };
    ws.onclose = () => {
        document.getElementById('ws-indicator').classList.remove('connected');
        document.getElementById('ws-status').textContent = 'منقطع - إعادة الاتصال...';
        scheduleReconnect();
    };
    ws.onerror = () => {
        // will trigger onclose
    };
}

function scheduleReconnect() {
    if (wsReconnectTimer) return;
    wsReconnectTimer = setTimeout(() => {
        wsReconnectTimer = null;
        connectWebSocket();
    }, 5000);
}

// ============================================================
// Tab Switching & Init
// ============================================================
function onTabShow(tabId) {
    currentTab = tabId;
    switch (tabId) {
        case 'tab-dashboard': loadDashboard(); break;
        case 'tab-clients': loadClients(); break;
        case 'tab-keys':
            // ensure clients loaded first for select
            if (!clientsCache.length) loadClients();
            loadKeys();
            break;
        case 'tab-licenses': loadLicenses(); break;
        case 'tab-events': loadEvents(); break;
    }
}

document.addEventListener('DOMContentLoaded', () => {
    // hook tab shown events
    document.querySelectorAll('a[data-bs-toggle="tab"]').forEach(a => {
        a.addEventListener('shown.bs.tab', (e) => {
            const href = e.target.getAttribute('href');
            if (href && href.startsWith('#')) onTabShow(href.substring(1));
        });
    });

    // initial load: dashboard + clients (for key modal select)
    loadDashboard();
    loadClients();

    // periodic background refresh of current tab (every 30s)
    refreshTimer = setInterval(() => {
        if (currentTab === 'tab-dashboard') loadDashboard();
        else if (currentTab === 'tab-licenses') loadLicenses();
    }, 30000);

    // start WebSocket
    connectWebSocket();
});

// Expose functions to global scope (onclick handlers in HTML)
window.showClientForm = showClientForm;
window.saveClient = saveClient;
window.deleteClient = deleteClient;
window.showKeyForm = showKeyForm;
window.saveKey = saveKey;
window.revokeKey = revokeKey;
window.copyGeneratedKey = copyGeneratedKey;
window.copyKeyValue = copyKeyValue;
window.freezeLicense = freezeLicense;
window.unfreezeLicense = unfreezeLicense;
window.revokeLicense = revokeLicense;
window.extendLicense = extendLicense;
