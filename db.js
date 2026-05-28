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

      // Parse arrays stored as JSON strings
      const parsedRegistries = registries.map(r => ({
        ...r,
        units: DB.parseField(r.units),
        comments: DB.parseField(r.comments) || []
      }));

      const parsedUnits = units.map(u => ({ ...u }));
      const parsedLeases = leases.map(l => ({ ...l }));
      const parsedUsers = users.map(u => ({ ...u }));

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
    return DB.post({ action: 'save', sheet: 'units', data: record });
  },

  async updateUnit(record) {
    return DB.post({ action: 'update', sheet: 'units', id: record.id, data: record });
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
    if (typeof val === 'string' && val.startsWith('[')) {
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