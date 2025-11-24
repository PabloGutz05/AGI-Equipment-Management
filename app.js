// Simple SPA with localStorage persistence and import/export JSON
const STORAGE_KEY = 'agi_vehicle_lease_v1';

const defaultData = {
  invoices: [],
  units: [],
  leases: [],
  users: [],
  registries: [],
  meta: { createdAt: new Date().toISOString(), registrySeq: 0 }
};

let state = loadState();

// --- Tabs ---
document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p=>p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(btn.dataset.tab).classList.add('active');
    renderOverview();
  });
});

// --- Authentication / Login Gate ---
const SESSION_KEY = 'agi_session';
function isAuthenticated(){
  try{ const s = sessionStorage.getItem(SESSION_KEY); return !!s; }catch(e){ return false; }
}

function showApp(yes){
  const root = qs('#appRoot'); const gate = qs('#loginGate'); const logoutBtn = qs('#logoutBtn');
  // ensure CSS variable for header height is set so the login overlay doesn't overlap the header
  setHeaderHeightVar();
  // If true, we don't immediately show the application: first present the AGI Process Menu
  const menu = qs('#agiProcessMenu');
  if(yes){ if(menu) menu.style.display = 'flex'; if(root) root.style.display='none'; if(gate) gate.style.display='none'; if(logoutBtn) logoutBtn.style.display='inline-block'; applyRoleRestrictions(); }
  else {
    // show login gate
    if(root) root.style.display='none'; if(gate) gate.style.display='flex'; if(menu) menu.style.display = 'none'; if(logoutBtn) logoutBtn.style.display='none';
    // when on the login page we must hide export/import controls and clear data button
    updateExportImportVisibility(true);
    const clearDataBtn = qs('#clearDataBtn'); if(clearDataBtn) clearDataBtn.style.display = 'none';
    // ensure header title is default when showing login
    updateHeaderTitleForMenu(false);
    // disable brand link while on login page so it cannot open the process menu
    try{ const bl = qs('#brandLink'); if(bl){ bl.classList.add('disabled-brand'); bl.setAttribute('aria-disabled','true'); bl.tabIndex = -1; } }catch(e){}
    return;
  }

  // update header title according to menu visibility
  const menuVisible = !!menu && menu.style.display !== 'none';
  updateHeaderTitleForMenu(menuVisible);
  // hide export/import controls and clear data button when menu visible, otherwise show them
  updateExportImportVisibility(menuVisible);
  const clearDataBtn = qs('#clearDataBtn');
  if(clearDataBtn){
    if(menuVisible){
      clearDataBtn.style.display = 'none';
    } else {
      // Only show if role allows (will be controlled by applyRoleRestrictions)
      applyRoleRestrictions();
    }
  }
  // ensure brandLink is enabled when leaving login
  try{ const bl = qs('#brandLink'); if(bl){ bl.classList.remove('disabled-brand'); bl.removeAttribute('aria-disabled'); bl.tabIndex = 0; } }catch(e){}
}

function updateExportImportVisibility(menuVisible){
  const exportBtn = qs('#exportBtn'); const importLabel = document.querySelector('.file-label');
  if(menuVisible){ if(exportBtn) exportBtn.style.display = 'none'; if(importLabel) importLabel.style.display = 'none'; }
  else { if(exportBtn) exportBtn.style.display = 'inline-block'; if(importLabel) importLabel.style.display = 'inline-flex'; }
}

// --- Header title update for Process Menu ---
function getCurrentUserInfo(){
  const session = currentSession(); if(!session) return null;
  if(session.user === 'Master') return { firstName: 'Master', lastName: '', role: 'Master', username: 'Master' };
  const u = (state.users||[]).find(x=> x.username === session.user);
  if(!u) return { firstName: session.user, lastName: '', role: '' };
  return { firstName: (u.firstName || u.username), lastName: (u.lastName || ''), role: (u.role || '') , username: u.username };
}

function updateHeaderTitleForMenu(menuVisible){
  const titleEl = qs('#brandLink h1') || qs('header h1'); if(!titleEl) return;
  if(menuVisible){
    const info = getCurrentUserInfo();
    if(info){
      const name = (info.firstName || info.username) + (info.lastName ? ' ' + info.lastName : '');
      const role = info.role ? (' — ' + info.role) : '';
      titleEl.textContent = 'Welcome! ' + name + role;
    } else {
      titleEl.textContent = 'Welcome!';
    }
  } else {
    titleEl.textContent = 'AGI Vehicle Lease Management';
  }
}

// compute header height and set a CSS variable used by the login overlay
function setHeaderHeightVar(){
  try{
    const header = document.querySelector('header');
    const h = header ? header.getBoundingClientRect().height : 72;
    document.documentElement.style.setProperty('--header-height', Math.ceil(h)+'px');
  }catch(e){ /* ignore */ }
}

// update header height on resize so overlay stays below header
window.addEventListener('resize', ()=>{ setHeaderHeightVar(); });

// login form handler
const loginForm = qs('#loginForm');
if(loginForm){
  loginForm.addEventListener('submit', e=>{
    e.preventDefault();
    const fd = new FormData(loginForm);
    const username = fd.get('username') || '';
    const password = fd.get('password') || '';
    // Master account (case-sensitive)
    if(username === 'Master' && password === 'Master'){
  sessionStorage.setItem(SESSION_KEY, JSON.stringify({user:'Master'}));
  showApp(true); renderAll(); syncTabLabels(); updateHeaderTitleForMenu(true); updateExportImportVisibility(true); return;
    }
    // check users in state (password must match and case-sensitive)
    const u = (state.users||[]).find(x=> x.username === username && x.password === password);
  if(u){ sessionStorage.setItem(SESSION_KEY, JSON.stringify({user: u.username})); showApp(true); renderAll(); syncTabLabels(); applyRoleRestrictions(); updateExportImportVisibility(true); return; }
    alert('Invalid credentials');
  });
}

// logout
const logoutBtn = qs('#logoutBtn'); if(logoutBtn){ logoutBtn.addEventListener('click', ()=>{ sessionStorage.removeItem(SESSION_KEY); showApp(false); }); }

// On load decide whether to show the app
document.addEventListener('DOMContentLoaded', ()=>{ showApp(isAuthenticated()); });

// --- AGI Process Menu wiring ---
const procMenu = qs('#agiProcessMenu');
const procVehicleBtn = qs('#procVehicleLease');
const procManagementBtn = qs('#procManagement');
const brandLink = qs('#brandLink');

if(procVehicleBtn){ procVehicleBtn.addEventListener('click', ()=>{ // open Vehicle Leasing Management (existing appRoot)
  const root = qs('#appRoot'); if(root) root.style.display = 'block'; if(procMenu) procMenu.style.display = 'none'; // ensure tabs are synced
  syncTabLabels(); renderAll(); applyRoleRestrictions(); updateHeaderTitleForMenu(false); updateExportImportVisibility(false);
  // Switch to Overview tab (Unit Overview)
  const overviewTab = Array.from(document.querySelectorAll('.tab')).find(t=>t.dataset.tab==='overview'); 
  if(overviewTab) overviewTab.click();
}); }

if(procManagementBtn){ procManagementBtn.addEventListener('click', ()=>{ alert('Management process not yet implemented.'); }); }

// Note: 'Close menu' button removed from markup; users enter the app via the process buttons or header

// clicking the logo/title navigates back to the AGI Process Menu
if(brandLink){ brandLink.addEventListener('click', e=>{ e.preventDefault(); // do not navigate
  // hide the app and show menu
  const root = qs('#appRoot'); if(root) root.style.display = 'none'; if(procMenu) procMenu.style.display = 'flex';
  // ensure logout is visible if session exists
  applyRoleRestrictions();
  // hide export/import
  updateExportImportVisibility(true);
  // keep focus on the menu for keyboard users
  const firstBtn = qs('#procVehicleLease'); if(firstBtn) firstBtn.focus();
});
  // keyboard accessibility (Enter/Space)
  brandLink.addEventListener('keydown', e=>{ if(e.key === 'Enter' || e.key === ' '){ e.preventDefault(); brandLink.click(); } });
}
// ensure header title is updated when brandLink click shows menu
if(brandLink){ brandLink.addEventListener('click', ()=>{ updateHeaderTitleForMenu(true); }); }

// --- Resizable tabs splitter ---
const SPLIT_KEY = 'agi_tabs_width';
function applySavedTabsWidth(){
  try{
    const v = localStorage.getItem(SPLIT_KEY);
    if(v){ document.documentElement.style.setProperty('--tabs-width', v+'px'); }
  }catch(e){}
}
applySavedTabsWidth();

const splitter = qs('#splitter');
if(splitter){
  let dragging = false;
  let startX = 0;
  let startWidth = 0;
  splitter.addEventListener('mousedown', e=>{
    dragging = true; startX = e.clientX; startWidth = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--tabs-width')) || 220;
    document.body.style.cursor = 'col-resize';
    e.preventDefault();
  });
  window.addEventListener('mousemove', e=>{
    if(!dragging) return;
    const dx = e.clientX - startX;
    let newW = startWidth + dx;
    // clamp
    newW = Math.max(120, Math.min(newW, Math.max(220, window.innerWidth - 200)));
    document.documentElement.style.setProperty('--tabs-width', newW+'px');
  });
  window.addEventListener('mouseup', ()=>{
    if(!dragging) return; dragging = false; document.body.style.cursor = ''; const final = getComputedStyle(document.documentElement).getPropertyValue('--tabs-width').trim();
    try{ localStorage.setItem(SPLIT_KEY, parseInt(final)+''); }catch(e){}
  });
}

// Set tab button labels from each panel's <h2> title so labels always match page titles
function syncTabLabels(){
  document.querySelectorAll('.tab').forEach(btn=>{
    const panel = document.getElementById(btn.dataset.tab);
    if(!panel) return;
    const h2 = panel.querySelector('h2');
    const titleText = h2 ? h2.textContent.trim() : btn.dataset.tab;
    const titleSpan = btn.querySelector('.tab-title');
    if(titleSpan) titleSpan.textContent = titleText;
    else btn.textContent = titleText;
  });
}

// --- Role-based tab visibility ---
function currentSession(){
  try{ const s = sessionStorage.getItem(SESSION_KEY); return s ? JSON.parse(s) : null; }catch(e){ return null; }
}

function applyRoleRestrictions(){
  const session = currentSession();
  let role = null;
  if(!session) return;
  // Master is a special built-in account
  if(session.user === 'Master'){ role = 'Master'; }
  else {
    const u = (state.users||[]).find(x=> x.username === session.user);
    role = u ? (u.role || null) : null;
  }

  // default: show all
  const tabs = document.querySelectorAll('.tab');
  tabs.forEach(t => t.style.display = 'flex');

  // apply restrictions
  if(role === 'Manager'){
    // hide Developer tab
    const dev = Array.from(tabs).find(x=> x.dataset.tab === 'developer'); if(dev) dev.style.display = 'none';
  }
  else if(role === 'Operator'){
    // hide developer, users, leaseControl
    const names = ['developer','users','leaseControl'];
    names.forEach(n => { const el = Array.from(tabs).find(x=> x.dataset.tab === n); if(el) el.style.display = 'none'; });
  }
  
  // Show/hide Clear Data button based on role (only Developer and Master)
  const clearDataBtn = qs('#clearDataBtn');
  if(clearDataBtn){
    if(role === 'Master' || role === 'Developer'){
      clearDataBtn.style.display = 'inline-block';
    } else {
      clearDataBtn.style.display = 'none';
    }
  }
  
  // Master and Developer: full access (do nothing)
  // ensure the Users form role options reflect the current session role
  try{ updateUserRoleOptionsVisibility(); }catch(e){}
}

// ensure role-based visibility for role radio options is applied when role restrictions change
try{ updateUserRoleOptionsVisibility(); }catch(e){}

// Hide Developer role option in the Users form for Manager/Operator sessions
function updateUserRoleOptionsVisibility(){
  try{
    const session = currentSession();
    let role = null;
    if(!session){ role = null; }
    else if(session.user === 'Master'){ role = 'Master'; }
    else {
      const u = (state.users||[]).find(x=> x.username === session.user);
      role = u ? (u.role || null) : null;
    }

    const devInput = qs('#role-developer');
    const devLabel = document.querySelector('label[for="role-developer"]');
    const operatorInput = qs('#role-operator');

    // For Manager or Operator sessions, hide and disable the Developer option
    if(role === 'Manager' || role === 'Operator'){
      if(devInput){ devInput.style.display = 'none'; devInput.disabled = true; }
      if(devLabel) devLabel.style.display = 'none';
      // if Developer was selected, fall back to Operator
      try{ if(devInput && devInput.checked && operatorInput) operatorInput.checked = true; }catch(e){}
    } else {
      // show and enable for Master and Developer
      if(devInput){ devInput.style.display = ''; devInput.disabled = false; }
      if(devLabel) devLabel.style.display = '';
    }
  }catch(e){ /* ignore */ }
}

// --- Forms ---
function qs(sel){return document.querySelector(sel)}

qs('#invoiceForm').addEventListener('submit', e=>{
  e.preventDefault();
  const form = e.target;
  const fd = new FormData(form);
  // New rule: only block submission when an existing invoice has the same
  // Lease, Category, Unit and WD Invoice number. If any of those differs,
  // allow the registration. Editing the same invoice is allowed.
  try{
    // Use FormData.getAll when available to detect multiple selected units
    const leaseVal = (fd.get('invoiceLease') || '').toString().trim();
    const catVal = (fd.get('invoiceCategory') || '').toString().trim();
    const wdVal = (fd.get('invoiceWD') || '').toString().trim();
    const editingId = form.dataset.editing || null;

    let unitsForCheck = [];
    if(typeof fd.getAll === 'function'){
      unitsForCheck = fd.getAll('invoiceUnit').map(s=> (s||'').toString().trim()).filter(Boolean);
    }
    if(unitsForCheck.length === 0){ unitsForCheck = [ (fd.get('invoiceUnit') || '').toString().trim() ]; }

    // If editing a single invoice, check uniqueness against other invoices for that single unit
    if(editingId){
      const unitVal = unitsForCheck.length ? unitsForCheck[0] : '';
      const clash = (state.invoices || []).find(inv => {
        if(inv.id === (editingId || '')) return false; // ignore self when editing
        const aLease = (inv.lease || '').toString().trim().toLowerCase();
        const aCat = (inv.category || '').toString().trim().toLowerCase();
        const aUnit = (inv.unit || '').toString().trim().toLowerCase();
        const aWd = (inv.wdNumber || '').toString().trim().toLowerCase();
        return aLease === leaseVal.toLowerCase() && aCat === catVal.toLowerCase() && aUnit === unitVal.toLowerCase() && aWd === wdVal.toLowerCase();
      });
      if(clash){ alert('An invoice with the same Lease, Category, Unit and WD Invoice number already exists. Submission blocked.'); return; }
    }
    // If creating multiple units, we'll handle uniqueness per-unit below (do not block whole submission here)
  }catch(err){ /* on unexpected error, let submission proceed */ }
  // Build a base invoice object (unit will be replaced per-unit if multiple units provided)
  const baseInvoice = {
    lease: fd.get('invoiceLease') || '',
    supplier: (qs('#invoiceSupplier') && qs('#invoiceSupplier').value) || fd.get('invoiceSupplier') || '',
    company: fd.get('invoiceCompany') || '',
    arrangement: fd.get('invoiceArrangement') || '',
    invoicing: (qs('#invoiceInvoicing') && qs('#invoiceInvoicing').value) || fd.get('invoiceInvoicing') || '',
    category: fd.get('invoiceCategory') || '',
    wdNumber: (fd.get('invoiceWD') || '').toString().trim(),
    docNumber: fd.get('invoiceDoc') || '',
    amount: (function(){ const v = fd.get('invoiceAmount')||''; const n = parseCurrency(v); return n===null ? '' : n.toFixed(2); })(),
    periodStart: fd.get('invoicePeriodStart') || '',
    periodEnd: fd.get('invoicePeriodEnd') || '',
    submittedDate: fd.get('invoiceSubmitted') || '',
    comment: fd.get('invoiceComment') || ''
  };

  const editingId = form.dataset.editing || null;
  if(editingId){
    // editing an existing single invoice: prefer first selected unit when available
    let unitVal = '';
    if(typeof fd.getAll === 'function'){
      const alls = fd.getAll('invoiceUnit') || [];
      unitVal = (alls.length ? alls[0] : (fd.get('invoiceUnit') || '')).toString().trim();
    } else {
      unitVal = (fd.get('invoiceUnit') || '').toString().trim();
    }

    const invoiceObj = Object.assign({}, baseInvoice, { id: editingId, unit: unitVal });
    state.invoices = state.invoices.map(inv => inv.id === editingId ? Object.assign({}, inv, invoiceObj, {id: editingId}) : inv);
    saveState(); renderInvoices();
    renderUnitOverview(); renderLeaseOverview(); renderOverview();
    form.reset(); delete form.dataset.editing;
    const submitBtn = form.querySelector('button[type="submit"]'); if(submitBtn) submitBtn.textContent = 'Add Invoice';
    const invCancel = qs('#invoiceCancelBtn'); if(invCancel) invCancel.style.display = 'none';
    const sub = qs('#invoiceSubmitted'); if(sub) sub.value = new Date().toISOString().slice(0,10);
  } else {
    // New registration: collect multiple units via FormData.getAll when available
    let units = [];
    if(typeof fd.getAll === 'function'){
      units = fd.getAll('invoiceUnit').map(s => (s||'').toString().trim()).filter(Boolean);
    }
    if(units.length === 0){
      const single = (fd.get('invoiceUnit') || '').toString();
      units = single.split(/[;,]+/).map(s=>s.trim()).filter(Boolean);
    }
    if(units.length === 0) units.push('');

  const skipped = [];
  const createdIds = [];
  const createdUnits = [];
    // Prepare per-unit amounts: treat entered amount as TOTAL for the WD invoice.
    // If multiple units are provided, split the total evenly (in cents) so per-unit amounts sum to the total.
    let perUnitAmounts = [];
    try{
      const tot = (baseInvoice.amount || '').toString().trim();
      if(tot !== '' && !Number.isNaN(Number(tot)) && units.length > 0){
        // work in cents to avoid floating point issues
        const totalCents = Math.round(Number(tot) * 100);
        const q = Math.floor(totalCents / units.length);
        let rem = totalCents % units.length;
        for(let i=0;i<units.length;i++){
          let cents = q + (rem > 0 ? 1 : 0);
          if(rem > 0) rem -= 1;
          perUnitAmounts.push((cents/100).toFixed(2));
        }
      } else {
        // no numeric total provided: keep blank amount for each unit
        perUnitAmounts = units.map(()=> '');
      }
    }catch(e){ perUnitAmounts = units.map(()=> baseInvoice.amount || ''); }

  units.forEach((uVal, ui) => {
      // uniqueness check per unit
      const clash = (state.invoices || []).find(inv => {
        const aLease = (inv.lease||'').toString().trim().toLowerCase();
        const aCat = (inv.category||'').toString().trim().toLowerCase();
        const aUnit = (inv.unit||'').toString().trim().toLowerCase();
        const aWd = (inv.wdNumber||'').toString().trim().toLowerCase();
        return aLease === (baseInvoice.lease||'').toString().trim().toLowerCase()
          && aCat === (baseInvoice.category||'').toString().trim().toLowerCase()
          && aUnit === uVal.toString().trim().toLowerCase()
          && aWd === (baseInvoice.wdNumber||'').toString().trim().toLowerCase();
      });
  if(clash){ skipped.push(uVal); return; }
      // assign per-unit amount if available
      const amountForThis = (perUnitAmounts && perUnitAmounts[ui] !== undefined) ? perUnitAmounts[ui] : (baseInvoice.amount || '');
      const newInv = Object.assign({}, baseInvoice, { id: id(), unit: uVal, amount: amountForThis });
      state.invoices.push(newInv); createdIds.push(newInv.id); createdUnits.push(uVal);
    });

    // If any invoices were created for this WD submission, record a registry entry
    if(createdIds.length > 0){
      state.meta = state.meta || {};
      state.meta.registrySeq = (state.meta.registrySeq || 0) + 1;
      const registry = {
        id: id(),
        seq: state.meta.registrySeq,
        wdNumber: baseInvoice.wdNumber || '',
        docNumber: baseInvoice.docNumber || '',
        totalAmount: baseInvoice.amount || '',
        unitCount: createdIds.length,
        units: createdUnits.slice(),
        periodStart: baseInvoice.periodStart || '',
        periodEnd: baseInvoice.periodEnd || '',
        submittedDate: baseInvoice.submittedDate || (new Date().toISOString().slice(0,10)),
        createdAt: new Date().toISOString(),
        comments: [],
        lease: baseInvoice.lease || ''
      };
      state.registries = state.registries || [];
      state.registries.push(registry);
    }

    saveState(); renderInvoices(); renderRegistries();
    renderUnitOverview(); renderLeaseOverview(); renderOverview();
    form.reset(); const submitBtn = form.querySelector('button[type="submit"]'); if(submitBtn) submitBtn.textContent = 'Add Invoice';
    const invCancel = qs('#invoiceCancelBtn'); if(invCancel) invCancel.style.display = 'none';
    const sub = qs('#invoiceSubmitted'); if(sub) sub.value = new Date().toISOString().slice(0,10);

    if(skipped.length && createdIds.length){ alert('Some units were skipped because a matching registry already exists: ' + skipped.join(', ')); }
    else if(skipped.length && createdIds.length===0){ alert('No invoices were created — all provided units already have an invoice with the same Lease, Category and WD number.'); }
  }

});

