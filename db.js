// db.js — Google Sheets Database Layer for AGI Vehicle Lease Management
const DB_URL = 'https://script.google.com/macros/s/AKfycbxCETj689oe4msZ4e60q0Q345Nnj7qp_EPn5ZLwZpqjSlm5V7OmQznqfF_WCoTrAD7sxw/exec';
const DB_SECRET = 'AGI_EQP_2026_s3cur3key';

// The Invoice Tracking sheet's header row uses the exact human-readable labels shown in the
// app (spaces and all), unlike every other sheet here which uses short camelCase headers —
// this maps between the two so the rest of the app can keep using normal camelCase fields.
const INVOICE_TRACKING_FIELD_MAP = {
  supplier: 'Supplier',
  lease: 'Lease',
  unitsInDispute: 'Units in Dispute',
  supplierInvoiceDoc: 'Supplier Invoice Doc',
  invoiceAmount: 'Invoice Amount',
  amountInDispute: 'Amount in Dispute',
  amountDue: 'Amount Due',
  wdInvoiceNum: 'WD Invoice Num',
  wdInvoiceDate: 'WD Invoice Date',
  invoiceStatus: 'Invoice Status',
  paymentStatus: 'Payment Status',
  fromDate: 'From Date',
  toDate: 'To Date',
  costCenter: 'Cost Center',
  descriptionOfIssue: 'Description of Issue',
  request: 'Request',
  status: 'Status',
  // New column — auto-created in Sheets on first save (ensureHeaders adds any missing header
  // automatically, same as how "leases"/"unitDetails" were added to the invoices sheet). Holds
  // the per-unit Amount in Dispute/Amount Due breakdown; Invoice Amount/Amount in Dispute/
  // Amount Due on the record itself are just the totals rolled up from this array.
  unitAmountDetails: 'Unit Amount Details',
  // The binnacle — without this the log only ever lives in the in-memory session and is lost
  // on reload.
  log: 'Log'
};

const INVOICE_TRACKING_JSON_FIELDS = ['unitsInDispute', 'lease', 'unitAmountDetails', 'log'];

function _invoiceTrackingToSheetRow(record){
  const out = { id: record.id || '' };
  Object.keys(INVOICE_TRACKING_FIELD_MAP).forEach(key => {
    const header = INVOICE_TRACKING_FIELD_MAP[key];
    let v = record[key];
    if(INVOICE_TRACKING_JSON_FIELDS.indexOf(key) !== -1) v = Array.isArray(v) ? JSON.stringify(v) : (v || '[]');
    out[header] = v !== undefined && v !== null ? v : '';
  });
  return out;
}

function _invoiceTrackingFromSheetRow(row){
  const rec = { id: String(row.id || '') };
  Object.keys(INVOICE_TRACKING_FIELD_MAP).forEach(key => {
    const header = INVOICE_TRACKING_FIELD_MAP[key];
    let v = row[header];
    if(INVOICE_TRACKING_JSON_FIELDS.indexOf(key) !== -1){ const parsed = DB.parseField(v); rec[key] = Array.isArray(parsed) ? parsed : []; }
    else rec[key] = v !== undefined && v !== null ? String(v) : '';
  });
  return rec;
}

