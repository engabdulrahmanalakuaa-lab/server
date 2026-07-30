/**
 * تقنيات سوفت Pro v5.7.0 - بوابة العميل
 * =============================================
 * صفحة عامة للتحقق من صلاحية مفتاح التفعيل
 * تستخدم POST /api/verify-key فقط (بدون تعديل بيانات)
 */
'use strict';

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
const ERROR_MESSAGES = {
    key_not_found: 'المفتاح غير موجود في قاعدة البيانات',
    missing_key: 'يرجى إدخال مفتاح التفعيل',
    internal_error: 'حدث خطأ في الخادم - حاول لاحقاً',
    network_error: 'تعذّر الاتصال بالخادم'
};

function esc(v) {
    if (v === null || v === undefined) return '';
    return String(v)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function fmtDate(v) {
    if (!v) return '-';
    try {
        const s = String(v).replace(' ', 'T');
        const d = new Date(s.endsWith('Z') ? s : s + 'Z');
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
        const s = String(v).replace(' ', 'T');
        const d = new Date(s.endsWith('Z') ? s : s + 'Z');
        if (isNaN(d.getTime())) return esc(v);
        return d.toLocaleDateString('ar-EG', {
            year: 'numeric', month: '2-digit', day: '2-digit'
        });
    } catch (_) { return esc(v); }
}

// تنسيق تلقائي للمفتاح: XXXX-XXXX-XXXX-XXXX
function formatKeyInput(input) {
    let v = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (v.length > 16) v = v.substring(0, 16);
    const parts = [];
    for (let i = 0; i < v.length; i += 4) parts.push(v.substring(i, i + 4));
    input.value = parts.join('-');
}

// تحقق من المفتاح
async function verifyKey() {
    const keyInput = document.getElementById('activation-key');
    const rawKey = (keyInput.value || '').trim().toUpperCase();
    const container = document.getElementById('result-container');

    if (!rawKey) {
        renderError(ERROR_MESSAGES.missing_key);
        keyInput.focus();
        return;
    }
    if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(rawKey)) {
        renderError('صيغة المفتاح غير صحيحة. المتوقع: XXXX-XXXX-XXXX-XXXX');
        return;
    }

    // Loading
    container.innerHTML = `
        <div class="result-box text-center">
            <div class="loader" style="border-color:rgba(102,126,234,0.3); border-top-color:#667eea; margin:auto"></div>
            <p class="mt-3 mb-0 text-muted">جاري التحقق من الخادم...</p>
        </div>`;

    try {
        const res = await fetch('/api/verify-key', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ activation_key: rawKey })
        });
        const text = await res.text();
        let data;
        try { data = text ? JSON.parse(text) : {}; }
        catch (_) { data = { error: 'invalid_response' }; }

        if (!res.ok) {
            const msg = ERROR_MESSAGES[data.error] || data.error || ('HTTP ' + res.status);
            renderError(msg);
            return;
        }
        renderResult(data);
    } catch (e) {
        renderError(ERROR_MESSAGES.network_error + ': ' + e.message);
    }
}

function renderError(msg) {
    const container = document.getElementById('result-container');
    container.innerHTML = `
        <div class="result-box result-invalid">
            <div class="d-flex align-items-center mb-2">
                <i class="fas fa-exclamation-triangle text-danger" style="font-size:32px; margin-left:15px;"></i>
                <div>
                    <h5 class="mb-1 text-danger">تعذّر التحقق</h5>
                    <div class="text-muted">${esc(msg)}</div>
                </div>
            </div>
        </div>`;
}

function statusBadge(status, daysLeft) {
    const map = {
        active: { label: 'ترخيص فعّال', cls: 'status-valid', icon: 'check-circle' },
        expired: { label: 'ترخيص منتهي', cls: 'status-expired', icon: 'times-circle' },
        frozen: { label: 'مجمّد مؤقتاً', cls: 'status-frozen', icon: 'snowflake' },
        revoked: { label: 'ملغى نهائياً', cls: 'status-expired', icon: 'ban' },
        used: { label: 'مستخدم بالكامل', cls: 'status-warn', icon: 'check-double' }
    };
    const info = map[status] || { label: status || '-', cls: 'status-warn', icon: 'question-circle' };
    // تحذير إذا اقتربت النهاية
    if (status === 'active' && daysLeft !== null && daysLeft <= 7 && daysLeft >= 0) {
        info.cls = 'status-warn';
        info.label = `فعّال - ${daysLeft} يوم متبقي`;
        info.icon = 'exclamation-circle';
    }
    return `<span class="status-badge ${info.cls}"><i class="fas fa-${info.icon}"></i> ${esc(info.label)}</span>`;
}