// sync invoice selects
function syncInvoiceLeaseOptions(){
  const sel = qs('#invoiceLease'); if(!sel) return;
  const cur = sel.value;
  sel.innerHTML = '<option value="">(select lease)</option>';
  // Show all operational leases (Enabled status or no status set)
  (state.leases || []).forEach(l=>{
    const status = (l.status || 'Enabled').toString().toLowerCase();
    // Include all leases except explicitly disabled ones
    if(status === 'disabled') return;
    const opt = document.createElement('option'); opt.value = l.leaseNumber || l.id; opt.textContent = l.leaseNumber || l.id; sel.appendChild(opt);
  });
  if(cur) sel.value = cur;
}
function syncInvoiceCompanyOptions(){ const sel = qs('#invoiceCompany'); if(!sel) return; const cur = sel.value; sel.innerHTML = '<option value="">(select company)</option>'; (state.meta.devCompanies||[]).forEach(c=>{ const opt = document.createElement('option'); opt.value = c; opt.textContent = c; sel.appendChild(opt); }); if(cur) sel.value = cur; }
function syncInvoiceArrangementOptions(){ const sel = qs('#invoiceArrangement'); if(!sel) return; const cur = sel.value; sel.innerHTML = '<option value="">(select arrangement)</option>'; (state.meta.devPayments||[]).forEach(p=>{ const opt = document.createElement('option'); opt.value = p; opt.textContent = p; sel.appendChild(opt); }); if(cur) sel.value = cur; }
function syncInvoiceUnitOptions(leaseVal, selectedValues){
  // selectedValues: optional array of values to pre-check
  selectedValues = Array.isArray(selectedValues) ? selectedValues.map(s=>String(s)) : [];
  const panel = qs('#invoiceUnitPanel'); const toggle = qs('#invoiceUnitToggle');
  const list = (typeof leaseVal === 'undefined' || !leaseVal) ? (state.units || []).slice() : (state.units || []).filter(u => (u.lease === leaseVal) || (u.lease === (leaseVal || '')) );

  if(panel){
    panel.innerHTML = '';
    if(list.length === 0){ const none = document.createElement('div'); none.className = 'small-muted'; none.textContent = '(no units available)'; panel.appendChild(none); if(toggle) toggle.textContent = 'Select units'; return; }

    // Add search box
    const searchContainer = document.createElement('div'); searchContainer.style.padding = '8px'; searchContainer.style.borderBottom = '1px solid #e6e6e6';
    const searchBox = document.createElement('input'); searchBox.type = 'text'; searchBox.placeholder = 'Search units...'; searchBox.id = 'invoiceUnitSearch';
    searchBox.style.width = '100%'; searchBox.style.padding = '6px 8px'; searchBox.style.border = '1px solid #e6e6e6'; searchBox.style.borderRadius = '4px'; searchBox.style.fontSize = '13px';
    searchContainer.appendChild(searchBox);
    panel.appendChild(searchContainer);

    // Add small controls: Select all / Clear
    const ctrl = document.createElement('div'); ctrl.style.display = 'flex'; ctrl.style.justifyContent = 'flex-end'; ctrl.style.gap = '6px'; ctrl.style.padding = '6px 8px';
    const btnAll = document.createElement('button'); btnAll.type = 'button'; btnAll.className = 'small-link'; btnAll.textContent = 'Select all';
    const btnClear = document.createElement('button'); btnClear.type = 'button'; btnClear.className = 'small-link'; btnClear.textContent = 'Clear';
    ctrl.appendChild(btnClear); ctrl.appendChild(btnAll); // Clear on left, Select all on right
    panel.appendChild(ctrl);

    // Container for checkbox list
    const checkboxContainer = document.createElement('div'); checkboxContainer.id = 'invoiceUnitCheckboxContainer';
    panel.appendChild(checkboxContainer);

    list.forEach(u => {
      const val = (u.unitId || u.id || '').toString();
      const row = document.createElement('div'); row.style.display = 'flex'; row.style.alignItems = 'center'; row.style.gap = '8px'; row.style.padding = '6px 4px';
      row.className = 'unit-checkbox-row';
      row.setAttribute('data-unit-id', val.toLowerCase());
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.name = 'invoiceUnit'; cb.value = val; cb.id = 'invoiceUnit_cb_' + val.replace(/[^a-z0-9_-]/gi,'_');
      if(selectedValues.length && selectedValues.indexOf(val) !== -1) cb.checked = true;
      const lab = document.createElement('label'); lab.htmlFor = cb.id; lab.textContent = val; lab.style.flex = '1 1 auto';
      cb.addEventListener('change', ()=>{ updateInvoiceUnitToggleLabel(); });
      row.appendChild(cb); row.appendChild(lab); checkboxContainer.appendChild(row);
    });

    // Add search functionality
    searchBox.addEventListener('input', () => {
      const searchTerm = searchBox.value.toLowerCase().trim();
      const rows = checkboxContainer.querySelectorAll('.unit-checkbox-row');
      rows.forEach(row => {
        const unitId = row.getAttribute('data-unit-id') || '';
        if(searchTerm === '' || unitId.includes(searchTerm)){
          row.style.display = 'flex';
        } else {
          row.style.display = 'none';
        }
      });
    });

    // Add Units button at the bottom
    const addUnitsContainer = document.createElement('div'); addUnitsContainer.style.padding = '8px'; addUnitsContainer.style.borderTop = '1px solid #e6e6e6'; addUnitsContainer.style.display = 'flex'; addUnitsContainer.style.justifyContent = 'center';
    const addUnitsBtn = document.createElement('button'); addUnitsBtn.type = 'button'; addUnitsBtn.className = 'btn-primary'; addUnitsBtn.textContent = 'Add Units'; addUnitsBtn.style.width = '100%';
    addUnitsBtn.addEventListener('click', (e) => {
      e.stopPropagation(); // Prevent event bubbling
      // Close the dropdown first
      panel.style.display = 'none';
      if(toggle) toggle.setAttribute('aria-expanded', 'false');
      // Then switch to Unit Control tab
      switchTab('unitControl');
      const unitInput = qs('#unitIdInput');
      if(unitInput) {
        setTimeout(() => unitInput.focus(), 100); // Delay focus to ensure tab switch completes
      }
    });
    addUnitsContainer.appendChild(addUnitsBtn);
    panel.appendChild(addUnitsContainer);

    // wiring for Select all / Clear
    btnAll.addEventListener('click', ()=>{
      // Only select visible checkboxes
      checkboxContainer.querySelectorAll('.unit-checkbox-row').forEach(row => {
        if(row.style.display !== 'none'){
          const cb = row.querySelector('input[type="checkbox"][name="invoiceUnit"]');
          if(cb) cb.checked = true;
        }
      });
      updateInvoiceUnitToggleLabel();
    });
    btnClear.addEventListener('click', ()=>{
      panel.querySelectorAll('input[type="checkbox"][name="invoiceUnit"]').forEach(i=> i.checked = false);
      updateInvoiceUnitToggleLabel();
    });

    function updateInvoiceUnitToggleLabel(){
      const tbtn = qs('#invoiceUnitToggle'); if(!tbtn) return;
      const checked = panel.querySelectorAll('input[type="checkbox"][name="invoiceUnit"]:checked').length;
      if(checked === 0) tbtn.textContent = 'Select units';
      else if(checked === 1) tbtn.textContent = panel.querySelector('input[type="checkbox"][name="invoiceUnit"]:checked').value;
      else tbtn.textContent = checked + ' units selected';
    }

    updateInvoiceUnitToggleLabel();

    if(toggle){
      try{ toggle.setAttribute('aria-expanded','false'); }catch(e){}
      const nt = toggle.cloneNode(true);
      toggle.parentNode.replaceChild(nt, toggle);
      nt.addEventListener('click', ()=>{
        const isOpen = panel.style.display !== 'none';
        panel.style.display = isOpen ? 'none' : 'block';
        nt.setAttribute('aria-expanded', String(!isOpen));
      });

      if(!window.__agi_invoice_dropdown_init){
        window.__agi_invoice_dropdown_init = true;
        document.addEventListener('click', (ev)=>{
          const panelEl = qs('#invoiceUnitPanel'); const toggleEl = qs('#invoiceUnitToggle');
          if(!panelEl || !toggleEl) return;
          const within = panelEl.contains(ev.target) || toggleEl.contains(ev.target);
          if(!within){ panelEl.style.display = 'none'; toggleEl.setAttribute('aria-expanded','false'); }
        });
        document.addEventListener('keydown', (ev)=>{ if(ev.key === 'Escape'){ const panelEl = qs('#invoiceUnitPanel'); const toggleEl = qs('#invoiceUnitToggle'); if(panelEl){ panelEl.style.display = 'none'; if(toggleEl) toggleEl.setAttribute('aria-expanded','false'); } } });
      }
    }
    return;
  }

  // fallback to native select if panel not present
  const sel = qs('#invoiceUnit'); if(!sel) return; const cur = sel.value; sel.innerHTML = '<option value="">(select unit)</option>';
  list.forEach(u=>{ const opt = document.createElement('option'); opt.value = u.unitId || u.id; opt.textContent = u.unitId || u.id; if(selectedValues.length && selectedValues.indexOf(opt.value) !== -1) opt.selected = true; sel.appendChild(opt); });
  if(cur) sel.value = cur;
}

// ensure invoice selects are updated when relevant lists change
if(typeof syncInvoiceLeaseOptions === 'function') syncInvoiceLeaseOptions();
if(typeof syncInvoiceCompanyOptions === 'function') syncInvoiceCompanyOptions();
if(typeof syncInvoiceArrangementOptions === 'function') syncInvoiceArrangementOptions();
if(typeof syncInvoiceUnitOptions === 'function') syncInvoiceUnitOptions();

// when invoice lease is selected, autofill company and arrangement informational inputs
const invoiceLeaseSel = qs('#invoiceLease');
if(invoiceLeaseSel){
  invoiceLeaseSel.addEventListener('change', ()=>{
    const val = invoiceLeaseSel.value;
  const c = qs('#invoiceCompany'); const a = qs('#invoiceArrangement'); const s = qs('#invoiceSupplier'); const inv = qs('#invoiceInvoicing');
    if(!val){ if(c) c.value=''; if(a) a.value=''; if(s) s.value=''; if(inv) inv.value=''; if(typeof syncInvoiceUnitOptions === 'function') syncInvoiceUnitOptions(); return; }
    const lease = state.leases.find(l => (l.leaseNumber === val) || (l.id === val));
    if(!lease){ if(c) c.value=''; if(a) a.value=''; if(s) s.value=''; if(inv) inv.value=''; return; }
    if(c) c.value = lease.company || '';
  if(s) s.value = lease.supplier || '';
    if(a) a.value = lease.arrangement || '';
    if(inv) inv.value = lease.invoicing || '';
    if(typeof syncInvoiceUnitOptions === 'function') syncInvoiceUnitOptions(val);
    // ensure the Submitted date is prefilled to today's date (predetermined actual date)
    const sub = qs('#invoiceSubmitted'); if(sub) sub.value = new Date().toISOString().slice(0,10);
  });
}

qs('#unitForm').addEventListener('submit', e=>{
  e.preventDefault();
  const form = e.target;
  const fd = new FormData(form);
  const editingId = form.dataset.editing || null;
  // Note: previously prevented submitting when lease and unit identifier matched.
  // That validation was intentionally removed so users can register a unit with the
  // same identifier as its lease if required.
  // Prevent duplicate unit registration for the same lease (case-insensitive).
  // Allow when editing the same existing unit (editingId).
  try{
    const leaseVal = (fd.get('unitLease') || '').toString().trim();
    const unitIdVal = ((fd.get('unitId') || fd.get('unitIdInput')) || '').toString().trim();
    if(leaseVal && unitIdVal){
      const clash = (state.units || []).find(u => {
        if(!u) return false;
        const ul = (u.lease || '').toString().trim().toLowerCase();
        const uid = (u.unitId || '').toString().trim().toLowerCase();
        return ul === leaseVal.toLowerCase() && uid === unitIdVal.toLowerCase() && u.id !== (editingId || '');
      });
      if(clash){
        alert('A unit with this identifier already exists for the selected lease. Duplicate registration is not allowed.');
        return;
      }
    }
  }catch(err){ /* fail open on unexpected error */ }
  const companyVal = (qs('#unitCompany') && qs('#unitCompany').value) || fd.get('unitCompany') || '';
  const supplierVal = (qs('#unitSupplier') && qs('#unitSupplier').value) || fd.get('unitSupplier') || '';
  const arrangementVal = (qs('#unitArrangement') && qs('#unitArrangement').value) || fd.get('unitArrangement') || '';
  const invoicingVal = (qs('#unitInvoicing') && qs('#unitInvoicing').value) || fd.get('unitInvoicing') || '';
  const unitObj = {
    id: editingId || id(),
    lease: fd.get('unitLease') || '',
    company: companyVal,
    supplier: supplierVal,
    arrangement: arrangementVal,
    invoicing: invoicingVal,
    unitId: fd.get('unitId') || fd.get('unitIdInput') || '',
  // store monthly as number (cents precision) where possible
  monthly: (function(){ const v = fd.get('unitMonthly') || ''; if(!v) return ''; const n = parseCurrency(v); return n === null ? '' : n.toFixed(2); })(),
    description: fd.get('unitDesc') || '',
    notes: fd.get('unitNotes') || '',
    status: (editingId ? (state.units.find(u=>u.id===editingId) || {}).status : 'Operational') || 'Operational'
  };
  if(editingId){
    state.units = state.units.map(u => u.id === editingId ? Object.assign({}, u, unitObj) : u);
  } else {
    state.units.push(unitObj);
  }
  saveState();
  renderUnits();
  if(typeof syncInvoiceUnitOptions === 'function') syncInvoiceUnitOptions();
  form.reset();
  delete form.dataset.editing;
  const submitBtn = form.querySelector('button[type="submit"]'); if(submitBtn) submitBtn.textContent = 'New';
  renderOverview();
  if(typeof renderOverviewUnits === 'function') renderOverviewUnits();
});

// currency helpers
function formatCurrency(val){
  if(val === '' || val === null || typeof val === 'undefined') return '';
  const n = Number(val);
  if(Number.isNaN(n)) return val;
  return n.toLocaleString(undefined, {style:'currency', currency:'USD', maximumFractionDigits:2});
}
function formatDate(dateStr){
  if(!dateStr) return '';
  // Convert YYYY-MM-DD to MM/DD/YYYY
  const parts = dateStr.split('-');
  if(parts.length === 3){
    return parts[1] + '/' + parts[2] + '/' + parts[0];
  }
  return dateStr;
}
function parseCurrency(str){
  if(str === '' || str === null || typeof str === 'undefined') return null;
  const cleaned = String(str).replace(/[^0-9.-]+/g,'');
  if(cleaned === '') return null;
  const n = Number(cleaned);
  if(Number.isNaN(n)) return null;
  return n;
}

// money input behaviour: show raw number on focus, formatted on blur
const moneyInput = qs('#unitMonthly');
if(moneyInput){
  moneyInput.addEventListener('focus', ()=>{
    const v = moneyInput.value;
    if(!v) return;
    // parse formatted value to plain number string for editing
    const n = parseCurrency(v);
    if(n !== null) moneyInput.value = n.toFixed(2);
  });
  moneyInput.addEventListener('blur', ()=>{
    const v = moneyInput.value;
    const n = parseCurrency(v);
    if(n === null){ moneyInput.value = ''; return; }
    moneyInput.value = formatCurrency(n);
  });
}

// invoice amount: behave like unit monthly (raw number while editing, formatted on blur)
const invoiceAmountInput = qs('#invoiceAmount');
if(invoiceAmountInput){
  invoiceAmountInput.addEventListener('focus', ()=>{
    const v = invoiceAmountInput.value;
    if(!v) return;
    const n = parseCurrency(v);
    if(n !== null) invoiceAmountInput.value = n.toFixed(2);
  });
  invoiceAmountInput.addEventListener('blur', ()=>{
    const v = invoiceAmountInput.value;
    const n = parseCurrency(v);
    if(n === null){ invoiceAmountInput.value = ''; return; }
    invoiceAmountInput.value = formatCurrency(n);
  });
}

qs('#leaseForm').addEventListener('submit', e=>{
  e.preventDefault();
  const form = e.target;
  const fd = new FormData(form);
  const editingId = form.dataset.editing || null;
  
  // Validate required fields
  const submittedLeaseNumber = (fd.get('leaseNumber') || '').toString().trim();
  const company = (fd.get('leaseCompany') || '').toString().trim();
  const supplier = (fd.get('leaseSupplier') || '').toString().trim();
  const arrangement = (fd.get('leaseArrangement') || '').toString().trim();
  const invoicing = (fd.get('leaseInvoicing') || '').toString().trim();
  
  if(!submittedLeaseNumber){ alert('Please provide a lease number'); return; }
  if(!company){ alert('Please select a company'); return; }
  if(!supplier){ alert('Please select a supplier'); return; }
  if(!arrangement){ alert('Please select an arrangement'); return; }
  if(!invoicing){ alert('Please select an invoicing type'); return; }
  
  // Prevent duplicate lease numbers (case-insensitive). Allow when editing the same lease.
  const lower = submittedLeaseNumber.toLowerCase();
  const existing = (state.leases || []).find(l => (l.leaseNumber || '').toString().toLowerCase() === lower && l.id !== (editingId || ''));
  if(existing){ alert('This lease number already exists. Please choose a different lease number.'); return; }
  const leaseObj = {
    id: editingId || id(),
    leaseNumber: fd.get('leaseNumber'),
    company: company,
    supplier: supplier,
    arrangement: arrangement,
    invoicing: invoicing,
    // optional seasonal month-day dates stored as MM-DD
    fromDate: (function(){ const m = fd.get('leaseFromMonth')||''; const d = fd.get('leaseFromDay')||''; return (m && d) ? (m+'-'+d) : ''; })(),
    toDate: (function(){ const m = fd.get('leaseToMonth')||''; const d = fd.get('leaseToDay')||''; return (m && d) ? (m+'-'+d) : ''; })()
  };

  if(editingId){
    state.leases = state.leases.map(l => l.id === editingId ? Object.assign({}, l, leaseObj) : l);
  } else {
    state.leases.push(leaseObj);
  }
  saveState();
  renderLeases();
  if(typeof syncInvoiceLeaseOptions === 'function') syncInvoiceLeaseOptions();
  form.reset();
  delete form.dataset.editing;
  const submitBtn = form.querySelector('button[type="submit"]');
  if(submitBtn) submitBtn.textContent = 'New';
  renderOverview();
  if(typeof renderOverviewUnits === 'function') renderOverviewUnits();
});

qs('#userForm').addEventListener('submit', e=>{
  e.preventDefault();
  const fd = new FormData(e.target);
  const editingId = e.target.dataset.editing || null;
  const userObj = {
    id: editingId || id(),
    firstName: fd.get('firstName'),
    lastName: fd.get('lastName'),
    username: (fd.get('username') || '').trim(),
    role: fd.get('role') || 'Operator'
  };
  const pwd = fd.get('password');
  if(pwd) userObj.password = pwd; // only set/replace password when provided

  // Validate uniqueness of username (case-insensitive)
  const newUsername = (userObj.username || '').toLowerCase();
  if(!newUsername){ alert('Please provide a username'); return; }
  const clash = (state.users || []).find(u => u.username && u.username.toLowerCase() === newUsername && u.id !== (editingId || ''));
  if(clash){ alert('Username already exists. Please choose another username.'); return; }

  if(editingId){
    // replace
    state.users = state.users.map(u => u.id === editingId ? Object.assign({}, u, userObj) : u);
  } else {
    state.users.push(userObj);
  }
  saveState();
  renderUsers();
  e.target.reset();
  delete e.target.dataset.editing;
  qs('#userCancelBtn').style.display = 'none';
});

// --- Renderers ---
function renderOverview(){
  const el = qs('#generalOverview');
  if(!el) return;
  el.innerHTML = '';

  // Create "Current Month" row
  const currentMonthRow = document.createElement('div');
  currentMonthRow.style.display = 'flex';
  currentMonthRow.style.alignItems = 'center';
  currentMonthRow.style.gap = '12px';
  currentMonthRow.style.marginBottom = '12px';
  currentMonthRow.style.padding = '8px';
  currentMonthRow.style.border = '1px solid #eef2f7';
  currentMonthRow.style.borderRadius = '6px';

  const label = document.createElement('div');
  label.style.fontWeight = '600';
  label.textContent = 'Current Month';

  currentMonthRow.appendChild(label);
  el.appendChild(currentMonthRow);
}

function oldRenderOverview(){
  const el = qs('#overviewSummary');
  if(!el) return;
  // Clear previous content
  el.innerHTML = '';
  // helper to render a month dashboard given a Date object representing any day in that month
  function renderMonthDashboard(dateObj){
    const year = dateObj.getFullYear();
    const monthIndex = dateObj.getMonth();
    const monthName = dateObj.toLocaleString(undefined, { month: 'long' });
    const monthStart = new Date(year, monthIndex, 1).toISOString().slice(0,10);
    const monthEnd = new Date(year, monthIndex + 1, 0).toISOString().slice(0,10);

    const operationalUnits = (state.units || []).filter(u => ((u.status || 'Operational') === 'Operational'));
    const totalOperational = operationalUnits.length;

    const invoicedUnitSet = new Set();
    (state.invoices || []).forEach(inv => {
      try{
        const unit = (inv.unit || '').toString().trim();
        if(!unit) return;
        const category = (inv.category || '').toString().toLowerCase();
        if(!category.includes('rental')) return;
        const s = (inv.periodStart || '').toString();
        const e = (inv.periodEnd || '').toString();
        if(!s || !e) return;
        if(!(e < monthStart || s > monthEnd)){
          invoicedUnitSet.add(unit.toLowerCase());
        }
      }catch(err){}
    });

    const invoicedUniqueCount = invoicedUnitSet.size;
    const percent = totalOperational ? Math.round((invoicedUniqueCount / totalOperational) * 100) : 0;

    const block = document.createElement('div');
    block.style.border = '1px solid #eef2f7';
    block.style.borderRadius = '8px';
    block.style.padding = '12px';
    block.style.marginBottom = '12px';

    const header = document.createElement('div');
    header.style.display = 'flex';
    header.style.justifyContent = 'space-between';
    header.style.alignItems = 'center';

    const title = document.createElement('h3'); title.style.margin = '0'; title.textContent = `${monthName} ${year}`;

    const statsInline = document.createElement('div');
    statsInline.style.display = 'flex'; statsInline.style.alignItems = 'baseline'; statsInline.style.gap = '12px';
    const pct = document.createElement('div'); pct.style.fontSize = '28px'; pct.style.fontWeight = '700'; pct.textContent = percent + '%';
    const vsInline = document.createElement('div'); vsInline.style.fontSize = '12px'; vsInline.style.color = '#6b7280'; vsInline.textContent = `${invoicedUniqueCount} / ${totalOperational} units — invoiced this month (unique) / operational units`;
    statsInline.appendChild(pct); statsInline.appendChild(vsInline);

    header.appendChild(title); header.appendChild(statsInline);
    block.appendChild(header);

    const barWrap = document.createElement('div'); barWrap.style.width = '100%'; barWrap.style.height = '14px'; barWrap.style.background = '#ffecec'; barWrap.style.borderRadius = '8px'; barWrap.style.overflow = 'hidden'; barWrap.style.marginTop = '8px';
    const progress = document.createElement('div'); progress.setAttribute('role','progressbar'); progress.setAttribute('aria-valuemin','0'); progress.setAttribute('aria-valuemax','100'); progress.setAttribute('aria-valuenow', String(percent)); progress.style.height = '100%'; progress.style.width = percent + '%'; progress.style.background = '#16a34a'; progress.style.transition = 'width 300ms ease';
    barWrap.appendChild(progress); block.appendChild(barWrap);

    return block;
  }

  // render current and previous month as a list
  const list = document.createElement('ul');
  list.style.listStyle = 'none';
  list.style.padding = '0';
  list.style.margin = '0';

  const now = new Date();
  const currentLi = document.createElement('li');
  currentLi.appendChild(renderMonthDashboard(now));
  list.appendChild(currentLi);

  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const prevLi = document.createElement('li');
  prevLi.appendChild(renderMonthDashboard(prev));
  list.appendChild(prevLi);

  el.appendChild(list);

  // --- month squares row ---
  const monthsWrap = qs('#overviewMonths');
  if(monthsWrap){
    monthsWrap.innerHTML = '';
    // ensure meta store for selected year
    state.meta = state.meta || {};
    const curYear = state.meta.overviewYear || (new Date()).getFullYear();
    // populate year selector (from curYear-3 .. curYear+1)
    const yearSel = qs('#overviewYear');
    if(yearSel){
      yearSel.innerHTML = '';
      for(let y = curYear - 3; y <= curYear + 1; y++){
        const opt = document.createElement('option'); opt.value = String(y); opt.textContent = String(y);
        yearSel.appendChild(opt);
      }
      yearSel.value = String(state.meta.overviewYear || curYear);
      yearSel.addEventListener('change', ()=>{ state.meta.overviewYear = parseInt(yearSel.value,10); saveState(); renderOverview(); });
    }

    const monthsRow = document.createElement('div'); monthsRow.className = 'months-row';
    const selectedYear = parseInt(state.meta.overviewYear || curYear,10);

    // helper: compute invoiced/operational counts for a given month index
    const computeMonthCounts = (year, monthIdx) =>{
      const monthStart = new Date(year, monthIdx, 1).toISOString().slice(0,10);
      const monthEnd = new Date(year, monthIdx + 1, 0).toISOString().slice(0,10);
      const operationalUnits = (state.units || []).filter(u => ((u.status || 'Operational') === 'Operational'));
      const totalOperational = operationalUnits.length;
      const invoicedUnitSet = new Set();
      (state.invoices || []).forEach(inv => {
        try{
          const unit = (inv.unit || '').toString().trim();
          if(!unit) return;
          const category = (inv.category || '').toString().toLowerCase();
          if(!category.includes('rental')) return;
          const s = (inv.periodStart || '').toString();
          const e = (inv.periodEnd || '').toString();
          if(!s || !e) return;
          if(!(e < monthStart || s > monthEnd)){
            invoicedUnitSet.add(unit.toLowerCase());
          }
        }catch(err){}
      });
      const invoicedUniqueCount = invoicedUnitSet.size;
      const percent = totalOperational ? Math.round((invoicedUniqueCount / totalOperational) * 100) : 0;
      return { totalOperational, invoicedUniqueCount, percent };
    };

    // create 12 squares
    const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    for(let m = 0; m < 12; m++){
      const counts = computeMonthCounts(selectedYear, m);
      const sq = document.createElement('div'); sq.className = 'month-square';
      sq.setAttribute('role','group'); sq.setAttribute('aria-label', `${monthNames[m]} ${selectedYear}: ${counts.invoicedUniqueCount} of ${counts.totalOperational} invoiced (${counts.percent}%)`);
      // fill element (green) width based on percent
      const fill = document.createElement('div'); fill.className = 'month-fill'; fill.style.width = counts.percent + '%';
      // remaining background slightly red is handled by CSS month-remaining (covering full area)
      const rem = document.createElement('div'); rem.className = 'month-remaining';
      const label = document.createElement('div'); label.className = 'month-label'; label.textContent = monthNames[m];
      sq.appendChild(rem);
      sq.appendChild(fill);
      sq.appendChild(label);
      monthsRow.appendChild(sq);
    }

    monthsWrap.appendChild(monthsRow);
  }
  // populate simple units table in overview if present
  if(typeof renderOverviewUnits === 'function') renderOverviewUnits();
}