const DB = {

  _fetchWithTimeout(fetchPromise, ms = 30000) {
    return Promise.race([
      fetchPromise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Request timed out after ' + (ms/1000) + 's — Google Sheets may be unavailable')), ms)
      )
    ]);
  },

  async _parseResponse(res) {
    const text = await res.text();
    if(text.trim().startsWith('<')){
      throw new Error(
        'Google Apps Script devolvió una página HTML en lugar de datos.\n\n' +
        'Solución: abre el Apps Script en Google Drive → Deploy → Manage deployments → ' +
        'verifica que esté activo y con acceso "Anyone". Si expiró, crea un nuevo deployment.'
      );
    }
    let data;
    try { data = JSON.parse(text); }
    catch(e) { throw new Error('Respuesta inválida de Google Sheets: ' + text.slice(0, 120)); }
    if(!data.success) throw new Error(data.error || 'DB error');
    return data.data;
  },

  async post(payload) {
    const res = await DB._fetchWithTimeout(fetch(DB_URL, {
      method: 'POST',
      body: JSON.stringify({...payload, secret: DB_SECRET}),
      headers: { 'Content-Type': 'text/plain' }
    }));
    return DB._parseResponse(res);
  },

  async get(params) {
    const url = DB_URL + '?' + new URLSearchParams({...params, secret: DB_SECRET}).toString();
    const res = await DB._fetchWithTimeout(fetch(url));
    return DB._parseResponse(res);
  },

  async loadAll() {
    try {
      showLoadingOverlay('Loading your data...');
      const [registries, units, leases, users, ccCentersRaw, invoiceTrackingRaw, meta] = await Promise.all([
        DB.get({ action: 'getAll', sheet: 'invoices' }),
        DB.get({ action: 'getAll', sheet: 'units' }),
        DB.get({ action: 'getAll', sheet: 'leases' }),
        DB.get({ action: 'getAll', sheet: 'users' }),
        DB.get({ action: 'getAll', sheet: 'ccControl' }),
        // Guarded separately: this sheet is new, and if its tab name doesn't match exactly
        // (case/spacing) the Apps Script throws "Sheet not found" — that used to fail the
        // whole Promise.all and block the entire app from loading over one optional sheet.
        DB.get({ action: 'getAll', sheet: 'Invoice Tracking' }).catch(e => {
          console.warn('Invoice Tracking sheet failed to load (falling back to empty) — verify the tab is named exactly "Invoice Tracking":', e.message);
          return [];
        }),
        DB.get({ action: 'getMeta' })
      ]);

      const parsedRegistries = registries.map(r => ({
        ...r,
        id: String(r[' '] || r.id || ''),
        seq: Number(r.seq) || 0,
        wdNumber: String(r.wdNumber || ''),
        docNumber: String(r.docNumber || ''),
        category: String(r.category || ''),
        totalAmount: String(r.totalAmount || ''),
        lease: String(r.lease || ''),
        leases: (()=>{ const v = DB.parseField(r.leases); return Array.isArray(v) ? v : []; })(),
        // This one column on the invoices sheet uses a spaced/title-case header ("Invoice
        // Date") rather than the camelCase convention every other column here follows — read
        // from that exact header; saveRegistry/updateRegistry mirror it back out the same way.
        invoiceDate: String(r['Invoice Date'] || r.invoiceDate || ''),
        periodStart: String(r.periodStart || ''),
        periodEnd: String(r.periodEnd || ''),
        submittedDate: String(r.submittedDate || ''),
        createdAt: String(r.createdAt || ''),
        units: DB.parseField(r.units),
        unitDetails: (()=>{ const v = DB.parseField(r.unitDetails); return Array.isArray(v) ? v : []; })(),
        // Quarterly leases: any additional periods beyond the registry's own (first) period
        // above, each carrying its own From/To dates and its own per-unit unitDetails.
        periods: (()=>{ const v = DB.parseField(r.periods); return Array.isArray(v) ? v : []; })(),
        comments: DB.parseField(r.comments) || []
      }));

      const parsedUnits = units.map(u => ({
        ...u,
        id: String(u.id || ''),
        lease: String(u.lease || ''),
        company: String(u.company || ''),
        costCenter: String(u.costCenter || ''),
        supplier: String(u.supplier || ''),
        arrangement: String(u.arrangement || ''),
        invoicing: String(u.invoicing || ''),
        unitId: String(u.unitId || ''),
        monthly: String(u.monthly || ''),
        description: String(u.description || ''),
        notes: String(u.notes || ''),
        status: String(u.status || ''),
        disabledDate: String(u.disabledDate || ''),
        enabledDate: String(u.enabledDate || ''),
        statusHistory: (()=>{ const v = DB.parseField(u.statusHistory); return Array.isArray(v) ? v : []; })(),
        comments: DB.parseField(u.comments) || [],
        overviewComments: DB.parseField(u.overviewComments) || [],
        manualCoverageDates: (()=>{ const v = DB.parseField(u.manualCoverageDates); return Array.isArray(v) ? v : []; })(),
        createdAt: String(u.createdAt || '')
      }));

      const parsedLeases = leases.map(l => ({
        ...l,
        id: String(l.id || ''),
        leaseNumber: String(l.leaseNumber || ''),
        company: String(l.company || ''),
        supplier: String(l.supplier || ''),
        arrangement: String(l.arrangement || ''),
        invoicing: String(l.invoicing || ''),
        notes: String(l.notes || ''),
        status: String(l.status || ''),
        fromDate: String(l.fromDate || ''),
        toDate: String(l.toDate || '')
      }));

      const parsedUsers = users.map(u => ({
        ...u,
        id: String(u.id || ''),
        username: String(u.username || ''),
        password: String(u.password || ''),
        firstName: String(u.firstName || ''),
        lastName: String(u.lastName || ''),
        role: String(u.role || ''),
        createdAt: String(u.createdAt || '')
      }));

      hideLoadingOverlay();
      // Sanitize meta fields to ensure correct types
      const sanitizedMeta = Object.assign(
        { createdAt: new Date().toISOString(), registrySeq: 0 },
        meta
      );
      const stringFields = ['unitSearch','unitOverviewSearch','leaseSearch','leaseOverviewSearch','registrySearch'];
      stringFields.forEach(f => { sanitizedMeta[f] = String(sanitizedMeta[f] || ''); });
      const numFields = ['unitOverviewMonth','unitOverviewYear','leaseOverviewMonth','leaseOverviewYear','registrySeq'];
      numFields.forEach(f => { sanitizedMeta[f] = Number(sanitizedMeta[f]) || 0; });
      const parsedCCCenters = (Array.isArray(ccCentersRaw) ? ccCentersRaw : []).map(c => ({
        ...c,
        id: String(c.id || ''),
        costCenter: String(c.costCenter || ''),
        referenceId: String(c.referenceId || ''),
        company: String(c.company || ''),
        location: String(c.location || ''),
        address: String(c.address || ''),
        createdAt: String(c.createdAt || '')
      }));

      const parsedInvoiceTracking = (Array.isArray(invoiceTrackingRaw) ? invoiceTrackingRaw : []).map(_invoiceTrackingFromSheetRow);

      const arrayFields = ['devCompanies','devRentals','devSuppliers','devPayments','devArrangements','devOtherCharges'];
      arrayFields.forEach(f => {
        const v = sanitizedMeta[f];
        if(Array.isArray(v)){ return; } // already parsed
        if(typeof v === 'string' && v.trim().startsWith('[')){
          try{ sanitizedMeta[f] = JSON.parse(v); }catch(e){ sanitizedMeta[f] = []; }
        } else {
          sanitizedMeta[f] = [];
        }
      });

      return {
        invoices: [],
        registries: parsedRegistries,
        units: parsedUnits,
        leases: parsedLeases,
        users: parsedUsers,
        ccCenters: parsedCCCenters,
        invoiceTracking: parsedInvoiceTracking,
        comments: {},
        meta: sanitizedMeta
      };
    } catch (e) {
      hideLoadingOverlay();
      throw e;
    }
  },

  async saveAll(state) {
    try {
      await DB.post({ action: 'saveMeta', data: state.meta });
    } catch(e) {
      console.error('DB saveAll error:', e);
    }
  },

  async saveRegistry(record) {
    const data = {
      ...record,
      units: Array.isArray(record.units) ? JSON.stringify(record.units) : record.units,
      leases: Array.isArray(record.leases) ? JSON.stringify(record.leases) : (record.leases || '[]'),
      unitDetails: Array.isArray(record.unitDetails) ? JSON.stringify(record.unitDetails) : (record.unitDetails || '[]'),
      periods: Array.isArray(record.periods) ? JSON.stringify(record.periods) : (record.periods || '[]'),
      comments: Array.isArray(record.comments) ? JSON.stringify(record.comments) : (record.comments || '[]')
    };
    // "Invoice Date" is the one column on this sheet with a spaced/title-case header instead
    // of camelCase — write to that exact header, not a new "invoiceDate" column.
    delete data.invoiceDate;
    data['Invoice Date'] = record.invoiceDate || '';
    return DB.post({ action: 'save', sheet: 'invoices', data });
  },

  async updateRegistry(record) {
    const data = {
      ...record,
      units: Array.isArray(record.units) ? JSON.stringify(record.units) : record.units,
      leases: Array.isArray(record.leases) ? JSON.stringify(record.leases) : (record.leases || '[]'),
      unitDetails: Array.isArray(record.unitDetails) ? JSON.stringify(record.unitDetails) : (record.unitDetails || '[]'),
      periods: Array.isArray(record.periods) ? JSON.stringify(record.periods) : (record.periods || '[]'),
      comments: Array.isArray(record.comments) ? JSON.stringify(record.comments) : (record.comments || '[]')
    };
    delete data.invoiceDate;
    data['Invoice Date'] = record.invoiceDate || '';
    return DB.post({ action: 'update', sheet: 'invoices', id: record.id, data });
  },

  async deleteRegistry(id, fallbackMatch) {
    return DB.post({ action: 'delete', sheet: 'invoices', id, fallbackMatch });
  },

  async saveUnit(record) {
    const data = {
      ...record,
      statusHistory: Array.isArray(record.statusHistory) ? JSON.stringify(record.statusHistory) : (record.statusHistory || '[]'),
      comments: Array.isArray(record.comments) ? JSON.stringify(record.comments) : (record.comments || '[]'),
      overviewComments: Array.isArray(record.overviewComments) ? JSON.stringify(record.overviewComments) : (record.overviewComments || '[]'),
      manualCoverageDates: Array.isArray(record.manualCoverageDates) ? JSON.stringify(record.manualCoverageDates) : (record.manualCoverageDates || '[]')
    };
    return DB.post({ action: 'save', sheet: 'units', data });
  },

  async updateUnit(record) {
    const data = {
      ...record,
      statusHistory: Array.isArray(record.statusHistory) ? JSON.stringify(record.statusHistory) : (record.statusHistory || '[]'),
      comments: Array.isArray(record.comments) ? JSON.stringify(record.comments) : (record.comments || '[]'),
      overviewComments: Array.isArray(record.overviewComments) ? JSON.stringify(record.overviewComments) : (record.overviewComments || '[]'),
      manualCoverageDates: Array.isArray(record.manualCoverageDates) ? JSON.stringify(record.manualCoverageDates) : (record.manualCoverageDates || '[]')
    };
    return DB.post({ action: 'update', sheet: 'units', id: record.id, data });
  },

  async deleteUnit(id) {
    return DB.post({ action: 'delete', sheet: 'units', id });
  },

  async saveLease(record) {
    return DB.post({ action: 'save', sheet: 'leases', data: record });
  },

  async updateLease(record) {
    return DB.post({ action: 'update', sheet: 'leases', id: record.id, data: record });
  },

  async deleteLease(id) {
    return DB.post({ action: 'delete', sheet: 'leases', id });
  },

  async saveCCCenter(record) {
    return DB.post({ action: 'save', sheet: 'ccControl', data: record });
  },

  async updateCCCenter(record) {
    return DB.post({ action: 'update', sheet: 'ccControl', id: record.id, data: record });
  },

  async deleteCCCenter(id) {
    return DB.post({ action: 'delete', sheet: 'ccControl', id });
  },

  async saveInvoiceTracking(record) {
    return DB.post({ action: 'save', sheet: 'Invoice Tracking', data: _invoiceTrackingToSheetRow(record) });
  },

  async updateInvoiceTracking(record) {
    return DB.post({ action: 'update', sheet: 'Invoice Tracking', id: record.id, data: _invoiceTrackingToSheetRow(record) });
  },

  async deleteInvoiceTracking(id) {
    return DB.post({ action: 'delete', sheet: 'Invoice Tracking', id });
  },

  async saveUser(record) {
    return DB.post({ action: 'save', sheet: 'users', data: record });
  },

  async updateUser(record) {
    return DB.post({ action: 'update', sheet: 'users', id: record.id, data: record });
  },

  async deleteUser(id) {
    return DB.post({ action: 'delete', sheet: 'users', id });
  },

  parseField(val) {
    if (Array.isArray(val)) return val;
    if (typeof val === 'object' && val !== null) return val;
    if (typeof val === 'string' && (val.startsWith('[') || val.startsWith('{'))) {
      try { return JSON.parse(val); } catch(e) { return []; }
    }
    return val;
  }
};