function renderResult(d) {
    const container = document.getElementById('result-container');
    const status = d.derived_status || d.key_status;
    const daysLeft = d.license ? d.license.days_left : null;

    let boxClass = 'result-box';
    if (status === 'active' && (daysLeft === null || daysLeft > 7)) boxClass += ' result-valid';
    else if (status === 'active' && daysLeft !== null && daysLeft <= 7) boxClass += ' result-warning';
    else boxClass += ' result-invalid';

    // بناء صفوف المعلومات
    const rows = [];
    rows.push(row('المفتاح', `<code style="letter-spacing:2px">${esc(d.activation_key)}</code>`));
    if (d.client_name) rows.push(row('العميل', esc(d.client_name)));
    if (d.client_phone) rows.push(row('الهاتف', esc(d.client_phone)));
    rows.push(row('النشاط التجاري', esc(BUSINESS_LABELS[d.business_type] || d.business_type)));
    rows.push(row('قالب الفاتورة', esc(TEMPLATE_LABELS[d.invoice_template] || d.invoice_template)));
    rows.push(row('المدة الأصلية', esc(d.duration_days) + ' يوم'));
    rows.push(row('عدد التفعيلات', `${esc(d.used_activations || 0)} / ${esc(d.max_activations)}`));
    rows.push(row('تاريخ الإصدار', fmtDate(d.created_at)));

    if (d.license) {
        rows.push(`<div class="mt-3 mb-2" style="border-top:2px dashed #ccc; padding-top:12px;">
            <strong style="color:#667eea;"><i class="fas fa-id-card"></i> بيانات الترخيص المُفعّل</strong>
        </div>`);
        rows.push(row('تاريخ التفعيل', fmtDate(d.license.issued_at)));
        rows.push(row('تاريخ الانتهاء', fmtDateOnly(d.license.expires_at)));
        if (daysLeft !== null) {
            let daysCls = 'text-success';
            if (daysLeft < 0) daysCls = 'text-danger';
            else if (daysLeft <= 7) daysCls = 'text-warning';
            const daysText = daysLeft < 0
                ? `منتهي منذ ${Math.abs(daysLeft)} يوم`
                : `${daysLeft} يوم متبقي`;
            rows.push(row('الأيام المتبقية', `<span class="${daysCls}"><strong>${esc(daysText)}</strong></span>`));
        }
        rows.push(row('آخر اتصال', fmtDate(d.license.last_heartbeat_at)));
        rows.push(row('عدد الاتصالات', esc(d.license.heartbeat_count || 0)));
        if (d.license.machine_id_masked) {
            rows.push(row('معرّف الجهاز', `<code>${esc(d.license.machine_id_masked)}</code>`));
        }
    } else {
        rows.push(`<div class="mt-3 alert alert-info mb-0">
            <i class="fas fa-info-circle"></i>
            هذا المفتاح لم يُفعّل على أي جهاز بعد. يمكنك تفعيله من داخل تطبيق تقنيات سوفت Pro.
        </div>`);
    }

    container.innerHTML = `
        <div class="${boxClass}">
            <div class="text-center mb-3">
                ${statusBadge(status, daysLeft)}
            </div>
            <div>${rows.join('')}</div>
        </div>`;
}

function row(label, value) {
    return `<div class="info-row">
        <span class="info-label">${esc(label)}</span>
        <span class="info-value">${value}</span>
    </div>`;
}

// ---------- Init ----------
document.addEventListener('DOMContentLoaded', () => {
    const input = document.getElementById('activation-key');
    if (input) {
        input.addEventListener('input', () => formatKeyInput(input));
        input.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); verifyKey(); }
        });
        input.focus();
    }
});

// Expose to global (onclick handlers)
window.verifyKey = verifyKey;