function card(title, value, note){
  const d = document.createElement('div');
  d.className = 'summaryCard';
  d.innerHTML = `<div style="font-size:20px;font-weight:600">${value}</div><div class="small-muted">${title}</div><div class="small-muted">${note}</div>`;
  return d;
}
function renderInvoices(){
  const tbody = qs('#invoiceList'); if(!tbody) return; tbody.innerHTML = '';

  // group invoices by WD number (empty WD displayed as '(no WD)').
  // Iterate invoices in reverse insertion order so newest invoices appear first.
  const groups = {};
  const invoicesArr = (state.invoices || []);
  for(let i = invoicesArr.length - 1; i >= 0; i--){
    const inv = invoicesArr[i];
    const key = (inv.wdNumber || '').toString().trim() || '(no WD)';
    groups[key] = groups[key] || [];
    groups[key].push(inv);
  }

  // preserve insertion order of groups (newest-first) but keep '(no WD)' group at the end
  const keys = Object.keys(groups);
  const noWdIndex = keys.indexOf('(no WD)');
  if(noWdIndex !== -1){ keys.splice(noWdIndex, 1); keys.push('(no WD)'); }

  keys.forEach((k, groupIdx) => {
    const list = groups[k];
    const groupIndex = groupIdx + 1; // WD group number shown in the header

    // group header row
    const hdr = document.createElement('tr'); hdr.className = 'wd-group';
  const td = document.createElement('td'); td.colSpan = 8;

  // left part: index, Doc Invoice Number (use docNumber from first invoice when available), count
  const left = document.createElement('div'); left.style.display = 'inline-block'; left.style.verticalAlign = 'middle';
  const headerDoc = (list && list[0] && list[0].docNumber && list[0].docNumber.toString().trim()) ? list[0].docNumber.toString().trim() : k;
  left.innerHTML = `<strong>${groupIndex}.</strong>&nbsp;&nbsp;<strong>Doc Invoice Number: ${escapeHtml(headerDoc)}</strong> — ${list.length} unit(s)`;

    // right part: total amount and actions button
    const total = list.reduce((s,inv) => s + (parseFloat(inv.amount) || 0), 0);
    const right = document.createElement('div'); right.style.cssText = 'display:inline-flex; gap:8px; float:right; align-items:center;';
    const totalSpan = document.createElement('span'); totalSpan.className = 'wd-total'; totalSpan.textContent = 'total ' + formatCurrency(total.toFixed ? total.toFixed(2) : total);

    const actionsBtn = document.createElement('button'); actionsBtn.type = 'button'; actionsBtn.className = 'wd-actions-toggle'; actionsBtn.textContent = '⋯'; actionsBtn.title = 'Actions';
    actionsBtn.style.minWidth = '36px'; actionsBtn.style.height = '28px';

    // small popup menu for group actions (hidden by default)
    const menu = document.createElement('div'); menu.className = 'wd-actions-menu'; menu.style.position = 'absolute'; menu.style.display = 'none'; menu.style.background = '#fff'; menu.style.border = '1px solid #ddd'; menu.style.boxShadow = '0 4px 8px rgba(0,0,0,0.08)'; menu.style.padding = '6px'; menu.style.borderRadius = '6px'; menu.style.zIndex = 9999;
    const editOpt = document.createElement('button'); editOpt.type = 'button'; editOpt.textContent = 'Edit'; editOpt.style.display = 'block'; editOpt.style.width = '100%'; editOpt.style.marginBottom = '6px';
    const delOpt = document.createElement('button'); delOpt.type = 'button'; delOpt.textContent = 'Delete'; delOpt.style.display = 'block'; delOpt.style.width = '100%';
    menu.appendChild(editOpt); menu.appendChild(delOpt);

    // attach event handlers
    actionsBtn.addEventListener('click', (ev)=>{
      ev.stopPropagation(); // avoid global click handlers
      // position menu under the button
      const rect = actionsBtn.getBoundingClientRect();
      menu.style.left = (rect.left + window.scrollX) + 'px';
      menu.style.top = (rect.bottom + window.scrollY + 6) + 'px';
      // toggle visibility
      menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
    });

    // Edit: open invoice form populated with first invoice in group
    editOpt.addEventListener('click', ()=>{
      if(!list || list.length === 0) return; const inv = list[0];
      const form = qs('#invoiceForm'); if(!form) return;
      form.dataset.editing = inv.id;
      const leaseSel = form.querySelector('#invoiceLease'); if(leaseSel) leaseSel.value = inv.lease || '';
      const s = qs('#invoiceSupplier'); if(s) s.value = inv.supplier || '';
      const c = qs('#invoiceCompany'); if(c) c.value = inv.company || '';
      const a = qs('#invoiceArrangement'); if(a) a.value = inv.arrangement || '';
      const cat = form.querySelector('#invoiceCategory'); if(cat) cat.value = inv.category || '';
      if(typeof syncInvoiceUnitOptions === 'function') syncInvoiceUnitOptions(inv.lease, [inv.unit]);
      const wd = form.querySelector('#invoiceWD'); if(wd) wd.value = inv.wdNumber || '';
      const doc = form.querySelector('#invoiceDoc'); if(doc) doc.value = inv.docNumber || '';
      const amt = form.querySelector('#invoiceAmount'); if(amt) amt.value = inv.amount || '';
      const ps = form.querySelector('#invoicePeriodStart'); if(ps) ps.value = inv.periodStart || '';
      const pe = form.querySelector('#invoicePeriodEnd'); if(pe) pe.value = inv.periodEnd || '';
      const sub = form.querySelector('#invoiceSubmitted'); if(sub) sub.value = inv.submittedDate || new Date().toISOString().slice(0,10);
      const com = form.querySelector('#invoiceComment'); if(com) com.value = inv.comment || '';
      const submitBtn = form.querySelector('button[type="submit"]'); if(submitBtn) submitBtn.textContent = 'Save';
      const invCancel = qs('#invoiceCancelBtn'); if(invCancel) invCancel.style.display = 'inline-block';
      // hide menu after action
      menu.style.display = 'none';
      // focus the form tab
      const invTab = Array.from(document.querySelectorAll('.tab')).find(t=>t.dataset.tab==='invoices'); if(invTab) invTab.click();
    });

    // Delete: remove all invoices in this WD group
    delOpt.addEventListener('click', ()=>{
      if(!confirm('Delete all invoices for WD "' + k + '"?')) return;
      const ids = (list || []).map(i=>i.id);
      state.invoices = (state.invoices || []).filter(inv => ids.indexOf(inv.id) === -1);
      saveState(); renderInvoices(); renderOverview();
      menu.style.display = 'none';
    });

    // close menu when clicking elsewhere
    document.addEventListener('click', ()=>{ if(menu) menu.style.display = 'none'; });

    right.appendChild(totalSpan); right.appendChild(actionsBtn);

    // assemble header cell
    td.appendChild(left);
    td.appendChild(right);
    td.appendChild(menu);
    hdr.appendChild(td);
    tbody.appendChild(hdr);

    // render rows for the group (no per-row actions column)
    list.forEach((inv, idx) => {
      const tr = document.createElement('tr');
      tr.style.transition = 'background-color 0.2s ease';
      
      // Add hover effect
      tr.addEventListener('mouseenter', () => {
        tr.style.backgroundColor = '#f3f6fb';
      });
      tr.addEventListener('mouseleave', () => {
        tr.style.backgroundColor = '';
      });
      
      tr.innerHTML = `
        <td>
          <div class="lease-cell">
            <div class="lease-number"><div class="small-muted lease-legend">Lease</div><div class="lease-value">${escapeHtml(inv.lease||'')}</div></div>
            <div class="lease-supplier small-muted">${escapeHtml(inv.supplier||'')}</div>
            <div class="lease-company small-muted">${escapeHtml(inv.company||'')}</div>
          </div>
        </td>
        <td>
          <div class="category-cell">
            <div class="category-name"><div class="small-muted category-legend">Category</div><div class="category-value">${escapeHtml(inv.category||'')}</div></div>
            <div class="category-arrangement small-muted">${escapeHtml(inv.arrangement||'')}</div>
          </div>
        </td>
        <td>
          <div class="unit-cell"><div class="small-muted unit-legend">Unit</div><div class="unit-value">${escapeHtml(inv.unit||'')}</div></div>
        </td>
        <td>
          <div class="invoice-cell"><div class="small-muted wd-legend">Doc Invoice Number</div><div class="invoice-doc-primary"><strong>${escapeHtml(inv.docNumber||'')}</strong></div></div>
        </td>
        <td>
          <div class="amount-cell"><div class="small-muted amount-legend">Amount</div><div class="amount-value">${formatCurrency(inv.amount||'')}</div></div>
        </td>
        <td>
          <div class="period-cell"><div class="small-muted period-legend">Period</div><div class="period-from">${escapeHtml(inv.periodStart||'')}</div><div class="period-to small-muted">${escapeHtml(inv.periodEnd||'')}</div></div>
        </td>
        <td>
          <div class="submitted-cell"><div class="small-muted submitted-legend">Submitted</div><div class="submitted-value">${escapeHtml(inv.submittedDate||'')}</div><div class="small-muted" style="margin-top:4px;font-size:12px;"><strong>Category:</strong> ${escapeHtml(inv.category||'')}</div></div>
        </td>
        <td>
          <div class="comment-cell">
            <div class="small-muted comment-legend">Comment</div>
            <div class="comment-value">${escapeHtml(inv.comment||'')}</div>
          </div>
        </td>`;
      
      // Add comment button in the last column
      const lastCell = tr.querySelector('td:last-child .comment-cell');
      if(lastCell){
        const commentBtn = document.createElement('button');
        commentBtn.textContent = '💬';
        commentBtn.title = 'Add/Edit Comment';
        commentBtn.style.marginTop = '4px';
        commentBtn.style.padding = '4px 8px';
        commentBtn.style.fontSize = '14px';
        commentBtn.style.border = '1px solid #ddd';
        commentBtn.style.borderRadius = '4px';
        commentBtn.style.background = '#fff';
        commentBtn.style.cursor = 'pointer';
        commentBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const newComment = prompt('Enter comment for this invoice:', inv.comment || '');
          if(newComment !== null){
            inv.comment = newComment;
            saveState();
            renderInvoices();
          }
        });
        lastCell.appendChild(commentBtn);
      }
      
      tbody.appendChild(tr);
    });
  });

  // lease numbers are plain text (no popup on click)
}



// Render registry of grouped submissions (registries created when multiple units are submitted under a WD)
function renderRegistries(keepOpenRegistryId){
  const wrap = qs('#registryList'); if(!wrap) return; 
  
  // Store which registries are currently open before re-rendering
  const openRegistries = new Set();
  if(!keepOpenRegistryId){
    wrap.querySelectorAll('.registry-details').forEach(details => {
      if(details.style.display !== 'none'){
        const registryRow = details.closest('.registry-row');
        if(registryRow && registryRow.dataset.registryId){
          openRegistries.add(registryRow.dataset.registryId);
        }
      }
    });
  } else {
    openRegistries.add(keepOpenRegistryId);
  }
  
  wrap.innerHTML = '';
  const regs = (state.registries || []).slice();
  if(regs.length === 0){ const em = document.createElement('div'); em.className = 'small-muted'; em.textContent = 'No registries yet.'; wrap.appendChild(em); return; }

  // show newest-first
  for(let i = regs.length - 1; i >= 0; i--){
    const r = regs[i];
    const row = document.createElement('div'); 
    row.className = 'registry-row'; 
    row.style.border = '1px solid #eef2f7'; 
    row.style.padding = '8px'; 
    row.style.borderRadius = '6px'; 
    row.style.marginBottom = '8px';
    row.style.transition = 'background-color 0.2s ease';
    row.dataset.registryId = r.id;
    
    // Add hover effect
    row.addEventListener('mouseenter', () => {
      row.style.backgroundColor = '#f3f6fb';
    });
    row.addEventListener('mouseleave', () => {
      row.style.backgroundColor = '';
    });
    
    const title = document.createElement('div'); title.style.display = 'flex'; title.style.justifyContent = 'space-between'; title.style.alignItems = 'center';
    
    // Get lease number from registry.lease or from registry's first unit
    let leaseNumber = r.lease || '';
    if(!leaseNumber){
      const registryUnits = Array.isArray(r.units) ? r.units : [];
      if(registryUnits.length > 0){
        const firstUnit = (state.units || []).find(u => (u.unitId || u.id) === registryUnits[0]);
        if(firstUnit) leaseNumber = firstUnit.lease || '';
      }
    }
    
    const leftInfo = document.createElement('div');
    leftInfo.innerHTML = `<strong>${r.seq}.</strong> WD: ${escapeHtml(r.wdNumber||'(no WD)')} — Doc: ${escapeHtml(r.docNumber||'')}${leaseNumber ? ' — Lease: ' + escapeHtml(leaseNumber) : ''}`;
    leftInfo.style.cursor = 'pointer';
    leftInfo.addEventListener('click', ()=>{ details.style.display = details.style.display === 'none' ? 'block' : 'none'; });
    
    const rightInfo = document.createElement('div');
    rightInfo.style.display = 'flex';
    rightInfo.style.alignItems = 'center';
    rightInfo.style.gap = '8px';
    
    const amountInfo = document.createElement('div');
    amountInfo.className = 'small-muted';
    amountInfo.textContent = `${r.unitCount} unit(s) — ${formatCurrency(r.totalAmount||'')}`;
    
    // Create dropdown menu button
    const menuBtn = document.createElement('button');
    menuBtn.textContent = '...';
    menuBtn.style.padding = '4px 8px';
    menuBtn.style.border = '1px solid #ddd';
    menuBtn.style.borderRadius = '4px';
    menuBtn.style.background = '#fff';
    menuBtn.style.cursor = 'pointer';
    menuBtn.style.fontSize = '16px';
    menuBtn.style.fontWeight = 'bold';
    menuBtn.style.color = '#000';
    
    const menuPanel = document.createElement('div');
    menuPanel.style.display = 'none';
    menuPanel.style.position = 'absolute';
    menuPanel.style.background = '#fff';
    menuPanel.style.border = '1px solid #ddd';
    menuPanel.style.borderRadius = '4px';
    menuPanel.style.boxShadow = '0 2px 8px rgba(0,0,0,0.1)';
    menuPanel.style.zIndex = '1000';
    menuPanel.style.minWidth = '120px';
    
    const editBtn = document.createElement('button');
    editBtn.textContent = 'Edit';
    editBtn.style.display = 'block';
    editBtn.style.width = '100%';
    editBtn.style.padding = '8px 12px';
    editBtn.style.border = 'none';
    editBtn.style.background = 'transparent';
    editBtn.style.textAlign = 'left';
    editBtn.style.cursor = 'pointer';
    editBtn.style.color = '#000';
    editBtn.addEventListener('mouseenter', () => editBtn.style.background = '#f3f4f6');
    editBtn.addEventListener('mouseleave', () => editBtn.style.background = 'transparent');
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      menuPanel.style.display = 'none';
      openRegistryEditModal(r);
    });
    
    const deleteBtn = document.createElement('button');
    deleteBtn.textContent = 'Delete';
    deleteBtn.style.display = 'block';
    deleteBtn.style.width = '100%';
    deleteBtn.style.padding = '8px 12px';
    deleteBtn.style.border = 'none';
    deleteBtn.style.background = 'transparent';
    deleteBtn.style.textAlign = 'left';
    deleteBtn.style.cursor = 'pointer';
    deleteBtn.style.color = '#dc2626';
    deleteBtn.addEventListener('mouseenter', () => deleteBtn.style.background = '#fee');
    deleteBtn.addEventListener('mouseleave', () => deleteBtn.style.background = 'transparent');
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      menuPanel.style.display = 'none';
      if(confirm(`Delete registry ${r.seq}?`)){
        state.registries = state.registries.filter(reg => reg.id !== r.id);
        saveState();
        renderRegistries();
        renderInvoices();
        renderUnitOverview();
        renderLeaseOverview();
        renderOverview();
      }
    });
    
    menuPanel.appendChild(editBtn);
    menuPanel.appendChild(deleteBtn);
    
    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = menuPanel.style.display === 'block';
      // Close all other menus
      document.querySelectorAll('.registry-row .menu-panel').forEach(p => p.style.display = 'none');
      menuPanel.style.display = isOpen ? 'none' : 'block';
      
      if(!isOpen){
        const rect = menuBtn.getBoundingClientRect();
        menuPanel.style.top = (rect.bottom + window.scrollY) + 'px';
        menuPanel.style.left = (rect.left + window.scrollX) + 'px';
      }
    });
    
    // Close menu when clicking outside
    document.addEventListener('click', (e) => {
      if(!menuPanel.contains(e.target) && e.target !== menuBtn){
        menuPanel.style.display = 'none';
      }
    });
    
    menuPanel.className = 'menu-panel';
    const menuContainer = document.createElement('div');
    menuContainer.style.position = 'relative';
    menuContainer.appendChild(menuBtn);
    document.body.appendChild(menuPanel);
    
    rightInfo.appendChild(amountInfo);
    rightInfo.appendChild(menuContainer);
    
    title.appendChild(leftInfo);
    title.appendChild(rightInfo);
    row.appendChild(title);

    const details = document.createElement('div'); details.className = 'registry-details'; details.style.display = 'none'; details.style.marginTop = '8px'; details.style.fontSize = '13px'; details.style.color = '#374151';
    const unitsList = document.createElement('div'); unitsList.innerHTML = '<strong>Units:</strong> ' + (Array.isArray(r.units) ? escapeHtml((r.units||[]).join(', ')) : '');
    const period = document.createElement('div'); period.innerHTML = `<strong>Period:</strong> ${escapeHtml(formatDate(r.periodStart))} — ${escapeHtml(formatDate(r.periodEnd))}`;
    const submitted = document.createElement('div'); submitted.innerHTML = `<strong>Submitted:</strong> ${escapeHtml(formatDate(r.submittedDate))} <span class="small-muted">(created ${new Date(r.createdAt||'').toLocaleString()})</span>`;
    
    // Get category from registry or fallback to invoices matching this registry's WD number
    const categoryDiv = document.createElement('div');
    let category = r.category || '';
    let supplier = '';
    let company = '';
    let arrangement = '';
    let invoicing = '';
    
    // Find matching invoice to get category and company info
    const matchingInvoice = (state.invoices || []).find(inv => {
      const invWd = (inv.wdNumber || '').toString().trim().toLowerCase();
      const regWd = (r.wdNumber || '').toString().trim().toLowerCase();
      return invWd === regWd;
    });
    
    if(matchingInvoice){
      if(!category) category = matchingInvoice.category || '';
      supplier = matchingInvoice.supplier || '';
      company = matchingInvoice.company || '';
      arrangement = matchingInvoice.arrangement || '';
    }
    
    // Get invoicing from the registry's lease
    if(r.lease){
      const lease = (state.leases || []).find(l => 
        (l.leaseNumber === r.lease) || (l.id === r.lease)
      );
      if(lease){
        invoicing = lease.invoicing || '';
      }
    }
    
    categoryDiv.innerHTML = `<strong>Category:</strong> ${escapeHtml(category)}`;
    
    // Add supplier, company, and arrangement info
    const supplierDiv = document.createElement('div');
    supplierDiv.innerHTML = `<strong>Supplier:</strong> ${escapeHtml(supplier)}`;
    
    const companyDiv = document.createElement('div');
    companyDiv.innerHTML = `<strong>AGI Company:</strong> ${escapeHtml(company)}`;
    
    const arrangementDiv = document.createElement('div');
    arrangementDiv.innerHTML = `<strong>Arrangement:</strong> ${escapeHtml(arrangement)}`;
    
    const invoicingDiv = document.createElement('div');
    invoicingDiv.innerHTML = `<strong>Invoicing:</strong> ${escapeHtml(invoicing)}`;
    
    // Comments section
    const commentsSection = document.createElement('div');
    commentsSection.style.marginTop = '8px';
    
    const commentsLabel = document.createElement('div');
    commentsLabel.innerHTML = '<strong>Comments:</strong>';
    commentsLabel.style.marginBottom = '6px';
    commentsSection.appendChild(commentsLabel);
    
    // Get current user role for permissions
    const session = currentSession();
    let userRole = null;
    if(session){
      if(session.user === 'Master'){ userRole = 'Master'; }
      else {
        const u = (state.users||[]).find(x=> x.username === session.user);
        userRole = u ? (u.role || 'Operator') : 'Operator';
      }
    }
    
    // Display existing comments
    const comments = r.comments || [];
    if(comments.length > 0){
      comments.forEach((c, commentIdx) => {
        const commentBox = document.createElement('div');
        commentBox.style.border = '1px solid #e6e6e6';
        commentBox.style.borderRadius = '6px';
        commentBox.style.padding = '8px';
        commentBox.style.marginBottom = '6px';
        commentBox.style.background = '#f9fafb';
        commentBox.style.position = 'relative';
        
        const commentHeader = document.createElement('div');
        commentHeader.style.fontSize = '11px';
        commentHeader.style.color = '#6b7280';
        commentHeader.style.marginBottom = '4px';
        commentHeader.style.display = 'flex';
        commentHeader.style.justifyContent = 'space-between';
        commentHeader.style.alignItems = 'center';
        
        const userDateWrapper = document.createElement('div');
        userDateWrapper.style.display = 'flex';
        userDateWrapper.style.gap = '8px';
        
        const userSpan = document.createElement('span');
        userSpan.textContent = c.user || 'Unknown User';
        
        const dateSpan = document.createElement('span');
        dateSpan.textContent = c.timestamp ? new Date(c.timestamp).toLocaleString() : '';
        
        userDateWrapper.appendChild(userSpan);
        userDateWrapper.appendChild(dateSpan);
        commentHeader.appendChild(userDateWrapper);
        
        // Add "..." menu button based on user role
        // Operator: no menu
        // Manager: edit only
        // Developer/Master: edit and delete
        if(userRole && userRole !== 'Operator'){
          const commentMenuBtn = document.createElement('button');
          commentMenuBtn.textContent = '...';
          commentMenuBtn.style.padding = '2px 6px';
          commentMenuBtn.style.border = '1px solid #ddd';
          commentMenuBtn.style.borderRadius = '4px';
          commentMenuBtn.style.background = '#fff';
          commentMenuBtn.style.cursor = 'pointer';
          commentMenuBtn.style.fontSize = '14px';
          commentMenuBtn.style.fontWeight = 'bold';
          commentMenuBtn.style.color = '#000';
          
          const commentMenuPanel = document.createElement('div');
          commentMenuPanel.style.display = 'none';
          commentMenuPanel.style.position = 'absolute';
          commentMenuPanel.style.background = '#fff';
          commentMenuPanel.style.border = '1px solid #ddd';
          commentMenuPanel.style.borderRadius = '4px';
          commentMenuPanel.style.boxShadow = '0 2px 8px rgba(0,0,0,0.1)';
          commentMenuPanel.style.zIndex = '1000';
          commentMenuPanel.style.minWidth = '100px';
          commentMenuPanel.style.right = '8px';
          commentMenuPanel.style.top = '28px';
          
          // Edit button (for Manager, Developer, Master)
          const editCommentBtn = document.createElement('button');
          editCommentBtn.textContent = 'Edit';
          editCommentBtn.style.display = 'block';
          editCommentBtn.style.width = '100%';
          editCommentBtn.style.padding = '6px 12px';
          editCommentBtn.style.border = 'none';
          editCommentBtn.style.background = 'transparent';
          editCommentBtn.style.textAlign = 'left';
          editCommentBtn.style.cursor = 'pointer';
          editCommentBtn.style.color = '#000';
          editCommentBtn.addEventListener('mouseenter', () => editCommentBtn.style.background = '#f3f4f6');
          editCommentBtn.addEventListener('mouseleave', () => editCommentBtn.style.background = 'transparent');
          editCommentBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            commentMenuPanel.style.display = 'none';
            openEditCommentModal(r, commentIdx);
          });
          commentMenuPanel.appendChild(editCommentBtn);
          
          // Delete button (only for Developer and Master)
          if(userRole === 'Developer' || userRole === 'Master'){
            const deleteCommentBtn = document.createElement('button');
            deleteCommentBtn.textContent = 'Delete';
            deleteCommentBtn.style.display = 'block';
            deleteCommentBtn.style.width = '100%';
            deleteCommentBtn.style.padding = '6px 12px';
            deleteCommentBtn.style.border = 'none';
            deleteCommentBtn.style.background = 'transparent';
            deleteCommentBtn.style.textAlign = 'left';
            deleteCommentBtn.style.cursor = 'pointer';
            deleteCommentBtn.style.color = '#dc2626';
            deleteCommentBtn.addEventListener('mouseenter', () => deleteCommentBtn.style.background = '#fee');
            deleteCommentBtn.addEventListener('mouseleave', () => deleteCommentBtn.style.background = 'transparent');
            deleteCommentBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              commentMenuPanel.style.display = 'none';
              if(confirm('Delete this comment?')){
                r.comments.splice(commentIdx, 1);
                saveState();
                renderRegistries(r.id);
              }
            });
            commentMenuPanel.appendChild(deleteCommentBtn);
          }
          
          commentMenuBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const isOpen = commentMenuPanel.style.display === 'block';
            document.querySelectorAll('.comment-menu-panel').forEach(p => p.style.display = 'none');
            commentMenuPanel.style.display = isOpen ? 'none' : 'block';
          });
          
          // Close menu when clicking outside
          document.addEventListener('click', (e) => {
            if(!commentMenuPanel.contains(e.target) && e.target !== commentMenuBtn){
              commentMenuPanel.style.display = 'none';
            }
          });
          
          commentMenuPanel.className = 'comment-menu-panel';
          commentBox.appendChild(commentMenuPanel);
          commentHeader.appendChild(commentMenuBtn);
        }
        
        const commentText = document.createElement('div');
        commentText.textContent = c.text || '';
        commentText.style.fontSize = '13px';
        
        commentBox.appendChild(commentHeader);
        commentBox.appendChild(commentText);
        commentsSection.appendChild(commentBox);
      });
    }
    
    const addCommentBtn = document.createElement('button');
    addCommentBtn.textContent = 'Add Comment';
    addCommentBtn.className = 'btn-primary';
    addCommentBtn.style.marginTop = '4px';
    addCommentBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openRegistryCommentModal(r);
    });
    commentsSection.appendChild(addCommentBtn);
    
    details.appendChild(unitsList); 
    details.appendChild(period); 
    details.appendChild(submitted); 
    details.appendChild(categoryDiv); 
    details.appendChild(supplierDiv);
    details.appendChild(companyDiv);
    details.appendChild(arrangementDiv);
    details.appendChild(invoicingDiv);
    details.appendChild(commentsSection);
    row.appendChild(details);
    
    // Restore open state if this registry was open before
    if(openRegistries.has(r.id)){
      details.style.display = 'block';
    }

    wrap.appendChild(row);
  }
}

