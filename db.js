// db.js — Google Sheets Database Layer for AGI Vehicle Lease Management
const DB_URL = 'https://script.google.com/macros/s/AKfycbwyQmfI665PCuvEM8zsJ0pmjwm2QNPtXvqkq02xEELaVoWEowVmqqgw1ILqDXNEZka2/exec';

const DB = {

  // --- Core fetch ---
  async post(payload) {
    const res = await fetch(DB_URL, {
      method: 'POST',
      body: JSON.stringify(payload),
      headers: { 'Content-Type': 'text/plain' }
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'DB error');
    return data.data;
  },

  async get(params) {
    const url = DB_URL + '?' + new URLSearchParams(params).toString();
    const res = await fetch(url);
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'DB error');
    return data.data;
  },

  // --- Load all data ---
  async loadAll() {
    try {
      showLoadingOverlay('Loading your data...');
      const [registries, units, leases, users, meta] = await Promise.all([
        DB.get({ action: 'getAll', sheet: 'invoices' }),
        DB.get({ action: 'getAll', sheet: 'units' }),
        DB.get({ action: 'getAll', sheet: 'leases' }),
        DB.get({ action: 'getAll', sheet: 'users' }),
        DB.get({ action: 'getMeta' })
      ]);

      // Parse registries
      const parsedRegistries = registries.map(r => ({
        ...r,
        id: String(r.id || ''),
        seq: Number(r.seq) || 0,
        wdNumber: String(r.wdNumber || ''),
        docNumber: String(r.docNumber || ''),
        category: String(r.category || ''),
        totalAmount: String(r.totalAmount || ''),
        lease: String(r.lease || ''),
        periodStart: String(r.periodStart || ''),
        periodEnd: String(r.periodEnd || ''),
        submittedDate: String(r.submittedDate || ''),
        createdAt: String(r.createdAt || ''),
        units: DB.parseField(r.units),
        comments: DB.parseField(r.comments) || []
      }));

      // Parse units — using correct field names from JSON
      const parsedUnits = units.map(u => ({
        ...u,
        id: String(u.id || ''),
        lease: String(u.lease || ''),
        company: String(u.company || ''),
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
        statusHistory: DB.parseField(u.statusHistory) || [],
        comments: DB.parseField(u.comments) || [],
        overviewComments: DB.parseField(u.overviewComments) || [],
        createdAt: String(u.createdAt || '')
      }));

      // Parse leases
      const parsedLeases = leases.map(l => ({
        ...l,
        id: String(l.id || ''),
        leaseNumber: String(l.leaseNumber || ''),
        company: String(l.company || ''),
        supplier: String(l.supplier || ''),
        category: String(l.category || ''),
        invoicing: String(l.invoicing || ''),
        arrangement: String(l.arrangement || ''),
        startDate: String(l.startDate || ''),
        endDate: String(l.endDate || ''),
        monthlyAmount: String(l.monthlyAmount || ''),
        status: String(l.status || ''),
        notes: String(l.notes || ''),
        createdAt: String(l.createdAt || '')
      }));

      // Parse users
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
      return {
        invoices: [],
        registries: parsedRegistries,
        units: parsedUnits,
        leases: parsedLeases,
        users: parsedUsers,
        comments: {},
        meta: Object.assign(
          { createdAt: new Date().toISOString(), registrySeq: 0 },
          meta
        )
      };
    } catch (e) {
      hideLoadingOverlay();
      throw e;
    }
  },

  // --- Save entire state ---
  async saveAll(state) {
    try {
      await DB.post({ action: 'saveMeta', data: state.meta });
    } catch(e) {
      console.error('DB saveAll error:', e);
    }
  },

  // --- Individual record operations ---
  async saveRegistry(record) {
    const data = {
      ...record,
      units: Array.isArray(record.units) ? JSON.stringify(record.units) : record.units,
      comments: Array.isArray(record.comments) ? JSON.stringify(record.comments) : (record.comments || '[]')
    };
    return DB.post({ action: 'save', sheet: 'invoices', data });
  },

  async updateRegistry(record) {
    const data = {
      ...record,
      units: Array.isArray(record.units) ? JSON.stringify(record.units) : record.units,
      comments: Array.isArray(record.comments) ? JSON.stringify(record.comments) : (record.comments || '[]')
    };
    return DB.post({ action: 'update', sheet: 'invoices', id: record.id, data });
  },

  async deleteRegistry(id) {
    return DB.post({ action: 'delete', sheet: 'invoices', id });
  },

  async saveUnit(record) {
    const data = {
      ...record,
      statusHistory: Array.isArray(record.statusHistory) ? JSON.stringify(record.statusHistory) : (record.statusHistory || '[]'),
      comments: Array.isArray(record.comments) ? JSON.stringify(record.comments) : (record.comments || '[]'),
      overviewComments: Array.isArray(record.overviewComments) ? JSON.stringify(record.overviewComments) : (record.overviewComments || '[]')
    };
    return DB.post({ action: 'save', sheet: 'units', data });
  },

  async updateUnit(record) {
    const data = {
      ...record,
      statusHistory: Array.isArray(record.statusHistory) ? JSON.stringify(record.statusHistory) : (record.statusHistory || '[]'),
      comments: Array.isArray(record.comments) ? JSON.stringify(record.comments) : (record.comments || '[]'),
      overviewComments: Array.isArray(record.overviewComments) ? JSON.stringify(record.overviewComments) : (record.overviewComments || '[]')
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

  async saveUser(record) {
    return DB.post({ action: 'save', sheet: 'users', data: record });
  },

  async updateUser(record) {
    return DB.post({ action: 'update', sheet: 'users', id: record.id, data: record });
  },

  async deleteUser(id) {
    return DB.post({ action: 'delete', sheet: 'users', id });
  },

  // --- Helper ---
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