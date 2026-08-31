// db.js — Google Sheets Database Layer for AGI Vehicle Lease Management
const DB_URL = 'https://script.google.com/macros/s/AKfycbwDucOuepk0hudhuFKvHmgguaf9-zhHxqXIUpB9xNOUco9JXaLxz0-TRvWSNpcR6WVFuw/exec';
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

  // 60s (was 30s): measured directly against the live backend, a single "Manual Coverage"
  // fetch alone took up to ~34.5s under real contention (every request — read or write, from
  // any operator — serializes through one global Apps Script lock), so 30s was already too
  // tight for the current data volume and was throwing "Request timed out" on ordinary page
  // loads, not just under unusual load. This is the default for every DB.get/DB.post call that
  // doesn't pass its own ms — including loadAll()'s initial fetch — so it's deliberately
  // generous rather than tuned to today's exact worst case, since that sheet keeps growing.
  _fetchWithTimeout(fetchPromise, ms = 60000) {
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

  // timeoutMs lets a caller override the default 30s client-side timeout — the "Manual
  // Coverage"/"Accruals" bulk actions read and rewrite their entire sheet in one pass server
  // side, so as those sheets grow (Manual Coverage stores one row per manually-covered day per
  // unit, so it's the one that grows fastest), that single request genuinely takes longer,
  // even though nothing is actually wrong. Without a longer allowance here, the client gives up
  // and reports a (silent, console-only) failure while Apps Script keeps running in the
  // background and completes the write moments later — which looks exactly like "the delete
  // didn't take" if the operator refreshes in that window, when it actually just hadn't
  // finished yet.
  async post(payload, timeoutMs) {
    const res = await DB._fetchWithTimeout(fetch(DB_URL, {
      method: 'POST',
      body: JSON.stringify({...payload, secret: DB_SECRET}),
      headers: { 'Content-Type': 'text/plain' }
    }), timeoutMs);
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
      const [registries, units, leases, users, ccCentersRaw, invoiceTrackingRaw, accrualsRaw, manualCoverageRaw, meta] = await Promise.all([
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
        DB.get({ action: 'getAll', sheet: 'Accruals' }).catch(e => {
          console.warn('Accruals sheet failed to load (falling back to empty) — verify the tab is named exactly "Accruals":', e.message);
          return [];
        }),
        // Manual coverage used to be a JSON blob column on the units sheet, saved via the same
        // full-record DB.updateUnit() call every other unit edit (comments, status, etc.) also
        // uses — any of those other calls could silently clobber it with a stale snapshot taken
        // before the manual-coverage edit, which is what was making marks disappear after a
        // refresh. Each date is now its own row here, saved/deleted independently of anything
        // else touching the unit.
        DB.get({ action: 'getAll', sheet: 'Manual Coverage' }).catch(e => {
          console.warn('Manual Coverage sheet failed to load (falling back to empty) — verify the tab is named exactly "Manual Coverage":', e.message);
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

      // Manual Coverage sheet: one row per manually-covered date, {id, unitId, date, createdAt}.
      // Grouped by unitId (case/whitespace-insensitive, matching how the rest of the app looks
      // units up) so each unit gets its own plain date-string array (manualCoverageDates, read
      // everywhere coverage is computed) plus a date->rowId map (manualCoverageRowIds, internal
      // bookkeeping only — lets setManualCoverageDate/persistManualCoverage save or delete
      // exactly the right row later without a full-sheet scan).
      const parsedManualCoverage = (Array.isArray(manualCoverageRaw) ? manualCoverageRaw : []).map(mc => ({
        id: String(mc.id || ''),
        unitId: String(mc.unitId || ''),
        date: String(mc.date || ''),
        createdAt: String(mc.createdAt || '')
      }));

      const parsedUnits = units.map(u => {
        const uidNorm = String(u.unitId || '').trim().toLowerCase();
        const ownCoverage = parsedManualCoverage.filter(mc => mc.unitId.trim().toLowerCase() === uidNorm);
        return {
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
          manualCoverageDates: ownCoverage.map(r => r.date),
          manualCoverageRowIds: ownCoverage.reduce((acc, r) => { acc[r.date] = r.id; return acc; }, {}),
          createdAt: String(u.createdAt || '')
        };
      });

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

      // Accruals: a period stays "open" (editable, undoable) while accrualMonth/accrualYear
      // are blank; "Close Month Accruals" stamps both and locks it — see accrueCurrentUnit/
      // closeAccrualsMonth in app.js.
      const parsedAccruals = (Array.isArray(accrualsRaw) ? accrualsRaw : []).map(a => ({
        id: String(a.id || ''),
        unitId: String(a.unitId || ''),
        lease: String(a.lease || ''),
        supplier: String(a.supplier || ''),
        costCenter: String(a.costCenter || ''),
        status: String(a.status || ''),
        periodStart: String(a.periodStart || ''),
        periodEnd: String(a.periodEnd || ''),
        days: Number(a.days) || 0,
        accrualMonth: String(a.accrualMonth || ''),
        accrualYear: String(a.accrualYear || ''),
        notAccruable: String(a.notAccruable || ''),
        createdAt: String(a.createdAt || '')
      }));

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
        accruals: parsedAccruals,
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
      overviewComments: Array.isArray(record.overviewComments) ? JSON.stringify(record.overviewComments) : (record.overviewComments || '[]')
    };
    // Manual coverage now lives entirely in its own "Manual Coverage" sheet (see
    // saveManualCoverage/deleteManualCoverage) — never write it back onto the units row here,
    // both to avoid an array value going straight into a Sheets cell and to keep this the one
    // source of truth (see loadAll's comment on why the old blob-column approach lost data).
    delete data.manualCoverageDates;
    delete data.manualCoverageRowIds;
    return DB.post({ action: 'save', sheet: 'units', data });
  },

  async updateUnit(record) {
    const data = {
      ...record,
      statusHistory: Array.isArray(record.statusHistory) ? JSON.stringify(record.statusHistory) : (record.statusHistory || '[]'),
      comments: Array.isArray(record.comments) ? JSON.stringify(record.comments) : (record.comments || '[]'),
      overviewComments: Array.isArray(record.overviewComments) ? JSON.stringify(record.overviewComments) : (record.overviewComments || '[]')
    };
    delete data.manualCoverageDates;
    delete data.manualCoverageRowIds;
    return DB.post({ action: 'update', sheet: 'units', id: record.id, data });
  },

  async deleteUnit(id) {
    return DB.post({ action: 'delete', sheet: 'units', id });
  },

  async saveManualCoverage(record) {
    return DB.post({ action: 'save', sheet: 'Manual Coverage', data: record });
  },
  async deleteManualCoverage(id) {
    return DB.post({ action: 'delete', sheet: 'Manual Coverage', id });
  },
  // A single drag can mark/unmark hundreds of dates at once — one network request per date
  // (the old approach) means a wide drag fires that many near-simultaneous requests against
  // Apps Script's single LockService queue and 30s client timeout, and a random subset would
  // silently fail. These batch everything from one Accept into one request each.
  async bulkSaveManualCoverage(records) {
    if (!records || records.length === 0) return { saved: 0 };
    // 120s: "Manual Coverage" holds one row per manually-covered day per unit, so it's grown
    // into the largest sheet by far — bulkSave/bulkDelete against it can legitimately take
    // longer than the default 30s as it keeps growing (see DB.post's comment).
    return DB.post({ action: 'bulkSave', sheet: 'Manual Coverage', data: records }, 120000);
  },
  async bulkDeleteManualCoverage(ids) {
    if (!ids || ids.length === 0) return { deleted: 0 };
    return DB.post({ action: 'bulkDelete', sheet: 'Manual Coverage', ids }, 120000);
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

  async saveAccrual(record) {
    return DB.post({ action: 'save', sheet: 'Accruals', data: record });
  },

  async updateAccrual(record) {
    return DB.post({ action: 'update', sheet: 'Accruals', id: record.id, data: record });
  },

  async deleteAccrual(id) {
    return DB.post({ action: 'delete', sheet: 'Accruals', id });
  },
  // A single "Accrue Unit"/undo click can touch several records at once (a unit with more than
  // one open missing period) — batched into one request each, same reasoning as
  // bulkSaveManualCoverage/bulkDeleteManualCoverage.
  async bulkSaveAccruals(records) {
    if (!records || records.length === 0) return { saved: 0 };
    return DB.post({ action: 'bulkSave', sheet: 'Accruals', data: records }, 120000);
  },
  async bulkDeleteAccruals(ids) {
    if (!ids || ids.length === 0) return { deleted: 0 };
    return DB.post({ action: 'bulkDelete', sheet: 'Accruals', ids }, 120000);
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