function renderUnits(){
  const tbody = qs('#unitList'); if(!tbody) return; tbody.innerHTML = '';
  state.units.forEach((u, i)=>{
    const tr = document.createElement('tr');
    const tdIndex = document.createElement('td'); tdIndex.textContent = i+1;
  const tdUnit = document.createElement('td'); tdUnit.innerHTML = `<strong>${escapeHtml(u.unitId || '')}</strong>`;
    const tdLease = document.createElement('td'); tdLease.textContent = u.lease || '';
    const tdCompany = document.createElement('td'); tdCompany.textContent = u.company || '';
    const tdSupplier = document.createElement('td'); tdSupplier.textContent = u.supplier || '';
    const tdArrangement = document.createElement('td'); tdArrangement.textContent = u.arrangement || '';
    const tdInvoicing = document.createElement('td'); tdInvoicing.textContent = u.invoicing || '';
    const tdMonthly = document.createElement('td'); tdMonthly.textContent = formatCurrency(u.monthly || '') || '';
    const tdDesc = document.createElement('td'); tdDesc.textContent = u.description || '';
  const tdNotes = document.createElement('td'); tdNotes.textContent = u.notes || '';
  const tdStatus = document.createElement('td'); tdStatus.textContent = u.status || 'Operational';
  const tdActions = document.createElement('td'); tdActions.className = 'dev-actions';

    const editBtn = document.createElement('button'); editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', ()=>{
      openUnitEditModal(u);
    });

    // helper to render the disabled date portion (click-to-edit)
    const renderDisabledDateFor = (index)=>{
      const unitObj = state.units[index] || {};
      // reset status text
      tdStatus.textContent = unitObj.status || 'Operational';
      // if disabled, show a small clickable date beneath the status
      if(unitObj.status === 'Disabled'){
        const dateSpan = document.createElement('div');
        dateSpan.className = 'small-muted disabled-date';
        dateSpan.textContent = unitObj.disabledDate || '';
        dateSpan.style.cursor = 'pointer';
        dateSpan.title = 'Click to edit disable date';
        dateSpan.addEventListener('click', ()=>{
          // replace content with inline date input + save/cancel
          tdStatus.innerHTML = '';
          tdStatus.appendChild(document.createTextNode(unitObj.status || 'Disabled'));
          tdStatus.appendChild(document.createElement('br'));
          const input = document.createElement('input'); input.type = 'date'; input.value = unitObj.disabledDate || new Date().toISOString().slice(0,10);
          const save = document.createElement('button'); save.textContent = 'Save';
          const cancel = document.createElement('button'); cancel.textContent = 'Cancel';
          tdStatus.appendChild(input); tdStatus.appendChild(save); tdStatus.appendChild(cancel);
          save.addEventListener('click', ()=>{
            const v = input.value;
            if(v) state.units[index].disabledDate = v; else delete state.units[index].disabledDate;
            saveState(); renderUnits(); renderOverview();
          });
          cancel.addEventListener('click', ()=>{ renderDisabledDateFor(index); });
        });
        tdStatus.appendChild(document.createElement('br'));
        tdStatus.appendChild(dateSpan);
      }
    };

    const toggleBtn = document.createElement('button'); toggleBtn.textContent = (u.status === 'Disabled' ? 'Enable' : 'Disable');
    toggleBtn.addEventListener('click', ()=>{
      const idx = state.units.findIndex(x=>x.id===u.id);
      if(idx === -1) return;
      if(state.units[idx].status === 'Disabled'){
        // re-enable
        state.units[idx].status = 'Operational';
        delete state.units[idx].disabledDate;
      } else {
        // disable and set today's date if not present
        state.units[idx].status = 'Disabled';
        if(!state.units[idx].disabledDate) state.units[idx].disabledDate = new Date().toISOString().slice(0,10);
      }
      saveState(); renderUnits(); renderOverview();
    });

    const delBtn = document.createElement('button'); delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', ()=>{ if(!confirm('Delete this unit?')) return; state.units.splice(i,1); saveState(); renderUnits(); renderOverview(); });

  tdActions.appendChild(editBtn); tdActions.appendChild(toggleBtn); tdActions.appendChild(delBtn);

    tr.appendChild(tdIndex);
    tr.appendChild(tdUnit);
    tr.appendChild(tdLease);
    tr.appendChild(tdCompany);
    tr.appendChild(tdSupplier);
    tr.appendChild(tdArrangement);
    tr.appendChild(tdInvoicing);
  tr.appendChild(tdMonthly);
  tr.appendChild(tdDesc);
  tr.appendChild(tdNotes);
  tr.appendChild(tdStatus);
  
  // Last Comment column
  const tdLastComment = document.createElement('td');
  tdLastComment.style.fontSize = '12px';
  tdLastComment.style.maxWidth = '200px';
  tdLastComment.style.overflow = 'hidden';
  tdLastComment.style.textOverflow = 'ellipsis';
  tdLastComment.style.whiteSpace = 'nowrap';
  tdLastComment.style.cursor = 'pointer';
  const comments = u.comments || [];
  if(comments.length > 0){
    const lastComment = comments[comments.length - 1];
    tdLastComment.textContent = lastComment.text || '';
    tdLastComment.title = lastComment.text || '';
    tdLastComment.addEventListener('click', () => {
      openUnitCommentsModal(u);
    });
  } else {
    tdLastComment.textContent = '';
    tdLastComment.style.cursor = 'default';
  }
  tr.appendChild(tdLastComment);
  
  // do NOT append tdActions here; we'll expose the same handlers via a compact
  // 'more' menu attached inline to the unit cell so the separate action column
  // is removed per user request.

  // add compact 'more' menu inside the <strong> element of the unit cell
  try{
    const strongEl = tdUnit.querySelector('strong');
    if(strongEl){
      const moreWrap = document.createElement('span'); moreWrap.style.position = 'relative'; moreWrap.style.display = 'inline-block'; moreWrap.style.marginLeft = '8px';
      const moreBtn = document.createElement('button'); moreBtn.type = 'button'; moreBtn.textContent = '⋯'; moreBtn.title = 'Actions'; moreBtn.className = 'lease-more-btn';
      moreWrap.appendChild(moreBtn);

      const moreMenu = document.createElement('div'); moreMenu.className = 'unit-more-menu'; moreMenu.style.position = 'absolute'; moreMenu.style.display = 'none'; moreMenu.style.right = '0'; moreMenu.style.top = 'calc(100% + 6px)'; moreMenu.style.background = '#fff'; moreMenu.style.border = '1px solid #ddd'; moreMenu.style.boxShadow = '0 6px 18px rgba(0,0,0,0.08)'; moreMenu.style.padding = '6px'; moreMenu.style.borderRadius = '6px'; moreMenu.style.zIndex = 9999; moreMenu.style.minWidth = '120px';
      const mEdit = document.createElement('button'); mEdit.type = 'button'; mEdit.textContent = 'Edit'; mEdit.style.display='block'; mEdit.style.width='100%'; mEdit.style.marginBottom='6px';
      const mComment = document.createElement('button'); mComment.type = 'button'; mComment.textContent = 'Comment'; mComment.style.display='block'; mComment.style.width='100%'; mComment.style.marginBottom='6px';
      const mToggle = document.createElement('button'); mToggle.type = 'button'; mToggle.textContent = (u.status === 'Disabled' ? 'Enable' : 'Disable'); mToggle.style.display='block'; mToggle.style.width='100%'; mToggle.style.marginBottom='6px';
      const mDel = document.createElement('button'); mDel.type = 'button'; mDel.textContent = 'Delete'; mDel.style.display='block'; mDel.style.width='100%';
      moreMenu.appendChild(mEdit); moreMenu.appendChild(mComment); moreMenu.appendChild(mToggle); moreMenu.appendChild(mDel);
      moreWrap.appendChild(moreMenu);

      moreBtn.addEventListener('click', (ev)=>{ ev.stopPropagation(); moreMenu.style.display = moreMenu.style.display === 'none' ? 'block' : 'none'; });
      mEdit.addEventListener('click', ()=>{ try{ editBtn.click(); }catch(e){} moreMenu.style.display='none'; });
      mComment.addEventListener('click', ()=>{ openUnitCommentsModal(u); moreMenu.style.display='none'; });
      mToggle.addEventListener('click', ()=>{ try{ toggleBtn.click(); }catch(e){} moreMenu.style.display='none'; });
      mDel.addEventListener('click', ()=>{ try{ delBtn.click(); }catch(e){} moreMenu.style.display='none'; });

      // close on outside click
      document.addEventListener('click', ()=>{ try{ moreMenu.style.display = 'none'; }catch(e){} });

      strongEl.style.display = 'inline-flex'; strongEl.style.alignItems = 'center';
      strongEl.appendChild(moreWrap);
    }
  }catch(e){ /* non-fatal */ }

    // render the disabled date UI for this row (uses current index i)
    try{ renderDisabledDateFor(i); }catch(e){}

    tbody.appendChild(tr);
  });
  // after rendering units
}

// overview units removed: no-op


// sync selects used in unit form
function syncUnitLeaseOptions(){
  const sel = qs('#unitLease'); if(!sel) return; const cur = sel.value; sel.innerHTML = '<option value="">(select lease)</option>';
  state.leases.forEach(l=>{ const opt = document.createElement('option'); opt.value = l.leaseNumber || l.id; opt.textContent = l.leaseNumber || l.id; sel.appendChild(opt); });
  if(cur) sel.value = cur;
}

// when a lease is selected in the unit form, autofill company/supplier/arrangement
const unitLeaseSel = qs('#unitLease');
if(unitLeaseSel){
  unitLeaseSel.addEventListener('change', ()=>{
    const val = unitLeaseSel.value;
    const c = qs('#unitCompany'); const s = qs('#unitSupplier'); const a = qs('#unitArrangement'); const inv = qs('#unitInvoicing');
    if(!val){
      // clear informational inputs when user selects the empty option
      if(c) c.value = '';
      if(s) s.value = '';
      if(a) a.value = '';
      if(inv) inv.value = '';
      return;
    }
    const lease = state.leases.find(l => (l.leaseNumber === val) || (l.id === val));
    if(!lease){
      if(c) c.value = '';
      if(s) s.value = '';
      if(a) a.value = '';
      if(inv) inv.value = '';
      return;
    }
    if(c) c.value = lease.company || '';
    if(s) s.value = lease.supplier || '';
    if(a) a.value = lease.arrangement || '';
    if(inv) inv.value = lease.invoicing || '';
  });
}
function syncUnitCompanyOptions(){ const inp = qs('#unitCompany'); if(!inp) return; inp.value = ''; }
function syncUnitSupplierOptions(){ const inp = qs('#unitSupplier'); if(!inp) return; inp.value = ''; }
function syncUnitArrangementOptions(){ const inp = qs('#unitArrangement'); if(!inp) return; inp.value = ''; }
function syncUnitInvoicingOptions(){ const inp = qs('#unitInvoicing'); if(!inp) return; inp.value = ''; }

// call initial syncs
syncUnitLeaseOptions(); syncUnitCompanyOptions(); syncUnitSupplierOptions(); syncUnitArrangementOptions(); syncUnitInvoicingOptions();

function renderLeases(){
  const ol = qs('#leaseList'); ol.innerHTML = '';
  state.leases.forEach((l, i)=>{
    const li = document.createElement('li');
    const text = document.createElement('span');
    // include seasonal dates when present (stored as MM-DD)
    const formatMD = (md)=>{
      if(!md) return '';
      const parts = String(md).split('-'); if(parts.length!==2) return md;
      const m = parts[0]; const d = parts[1].replace(/^0/,'');
      const months = { '01':'Jan','02':'Feb','03':'Mar','04':'Apr','05':'May','06':'Jun','07':'Jul','08':'Aug','09':'Sep','10':'Oct','11':'Nov','12':'Dec' };
      return (months[m] || m) + ' ' + d;
    };
    const datesHtml = (l.fromDate || l.toDate) ? `<div class='small-muted'>${escapeHtml(formatMD(l.fromDate)||'')} ${l.fromDate || l.toDate ? '&#8212;' : ''} ${escapeHtml(formatMD(l.toDate)||'')}</div>` : '';
    text.innerHTML = `<strong>${escapeHtml(l.leaseNumber||'')}</strong><div class='small-muted'>${escapeHtml(l.company||'')} &#8212; ${escapeHtml(l.supplier||'')} &#8212; ${escapeHtml(l.arrangement||'')} &#8212; ${escapeHtml(l.invoicing||'')}</div>${datesHtml}`;
    // informational lease entry plus actions
    li.appendChild(text);
  // actions container (Edit / Disable/Enable / Delete)
  // NOTE: we keep the buttons for reuse by the compact 'more' menu, but
  // do not append the visible actions container to the DOM so only the
  // '⋯' menu is shown per lease (user requested removing the older visible buttons).
  const actions = document.createElement('div'); actions.className = 'dev-actions';
  const editBtn = document.createElement('button'); editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', ()=>{
      // populate the lease form for editing
      const form = qs('#leaseForm'); if(!form) return;
      form.leaseNumber.value = l.leaseNumber || '';
      form.leaseCompany.value = l.company || '';
      form.leaseSupplier.value = l.supplier || '';
      form.leaseArrangement.value = l.arrangement || '';
      form.leaseInvoicing.value = l.invoicing || '';
      // populate seasonal fields if present
      if(l.fromDate){ const parts = String(l.fromDate).split('-'); if(parts.length===2){ const fm = qs('#leaseFromMonth'); const fdsel = qs('#leaseFromDay'); if(fm) fm.value = parts[0]; if(fdsel) fdsel.value = parts[1]; } }
      if(l.toDate){ const parts2 = String(l.toDate).split('-'); if(parts2.length===2){ const tm = qs('#leaseToMonth'); const tdsel = qs('#leaseToDay'); if(tm) tm.value = parts2[0]; if(tdsel) tdsel.value = parts2[1]; } }
      form.dataset.editing = l.id;
      const submitBtn = form.querySelector('button[type="submit"]'); if(submitBtn) submitBtn.textContent = 'Save';
      // switch to Lease Control tab so the user can edit
      const leaseTab = Array.from(document.querySelectorAll('.tab')).find(t=>t.dataset.tab==='leaseControl'); if(leaseTab) leaseTab.click();
      form.leaseNumber.focus();
    });

    // Enable/Disable toggle button
    const toggleBtn = document.createElement('button');
    toggleBtn.textContent = (l.status === 'Disabled') ? 'Enable' : 'Disable';
    toggleBtn.addEventListener('click', ()=>{
      const idx = state.leases.findIndex(x=>x.id===l.id);
      if(idx === -1) return;
      if(state.leases[idx].status === 'Disabled'){
        state.leases[idx].status = 'Enabled';
        delete state.leases[idx].disabledDate;
      } else {
        state.leases[idx].status = 'Disabled';
        if(!state.leases[idx].disabledDate) state.leases[idx].disabledDate = new Date().toISOString().slice(0,10);
      }
      saveState(); renderLeases(); renderOverview();
    });

    const delBtn = document.createElement('button'); delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', ()=>{
      if(!confirm('Delete this lease? This will not delete units or invoices automatically.')) return;
      // remove lease
      state.leases = state.leases.filter(x=>x.id !== l.id);
      // also clear lease references from units and invoices that pointed to this leaseNumber (optional: keep integrity)
      state.units = (state.units || []).map(u => (u.lease === l.leaseNumber) ? Object.assign({}, u, { lease: '' }) : u);
      state.invoices = (state.invoices || []).map(inv => (inv.lease === l.leaseNumber) ? Object.assign({}, inv, { lease: '' }) : inv);
      saveState(); renderLeases(); renderUnits(); renderInvoices(); renderOverview();
    });

  actions.appendChild(editBtn);
  actions.appendChild(toggleBtn);
  actions.appendChild(delBtn);
  // do NOT append 'actions' into the lease row - the compact moreMenu will
  // reuse these button handlers internally. This keeps the UI clean.

    // small 'more' button next to lease text that opens a compact menu
    try{
      const moreWrap = document.createElement('span'); moreWrap.style.position = 'relative'; moreWrap.style.display = 'inline-block'; moreWrap.style.marginLeft = '8px';
  const moreBtn = document.createElement('button'); moreBtn.type = 'button'; moreBtn.textContent = '⋯'; moreBtn.title = 'Actions';
  // apply CSS class so the button background matches the page and is
  // visually inline with the lease number (no inline background color).
  moreBtn.className = 'lease-more-btn';
  moreWrap.appendChild(moreBtn);

      const moreMenu = document.createElement('div'); moreMenu.className = 'lease-more-menu'; moreMenu.style.position = 'absolute'; moreMenu.style.display = 'none'; moreMenu.style.right = '0'; moreMenu.style.top = 'calc(100% + 6px)'; moreMenu.style.background = '#fff'; moreMenu.style.border = '1px solid #ddd'; moreMenu.style.boxShadow = '0 6px 18px rgba(0,0,0,0.08)'; moreMenu.style.padding = '6px'; moreMenu.style.borderRadius = '6px'; moreMenu.style.zIndex = 9999; moreMenu.style.minWidth = '120px';
      const mEdit = document.createElement('button'); mEdit.type = 'button'; mEdit.textContent = 'Edit'; mEdit.style.display='block'; mEdit.style.width='100%'; mEdit.style.marginBottom='6px';
      const mToggle = document.createElement('button'); mToggle.type = 'button'; mToggle.textContent = (l.status === 'Disabled') ? 'Enable' : 'Disable'; mToggle.style.display='block'; mToggle.style.width='100%'; mToggle.style.marginBottom='6px';
      const mDel = document.createElement('button'); mDel.type = 'button'; mDel.textContent = 'Delete'; mDel.style.display='block'; mDel.style.width='100%';
      moreMenu.appendChild(mEdit); moreMenu.appendChild(mToggle); moreMenu.appendChild(mDel);
      moreWrap.appendChild(moreMenu);

      // wire menu actions to reuse existing handlers
      moreBtn.addEventListener('click', (ev)=>{ ev.stopPropagation(); moreMenu.style.display = moreMenu.style.display === 'none' ? 'block' : 'none'; });
      mEdit.addEventListener('click', ()=>{ try{ editBtn.click(); }catch(e){} moreMenu.style.display='none'; });
      mToggle.addEventListener('click', ()=>{ try{ toggleBtn.click(); }catch(e){} moreMenu.style.display='none'; });
      mDel.addEventListener('click', ()=>{ try{ delBtn.click(); }catch(e){} moreMenu.style.display='none'; });

      // close on outside click
      document.addEventListener('click', ()=>{ try{ moreMenu.style.display = 'none'; }catch(e){} });

      // append the more control into the lease text span, but place it
      // inline with the lease number so it appears on the same row as
      // the strong lease label (user requested relocation).
      const strongEl = text.querySelector('strong');
      if(strongEl){
        // ensure the strong element can contain an inline control
        try{ strongEl.style.display = 'inline-flex'; strongEl.style.alignItems = 'center'; }catch(e){}
        strongEl.appendChild(moreWrap);
      } else {
        text.appendChild(moreWrap);
      }
    }catch(e){ /* non-fatal */ }
    // actions intentionally not appended to the list item

    // when user clicks the lease item in the Lease Control list, close any open popup window
    text.addEventListener('click', ()=>{ try{ if(window.__agi_open_popup && !window.__agi_open_popup.closed) window.__agi_open_popup.close(); }catch(e){} });
    ol.appendChild(li);
  });
  // ensure unit lease select is updated when leases change
  if(typeof syncUnitLeaseOptions === 'function') syncUnitLeaseOptions();
}

// Open a new small window showing full invoice details for a row
function openInvoiceWindow(inv){
  try{
    // close any previously opened popup from this app to avoid multiple lingering windows
    if(window.__agi_open_popup && !window.__agi_open_popup.closed){ try{ window.__agi_open_popup.close(); }catch(e){} }
    const w = window.open('', '_blank', 'width=520,height=560,noopener');
    // remember the popup so we can close it later from the main window
    window.__agi_open_popup = w;
    if(!w) { alert('Popup blocked. Please allow popups for this app to view details.'); return; }
    const doc = w.document;
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Invoice ${escapeHtml(inv.lease||inv.id)}</title><style>body{font-family:Segoe UI, Roboto, Arial, sans-serif;padding:14px;color:#111}h1{font-size:16px;margin:0 0 8px}dl{display:grid;grid-template-columns:120px 1fr;gap:6px 12px}dt{color:#6b7280;font-weight:600}dd{margin:0 0 6px 0}pre{background:#f8fafc;padding:8px;border-radius:6px;border:1px solid #eef2f7;white-space:pre-wrap}</style></head><body>
      <h1>Invoice details</h1>
      <dl>
        <dt>Lease</dt><dd>${escapeHtml(inv.lease||'')}</dd>
        <dt>Supplier</dt><dd>${escapeHtml(inv.supplier||'')}</dd>
        <dt>Company</dt><dd>${escapeHtml(inv.company||'')}</dd>
        <dt>Arrangement</dt><dd>${escapeHtml(inv.arrangement||'')}</dd>
        <dt>Category</dt><dd>${escapeHtml(inv.category||'')}</dd>
        <dt>Unit</dt><dd>${escapeHtml(inv.unit||'')}</dd>
        <dt>WD</dt><dd>${escapeHtml(inv.wdNumber||'')}</dd>
        <dt>Doc</dt><dd>${escapeHtml(inv.docNumber||'')}</dd>
        <dt>Amount</dt><dd>${formatCurrency(inv.amount||'')}</dd>
        <dt>Period</dt><dd>${escapeHtml(inv.periodStart||'')} — ${escapeHtml(inv.periodEnd||'')}</dd>
        <dt>Submitted</dt><dd>${escapeHtml(inv.submittedDate||'')}</dd>
        <dt>Comment</dt><dd><pre>${escapeHtml(inv.comment||'')}</pre></dd>
      </dl>
      <div style="margin-top:12px"><button id="closeBtn">Close</button></div>
    </body></html>`;
    doc.open(); doc.write(html); doc.close();
    const closeBtn = w.document.getElementById('closeBtn'); if(closeBtn) closeBtn.addEventListener('click', ()=>{ w.close(); });
    // when the popup closes (manually or via close button), clear our reference
    const cleanupInterval = setInterval(()=>{
      try{ if(!window.__agi_open_popup || window.__agi_open_popup.closed){ clearInterval(cleanupInterval); window.__agi_open_popup = null; } }catch(e){ clearInterval(cleanupInterval); window.__agi_open_popup = null; }
    }, 500);
  }catch(e){ console.error('Failed to open invoice window', e); alert('Cannot open detail window: '+e.message); }
}

function renderUsers(){
  const tbody = qs('#userList'); tbody.innerHTML='';
  // adjust visibility of the Developer role option based on current session
  try{ updateUserRoleOptionsVisibility(); }catch(e){}
  state.users.forEach((u, idx)=>{
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${idx+1}</td><td>${escapeHtml(u.firstName||'')}</td><td>${escapeHtml(u.lastName||'')}</td><td>${escapeHtml(u.username||'')}</td><td>${escapeHtml(u.role||'Operator')}</td><td><button class="edit" data-id="${u.id}">Edit</button> <button class="del" data-id="${u.id}">Delete</button></td>`;
    tbody.appendChild(tr);
  });
  tbody.querySelectorAll('.del').forEach(b=>b.addEventListener('click', e=>{ const id=e.target.dataset.id; if(!confirm('Delete this user?')) return; state.users = state.users.filter(x=>x.id!==id); saveState(); renderUsers(); renderOverview(); }));
  tbody.querySelectorAll('.edit').forEach(b=>b.addEventListener('click', e=>{
    const id = e.target.dataset.id; const u = state.users.find(x=>x.id===id); if(!u) return;
  const form = qs('#userForm');
  form.firstName.value = u.firstName || '';
  form.lastName.value = u.lastName || '';
  form.username.value = u.username || '';
  form.password.value = '';
  form.role.value = u.role || 'Operator';
    form.dataset.editing = u.id;
    qs('#userCancelBtn').style.display = 'inline-block';
  }));
}

qs('#userCancelBtn').addEventListener('click', ()=>{
  const form = qs('#userForm'); form.reset(); delete form.dataset.editing; qs('#userCancelBtn').style.display='none';
});