// --- Loading overlay ---
function showLoadingOverlay(msg) {
  let overlay = document.getElementById('dbLoadingOverlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'dbLoadingOverlay';
    overlay.style.cssText = `
      position:fixed; top:0; left:0; width:100%; height:100%;
      background:rgba(15,23,42,0.85); display:flex; flex-direction:column;
      align-items:center; justify-content:center; z-index:99999;
      font-family:Arial,sans-serif; color:white;
    `;
    overlay.innerHTML = `
      <img src="AGILogo.jpg" style="height:60px;margin-bottom:24px;opacity:0.9" onerror="this.style.display='none'">
      <div style="font-size:22px;font-weight:600;margin-bottom:12px">AGI Vehicle Lease Management</div>
      <div id="dbLoadingMsg" style="font-size:15px;opacity:0.8;margin-bottom:24px">${msg}</div>
      <div style="width:200px;height:4px;background:rgba(255,255,255,0.2);border-radius:2px;overflow:hidden">
        <div id="dbLoadingBar" style="height:100%;width:30%;background:#3b82f6;border-radius:2px;animation:dbSlide 1.2s ease-in-out infinite"></div>
      </div>
      <style>@keyframes dbSlide{0%{transform:translateX(-100%)}100%{transform:translateX(700%)}}</style>
    `;
    document.body.appendChild(overlay);
  } else {
    document.getElementById('dbLoadingMsg').textContent = msg;
    overlay.style.display = 'flex';
  }
}

function hideLoadingOverlay() {
  const overlay = document.getElementById('dbLoadingOverlay');
  if (overlay) overlay.style.display = 'none';
}