// invoice cancel button: clear editing state and reset form
const invCancelBtn = qs('#invoiceCancelBtn'); if(invCancelBtn){ invCancelBtn.addEventListener('click', ()=>{
  const form = qs('#invoiceForm'); if(!form) return; form.reset(); delete form.dataset.editing; const submitBtn = form.querySelector('button[type="submit"]'); if(submitBtn) submitBtn.textContent = 'Add Invoice'; invCancelBtn.style.display = 'none'; const sub = qs('#invoiceSubmitted'); if(sub) sub.value = new Date().toISOString().slice(0,10);
}); }

// small helper to avoid HTML injection in table cells
function escapeHtml(str){
  return String(str).replace(/[&<>"']/g, s => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[s]));
}

// --- Persistence ---
function saveState(){
  try{ localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }catch(e){ alert('Error saving data: '+e.message); }
}

function loadState(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    if(!raw) return JSON.parse(JSON.stringify(defaultData));
    const parsed = JSON.parse(raw);
    // ensure shape
    return Object.assign(JSON.parse(JSON.stringify(defaultData)), parsed);
  }catch(e){ console.error('Failed to load state', e); return JSON.parse(JSON.stringify(defaultData)); }
}

function clearAllData(){
  if(confirm('Clear all data? This will remove all invoices, units, leases, registries, and users (except Master). This action cannot be undone.')){
    // Clear localStorage completely
    localStorage.removeItem(STORAGE_KEY);
    
    // Reset state to default (empty arrays)
    state = {
      invoices: [],
      units: [],
      leases: [],
      users: [],
      registries: [],
      meta: { createdAt: new Date().toISOString(), registrySeq: 0 }
    };
    
    // Preserve Master account
    const masterUser = { id: 'master', username: 'Master', password: '', role: 'Master', firstName: 'Master', lastName: '' };
    state.users = [masterUser];
    
    saveState();
    
    // Force reload the page to ensure clean state
    alert('All data has been cleared. Master account preserved. The page will now reload.');
    window.location.reload();
  }
}

function id(){ return Math.random().toString(36).slice(2,9); }

// --- Import / Export ---
qs('#exportBtn').addEventListener('click', ()=>{
  const dataStr = JSON.stringify(state, null, 2);
  const blob = new Blob([dataStr], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `agi_vehicle_lease_${new Date().toISOString().slice(0,19)}.json`;
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
});

qs('#importInput').addEventListener('change', async e=>{
  const file = e.target.files[0];
  if(!file) return;
  try{
    const text = await file.text();
    const parsed = JSON.parse(text);
    if(!confirm('Importing will replace current local data. Continue?')) return;
    // basic validation
    if(typeof parsed !== 'object') throw new Error('Invalid JSON root');
    state = Object.assign(JSON.parse(JSON.stringify(defaultData)), parsed);
    saveState();
    // re-render
  renderAll();
  syncTabLabels();
    alert('Import successful');
  }catch(err){ alert('Failed to import: '+err.message); }
  e.target.value = '';
});

// Clear data button removed by user request

function renderAll(){ renderOverview(); renderInvoices(); renderRegistries(); renderUnits(); renderLeases(); renderUsers(); renderUnitOverview(); renderLeaseOverview(); }

// Render the Unit Overview page: year/month selectors and per-unit day grid
function renderUnitOverview(){
  const el = qs('#unitOverview'); if(!el) return;
  el.innerHTML = '';

  // Create controls for month and year selection
  state.meta = state.meta || {};
  const now = new Date();
  const selectedYear = state.meta.unitOverviewYear || now.getFullYear();
  const selectedMonth = (typeof state.meta.unitOverviewMonth !== 'undefined') ? state.meta.unitOverviewMonth : now.getMonth();

  const controls = document.createElement('div');
  controls.style.display = 'flex';
  controls.style.gap = '12px';
  controls.style.alignItems = 'center';
  controls.style.marginBottom = '12px';

  const label = document.createElement('label');
  label.style.fontWeight = '600';
  label.textContent = 'Period:';
  controls.appendChild(label);

  const monthSelect = document.createElement('select');
  monthSelect.id = 'unitOverviewMonth';
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  monthNames.forEach((name, index) => {
    const option = document.createElement('option');
    option.value = index;
    option.textContent = name;
    if(index === selectedMonth) option.selected = true;
    monthSelect.appendChild(option);
  });

  const yearSelect = document.createElement('select');
  yearSelect.id = 'unitOverviewYear';
  for(let y = now.getFullYear() - 3; y <= now.getFullYear() + 1; y++){
    const option = document.createElement('option');
    option.value = y;
    option.textContent = y;
    if(y === selectedYear) option.selected = true;
    yearSelect.appendChild(option);
  }

  controls.appendChild(monthSelect);
  controls.appendChild(yearSelect);
  
  // Add search box
  const searchLabel = document.createElement('label');
  searchLabel.style.fontWeight = '600';
  searchLabel.style.marginLeft = '20px';
  searchLabel.textContent = 'Search:';
  controls.appendChild(searchLabel);
  
  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.id = 'unitOverviewSearch';
  searchInput.placeholder = 'Filter by unit, lease, arrangement, invoicing...';
  searchInput.style.padding = '6px 10px';
  searchInput.style.border = '1px solid #e6e9ee';
  searchInput.style.borderRadius = '6px';
  searchInput.style.fontSize = '13px';
  searchInput.style.width = '250px';
  searchInput.value = state.meta.unitOverviewSearch || '';
  searchInput.addEventListener('input', () => {
    if(searchInput.value === ''){
      state.meta.unitOverviewSearch = '';
      try{ saveState(); }catch(e){}
      renderUnitOverview();
    }
  });
  searchInput.addEventListener('keypress', (e) => {
    if(e.key === 'Enter'){
      state.meta.unitOverviewSearch = searchInput.value;
      try{ saveState(); }catch(e){}
      renderUnitOverview();
    }
  });
  controls.appendChild(searchInput);
  
  const searchBtn = document.createElement('button');
  searchBtn.textContent = 'Search';
  searchBtn.style.padding = '6px 16px';
  searchBtn.style.borderRadius = '6px';
  searchBtn.style.fontSize = '13px';
  searchBtn.style.cursor = 'pointer';
  searchBtn.addEventListener('click', () => {
    state.meta.unitOverviewSearch = searchInput.value;
    try{ saveState(); }catch(e){}
    renderUnitOverview();
  });
  controls.appendChild(searchBtn);
  
  el.appendChild(controls);

  // Event listeners for dropdowns
  monthSelect.addEventListener('change', () => {
    state.meta.unitOverviewMonth = parseInt(monthSelect.value, 10);
    try{ saveState(); }catch(e){}
    renderUnitOverview();
  });

  yearSelect.addEventListener('change', () => {
    state.meta.unitOverviewYear = parseInt(yearSelect.value, 10);
    try{ saveState(); }catch(e){}
    renderUnitOverview();
  });

  // Initialize sorting state
  state.meta.unitOverviewSort = state.meta.unitOverviewSort || { column: 'unitId', ascending: true };

  // Calculate days in selected month
  const year = parseInt(yearSelect.value, 10);
  const month = parseInt(monthSelect.value, 10);
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  // Create table for all units
  const table = document.createElement('table');
  table.style.width = '100%';
  table.style.borderCollapse = 'collapse';
  table.style.marginTop = '12px';

  // Header row
  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  
  const headers = [
    { text: 'Unit ID', key: 'unitId' },
    { text: 'Lease', key: 'lease' },
    { text: 'Arrangement', key: 'arrangement' },
    { text: 'Invoicing', key: 'invoicing' },
    { text: 'Status', key: 'status' }
  ];
  
  headers.forEach(header => {
    const th = document.createElement('th');
    th.textContent = header.text;
    th.style.textAlign = 'left';
    th.style.padding = '6px';
    th.style.fontSize = '12px';
    th.style.borderBottom = '2px solid #eef2f7';
    th.style.fontWeight = '600';
    th.style.background = '#f9fafb';
    th.style.minWidth = header.key === 'unitId' ? '120px' : '100px';
    th.style.cursor = 'pointer';
    th.style.userSelect = 'none';
    
    // Add sort indicator
    if(state.meta.unitOverviewSort.column === header.key){
      th.textContent += state.meta.unitOverviewSort.ascending ? ' ▲' : ' ▼';
    }
    
    th.addEventListener('click', () => {
      if(state.meta.unitOverviewSort.column === header.key){
        state.meta.unitOverviewSort.ascending = !state.meta.unitOverviewSort.ascending;
      } else {
        state.meta.unitOverviewSort.column = header.key;
        state.meta.unitOverviewSort.ascending = true;
      }
      try{ saveState(); }catch(e){}
      renderUnitOverview();
    });
    
    headerRow.appendChild(th);
  });

  // Period column header (spans all day columns)
  const thPeriod = document.createElement('th');
  thPeriod.textContent = 'Period';
  thPeriod.colSpan = daysInMonth;
  thPeriod.style.textAlign = 'center';
  thPeriod.style.padding = '6px';
  thPeriod.style.fontSize = '12px';
  thPeriod.style.borderBottom = '2px solid #eef2f7';
  thPeriod.style.fontWeight = '600';
  thPeriod.style.background = '#f9fafb';
  headerRow.appendChild(thPeriod);

  thead.appendChild(headerRow);
  table.appendChild(thead);

  // Body rows
  const tbody = document.createElement('tbody');
  let units = (state.units || []).slice();
  
  // Filter by search term
  const searchTerm = (state.meta.unitOverviewSearch || '').toLowerCase().trim();
  if(searchTerm){
    units = units.filter(u => {
      const unitId = (u.unitId || '').toString().toLowerCase();
      const lease = (u.lease || '').toString().toLowerCase();
      const arrangement = (u.arrangement || '').toString().toLowerCase();
      const invoicing = (u.invoicing || '').toString().toLowerCase();
      const status = (u.status || '').toString().toLowerCase();
      return unitId.includes(searchTerm) || lease.includes(searchTerm) || 
             arrangement.includes(searchTerm) || invoicing.includes(searchTerm) || status.includes(searchTerm);
    });
  }
  
  // Sort units based on current sort settings
  const sortCol = state.meta.unitOverviewSort.column;
  const sortAsc = state.meta.unitOverviewSort.ascending;
  
  units.sort((a, b) => {
    let valA = (a[sortCol] || '').toString().toLowerCase();
    let valB = (b[sortCol] || '').toString().toLowerCase();
    
    if(valA < valB) return sortAsc ? -1 : 1;
    if(valA > valB) return sortAsc ? 1 : -1;
    return 0;
  });

  if(units.length === 0){
    const emptyRow = document.createElement('tr');
    const emptyCell = document.createElement('td');
    emptyCell.colSpan = 4 + daysInMonth;
    emptyCell.textContent = 'No units registered.';
    emptyCell.style.padding = '12px';
    emptyCell.style.textAlign = 'center';
    emptyCell.className = 'small-muted';
    emptyRow.appendChild(emptyCell);
    tbody.appendChild(emptyRow);
  } else {
    units.forEach(u => {
      const row = document.createElement('tr');
      row.style.borderBottom = '1px solid #eef2f7';
      row.style.cursor = 'pointer';
      row.style.transition = 'background-color 0.2s ease';
      
      // Hover effect
      row.addEventListener('mouseenter', () => {
        if(row.style.backgroundColor !== 'rgb(224, 242, 254)') {
          row.style.backgroundColor = '#f3f6fb';
        }
      });
      row.addEventListener('mouseleave', () => {
        if(row.style.backgroundColor !== 'rgb(224, 242, 254)') {
          row.style.backgroundColor = '';
        }
      });
      
      // Click handler for row highlighting
      row.addEventListener('click', () => {
        // Remove highlight from all rows in this table
        const allRows = tbody.querySelectorAll('tr');
        allRows.forEach(r => {
          r.style.backgroundColor = '';
        });
        // Highlight clicked row
        row.style.backgroundColor = '#e0f2fe';
      });

      // Unit ID column
      const tdUnit = document.createElement('td');
      tdUnit.style.padding = '6px';
      tdUnit.style.fontSize = '12px';
      tdUnit.style.verticalAlign = 'middle';
      tdUnit.style.fontWeight = '600';
      tdUnit.style.cursor = 'pointer';
      tdUnit.style.color = '#0b74de';
      tdUnit.textContent = u.unitId || '(no unit)';
      tdUnit.addEventListener('click', () => {
        openUnitWdNumbersModal(u.unitId, year, month);
      });
      row.appendChild(tdUnit);

      // Lease column
      const tdLease = document.createElement('td');
      tdLease.style.padding = '6px';
      tdLease.style.fontSize = '12px';
      tdLease.style.verticalAlign = 'middle';
      tdLease.textContent = u.lease || '';
      row.appendChild(tdLease);

      // Arrangement column
      const tdArrangement = document.createElement('td');
      tdArrangement.style.padding = '6px';
      tdArrangement.style.fontSize = '12px';
      tdArrangement.style.verticalAlign = 'middle';
      tdArrangement.textContent = u.arrangement || '';
      row.appendChild(tdArrangement);

      // Invoicing column
      const tdInvoicing = document.createElement('td');
      tdInvoicing.style.padding = '6px';
      tdInvoicing.style.fontSize = '12px';
      tdInvoicing.style.verticalAlign = 'middle';
      tdInvoicing.textContent = u.invoicing || '';
      row.appendChild(tdInvoicing);

      // Status column
      const tdStatus = document.createElement('td');
      tdStatus.style.padding = '6px';
      tdStatus.style.fontSize = '12px';
      tdStatus.style.verticalAlign = 'middle';
      tdStatus.textContent = u.status || 'Operational';
      row.appendChild(tdStatus);

      // Build map of days covered by registries for this unit (track count for overlap detection)
      const coveredDays = new Map();
      const registries = state.registries || [];
      const invoices = state.invoices || [];
      
      registries.forEach(reg => {
        // Check if this unit is in the registry's units array
        const units = reg.units || [];
        const unitId = (u.unitId || '').toString().trim().toLowerCase();
        const unitIdAlt = (u.id || '').toString().trim().toLowerCase();
        
        const isInRegistry = units.some(unitStr => {
          const regUnit = (unitStr || '').toString().trim().toLowerCase();
          return regUnit === unitId || regUnit === unitIdAlt;
        });
        
        // Check if registry or matching invoice has Rental category
        let category = '';
        
        // First, check if registry has a category
        if(reg.category){
          category = reg.category.toString().trim().toLowerCase();
        } else {
          // Fallback to invoice category
          const matchingInvoice = invoices.find(inv => {
            const invWd = (inv.wdNumber || '').toString().trim().toLowerCase();
            const regWd = (reg.wdNumber || '').toString().trim().toLowerCase();
            return invWd === regWd;
          });
          if(matchingInvoice){
            category = (matchingInvoice.category || '').toString().trim().toLowerCase();
          }
        }
        
        const hasRentalCategory = category === 'rental';
        
        if(isInRegistry && hasRentalCategory && reg.periodStart && reg.periodEnd){
          // Parse dates as local dates to avoid timezone issues
          const startParts = reg.periodStart.toString().trim().split('-');
          const endParts = reg.periodEnd.toString().trim().split('-');
          const startDate = new Date(parseInt(startParts[0]), parseInt(startParts[1]) - 1, parseInt(startParts[2]));
          const endDate = new Date(parseInt(endParts[0]), parseInt(endParts[1]) - 1, parseInt(endParts[2]));
          
          if(!isNaN(startDate.getTime()) && !isNaN(endDate.getTime())){
            // Add all days in the period that fall in the selected month/year
            const currentDate = new Date(startDate);
            while(currentDate <= endDate){
              if(currentDate.getFullYear() === year && currentDate.getMonth() === month){
                const day = currentDate.getDate();
                coveredDays.set(day, (coveredDays.get(day) || 0) + 1);
              }
              currentDate.setDate(currentDate.getDate() + 1);
            }
          }
        }
      });

      // Day columns - create squares for each day with day numbers inside
      for(let d = 1; d <= daysInMonth; d++){
        const tdDay = document.createElement('td');
        tdDay.style.padding = '2px';
        tdDay.style.textAlign = 'center';
        tdDay.style.verticalAlign = 'middle';

        const square = document.createElement('div');
        square.style.width = '24px';
        square.style.height = '24px';
        square.style.border = '1px solid #ddd';
        square.style.borderRadius = '4px';
        square.style.display = 'flex';
        square.style.alignItems = 'center';
        square.style.justifyContent = 'center';
        square.style.fontSize = '11px';
        square.textContent = d;
        
        // Highlight based on coverage count
        const coverageCount = coveredDays.get(d) || 0;
        if(coverageCount > 1){
          // Red for overlaps (2 or more registries covering the same day)
          square.style.backgroundColor = '#fee2e2';
          square.style.borderColor = '#dc2626';
          square.style.color = '#991b1b';
          square.style.fontWeight = '600';
          square.title = `Overlap: ${coverageCount} registries cover this day`;
        } else if(coverageCount === 1){
          // Green for single coverage
          square.style.backgroundColor = '#dcfce7';
          square.style.borderColor = '#16a34a';
          square.style.color = '#15803d';
          square.style.fontWeight = '600';
        } else {
          // White for no coverage
          square.style.backgroundColor = '#fff';
          square.style.color = '#6b7280';
        }

        tdDay.appendChild(square);
        row.appendChild(tdDay);
      }

      tbody.appendChild(row);
    });
  }

  table.appendChild(tbody);
  el.appendChild(table);
}

// Render a minimal Lease Overview placeholder
function renderLeaseOverview(){
  const el = qs('#leaseOverview'); if(!el) return;
  el.innerHTML = '';

  // Create controls for month and year selection
  state.meta = state.meta || {};
  const now = new Date();
  const selectedYear = state.meta.leaseOverviewYear || now.getFullYear();
  const selectedMonth = (typeof state.meta.leaseOverviewMonth !== 'undefined') ? state.meta.leaseOverviewMonth : now.getMonth();

  const controls = document.createElement('div');
  controls.style.display = 'flex';
  controls.style.gap = '12px';
  controls.style.alignItems = 'center';
  controls.style.marginBottom = '12px';

  const label = document.createElement('label');
  label.style.fontWeight = '600';
  label.textContent = 'Period:';
  controls.appendChild(label);

  const monthSelect = document.createElement('select');
  monthSelect.id = 'leaseOverviewMonth';
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  monthNames.forEach((name, index) => {
    const option = document.createElement('option');
    option.value = index;
    option.textContent = name;
    if(index === selectedMonth) option.selected = true;
    monthSelect.appendChild(option);
  });

  const yearSelect = document.createElement('select');
  yearSelect.id = 'leaseOverviewYear';
  for(let y = now.getFullYear() - 3; y <= now.getFullYear() + 1; y++){
    const option = document.createElement('option');
    option.value = y;
    option.textContent = y;
    if(y === selectedYear) option.selected = true;
    yearSelect.appendChild(option);
  }

  controls.appendChild(monthSelect);
  controls.appendChild(yearSelect);
  
  // Add search box
  const searchLabel = document.createElement('label');
  searchLabel.style.fontWeight = '600';
  searchLabel.style.marginLeft = '20px';
  searchLabel.textContent = 'Search:';
  controls.appendChild(searchLabel);
  
  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.id = 'leaseOverviewSearch';
  searchInput.placeholder = 'Filter by lease, company, supplier, invoicing...';
  searchInput.style.padding = '6px 10px';
  searchInput.style.border = '1px solid #e6e9ee';
  searchInput.style.borderRadius = '6px';
  searchInput.style.fontSize = '13px';
  searchInput.style.width = '250px';
  searchInput.value = state.meta.leaseOverviewSearch || '';
  searchInput.addEventListener('input', () => {
    if(searchInput.value === ''){
      state.meta.leaseOverviewSearch = '';
      try{ saveState(); }catch(e){}
      renderLeaseOverview();
    }
  });
  searchInput.addEventListener('keypress', (e) => {
    if(e.key === 'Enter'){
      state.meta.leaseOverviewSearch = searchInput.value;
      try{ saveState(); }catch(e){}
      renderLeaseOverview();
    }
  });
  controls.appendChild(searchInput);
  
  const searchBtn = document.createElement('button');
  searchBtn.textContent = 'Search';
  searchBtn.style.padding = '6px 16px';
  searchBtn.style.borderRadius = '6px';
  searchBtn.style.fontSize = '13px';
  searchBtn.style.cursor = 'pointer';
  searchBtn.addEventListener('click', () => {
    state.meta.leaseOverviewSearch = searchInput.value;
    try{ saveState(); }catch(e){}
    renderLeaseOverview();
  });
  controls.appendChild(searchBtn);
  
  el.appendChild(controls);

  // Event listeners for dropdowns
  monthSelect.addEventListener('change', () => {
    state.meta.leaseOverviewMonth = parseInt(monthSelect.value, 10);
    try{ saveState(); }catch(e){}
    renderLeaseOverview();
  });

  yearSelect.addEventListener('change', () => {
    state.meta.leaseOverviewYear = parseInt(yearSelect.value, 10);
    try{ saveState(); }catch(e){}
    renderLeaseOverview();
  });

  // Initialize sorting state
  state.meta.leaseOverviewSort = state.meta.leaseOverviewSort || { column: 'leaseNumber', ascending: true };

  // Calculate days in selected month
  const year = parseInt(yearSelect.value, 10);
  const month = parseInt(monthSelect.value, 10);
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  // Create table for all leases
  const table = document.createElement('table');
  table.style.width = '100%';
  table.style.borderCollapse = 'collapse';
  table.style.marginTop = '12px';

  // Header row
  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  
  const headers = [
    { text: 'Lease Number', key: 'leaseNumber' },
    { text: 'Company', key: 'company' },
    { text: 'Supplier', key: 'supplier' },
    { text: 'Arrangement', key: 'arrangement' },
    { text: 'Invoicing', key: 'invoicing' },
    { text: 'Status', key: 'status' }
  ];
  
  headers.forEach(header => {
    const th = document.createElement('th');
    th.textContent = header.text;
    th.style.textAlign = 'left';
    th.style.padding = '6px';
    th.style.fontSize = '12px';
    th.style.borderBottom = '2px solid #eef2f7';
    th.style.fontWeight = '600';
    th.style.background = '#f9fafb';
    th.style.cursor = 'pointer';
    th.style.userSelect = 'none';
    
    // Add sort indicator
    if(state.meta.leaseOverviewSort.column === header.key){
      th.textContent += state.meta.leaseOverviewSort.ascending ? ' ▲' : ' ▼';
    }
    
    th.addEventListener('click', () => {
      if(state.meta.leaseOverviewSort.column === header.key){
        state.meta.leaseOverviewSort.ascending = !state.meta.leaseOverviewSort.ascending;
      } else {
        state.meta.leaseOverviewSort.column = header.key;
        state.meta.leaseOverviewSort.ascending = true;
      }
      try{ saveState(); }catch(e){}
      renderLeaseOverview();
    });
    
    headerRow.appendChild(th);
  });

  // Period column header (spans all day columns)
  const thPeriod = document.createElement('th');
  thPeriod.textContent = 'Period';
  thPeriod.colSpan = daysInMonth;
  thPeriod.style.textAlign = 'center';
  thPeriod.style.padding = '6px';
  thPeriod.style.fontSize = '12px';
  thPeriod.style.borderBottom = '2px solid #eef2f7';
  thPeriod.style.fontWeight = '600';
  thPeriod.style.background = '#f9fafb';
  headerRow.appendChild(thPeriod);

  thead.appendChild(headerRow);
  table.appendChild(thead);

  // Body rows
  const tbody = document.createElement('tbody');
  let leases = (state.leases || []).slice();
  
  // Filter by search term
  const searchTerm = (state.meta.leaseOverviewSearch || '').toLowerCase().trim();
  if(searchTerm){
    leases = leases.filter(l => {
      const leaseNumber = (l.leaseNumber || '').toString().toLowerCase();
      const company = (l.company || '').toString().toLowerCase();
      const supplier = (l.supplier || '').toString().toLowerCase();
      const arrangement = (l.arrangement || '').toString().toLowerCase();
      const invoicing = (l.invoicing || '').toString().toLowerCase();
      const status = (l.status || '').toString().toLowerCase();
      return leaseNumber.includes(searchTerm) || company.includes(searchTerm) || 
             supplier.includes(searchTerm) || arrangement.includes(searchTerm) || 
             invoicing.includes(searchTerm) || status.includes(searchTerm);
    });
  }
  
  // Sort leases based on current sort state
  const sortCol = state.meta.leaseOverviewSort.column;
  const sortAsc = state.meta.leaseOverviewSort.ascending;
  
  leases.sort((a, b) => {
    let valA = (a[sortCol] || '').toString().toLowerCase();
    let valB = (b[sortCol] || '').toString().toLowerCase();
    
    if(valA < valB) return sortAsc ? -1 : 1;
    if(valA > valB) return sortAsc ? 1 : -1;
    return 0;
  });

  if(leases.length === 0){
    const emptyRow = document.createElement('tr');
    const emptyCell = document.createElement('td');
    emptyCell.textContent = 'No leases registered.';
    emptyCell.colSpan = headers.length;
    emptyCell.style.padding = '12px';
    emptyCell.style.textAlign = 'center';
    emptyCell.className = 'small-muted';
    emptyRow.appendChild(emptyCell);
    tbody.appendChild(emptyRow);
  } else {
    // Helper function to format month-day dates
    const formatMD = (md) => {
      if(!md) return '';
      const parts = String(md).split('-');
      if(parts.length !== 2) return md;
      const m = parts[0];
      const d = parts[1].replace(/^0/, '');
      const months = { '01':'Jan','02':'Feb','03':'Mar','04':'Apr','05':'May','06':'Jun','07':'Jul','08':'Aug','09':'Sep','10':'Oct','11':'Nov','12':'Dec' };
      return (months[m] || m) + ' ' + d;
    };

    leases.forEach(lease => {
      const row = document.createElement('tr');
      row.style.borderBottom = '1px solid #eef2f7';
      row.style.cursor = 'pointer';
      row.style.transition = 'background-color 0.2s ease';
      
      // Hover effect
      row.addEventListener('mouseenter', () => {
        if(row.style.backgroundColor !== 'rgb(224, 242, 254)') {
          row.style.backgroundColor = '#f3f6fb';
        }
      });
      row.addEventListener('mouseleave', () => {
        if(row.style.backgroundColor !== 'rgb(224, 242, 254)') {
          row.style.backgroundColor = '';
        }
      });
      
      // Click handler for row highlighting
      row.addEventListener('click', () => {
        // Remove highlight from all rows in this table
        const allRows = tbody.querySelectorAll('tr');
        allRows.forEach(r => {
          r.style.backgroundColor = '';
        });
        // Highlight clicked row
        row.style.backgroundColor = '#e0f2fe';
      });

      // Lease Number
      const tdLeaseNum = document.createElement('td');
      tdLeaseNum.style.padding = '6px';
      tdLeaseNum.style.fontSize = '12px';
      tdLeaseNum.style.fontWeight = '600';
      tdLeaseNum.textContent = lease.leaseNumber || '(no number)';
      row.appendChild(tdLeaseNum);

      // Company
      const tdCompany = document.createElement('td');
      tdCompany.style.padding = '6px';
      tdCompany.style.fontSize = '12px';
      tdCompany.textContent = lease.company || '';
      row.appendChild(tdCompany);

      // Supplier
      const tdSupplier = document.createElement('td');
      tdSupplier.style.padding = '6px';
      tdSupplier.style.fontSize = '12px';
      tdSupplier.textContent = lease.supplier || '';
      row.appendChild(tdSupplier);

      // Arrangement
      const tdArrangement = document.createElement('td');
      tdArrangement.style.padding = '6px';
      tdArrangement.style.fontSize = '12px';
      tdArrangement.textContent = lease.arrangement || '';
      row.appendChild(tdArrangement);

      // Invoicing
      const tdInvoicing = document.createElement('td');
      tdInvoicing.style.padding = '6px';
      tdInvoicing.style.fontSize = '12px';
      tdInvoicing.textContent = lease.invoicing || '';
      row.appendChild(tdInvoicing);

      // Status
      const tdStatus = document.createElement('td');
      tdStatus.style.padding = '6px';
      tdStatus.style.fontSize = '12px';
      tdStatus.textContent = lease.status || 'Enabled';
      row.appendChild(tdStatus);

      // Build set of days covered by invoices/registries for this lease (Rental category only)
      const coveredDays = new Set();
      const invoices = state.invoices || [];
      const registries = state.registries || [];
      
      // First, check registries that have a lease field matching this lease
      registries.forEach(reg => {
        if(!reg) return;
        const regLease = (reg.lease || '').toString().trim().toLowerCase();
        const leaseNum = (lease.leaseNumber || '').toString().trim().toLowerCase();
        
        if(regLease === leaseNum && regLease !== ''){
          // Check if registry has Rental category
          let category = '';
          if(reg.category){
            category = reg.category.toString().trim().toLowerCase();
          } else {
            // Fallback to invoice category
            const matchingInvoice = invoices.find(inv => {
              const invWd = (inv.wdNumber || '').toString().trim().toLowerCase();
              const regWd = (reg.wdNumber || '').toString().trim().toLowerCase();
              return invWd === regWd;
            });
            if(matchingInvoice){
              category = (matchingInvoice.category || '').toString().trim().toLowerCase();
            }
          }
          
          // Only process if category is Rental and has valid period dates
          if(category === 'rental' && reg.periodStart && reg.periodEnd){
            // Parse dates as local dates to avoid timezone issues
            const startParts = reg.periodStart.toString().trim().split('-');
            const endParts = reg.periodEnd.toString().trim().split('-');
            const startDate = new Date(parseInt(startParts[0]), parseInt(startParts[1]) - 1, parseInt(startParts[2]));
            const endDate = new Date(parseInt(endParts[0]), parseInt(endParts[1]) - 1, parseInt(endParts[2]));
            
            if(!isNaN(startDate.getTime()) && !isNaN(endDate.getTime())){
              // Add all days in the period that fall in the selected month/year
              const currentDate = new Date(startDate);
              while(currentDate <= endDate){
                if(currentDate.getFullYear() === year && currentDate.getMonth() === month){
                  coveredDays.add(currentDate.getDate());
                }
                currentDate.setDate(currentDate.getDate() + 1);
              }
            }
          }
        }
      });
      
      // Then check invoices (for backwards compatibility with invoices not in registries)
      invoices.forEach(inv => {
        // Skip if invoice doesn't have required data
        if(!inv || !inv.lease) return;
        
        const invWd = (inv.wdNumber || '').toString().trim().toLowerCase();
        const leaseNum = (lease.leaseNumber || '').toString().trim().toLowerCase();
        
        // Check if this invoice has a matching registry with a lease field
        const matchingRegistry = registries.find(reg => {
          const regWd = (reg.wdNumber || '').toString().trim().toLowerCase();
          const regLease = (reg.lease || '').toString().trim().toLowerCase();
          return regWd === invWd && regLease !== '';
        });
        
        // Skip if registry with lease field was already processed
        if(matchingRegistry) return;
        
        // Check if this invoice's lease matches current lease
        const invLease = (inv.lease || '').toString().trim().toLowerCase();
        
        if(invLease === leaseNum && invLease !== ''){
          // Check category - try to find matching registry for category
          let category = '';
          const matchingRegistryForCategory = registries.find(reg => {
            const regWd = (reg.wdNumber || '').toString().trim().toLowerCase();
            return regWd === invWd;
          });
          
          // Use registry category if available, otherwise use invoice category
          if(matchingRegistryForCategory && matchingRegistryForCategory.category){
            category = matchingRegistryForCategory.category.trim().toLowerCase();
          } else {
            category = (inv.category || '').toString().trim().toLowerCase();
          }
          
          // Only process if category is Rental and has valid period dates
          if(category === 'rental' && inv.periodStart && inv.periodEnd){
            // Parse dates as local dates to avoid timezone issues
            const startParts = inv.periodStart.split('-');
            const endParts = inv.periodEnd.split('-');
            const startDate = new Date(parseInt(startParts[0]), parseInt(startParts[1]) - 1, parseInt(startParts[2]));
            const endDate = new Date(parseInt(endParts[0]), parseInt(endParts[1]) - 1, parseInt(endParts[2]));
            
            if(!isNaN(startDate.getTime()) && !isNaN(endDate.getTime())){
              // Add all days in the period that fall in the selected month/year
              const currentDate = new Date(startDate);
              while(currentDate <= endDate){
                if(currentDate.getFullYear() === year && currentDate.getMonth() === month){
                  coveredDays.add(currentDate.getDate());
                }
                currentDate.setDate(currentDate.getDate() + 1);
              }
            }
          }
        }
      });

      // Day columns - create squares for each day with day numbers inside
      for(let d = 1; d <= daysInMonth; d++){
        const tdDay = document.createElement('td');
        tdDay.style.padding = '2px';
        tdDay.style.textAlign = 'center';
        tdDay.style.verticalAlign = 'middle';

        const square = document.createElement('div');
        square.style.width = '20px';
        square.style.height = '20px';
        square.style.border = '1px solid #ddd';
        square.style.borderRadius = '3px';
        square.style.display = 'flex';
        square.style.alignItems = 'center';
        square.style.justifyContent = 'center';
        square.style.fontSize = '9px';
        square.textContent = d;
        
        // Highlight if day is covered by a Rental invoice
        if(coveredDays.has(d)){
          square.style.backgroundColor = '#dcfce7';
          square.style.borderColor = '#16a34a';
          square.style.color = '#15803d';
          square.style.fontWeight = '600';
        } else {
          square.style.backgroundColor = '#fff';
          square.style.color = '#6b7280';
        }

        tdDay.appendChild(square);
        row.appendChild(tdDay);
      }

      tbody.appendChild(row);
    });
  }

  table.appendChild(tbody);
  el.appendChild(table);
}

function renderReport(){
  const el = qs('#report'); if(!el) return;
  el.innerHTML = '';
}

// init
renderAll();
renderUsers();
syncTabLabels();

// set default submitted date to today
const invoiceSubmittedInput = qs('#invoiceSubmitted'); if(invoiceSubmittedInput) invoiceSubmittedInput.value = new Date().toISOString().slice(0,10);

// Clear data button
qs('#clearDataBtn').addEventListener('click', clearAllData);

// --- Comment editor: modal-only (no popup)
;(function(){
  const commentBtn = qs('#invoiceCommentBtn');
  const hiddenInput = qs('#invoiceComment');
  const modal = qs('#commentModal');
  const modalTextarea = qs('#commentModalTextarea');
  const modalSave = qs('#commentSaveBtn');
  const modalCancel = qs('#commentCancelBtn');

  function updateCommentButtonLabel(){
    if(!commentBtn || !hiddenInput) return;
    const v = (hiddenInput.value || '').toString().trim();
    // normalize classes: remove both then add appropriate
    try{ commentBtn.classList.remove('btn-primary','btn-warning'); }catch(e){}
    if(!v) {
      commentBtn.textContent = 'Add Comment';
      commentBtn.title = '';
      try{ commentBtn.classList.add('btn-primary'); }catch(e){}
    }
    else {
      commentBtn.textContent = 'Edit Comment';
      commentBtn.title = v.length > 48 ? v.slice(0,48) + '…' : v;
      try{ commentBtn.classList.add('btn-warning'); }catch(e){}
    }
  }

  // modal save/cancel wiring
  if(modalSave){ modalSave.addEventListener('click', ()=>{
    // Check if this is for a registry comment
    if(modal && modal.dataset.registryId){
      const registryId = modal.dataset.registryId;
      const commentIndex = modal.dataset.commentIndex;
      const registry = state.registries.find(r => r.id === registryId);
      if(registry && modalTextarea){
        const commentText = modalTextarea.value || '';
        if(commentText.trim()){
          // Check if editing existing comment or adding new
          if(commentIndex !== undefined && commentIndex !== null && commentIndex !== ''){
            // Edit existing comment
            const idx = parseInt(commentIndex, 10);
            if(registry.comments && registry.comments[idx]){
              registry.comments[idx].text = commentText.trim();
              registry.comments[idx].editedAt = new Date().toISOString();
            }
          } else {
            // Add new comment
            registry.comments = registry.comments || [];
            // Get current user's first and last name from session
            const session = currentSession();
            let userName = 'Unknown User';
            if(session){
              if(session.user === 'Master'){
                userName = 'Master';
              } else {
                const u = (state.users||[]).find(x=> x.username === session.user);
                if(u){
                  userName = (u.firstName || '') + ' ' + (u.lastName || '');
                  userName = userName.trim() || u.username || 'Unknown User';
                } else {
                  userName = session.user || 'Unknown User';
                }
              }
            }
            registry.comments.push({
              text: commentText.trim(),
              user: userName,
              timestamp: new Date().toISOString()
            });
          }
          saveState();
          renderRegistries(registryId);
        }
      }
      delete modal.dataset.registryId;
      delete modal.dataset.commentIndex;
      if(modal){ modal.style.display = 'none'; modal.setAttribute('aria-hidden','true'); }
    } else {
      // Invoice comment
      if(modalTextarea && hiddenInput){ hiddenInput.value = modalTextarea.value || ''; }
      if(modal){ modal.style.display = 'none'; modal.setAttribute('aria-hidden','true'); }
      updateCommentButtonLabel();
    }
  }); }
  if(modalCancel){ modalCancel.addEventListener('click', ()=>{ 
    if(modal){ 
      delete modal.dataset.registryId;
      modal.style.display = 'none'; 
      modal.setAttribute('aria-hidden','true'); 
    } 
  }); }

  // comment button opens in-page modal only
  if(commentBtn){
    commentBtn.addEventListener('click', ()=>{
      const initial = hiddenInput ? (hiddenInput.value || '') : '';
      if(modal && modalTextarea){ modalTextarea.value = initial || ''; modal.style.display = 'block'; modal.setAttribute('aria-hidden','false'); modalTextarea.focus(); }
    });
  }

  // initialize label on load
  updateCommentButtonLabel();
})();

// Developer company list: persist and render company names entered in Developer tab
// ensure meta and companies array exist
state.meta = state.meta || {};
state.meta.devCompanies = state.meta.devCompanies || [];

const devCompanyInput = qs('#devCompany');
const devCompanyListEl = qs('#devCompanyList');

function renderCompanyList(){
  if(!devCompanyListEl) return;
  devCompanyListEl.innerHTML = '';
  state.meta.devCompanies.forEach((c, i)=>{
    const li = document.createElement('li');
    const text = document.createElement('span'); text.textContent = c;
    const actions = document.createElement('div'); actions.className = 'dev-actions';
    const editBtn = document.createElement('button'); editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', ()=>{
      if(!devCompanyInput) return;
      devCompanyInput.value = c;
      const saveBtn = qs('#saveDevCompany');
      if(saveBtn){ saveBtn.dataset.editIndex = i; saveBtn.textContent = 'Save'; }
      devCompanyInput.focus();
    });
    const delBtn = document.createElement('button'); delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', ()=>{
      if(!confirm('Delete this company?')) return; state.meta.devCompanies.splice(i,1); saveState(); renderCompanyList();
    });
    actions.appendChild(editBtn);
    actions.appendChild(delBtn);
    li.appendChild(text);
    li.appendChild(actions);
    devCompanyListEl.appendChild(li);
  });
  syncLeaseCompanyOptions();
}

const saveDevBtn = qs('#saveDevCompany');
if(saveDevBtn){
  saveDevBtn.addEventListener('click', ()=>{
    const v = (devCompanyInput && devCompanyInput.value || '').trim();
    if(!v){ alert('Please enter a company name'); return; }
    const editIndex = saveDevBtn.dataset.editIndex;
    if(typeof editIndex !== 'undefined'){
      const idx = parseInt(editIndex,10);
      if(!Number.isNaN(idx) && state.meta.devCompanies[idx] !== undefined){
        state.meta.devCompanies[idx] = v;
      } else {
        state.meta.devCompanies.push(v);
      }
      delete saveDevBtn.dataset.editIndex;
      saveDevBtn.textContent = 'New';
    } else {
      state.meta.devCompanies.push(v);
    }
    saveState();
    renderCompanyList();
    if(devCompanyInput) devCompanyInput.value = '';
  });
}

renderCompanyList();

// populate lease company select from developer companies
function syncLeaseCompanyOptions(){
  const sel = qs('#leaseCompany');
  if(!sel) return;
  const cur = sel.value;
  sel.innerHTML = '<option value="">(select company)</option>';
  state.meta.devCompanies.forEach(c=>{
    const opt = document.createElement('option'); opt.value = c; opt.textContent = c; sel.appendChild(opt);
  });
  // restore selection if possible
  if(cur) sel.value = cur;
}

syncLeaseCompanyOptions();

// --- Developer rentals list ---
state.meta.devRentals = state.meta.devRentals || [];
const devRentalInput = qs('#devRentalInput');
const devRentalListEl = qs('#devRentalList');

function renderRentalList(){
  if(!devRentalListEl) return;
  devRentalListEl.innerHTML = '';
  state.meta.devRentals.forEach((r, i)=>{
    const li = document.createElement('li');
    const text = document.createElement('span'); text.textContent = r;
    const actions = document.createElement('div'); actions.className = 'dev-actions';
    const editBtn = document.createElement('button'); editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', ()=>{
      if(!devRentalInput) return;
      devRentalInput.value = r;
      const saveBtn = qs('#saveDevRental');
      if(saveBtn){ saveBtn.dataset.editIndex = i; saveBtn.textContent = 'Save'; }
      devRentalInput.focus();
    });
    const delBtn = document.createElement('button'); delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', ()=>{
      if(!confirm('Delete this rental?')) return; state.meta.devRentals.splice(i,1); saveState(); renderRentalList(); if(typeof syncInvoiceCategoryOptions === 'function') syncInvoiceCategoryOptions();
    });
    actions.appendChild(editBtn);
    actions.appendChild(delBtn);
    li.appendChild(text);
    li.appendChild(actions);
    devRentalListEl.appendChild(li);
  });
}

// populate invoice category select from developer rentals
function syncInvoiceCategoryOptions(){
  const sel = qs('#invoiceCategory'); if(!sel) return; const cur = sel.value; sel.innerHTML = '<option value="">(select category)</option>';
  (state.meta.devRentals||[]).forEach(r=>{ const opt = document.createElement('option'); opt.value = r; opt.textContent = r; sel.appendChild(opt); });
  if(cur) sel.value = cur;
}

const saveRentalBtn = qs('#saveDevRental');
if(saveRentalBtn){
  saveRentalBtn.addEventListener('click', ()=>{
    const v = devRentalInput && devRentalInput.value ? devRentalInput.value.trim() : '';
    if(v === ''){ alert('Please enter a rental value'); return; }
    const editIndex = saveRentalBtn.dataset.editIndex;
    if(typeof editIndex !== 'undefined'){
      const idx = parseInt(editIndex,10);
      if(!Number.isNaN(idx) && state.meta.devRentals[idx] !== undefined){
        state.meta.devRentals[idx] = v;
      } else {
        state.meta.devRentals.push(v);
      }
      delete saveRentalBtn.dataset.editIndex;
      saveRentalBtn.textContent = 'new';
    } else {
      state.meta.devRentals.push(v);
    }
    saveState();
    renderRentalList();
    if(typeof syncInvoiceCategoryOptions === 'function') syncInvoiceCategoryOptions();
    if(devRentalInput) devRentalInput.value = '';
  });
}

renderRentalList();

// ensure invoice category select is initialized
if(typeof syncInvoiceCategoryOptions === 'function') syncInvoiceCategoryOptions();

// --- Developer suppliers list ---
state.meta.devSuppliers = state.meta.devSuppliers || [];
const devSupplierInput = qs('#devSupplierInput');
const devSupplierListEl = qs('#devSupplierList');

function renderSupplierList(){
  if(!devSupplierListEl) return;
  devSupplierListEl.innerHTML = '';
  state.meta.devSuppliers.forEach((s, i)=>{
    const li = document.createElement('li');
    const text = document.createElement('span'); text.textContent = s;
    const actions = document.createElement('div'); actions.className = 'dev-actions';
    const editBtn = document.createElement('button'); editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', ()=>{
      if(!devSupplierInput) return;
      devSupplierInput.value = s;
      const saveBtn = qs('#saveDevSupplier');
      if(saveBtn){ saveBtn.dataset.editIndex = i; saveBtn.textContent = 'Save'; }
      devSupplierInput.focus();
    });
    const delBtn = document.createElement('button'); delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', ()=>{
      if(!confirm('Delete this supplier?')) return; state.meta.devSuppliers.splice(i,1); saveState(); renderSupplierList();
    });
    actions.appendChild(editBtn);
    actions.appendChild(delBtn);
    li.appendChild(text);
    li.appendChild(actions);
    devSupplierListEl.appendChild(li);
  });
  syncLeaseSupplierOptions();
}

const saveSupplierBtn = qs('#saveDevSupplier');
if(saveSupplierBtn){
  saveSupplierBtn.addEventListener('click', ()=>{
    const v = devSupplierInput && devSupplierInput.value ? devSupplierInput.value.trim() : '';
    if(v === ''){ alert('Please enter a supplier name'); return; }
    const editIndex = saveSupplierBtn.dataset.editIndex;
    if(typeof editIndex !== 'undefined'){
      const idx = parseInt(editIndex,10);
      if(!Number.isNaN(idx) && state.meta.devSuppliers[idx] !== undefined){
        state.meta.devSuppliers[idx] = v;
      } else {
        state.meta.devSuppliers.push(v);
      }
      delete saveSupplierBtn.dataset.editIndex;
      saveSupplierBtn.textContent = 'new';
    } else {
      state.meta.devSuppliers.push(v);
    }
    saveState();
    renderSupplierList();
    if(devSupplierInput) devSupplierInput.value = '';
  });
}

renderSupplierList();

// populate lease supplier select from developer suppliers
function syncLeaseSupplierOptions(){
  const sel = qs('#leaseSupplier');
  if(!sel) return;
  const cur = sel.value;
  sel.innerHTML = '<option value="">(select supplier)</option>';
  state.meta.devSuppliers.forEach(s=>{
    const opt = document.createElement('option'); opt.value = s; opt.textContent = s; sel.appendChild(opt);
  });
  if(cur) sel.value = cur;
}

syncLeaseSupplierOptions();

// --- Developer payments (Payment Arrangement) list ---
state.meta.devPayments = state.meta.devPayments || [];
const devPaymentInput = qs('#devPaymentInput');
const devPaymentListEl = qs('#devPaymentList');

function renderPaymentList(){
  if(!devPaymentListEl) return;
  devPaymentListEl.innerHTML = '';
  state.meta.devPayments.forEach((p, i)=>{
    const li = document.createElement('li');
    const text = document.createElement('span'); text.textContent = p;
    const actions = document.createElement('div'); actions.className = 'dev-actions';
    const editBtn = document.createElement('button'); editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', ()=>{
      if(!devPaymentInput) return;
      devPaymentInput.value = p;
      const saveBtn = qs('#saveDevPayment');
      if(saveBtn){ saveBtn.dataset.editIndex = i; saveBtn.textContent = 'Save'; }
      devPaymentInput.focus();
    });
    const delBtn = document.createElement('button'); delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', ()=>{
      if(!confirm('Delete this invoicing type?')) return; state.meta.devPayments.splice(i,1); saveState(); renderPaymentList();
    });
    actions.appendChild(editBtn);
    actions.appendChild(delBtn);
    li.appendChild(text);
    li.appendChild(actions);
    devPaymentListEl.appendChild(li);
  });
  if(typeof syncLeaseInvoicingOptions === 'function') syncLeaseInvoicingOptions();
}

const savePaymentBtn = qs('#saveDevPayment');
if(savePaymentBtn){
  savePaymentBtn.addEventListener('click', ()=>{
    const v = devPaymentInput && devPaymentInput.value ? devPaymentInput.value.trim() : '';
    if(v === ''){ alert('Please enter an invoicing type'); return; }
    const editIndex = savePaymentBtn.dataset.editIndex;
    if(typeof editIndex !== 'undefined'){
      const idx = parseInt(editIndex,10);
      if(!Number.isNaN(idx) && state.meta.devPayments[idx] !== undefined){
        state.meta.devPayments[idx] = v;
      } else {
        state.meta.devPayments.push(v);
      }
      delete savePaymentBtn.dataset.editIndex;
      savePaymentBtn.textContent = 'new';
    } else {
      state.meta.devPayments.push(v);
    }
    saveState();
    renderPaymentList();
    if(devPaymentInput) devPaymentInput.value = '';
  });
}

renderPaymentList();

// --- Developer arrangements list ---
state.meta.devArrangements = state.meta.devArrangements || [];
const devArrangementInput = qs('#devArrangementInput');
const devArrangementListEl = qs('#devArrangementList');

function renderArrangementList(){
  if(!devArrangementListEl) return;
  devArrangementListEl.innerHTML = '';
  state.meta.devArrangements.forEach((a, i)=>{
    const li = document.createElement('li');
    const text = document.createElement('span'); text.textContent = a;
    const actions = document.createElement('div'); actions.className = 'dev-actions';
    const editBtn = document.createElement('button'); editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', ()=>{
      if(!devArrangementInput) return;
      devArrangementInput.value = a;
      const saveBtn = qs('#saveDevArrangement');
      if(saveBtn){ saveBtn.dataset.editIndex = i; saveBtn.textContent = 'Save'; }
      devArrangementInput.focus();
    });
    const delBtn = document.createElement('button'); delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', ()=>{
      if(!confirm('Delete this arrangement?')) return; state.meta.devArrangements.splice(i,1); saveState(); renderArrangementList();
    });
    actions.appendChild(editBtn);
    actions.appendChild(delBtn);
    li.appendChild(text);
    li.appendChild(actions);
    devArrangementListEl.appendChild(li);
  });
  syncLeaseArrangementOptions();
}

const saveArrangementBtn = qs('#saveDevArrangement');
if(saveArrangementBtn){
  saveArrangementBtn.addEventListener('click', ()=>{
    const v = devArrangementInput && devArrangementInput.value ? devArrangementInput.value.trim() : '';
    if(v === ''){ alert('Please enter an arrangement'); return; }
    const editIndex = saveArrangementBtn.dataset.editIndex;
    if(typeof editIndex !== 'undefined'){
      const idx = parseInt(editIndex,10);
      if(!Number.isNaN(idx) && state.meta.devArrangements[idx] !== undefined){
        state.meta.devArrangements[idx] = v;
      } else {
        state.meta.devArrangements.push(v);
      }
      delete saveArrangementBtn.dataset.editIndex;
      saveArrangementBtn.textContent = 'new';
    } else {
      state.meta.devArrangements.push(v);
    }
    saveState();
    renderArrangementList();
    if(devArrangementInput) devArrangementInput.value = '';
  });
}

renderArrangementList();

// populate lease arrangement select from developer arrangements
function syncLeaseArrangementOptions(){
  const sel = qs('#leaseArrangement');
  if(!sel) return;
  const cur = sel.value;
  sel.innerHTML = '<option value="">(select arrangement)</option>';
  state.meta.devArrangements.forEach(a=>{
    const opt = document.createElement('option'); opt.value = a; opt.textContent = a; sel.appendChild(opt);
  });
  if(cur) sel.value = cur;
}

syncLeaseArrangementOptions();

// populate lease invoicing select from developer payments
function syncLeaseInvoicingOptions(){
  const sel = qs('#leaseInvoicing');
  if(!sel) return;
  const cur = sel.value;
  sel.innerHTML = '<option value="">(select invoicing)</option>';
  state.meta.devPayments.forEach(p=>{
    const opt = document.createElement('option'); opt.value = p; opt.textContent = p; sel.appendChild(opt);
  });
  if(cur) sel.value = cur;
}

syncLeaseInvoicingOptions();

// show/hide seasonal date inputs in the lease form when arrangement === 'Seasonal'
const leaseArrangementSel = qs('#leaseArrangement');
const leaseSeasonalWrap = qs('#leaseSeasonalDates');
function updateLeaseSeasonalVisibility(){
  try{
    const val = leaseArrangementSel ? leaseArrangementSel.value : '';
    if(val === 'Seasonal'){
      if(leaseSeasonalWrap) leaseSeasonalWrap.style.display = 'flex';
    } else {
      if(leaseSeasonalWrap){
        // clear month/day selects when hiding
        const fm = qs('#leaseFromMonth'); const fdsel = qs('#leaseFromDay'); const tm = qs('#leaseToMonth'); const tdsel = qs('#leaseToDay');
        if(fm) fm.value = ''; if(fdsel) fdsel.value = ''; if(tm) tm.value = ''; if(tdsel) tdsel.value = '';
        leaseSeasonalWrap.style.display = 'none';
      }
    }
  }catch(e){}
}
if(leaseArrangementSel){ leaseArrangementSel.addEventListener('change', updateLeaseSeasonalVisibility); }
// initialize visibility on load
updateLeaseSeasonalVisibility();

// --- Overview sub-tab wiring (General Overview / Unit Overview / Lease Overview / Report) ---
function showOverviewSection(sectionId){
  const sections = ['generalOverview','unitOverview','leaseOverview','report'];
  sections.forEach(s => {
    const el = qs('#'+s);
    if(!el) return;
    el.style.display = (s === sectionId) ? '' : 'none';
  });
  // toggle active-sub class on buttons
  document.querySelectorAll('.overview-tab').forEach(b=>{
    if(b.dataset.section === sectionId) b.classList.add('active-sub'); else b.classList.remove('active-sub');
  });
}

function initOverviewSubtabs(){
  state.meta = state.meta || {};
  const defaultSection = state.meta.overviewSection || 'generalOverview';
  document.querySelectorAll('.overview-tab').forEach(btn => {
    btn.addEventListener('click', ()=>{
      const sec = btn.dataset.section;
      state.meta.overviewSection = sec;
      try{ saveState(); }catch(e){}
      // render the appropriate section
      if(sec === 'generalOverview') renderOverview();
      if(sec === 'unitOverview') renderUnitOverview();
      if(sec === 'leaseOverview') renderLeaseOverview();
      if(sec === 'report') renderReport();
      showOverviewSection(sec);
    });
  });
  // initial visibility
  showOverviewSection(defaultSection);
}

// Registry Edit Modal Functions
// Populate registry edit category select from developer rentals
function syncRegistryCategoryOptions(){
  const sel = qs('#editRegistryCategory'); if(!sel) return; 
  const cur = sel.value; 
  sel.innerHTML = '<option value="">Select Category</option>';
  (state.meta.devRentals||[]).forEach(r=>{ 
    const opt = document.createElement('option'); 
    opt.value = r; 
    opt.textContent = r; 
    sel.appendChild(opt); 
  });
  if(cur) sel.value = cur;
}

// Populate registry edit lease select
function syncRegistryLeaseOptions(){
  const sel = qs('#editRegistryLease'); if(!sel) return;
  const cur = sel.value;
  sel.innerHTML = '<option value="">Select Lease</option>';
  (state.leases || []).forEach(l=>{
    const status = (l.status || 'Enabled').toString().toLowerCase();
    if(status === 'disabled') return;
    const opt = document.createElement('option');
    opt.value = l.leaseNumber || l.id;
    opt.textContent = l.leaseNumber || l.id;
    sel.appendChild(opt);
  });
  if(cur) sel.value = cur;
}

// Populate registry edit units select based on lease
function syncRegistryUnitOptions(leaseVal, selectedUnits){
  const container = qs('#editRegistryUnits'); if(!container) return;
  selectedUnits = Array.isArray(selectedUnits) ? selectedUnits : [];
  
  container.innerHTML = '';
  const units = leaseVal ? (state.units || []).filter(u => u.lease === leaseVal) : (state.units || []);
  
  if(units.length === 0){
    const noUnitsMsg = document.createElement('div');
    noUnitsMsg.style.color = '#6b7280';
    noUnitsMsg.style.fontSize = '13px';
    noUnitsMsg.style.fontStyle = 'italic';
    noUnitsMsg.textContent = 'No units available';
    container.appendChild(noUnitsMsg);
    return;
  }
  
  units.forEach(u => {
    const unitId = u.unitId || u.id || '';
    
    const label = document.createElement('label');
    label.style.display = 'flex';
    label.style.alignItems = 'center';
    label.style.gap = '8px';
    label.style.cursor = 'pointer';
    label.style.padding = '4px';
    label.style.borderRadius = '4px';
    label.style.transition = 'background 0.2s';
    
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = unitId;
    checkbox.style.cursor = 'pointer';
    if(selectedUnits.includes(unitId)) checkbox.checked = true;
    
    const text = document.createElement('span');
    text.textContent = unitId;
    text.style.fontSize = '13px';
    
    label.appendChild(checkbox);
    label.appendChild(text);
    
    // Hover effect
    label.addEventListener('mouseenter', () => {
      label.style.background = '#f3f6fb';
    });
    label.addEventListener('mouseleave', () => {
      label.style.background = 'transparent';
    });
    
    container.appendChild(label);
  });
}

function openRegistryEditModal(registry){
  const modal = qs('#registryEditModal');
  if(!modal) return;
  
  // Get lease from registry.lease or from registry's first unit
  let registryLease = registry.lease || '';
  if(!registryLease){
    const registryUnits = Array.isArray(registry.units) ? registry.units : [];
    if(registryUnits.length > 0){
      const firstUnit = (state.units || []).find(u => (u.unitId || u.id) === registryUnits[0]);
      if(firstUnit) registryLease = firstUnit.lease || '';
    }
  }
  
  // Check user role for lease field restriction
  const session = currentSession();
  let userRole = 'Operator'; // default
  if(session){
    if(session.user === 'Master') userRole = 'Master';
    else {
      const u = (state.users||[]).find(x => x.username === session.user);
      userRole = u ? (u.role || 'Operator') : 'Operator';
    }
  }
  
  // Set the lease value first, then sync dropdown options
  const leaseSelect = qs('#editRegistryLease');
  if(leaseSelect) leaseSelect.value = registryLease;
  
  // Set category value before sync so it can be preserved
  const categorySelect = qs('#editRegistryCategory');
  if(categorySelect) categorySelect.value = registry.category || '';
  
  // Sync dropdown options
  if(typeof syncRegistryCategoryOptions === 'function') syncRegistryCategoryOptions();
  if(typeof syncRegistryLeaseOptions === 'function') syncRegistryLeaseOptions();
  
  // Populate form fields
  qs('#editRegistryId').value = registry.id || '';
  qs('#editRegistryWD').value = registry.wdNumber || '';
  qs('#editRegistryDoc').value = registry.docNumber || '';
  qs('#editRegistryAmount').value = registry.totalAmount || '';
  
  // Re-set category value after sync to ensure it's selected
  if(categorySelect) categorySelect.value = registry.category || '';
  
  // Re-set lease value after sync to ensure it's selected
  if(leaseSelect) {
    leaseSelect.value = registryLease;
    
    // Disable lease select for Operator role
    if(userRole === 'Operator'){
      leaseSelect.disabled = true;
      leaseSelect.style.backgroundColor = '#f5f5f5';
      leaseSelect.style.cursor = 'not-allowed';
      leaseSelect.style.color = '#6b7280';
    } else {
      leaseSelect.disabled = false;
      leaseSelect.style.backgroundColor = '';
      leaseSelect.style.cursor = '';
      leaseSelect.style.color = '';
    }
  }
  
  if(typeof syncRegistryUnitOptions === 'function') syncRegistryUnitOptions(registryLease, Array.isArray(registry.units) ? registry.units : []);
  
  qs('#editRegistryPeriodStart').value = registry.periodStart || '';
  qs('#editRegistryPeriodEnd').value = registry.periodEnd || '';
  qs('#editRegistrySubmitted').value = registry.submittedDate || '';
  
  // Add lease change handler
  if(leaseSelect){
    const newLeaseSelect = leaseSelect.cloneNode(true);
    leaseSelect.parentNode.replaceChild(newLeaseSelect, leaseSelect);
    newLeaseSelect.value = registryLease; // Restore value after cloning
    
    // Re-apply role restriction after cloning
    if(userRole === 'Operator'){
      newLeaseSelect.disabled = true;
      newLeaseSelect.style.backgroundColor = '#f5f5f5';
      newLeaseSelect.style.cursor = 'not-allowed';
      newLeaseSelect.style.color = '#6b7280';
    }
    
    newLeaseSelect.addEventListener('change', () => {
      const container = qs('#editRegistryUnits');
      const currentlySelected = container ? Array.from(container.querySelectorAll('input[type="checkbox"]:checked')).map(cb => cb.value) : [];
      if(typeof syncRegistryUnitOptions === 'function') syncRegistryUnitOptions(newLeaseSelect.value, currentlySelected);
    });
  }
  
  modal.style.display = 'block';
}

function openRegistryCommentModal(registry){
  const modal = qs('#commentModal');
  if(!modal) return;
  
  const textarea = qs('#commentModalTextarea');
  if(textarea) textarea.value = '';
  
  modal.style.display = 'block';
  
  // Store registry id for saving (new comment)
  modal.dataset.registryId = registry.id;
  delete modal.dataset.commentIndex;
}

function openEditCommentModal(registry, commentIndex){
  const modal = qs('#commentModal');
  if(!modal) return;
  
  const comment = registry.comments[commentIndex];
  if(!comment) return;
  
  const textarea = qs('#commentModalTextarea');
  if(textarea) textarea.value = comment.text || '';
  
  modal.style.display = 'block';
  
  // Store registry id and comment index for editing
  modal.dataset.registryId = registry.id;
  modal.dataset.commentIndex = commentIndex;
}

function closeRegistryEditModal(){
  const modal = qs('#registryEditModal');
  if(modal) modal.style.display = 'none';
}

// Registry Edit Modal Event Listeners
const registryEditCancelBtn = qs('#registryEditCancelBtn');
if(registryEditCancelBtn){
  registryEditCancelBtn.addEventListener('click', closeRegistryEditModal);
}

const registryEditSaveBtn = qs('#registryEditSaveBtn');
if(registryEditSaveBtn){
  registryEditSaveBtn.addEventListener('click', () => {
    const registryId = qs('#editRegistryId').value;
    const registry = state.registries.find(r => r.id === registryId);
    if(!registry) return;
    
    // Update registry fields
    registry.wdNumber = qs('#editRegistryWD').value.trim();
    registry.docNumber = qs('#editRegistryDoc').value.trim();
    registry.totalAmount = qs('#editRegistryAmount').value.trim();
    registry.lease = qs('#editRegistryLease').value.trim();
    registry.category = qs('#editRegistryCategory').value.trim();
    registry.periodStart = qs('#editRegistryPeriodStart').value.trim();
    registry.periodEnd = qs('#editRegistryPeriodEnd').value.trim();
    registry.submittedDate = qs('#editRegistrySubmitted').value.trim();
    
    // Get selected units from checkboxes
    const unitsContainer = qs('#editRegistryUnits');
    const checkedBoxes = unitsContainer ? Array.from(unitsContainer.querySelectorAll('input[type="checkbox"]:checked')) : [];
    registry.units = checkedBoxes.map(cb => cb.value).filter(v => v);
    registry.unitCount = registry.units.length;
    
    saveState();
    renderRegistries(registry.id);
    renderInvoices();
    renderUnitOverview();
    renderLeaseOverview();
    renderOverview();
    closeRegistryEditModal();
  });
}

// Close modal when clicking backdrop
const registryEditModal = qs('#registryEditModal');
if(registryEditModal){
  const backdrop = registryEditModal.querySelector('.modal-backdrop');
  if(backdrop){
    backdrop.addEventListener('click', closeRegistryEditModal);
  }
}

// initialize overview sub-tabs if DOM is ready
try{ if(typeof initOverviewSubtabs === 'function') initOverviewSubtabs(); }catch(e){}

// ========== Unit Edit Modal ==========
function openUnitEditModal(unit){
  const modal = qs('#unitEditModal');
  if(!modal) return;
  
  // Populate lease dropdown
  const leaseSelect = qs('#editUnitLease');
  if(leaseSelect){
    leaseSelect.innerHTML = '<option value="">(select lease)</option>';
    state.leases.forEach(l => {
      const opt = document.createElement('option');
      opt.value = l.leaseNumber || l.id;
      opt.textContent = l.leaseNumber || l.id;
      leaseSelect.appendChild(opt);
    });
    leaseSelect.value = unit.lease || '';
  }
  
  // Populate fields
  qs('#editUnitId').value = unit.id || '';
  qs('#editUnitIdInput').value = unit.unitId || '';
  qs('#editUnitMonthly').value = unit.monthly ? Number(unit.monthly).toFixed(2) : '';
  qs('#editUnitDesc').value = unit.description || '';
  qs('#editUnitNotes').value = unit.notes || '';
  qs('#editUnitStatus').value = unit.status || 'Operational';
  
  // Update readonly fields based on selected lease
  updateUnitEditLeaseInfo(unit.lease || '');
  
  // Show/hide disabled date based on status
  const statusSelect = qs('#editUnitStatus');
  const disabledDateContainer = qs('#editUnitDisabledDateContainer');
  const disabledDateInput = qs('#editUnitDisabledDate');
  
  if(unit.status === 'Disabled'){
    disabledDateContainer.style.display = 'block';
    disabledDateInput.value = unit.disabledDate || new Date().toISOString().slice(0,10);
  } else {
    disabledDateContainer.style.display = 'none';
    disabledDateInput.value = '';
  }
  
  // Add lease change handler
  if(leaseSelect){
    const newLeaseSelect = leaseSelect.cloneNode(true);
    leaseSelect.parentNode.replaceChild(newLeaseSelect, leaseSelect);
    newLeaseSelect.value = unit.lease || '';
    newLeaseSelect.addEventListener('change', () => {
      updateUnitEditLeaseInfo(newLeaseSelect.value);
    });
  }
  
  // Add status change handler
  if(statusSelect){
    const newStatusSelect = statusSelect.cloneNode(true);
    statusSelect.parentNode.replaceChild(newStatusSelect, statusSelect);
    newStatusSelect.value = unit.status || 'Operational';
    newStatusSelect.addEventListener('change', () => {
      if(newStatusSelect.value === 'Disabled'){
        disabledDateContainer.style.display = 'block';
        if(!disabledDateInput.value){
          disabledDateInput.value = new Date().toISOString().slice(0,10);
        }
      } else {
        disabledDateContainer.style.display = 'none';
      }
    });
  }
  
  modal.style.display = 'block';
}

function updateUnitEditLeaseInfo(leaseValue){
  const lease = state.leases.find(l => (l.leaseNumber === leaseValue) || (l.id === leaseValue));
  const companyInput = qs('#editUnitCompany');
  const supplierInput = qs('#editUnitSupplier');
  const arrangementInput = qs('#editUnitArrangement');
  const invoicingInput = qs('#editUnitInvoicing');
  
  if(lease){
    if(companyInput) companyInput.value = lease.company || '';
    if(supplierInput) supplierInput.value = lease.supplier || '';
    if(arrangementInput) arrangementInput.value = lease.arrangement || '';
    if(invoicingInput) invoicingInput.value = lease.invoicing || '';
  } else {
    if(companyInput) companyInput.value = '';
    if(supplierInput) supplierInput.value = '';
    if(arrangementInput) arrangementInput.value = '';
    if(invoicingInput) invoicingInput.value = '';
  }
}

function closeUnitEditModal(){
  const modal = qs('#unitEditModal');
  if(modal) modal.style.display = 'none';
}

// Unit Edit Modal Event Listeners
const unitEditCancelBtn = qs('#unitEditCancelBtn');
if(unitEditCancelBtn){
  unitEditCancelBtn.addEventListener('click', closeUnitEditModal);
}

const unitEditSaveBtn = qs('#unitEditSaveBtn');
if(unitEditSaveBtn){
  unitEditSaveBtn.addEventListener('click', () => {
    const unitId = qs('#editUnitId').value;
    const unit = state.units.find(u => u.id === unitId);
    if(!unit) return;
    
    const newLeaseValue = qs('#editUnitLease').value.trim();
    const newUnitId = qs('#editUnitIdInput').value.trim();
    
    if(!newLeaseValue){ alert('Please select a lease'); return; }
    if(!newUnitId){ alert('Please enter a unit ID'); return; }
    
    // Check for duplicate unit ID in the same lease (excluding current unit)
    const clash = state.units.find(u => {
      return u.id !== unitId && 
             (u.lease || '').toLowerCase() === newLeaseValue.toLowerCase() && 
             (u.unitId || '').toLowerCase() === newUnitId.toLowerCase();
    });
    if(clash){
      alert('A unit with this ID already exists for the selected lease.');
      return;
    }
    
    // Get lease info
    const lease = state.leases.find(l => (l.leaseNumber === newLeaseValue) || (l.id === newLeaseValue));
    
    // Update unit fields
    unit.lease = newLeaseValue;
    unit.company = lease ? (lease.company || '') : '';
    unit.supplier = lease ? (lease.supplier || '') : '';
    unit.arrangement = lease ? (lease.arrangement || '') : '';
    unit.invoicing = lease ? (lease.invoicing || '') : '';
    unit.unitId = newUnitId;
    unit.monthly = (() => {
      const v = qs('#editUnitMonthly').value.trim();
      if(!v) return '';
      const n = parseCurrency(v);
      return n === null ? '' : n.toFixed(2);
    })();
    unit.description = qs('#editUnitDesc').value.trim();
    unit.notes = qs('#editUnitNotes').value.trim();
    unit.status = qs('#editUnitStatus').value;
    
    if(unit.status === 'Disabled'){
      unit.disabledDate = qs('#editUnitDisabledDate').value || new Date().toISOString().slice(0,10);
    } else {
      delete unit.disabledDate;
    }
    
    saveState();
    renderUnits();
    renderOverview();
    if(typeof renderUnitOverview === 'function') renderUnitOverview();
    closeUnitEditModal();
  });
}

// Close modal when clicking backdrop
const unitEditModal = qs('#unitEditModal');
if(unitEditModal){
  const backdrop = unitEditModal.querySelector('.modal-backdrop');
  if(backdrop){
    backdrop.addEventListener('click', closeUnitEditModal);
  }
}

// --- Unit Comments Modal Functions ---
let currentUnitForComments = null;

function openUnitCommentsModal(unit){
  currentUnitForComments = unit;
  const modal = qs('#unitCommentsModal');
  const title = qs('#unitCommentsTitle');
  if(!modal) return;
  
  if(title) title.textContent = `Comments - ${unit.unitId || 'Unit'}`;
  
  // Initialize comments array if not present
  if(!unit.comments) unit.comments = [];
  
  renderUnitComments();
  modal.style.display = 'flex';
}

function closeUnitCommentsModal(){
  const modal = qs('#unitCommentsModal');
  if(modal) modal.style.display = 'none';
  currentUnitForComments = null;
  const textarea = qs('#newUnitComment');
  if(textarea) textarea.value = '';
}

function renderUnitComments(){
  const list = qs('#unitCommentsList');
  if(!list || !currentUnitForComments) return;
  
  list.innerHTML = '';
  
  const comments = currentUnitForComments.comments || [];
  
  if(comments.length === 0){
    const emptyMsg = document.createElement('div');
    emptyMsg.style.padding = '16px';
    emptyMsg.style.textAlign = 'center';
    emptyMsg.style.color = '#9ca3af';
    emptyMsg.style.fontSize = '13px';
    emptyMsg.textContent = 'No comments yet';
    list.appendChild(emptyMsg);
    return;
  }
  
  // Get current user role for delete permission
  const session = currentSession();
  let canDelete = false;
  if(session){
    if(session.user === 'Master'){
      canDelete = true;
    } else {
      const u = (state.users||[]).find(x=> x.username === session.user);
      const role = u ? (u.role || null) : null;
      canDelete = (role === 'Manager' || role === 'Developer');
    }
  }
  
  comments.forEach((comment, index) => {
    const commentDiv = document.createElement('div');
    commentDiv.style.padding = '12px';
    commentDiv.style.marginBottom = '8px';
    commentDiv.style.background = '#f9fafb';
    commentDiv.style.border = '1px solid #e5e7eb';
    commentDiv.style.borderRadius = '6px';
    
    const header = document.createElement('div');
    header.style.display = 'flex';
    header.style.justifyContent = 'space-between';
    header.style.alignItems = 'center';
    header.style.marginBottom = '6px';
    
    const meta = document.createElement('div');
    meta.style.fontSize = '12px';
    meta.style.color = '#6b7280';
    const userName = comment.userName || 'Unknown';
    const timestamp = comment.timestamp ? new Date(comment.timestamp).toLocaleString() : '';
    meta.innerHTML = `<strong>${escapeHtml(userName)}</strong> • ${escapeHtml(timestamp)}`;
    
    header.appendChild(meta);
    
    // Only add delete button if user has permission
    if(canDelete){
      const deleteBtn = document.createElement('button');
      deleteBtn.textContent = 'Delete';
      deleteBtn.style.fontSize = '11px';
      deleteBtn.style.padding = '2px 8px';
      deleteBtn.style.background = '#dc2626';
      deleteBtn.style.color = '#fff';
      deleteBtn.style.border = 'none';
      deleteBtn.style.borderRadius = '4px';
      deleteBtn.style.cursor = 'pointer';
      deleteBtn.addEventListener('click', () => {
        if(confirm('Delete this comment?')){
          currentUnitForComments.comments.splice(index, 1);
          // Update the unit in state
          const unitIndex = state.units.findIndex(u => u.id === currentUnitForComments.id);
          if(unitIndex !== -1){
            state.units[unitIndex] = currentUnitForComments;
          }
          saveState();
          renderUnitComments();
          renderUnits(); // Refresh the units table to update the last comment column
        }
      });
      header.appendChild(deleteBtn);
    }
    
    const text = document.createElement('div');
    text.style.fontSize = '13px';
    text.style.color = '#374151';
    text.style.whiteSpace = 'pre-wrap';
    text.textContent = comment.text || '';
    
    commentDiv.appendChild(header);
    commentDiv.appendChild(text);
    list.appendChild(commentDiv);
  });
}

// Close unit comments modal button
const closeUnitCommentsBtn = qs('#closeUnitCommentsBtn');
if(closeUnitCommentsBtn){
  closeUnitCommentsBtn.addEventListener('click', closeUnitCommentsModal);
}

// Add unit comment button
const addUnitCommentBtn = qs('#addUnitCommentBtn');
if(addUnitCommentBtn){
  addUnitCommentBtn.addEventListener('click', () => {
    const textarea = qs('#newUnitComment');
    if(!textarea || !currentUnitForComments) return;
    
    const text = textarea.value.trim();
    if(!text){
      alert('Please enter a comment');
      return;
    }
    
    const session = currentSession();
    let userName = 'Unknown';
    if(session){
      if(session.user === 'Master'){
        userName = 'Master';
      } else {
        const u = (state.users||[]).find(x=> x.username === session.user);
        if(u){
          userName = (u.firstName || '') + ' ' + (u.lastName || '');
          userName = userName.trim() || session.user;
        } else {
          userName = session.user;
        }
      }
    }
    
    if(!currentUnitForComments.comments) currentUnitForComments.comments = [];
    
    currentUnitForComments.comments.push({
      text: text,
      userName: userName,
      timestamp: new Date().toISOString()
    });
    
    // Update the unit in state
    const unitIndex = state.units.findIndex(u => u.id === currentUnitForComments.id);
    if(unitIndex !== -1){
      state.units[unitIndex] = currentUnitForComments;
    }
    
    saveState();
    textarea.value = '';
    renderUnitComments();
    renderUnits(); // Refresh the units table to show the new comment
  });
}

// Close modal when clicking backdrop - DISABLED to prevent accidental closure
// const unitCommentsModal = qs('#unitCommentsModal');
// if(unitCommentsModal){
//   unitCommentsModal.addEventListener('click', (e) => {
//     if(e.target === unitCommentsModal){
//       closeUnitCommentsModal();
//     }
//   });
// }

// ==================== WD NUMBERS MODAL ====================
function openUnitWdNumbersModal(unitId, year, month) {
  const modal = qs('#unitWdNumbersModal');
  const title = qs('#unitWdNumbersTitle');
  const listDiv = qs('#unitWdNumbersList');
  
  if (!modal || !title || !listDiv) return;
  
  // Find the unit to display full information
  const unit = (state.units || []).find(u => 
    (u.unitId || '').toString().trim().toLowerCase() === (unitId || '').toString().trim().toLowerCase()
  );
  
  title.textContent = `WD Numbers - ${unitId}`;
  
  // Add unit information below title (as first child of modal-body, before the list)
  const modalBody = listDiv.parentNode;
  let unitInfoDiv = qs('#unitWdNumbersInfo');
  if (!unitInfoDiv) {
    unitInfoDiv = document.createElement('div');
    unitInfoDiv.id = 'unitWdNumbersInfo';
    unitInfoDiv.style.padding = '12px 20px';
    unitInfoDiv.style.backgroundColor = '#f9fafb';
    unitInfoDiv.style.borderBottom = '1px solid #e5e7eb';
    unitInfoDiv.style.fontSize = '13px';
    unitInfoDiv.style.color = '#374151';
    modalBody.insertBefore(unitInfoDiv, listDiv);
  }
  
  if (unit) {
    unitInfoDiv.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(2, 1fr);gap:8px;">
        <div><strong>Lease:</strong> ${escapeHtml(unit.lease || 'N/A')}</div>
        <div><strong>Company:</strong> ${escapeHtml(unit.company || 'N/A')}</div>
        <div><strong>Supplier:</strong> ${escapeHtml(unit.supplier || 'N/A')}</div>
        <div><strong>Arrangement:</strong> ${escapeHtml(unit.arrangement || 'N/A')}</div>
        <div><strong>Invoicing:</strong> ${escapeHtml(unit.invoicing || 'N/A')}</div>
        <div><strong>Monthly:</strong> ${unit.monthly ? formatCurrency(unit.monthly) : 'N/A'}</div>
        <div style="grid-column:1/-1;"><strong>Description:</strong> ${escapeHtml(unit.description || 'N/A')}</div>
        <div style="grid-column:1/-1;"><strong>Status:</strong> ${escapeHtml(unit.status || 'Operational')}</div>
      </div>
    `;
  } else {
    unitInfoDiv.innerHTML = '<div style="color:#6b7280;">Unit information not found.</div>';
  }
  
  // Filter registries that cover this unit in the selected month (same logic as Unit Overview)
  const registries = state.registries || [];
  const invoices = state.invoices || [];
  const wdNumberMap = new Map();
  
  registries.forEach(reg => {
    // Check if this unit is in the registry's units array
    const units = reg.units || [];
    const unitIdLower = (unitId || '').toString().trim().toLowerCase();
    
    const isInRegistry = units.some(unitStr => {
      const regUnit = (unitStr || '').toString().trim().toLowerCase();
      return regUnit === unitIdLower;
    });
    
    if (!isInRegistry) return;
    
    // Check if registry or matching invoice has Rental category
    let category = '';
    
    if(reg.category){
      category = reg.category.toString().trim().toLowerCase();
    } else {
      // Fallback to invoice category
      const matchingInvoice = invoices.find(inv => {
        const invWd = (inv.wdNumber || '').toString().trim().toLowerCase();
        const regWd = (reg.wdNumber || '').toString().trim().toLowerCase();
        return invWd === regWd;
      });
      if(matchingInvoice){
        category = (matchingInvoice.category || '').toString().trim().toLowerCase();
      }
    }
    
    const hasRentalCategory = category === 'rental';
    if (!hasRentalCategory) return;
    
    // Check if registry period overlaps with selected month
    if (!reg.periodStart || !reg.periodEnd) return;
    
    const startParts = reg.periodStart.split('-');
    const endParts = reg.periodEnd.split('-');
    const startDate = new Date(parseInt(startParts[0]), parseInt(startParts[1]) - 1, parseInt(startParts[2]));
    const endDate = new Date(parseInt(endParts[0]), parseInt(endParts[1]) - 1, parseInt(endParts[2]));
    
    if(isNaN(startDate.getTime()) || isNaN(endDate.getTime())) return;
    
    // Check if any day in the period falls in the selected month/year
    let coversMonth = false;
    const currentDate = new Date(startDate);
    while(currentDate <= endDate){
      if(currentDate.getFullYear() === year && currentDate.getMonth() === month){
        coversMonth = true;
        break;
      }
      currentDate.setDate(currentDate.getDate() + 1);
    }
    
    if (!coversMonth) return;
    
    // Add to map with period from matching invoice
    const wd = (reg.wdNumber || '').toString().trim() || '(No WD Number)';
    if (!wdNumberMap.has(wd)) {
      // Find matching invoice to get the correct period
      const matchingInvoice = invoices.find(inv => {
        const invWd = (inv.wdNumber || '').toString().trim().toLowerCase();
        const regWd = wd.toLowerCase();
        const invUnit = (inv.unit || '').toString().trim().toLowerCase();
        return invWd === regWd && invUnit === unitIdLower;
      });
      
      wdNumberMap.set(wd, {
        wdNumber: wd,
        periodStart: matchingInvoice ? matchingInvoice.periodStart : reg.periodStart,
        periodEnd: matchingInvoice ? matchingInvoice.periodEnd : reg.periodEnd
      });
    }
  });
  
  // Render WD numbers list
  listDiv.innerHTML = '';
  
  if (wdNumberMap.size === 0) {
    listDiv.innerHTML = '<p style="color:#6b7280;font-size:14px;">No WD numbers found for this unit in the selected month.</p>';
  } else {
    wdNumberMap.forEach(wdData => {
      const item = document.createElement('div');
      item.style.padding = '10px';
      item.style.borderBottom = '1px solid #e5e7eb';
      item.style.fontSize = '14px';
      
      const wdNumber = document.createElement('div');
      wdNumber.style.fontWeight = '600';
      wdNumber.style.color = '#111827';
      wdNumber.textContent = wdData.wdNumber;
      
      const period = document.createElement('div');
      period.style.color = '#6b7280';
      period.style.fontSize = '12px';
      period.style.marginTop = '4px';
      
      const formatDate = (dateStr) => {
        if (!dateStr) return '';
        // Parse as local date to avoid timezone issues
        const parts = dateStr.split('-');
        if (parts.length === 3) {
          const d = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
          return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        }
        return dateStr;
      };
      
      period.textContent = `${formatDate(wdData.periodStart)} - ${formatDate(wdData.periodEnd)}`;
      
      item.appendChild(wdNumber);
      item.appendChild(period);
      listDiv.appendChild(item);
    });
  }
  
  modal.style.display = 'flex';
}

function closeUnitWdNumbersModal() {
  const modal = qs('#unitWdNumbersModal');
  if (modal) {
    modal.style.display = 'none';
  }
}

const closeUnitWdNumbersBtn = qs('#closeUnitWdNumbersBtn');
if (closeUnitWdNumbersBtn) {
  closeUnitWdNumbersBtn.addEventListener('click', closeUnitWdNumbersModal);
}

// ==================== BULK DATA UPLOAD ====================
const uploadTargets = ['Invoices', 'Units', 'Leases', 'Users'];

uploadTargets.forEach(target => {
  const targetLower = target.toLowerCase();
  const fileInput = qs(`#upload${target}File`);
  const formatBtn = qs(`#format${target}Btn`);
  const statusDiv = qs(`#status${target}`);
  
  if (fileInput) {
    fileInput.addEventListener('change', () => {
      if (!fileInput.files || fileInput.files.length === 0) {
        return;
      }
      
      const file = fileInput.files[0];
      const fileName = file.name.toLowerCase();
      const reader = new FileReader();
      
      reader.onload = (e) => {
        try {
          const content = e.target.result;
          let data = [];
          
          if (fileName.endsWith('.json')) {
            data = JSON.parse(content);
            if (!Array.isArray(data)) {
              showUploadStatus(statusDiv, 'JSON file must contain an array of objects.', 'error');
              return;
            }
          } else if (fileName.endsWith('.csv')) {
            data = parseCSV(content);
          } else {
            showUploadStatus(statusDiv, 'Unsupported file format. Please use CSV or JSON.', 'error');
            return;
          }
          
          if (data.length === 0) {
            showUploadStatus(statusDiv, 'No data found in the file.', 'error');
            return;
          }
          
          uploadBulkData(targetLower, data, statusDiv);
          fileInput.value = ''; // Clear the file input after upload
          
        } catch (err) {
          showUploadStatus(statusDiv, `Error processing file: ${err.message}`, 'error');
        }
      };
      
      reader.onerror = () => {
        showUploadStatus(statusDiv, 'Error reading file.', 'error');
      };
      
      reader.readAsText(file);
    });
  }
  
  if (formatBtn) {
    formatBtn.addEventListener('click', () => {
      downloadFormatTemplate(targetLower);
    });
  }
});

function parseCSV(text) {
  const lines = text.split('\n').filter(line => line.trim());
  if (lines.length < 2) return [];
  
  // Parse CSV line respecting quoted fields that may contain commas
  function parseCSVLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;
    
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      const nextChar = line[i + 1];
      
      if (char === '"') {
        if (inQuotes && nextChar === '"') {
          // Escaped quote ("")
          current += '"';
          i++; // Skip next quote
        } else {
          // Toggle quote state
          inQuotes = !inQuotes;
        }
      } else if (char === ',' && !inQuotes) {
        // Field delimiter outside quotes
        result.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    
    // Add last field
    result.push(current.trim());
    return result;
  }
  
  const headers = parseCSVLine(lines[0]);
  const data = [];
  
  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    const obj = {};
    headers.forEach((header, index) => {
      obj[header] = values[index] || '';
    });
    data.push(obj);
  }
  
  return data;
}

// Helper function to convert various date formats to YYYY-MM-DD
function convertToSystemDate(dateStr) {
  if (!dateStr) return '';
  
  const str = dateStr.toString().trim();
  if (!str) return '';
  
  // Already in YYYY-MM-DD format
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    return str;
  }
  
  // Excel serial number (days since 1900-01-01, accounting for Excel's leap year bug)
  if (/^\d+$/.test(str)) {
    const excelEpoch = new Date(1899, 11, 30); // Excel's epoch (accounting for 1900 bug)
    const days = parseInt(str, 10);
    const date = new Date(excelEpoch.getTime() + days * 86400000);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  
  // Try parsing common formats: MM/DD/YYYY, DD/MM/YYYY, M/D/YYYY, etc.
  let parsedDate = null;
  
  // MM/DD/YYYY or M/D/YYYY (US format)
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(str)) {
    const parts = str.split('/');
    const month = parseInt(parts[0], 10);
    const day = parseInt(parts[1], 10);
    const year = parseInt(parts[2], 10);
    
    // Validate month and day
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      parsedDate = new Date(year, month - 1, day);
    }
  }
  
  // DD-MM-YYYY or D-M-YYYY (European format with dashes)
  if (!parsedDate && /^\d{1,2}-\d{1,2}-\d{4}$/.test(str)) {
    const parts = str.split('-');
    const day = parseInt(parts[0], 10);
    const month = parseInt(parts[1], 10);
    const year = parseInt(parts[2], 10);
    
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      parsedDate = new Date(year, month - 1, day);
    }
  }
  
  // If parsing succeeded, format as YYYY-MM-DD
  if (parsedDate && !isNaN(parsedDate.getTime())) {
    const year = parsedDate.getFullYear();
    const month = String(parsedDate.getMonth() + 1).padStart(2, '0');
    const day = String(parsedDate.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  
  // Fallback: return original string
  return str;
}

function uploadBulkData(target, data, statusDiv) {
  let added = 0;
  let skipped = 0;
  
  try {
    switch (target) {
      case 'invoices':
        // Group invoices by WD number to create registries
        const invoicesByWD = new Map();
        
        data.forEach(item => {
          if (!item.unit || !item.wdNumber) {
            skipped++;
            return;
          }
          
          // Find the associated lease to get company, supplier, arrangement, invoicing
          const associatedLease = state.leases.find(l => l.leaseNumber === item.lease);
          
          const invoice = {
            id: id(),
            lease: item.lease || '',
            company: associatedLease ? associatedLease.company : '',
            supplier: associatedLease ? associatedLease.supplier : '',
            arrangement: associatedLease ? associatedLease.arrangement : '',
            invoicing: associatedLease ? associatedLease.invoicing : '',
            unit: item.unit || '',
            category: item.category || 'Rental',
            wdNumber: item.wdNumber || '',
            docNumber: item.docNumber || '',
            amount: item.amount || '',
            periodStart: convertToSystemDate(item.periodStart),
            periodEnd: convertToSystemDate(item.periodEnd),
            submittedDate: convertToSystemDate(item.submittedDate) || new Date().toISOString().slice(0, 10),
            comment: item.comment || ''
          };
          state.invoices.push(invoice);
          added++;
          
          // Group by WD number for registry creation
          const wd = invoice.wdNumber;
          if (!invoicesByWD.has(wd)) {
            invoicesByWD.set(wd, []);
          }
          invoicesByWD.get(wd).push(invoice);
        });
        
        // Create registries for each WD number group
        invoicesByWD.forEach((invoices, wdNumber) => {
          const firstInvoice = invoices[0];
          const units = invoices.map(inv => inv.unit);
          const totalAmount = invoices.reduce((sum, inv) => {
            const amt = parseFloat(inv.amount) || 0;
            return sum + amt;
          }, 0);
          
          state.meta = state.meta || {};
          state.meta.registrySeq = (state.meta.registrySeq || 0) + 1;
          
          const registry = {
            id: id(),
            seq: state.meta.registrySeq,
            wdNumber: wdNumber,
            docNumber: firstInvoice.docNumber || '',
            totalAmount: totalAmount.toFixed(2),
            unitCount: units.length,
            units: units,
            periodStart: (firstInvoice.periodStart || '').toString().trim(),
            periodEnd: (firstInvoice.periodEnd || '').toString().trim(),
            submittedDate: (firstInvoice.submittedDate || new Date().toISOString().slice(0, 10)).toString().trim(),
            createdAt: new Date().toISOString(),
            comments: [],
            lease: (firstInvoice.lease || '').toString().trim(),
            category: (firstInvoice.category || '').toString().trim()
          };
          
          state.registries = state.registries || [];
          state.registries.push(registry);
        });
        
        saveState();
        renderInvoices();
        renderRegistries();
        renderUnitOverview();
        renderLeaseOverview();
        break;
        
      case 'units':
        data.forEach(item => {
          if (!item.unitId || !item.lease) {
            skipped++;
            return;
          }
          
          // Find the associated lease to get company, supplier, arrangement, invoicing
          const associatedLease = state.leases.find(l => l.leaseNumber === item.lease);
          
          const unit = {
            id: id(),
            lease: item.lease || '',
            company: associatedLease ? associatedLease.company : '',
            supplier: associatedLease ? associatedLease.supplier : '',
            arrangement: associatedLease ? associatedLease.arrangement : '',
            invoicing: associatedLease ? associatedLease.invoicing : '',
            unitId: item.unitId || '',
            monthly: item.monthly || '',
            description: item.description || '',
            notes: item.notes || '',
            status: item.status || 'Operational'
          };
          state.units.push(unit);
          added++;
        });
        renderUnits();
        break;
        
      case 'leases':
        data.forEach(item => {
          if (!item.leaseNumber) {
            skipped++;
            return;
          }
          
          // Add company, supplier, arrangement, and invoicing to developer configurations if not already present
          state.meta = state.meta || {};
          state.meta.devCompanies = state.meta.devCompanies || [];
          state.meta.devSuppliers = state.meta.devSuppliers || [];
          state.meta.devArrangements = state.meta.devArrangements || [];
          state.meta.devPayments = state.meta.devPayments || [];
          
          if (item.company && !state.meta.devCompanies.includes(item.company)) {
            state.meta.devCompanies.push(item.company);
          }
          if (item.supplier && !state.meta.devSuppliers.includes(item.supplier)) {
            state.meta.devSuppliers.push(item.supplier);
          }
          if (item.arrangement && !state.meta.devArrangements.includes(item.arrangement)) {
            state.meta.devArrangements.push(item.arrangement);
          }
          if (item.invoicing && !state.meta.devPayments.includes(item.invoicing)) {
            state.meta.devPayments.push(item.invoicing);
          }
          
          const lease = {
            id: id(),
            leaseNumber: item.leaseNumber || '',
            company: item.company || '',
            supplier: item.supplier || '',
            arrangement: item.arrangement || '',
            invoicing: item.invoicing || '',
            notes: item.notes || '',
            status: 'Enabled'
          };
          state.leases.push(lease);
          added++;
        });
        renderLeases();
        // Refresh developer lists
        if (typeof renderCompanyList === 'function') renderCompanyList();
        if (typeof renderSupplierList === 'function') renderSupplierList();
        if (typeof renderArrangementList === 'function') renderArrangementList();
        if (typeof renderPaymentList === 'function') renderPaymentList();
        break;
        
      case 'registries':
        data.forEach(item => {
          if (!item.wdNumber || !item.units) {
            skipped++;
            return;
          }
          state.meta = state.meta || {};
          state.meta.registrySeq = (state.meta.registrySeq || 0) + 1;
          const registry = {
            id: id(),
            seq: state.meta.registrySeq,
            wdNumber: item.wdNumber || '',
            docNumber: item.docNumber || '',
            totalAmount: item.totalAmount || '',
            unitCount: item.unitCount || 0,
            units: Array.isArray(item.units) ? item.units : (item.units || '').split(';').map(u => u.trim()),
            periodStart: item.periodStart || '',
            periodEnd: item.periodEnd || '',
            submittedDate: item.submittedDate || new Date().toISOString().slice(0, 10),
            createdAt: new Date().toISOString(),
            comments: [],
            lease: item.lease || ''
          };
          state.registries.push(registry);
          added++;
        });
        renderRegistries();
        break;
        
      case 'users':
        data.forEach(item => {
          if (!item.username) {
            skipped++;
            return;
          }
          const user = {
            id: id(),
            username: item.username || '',
            password: item.password || '',
            firstName: item.firstName || '',
            lastName: item.lastName || '',
            role: item.role || 'User'
          };
          state.users.push(user);
          added++;
        });
        renderUsers();
        break;
        
      default:
        showUploadStatus(statusDiv, 'Invalid target selected.', 'error');
        return;
    }
    
    saveState();
    renderOverview();
    renderUnitOverview();
    renderLeaseOverview();
    
    let message = `Successfully uploaded ${added} record(s).`;
    if (skipped > 0) {
      message += ` ${skipped} record(s) were skipped due to missing required fields.`;
    }
    showUploadStatus(statusDiv, message, 'success');
    
  } catch (err) {
    showUploadStatus(statusDiv, `Error uploading data: ${err.message}`, 'error');
  }
}

function downloadFormatTemplate(target) {
  let headers = [];
  let filename = '';
  let exampleRow = [];
  
  switch (target) {
    case 'invoices':
      headers = ['wdNumber', 'docNumber', 'lease', 'category', 'amount', 'periodStart', 'periodEnd', 'submittedDate', 'unit', 'comment'];
      exampleRow = ['SINV-362005', '65508', 'LEASE001', 'Rental', '1500.00', '2025-11-01', '2025-11-30', '2025-11-15', 'UNIT123', 'Optional comment'];
      filename = 'invoices_template.csv';
      break;
    case 'units':
      headers = ['lease', 'unitId', 'monthly', 'description', 'notes'];
      exampleRow = ['LEASE001', 'UNIT123', '1500.00', 'Equipment description', 'Additional notes'];
      filename = 'units_template.csv';
      break;
    case 'leases':
      headers = ['leaseNumber', 'company', 'supplier', 'arrangement', 'invoicing'];
      exampleRow = ['LEASE001', 'AGI Company', 'Supplier Name', 'Monthly', 'Net 30'];
      filename = 'leases_template.csv';
      break;
    case 'users':
      headers = ['username', 'password', 'firstName', 'lastName', 'role'];
      exampleRow = ['john.doe', 'password123', 'John', 'Doe', 'User'];
      filename = 'users_template.csv';
      break;
    default:
      return;
  }
  
  // Create CSV with headers and example row
  const csv = headers.join(',') + '\n' + exampleRow.join(',') + '\n';
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function showUploadStatus(statusDiv, message, type) {
  if (!statusDiv) return;
  
  statusDiv.textContent = message;
  statusDiv.style.display = 'block';
  
  if (type === 'success') {
    statusDiv.style.background = '#dcfce7';
    statusDiv.style.color = '#15803d';
    statusDiv.style.border = '1px solid #16a34a';
  } else if (type === 'error') {
    statusDiv.style.background = '#fee2e2';
    statusDiv.style.color = '#991b1b';
    statusDiv.style.border = '1px solid #dc2626';
  }
}

// Helper function to escape CSV fields that contain commas, quotes, or newlines
function escapeCSVField(field) {
  if (field == null) return '';
  const str = String(field);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

// Helper function to convert array of objects to CSV
function convertToCSV(data, headers) {
  if (!data || data.length === 0) return headers.join(',') + '\n';
  
  const rows = [headers.join(',')];
  
  data.forEach(item => {
    const row = headers.map(header => escapeCSVField(item[header]));
    rows.push(row.join(','));
  });
  
  return rows.join('\n');
}

// Download all data as separate CSV files
function downloadAllData() {
  const timestamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  
  // Download Invoices
  const invoicesHeaders = ['wdNumber', 'docNumber', 'lease', 'category', 'amount', 'periodStart', 'periodEnd', 'submittedDate', 'unit', 'comment', 'company', 'supplier', 'arrangement', 'invoicing'];
  const invoicesData = (state.invoices || []).map(inv => ({
    wdNumber: inv.wdNumber || '',
    docNumber: inv.docNumber || '',
    lease: inv.lease || '',
    category: inv.category || '',
    amount: inv.amount || '',
    periodStart: inv.periodStart || '',
    periodEnd: inv.periodEnd || '',
    submittedDate: inv.submittedDate || '',
    unit: inv.unit || '',
    comment: inv.comment || '',
    company: inv.company || '',
    supplier: inv.supplier || '',
    arrangement: inv.arrangement || '',
    invoicing: inv.invoicing || ''
  }));
  downloadCSV(convertToCSV(invoicesData, invoicesHeaders), `invoices_${timestamp}.csv`);
  
  // Download Units
  const unitsHeaders = ['lease', 'unitId', 'monthly', 'description', 'notes', 'company', 'supplier', 'arrangement', 'invoicing', 'status'];
  const unitsData = (state.units || []).map(u => ({
    lease: u.lease || '',
    unitId: u.unitId || '',
    monthly: u.monthly || '',
    description: u.description || '',
    notes: u.notes || '',
    company: u.company || '',
    supplier: u.supplier || '',
    arrangement: u.arrangement || '',
    invoicing: u.invoicing || '',
    status: u.status || 'Operational'
  }));
  downloadCSV(convertToCSV(unitsData, unitsHeaders), `units_${timestamp}.csv`);
  
  // Download Leases
  const leasesHeaders = ['leaseNumber', 'company', 'supplier', 'arrangement', 'invoicing', 'notes', 'status'];
  const leasesData = (state.leases || []).map(l => ({
    leaseNumber: l.leaseNumber || '',
    company: l.company || '',
    supplier: l.supplier || '',
    arrangement: l.arrangement || '',
    invoicing: l.invoicing || '',
    notes: l.notes || '',
    status: l.status || 'Enabled'
  }));
  downloadCSV(convertToCSV(leasesData, leasesHeaders), `leases_${timestamp}.csv`);
  
  // Download Users
  const usersHeaders = ['username', 'password', 'firstName', 'lastName', 'role'];
  const usersData = (state.users || []).map(u => ({
    username: u.username || '',
    password: u.password || '',
    firstName: u.firstName || '',
    lastName: u.lastName || '',
    role: u.role || 'User'
  }));
  downloadCSV(convertToCSV(usersData, usersHeaders), `users_${timestamp}.csv`);
  
  alert(`Downloaded 4 CSV files:\n- invoices_${timestamp}.csv\n- units_${timestamp}.csv\n- leases_${timestamp}.csv\n- users_${timestamp}.csv`);
}

function downloadCSV(csvContent, filename) {
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);
  link.href = url;
  link.download = filename;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

// Wire up the download all data button
const downloadAllDataBtn = qs('#downloadAllDataBtn');
if (downloadAllDataBtn) {
  downloadAllDataBtn.addEventListener('click', downloadAllData);
}

