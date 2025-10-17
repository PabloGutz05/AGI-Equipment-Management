// Simple SPA with localStorage persistence and import/export JSON
const STORAGE_KEY = 'agi_vehicle_lease_v1';

const defaultData = {
  invoices: [],
  units: [],
  leases: [],
  users: [],
  meta: { createdAt: new Date().toISOString() }
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
    // when on the login page we must hide export/import controls
    updateExportImportVisibility(true);
    // ensure header title is default when showing login
    updateHeaderTitleForMenu(false);
    // disable brand link while on login page so it cannot open the process menu
    try{ const bl = qs('#brandLink'); if(bl){ bl.classList.add('disabled-brand'); bl.setAttribute('aria-disabled','true'); bl.tabIndex = -1; } }catch(e){}
    return;
  }

  // update header title according to menu visibility
  const menuVisible = !!menu && menu.style.display !== 'none';
  updateHeaderTitleForMenu(menuVisible);
  // hide export/import controls when menu visible, otherwise show them
  updateExportImportVisibility(menuVisible);
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
  syncTabLabels(); renderAll(); applyRoleRestrictions(); updateHeaderTitleForMenu(false); updateExportImportVisibility(false); }); }

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
  // Prevent duplicate WD Invoice numbers (case-insensitive). Allow when editing the same invoice.
  try{
    const wdCheck = (fd.get('invoiceWD') || '').toString().trim();
    const editingIdForWD = form.dataset.editing || null;
    if(wdCheck){
      const wdLower = wdCheck.toLowerCase();
      const wdClash = (state.invoices || []).find(inv => (inv.wdNumber || '').toString().trim().toLowerCase() === wdLower && inv.id !== (editingIdForWD || ''));
      if(wdClash){
        alert('WD Invoice number already registered: ' + (wdClash.wdNumber || '(none)') + '. Submission blocked.');
        return;
      }
    }
  }catch(e){ /* ignore and continue to other validations */ }
  // Validation: prevent exact duplicate (unit, category, from/to identical)
  try{
    const unitVal = (fd.get('invoiceUnit') || '').toString().trim();
    const catVal = (fd.get('invoiceCategory') || '').toString().trim();
    const fromVal = (fd.get('invoicePeriodStart') || '').toString().trim();
    const toVal = (fd.get('invoicePeriodEnd') || '').toString().trim();
    const wdVal = (fd.get('invoiceWD') || '').toString().trim();
    const editingId = form.dataset.editing || null;

    if(unitVal && catVal && fromVal && toVal){
      // exact duplicate
      const exact = (state.invoices || []).find(inv => {
        return (inv.unit || '').toString().trim().toLowerCase() === unitVal.toLowerCase()
          && (inv.category || '').toString().trim().toLowerCase() === catVal.toLowerCase()
          && (inv.periodStart || '') === fromVal
          && (inv.periodEnd || '') === toVal
          && inv.id !== (editingId || '');
      });
      if(exact){
        alert('An identical invoice (same Unit, Category and Period) already exists. WD Invoice#: ' + (exact.wdNumber || '(none)') + '. Submission blocked.');
        return;
      }

      // check overlapping periods for same unit+category
      // overlap if NOT (existingEnd < newStart OR existingStart > newEnd)
      const overlaps = (state.invoices || []).filter(inv => {
        if(inv.id === (editingId || '')) return false;
        if(!inv.unit || !inv.category || !inv.periodStart || !inv.periodEnd) return false;
        if((inv.unit || '').toString().trim().toLowerCase() !== unitVal.toLowerCase()) return false;
        if((inv.category || '').toString().trim().toLowerCase() !== catVal.toLowerCase()) return false;
        const aStart = inv.periodStart;
        const aEnd = inv.periodEnd;
        // simple lexicographic compare works for YYYY-MM-DD
        if(aEnd < fromVal || aStart > toVal) return false;
        return true;
      });

      if(overlaps.length){
        const wds = overlaps.map(x => x.wdNumber || '(no WD)').join(', ');
        const proceed = confirm('Warning: existing invoice(s) for the same Unit & Category overlap this period. Registered WD Invoice#: ' + wds + '\n\nPress OK to submit anyway, or Cancel to abort.');
        if(!proceed) return; // abort submission
        // if proceed==true, continue to submit
      }
    }
  }catch(err){ /* if validation fails unexpectedly, fall back to normal submission */ }
  const invoiceObj = {
    id: id(),
    lease: fd.get('invoiceLease') || '',
    // invoiceSupplier is informational (readonly) so prefer reading from DOM
    supplier: (qs('#invoiceSupplier') && qs('#invoiceSupplier').value) || fd.get('invoiceSupplier') || '',
    company: fd.get('invoiceCompany') || '',
    arrangement: fd.get('invoiceArrangement') || '',
    unit: fd.get('invoiceUnit') || '',
    category: fd.get('invoiceCategory') || '',
    wdNumber: fd.get('invoiceWD') || '',
    docNumber: fd.get('invoiceDoc') || '',
    amount: (function(){ const v = fd.get('invoiceAmount')||''; const n = parseCurrency(v); return n===null ? '' : n.toFixed(2); })(),
    periodStart: fd.get('invoicePeriodStart') || '',
    periodEnd: fd.get('invoicePeriodEnd') || '',
    submittedDate: fd.get('invoiceSubmitted') || '',
    comment: fd.get('invoiceComment') || ''
  };

  const editingId = form.dataset.editing || null;
  if(editingId){
    // update existing invoice in place
    state.invoices = state.invoices.map(inv => inv.id === editingId ? Object.assign({}, inv, invoiceObj, {id: editingId}) : inv);
  } else {
    // new invoice
    state.invoices.push(invoiceObj);
  }

  saveState();
  renderInvoices();
  form.reset();
  // clear editing state and restore submit label and hide cancel
  delete form.dataset.editing;
  const submitBtn = form.querySelector('button[type="submit"]'); if(submitBtn) submitBtn.textContent = 'Add Invoice';
  const invCancel = qs('#invoiceCancelBtn'); if(invCancel) invCancel.style.display = 'none';
  // reset submitted date to today after clearing the form
  const sub = qs('#invoiceSubmitted'); if(sub) sub.value = new Date().toISOString().slice(0,10);

});

// sync invoice selects
function syncInvoiceLeaseOptions(){ const sel = qs('#invoiceLease'); if(!sel) return; const cur = sel.value; sel.innerHTML = '<option value="">(select lease)</option>'; state.leases.forEach(l=>{ const opt = document.createElement('option'); opt.value = l.leaseNumber || l.id; opt.textContent = l.leaseNumber || l.id; sel.appendChild(opt); }); if(cur) sel.value = cur; }
function syncInvoiceCompanyOptions(){ const sel = qs('#invoiceCompany'); if(!sel) return; const cur = sel.value; sel.innerHTML = '<option value="">(select company)</option>'; (state.meta.devCompanies||[]).forEach(c=>{ const opt = document.createElement('option'); opt.value = c; opt.textContent = c; sel.appendChild(opt); }); if(cur) sel.value = cur; }
function syncInvoiceArrangementOptions(){ const sel = qs('#invoiceArrangement'); if(!sel) return; const cur = sel.value; sel.innerHTML = '<option value="">(select arrangement)</option>'; (state.meta.devPayments||[]).forEach(p=>{ const opt = document.createElement('option'); opt.value = p; opt.textContent = p; sel.appendChild(opt); }); if(cur) sel.value = cur; }
function syncInvoiceUnitOptions(leaseVal){
  const sel = qs('#invoiceUnit'); if(!sel) return; const cur = sel.value; sel.innerHTML = '<option value="">(select unit)</option>';
  // if leaseVal provided, only show units belonging to that lease
  const list = typeof leaseVal === 'undefined' || !leaseVal ? state.units : state.units.filter(u => (u.lease === leaseVal) || (u.lease === (leaseVal || '')) );
  list.forEach(u=>{ const opt = document.createElement('option'); opt.value = u.unitId || u.id; opt.textContent = u.unitId || u.id; sel.appendChild(opt); });
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
  const c = qs('#invoiceCompany'); const a = qs('#invoiceArrangement'); const s = qs('#invoiceSupplier');
    if(!val){ if(c) c.value=''; if(a) a.value=''; if(s) s.value=''; if(typeof syncInvoiceUnitOptions === 'function') syncInvoiceUnitOptions(); return; }
    const lease = state.leases.find(l => (l.leaseNumber === val) || (l.id === val));
    if(!lease){ if(c) c.value=''; if(a) a.value=''; return; }
    if(c) c.value = lease.company || '';
  if(s) s.value = lease.supplier || '';
    if(a) a.value = lease.arrangement || '';
    if(typeof syncInvoiceUnitOptions === 'function') syncInvoiceUnitOptions(val);
  });
}

qs('#unitForm').addEventListener('submit', e=>{
  e.preventDefault();
  const form = e.target;
  const fd = new FormData(form);
  const editingId = form.dataset.editing || null;
  // Prevent submitting when lease and unit identifier are the same (case-insensitive)
  const leaseVal = (fd.get('unitLease') || '').toString().trim();
  const unitIdVal = ((fd.get('unitId') || fd.get('unitIdInput')) || '').toString().trim();
  if(leaseVal && unitIdVal && leaseVal.toLowerCase() === unitIdVal.toLowerCase()){
    alert('Lease and Unit cannot be the same value. Please correct the Unit identifier or choose a different Lease.');
    return;
  }
  // read company/supplier/arrangement from DOM directly because these selects are informational (disabled)
  const companyVal = (qs('#unitCompany') && qs('#unitCompany').value) || fd.get('unitCompany') || '';
  const supplierVal = (qs('#unitSupplier') && qs('#unitSupplier').value) || fd.get('unitSupplier') || '';
  const arrangementVal = (qs('#unitArrangement') && qs('#unitArrangement').value) || fd.get('unitArrangement') || '';
  const unitObj = {
    id: editingId || id(),
    lease: fd.get('unitLease') || '',
    company: companyVal,
    supplier: supplierVal,
    arrangement: arrangementVal,
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

qs('#leaseForm').addEventListener('submit', e=>{
  e.preventDefault();
  const form = e.target;
  const fd = new FormData(form);
  const editingId = form.dataset.editing || null;
  // Prevent duplicate lease numbers (case-insensitive). Allow when editing the same lease.
  const submittedLeaseNumber = (fd.get('leaseNumber') || '').toString().trim();
  if(!submittedLeaseNumber){ alert('Please provide a lease number'); return; }
  const lower = submittedLeaseNumber.toLowerCase();
  const existing = (state.leases || []).find(l => (l.leaseNumber || '').toString().toLowerCase() === lower && l.id !== (editingId || ''));
  if(existing){ alert('This lease number already exists. Please choose a different lease number.'); return; }
  const leaseObj = {
    id: editingId || id(),
    leaseNumber: fd.get('leaseNumber'),
    company: fd.get('leaseCompany') || '',
    supplier: fd.get('leaseSupplier') || '',
    arrangement: fd.get('leaseArrangement') || '',
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
  state.invoices.forEach((inv, idx)=>{
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${idx+1}</td>
  <td><div class="lease-cell"><div class="lease-number">${escapeHtml(inv.lease||'')}</div><div class="lease-supplier small-muted">${escapeHtml(inv.supplier||'')}</div><div class="lease-company small-muted">${escapeHtml(inv.company||'')}</div></div></td>
  <td><div class="category-cell"><div class="category-name">${escapeHtml(inv.category||'')}</div><div class="category-arrangement small-muted">${escapeHtml(inv.arrangement||'')}</div></div></td>
  <td>${escapeHtml(inv.unit||'')}</td>
  <td><div class="invoice-cell"><div class="invoice-wd"><strong>${escapeHtml(inv.wdNumber||'')}</strong></div><div class="invoice-doc small-muted">${escapeHtml(inv.docNumber||'')}</div></div></td>
  <td>${formatCurrency(inv.amount||'')}</td>
  <td><div class="period-cell"><div class="period-from">${escapeHtml(inv.periodStart||'')}</div><div class="period-to small-muted">${escapeHtml(inv.periodEnd||'')}</div></div></td>
      <td>${escapeHtml(inv.submittedDate||'')}</td>
      <td>${escapeHtml(inv.comment||'')}</td>
      <td class="actions"><button class="edit-inv" data-id="${inv.id}">Edit</button> <button class="del" data-id="${inv.id}">Delete</button></td>`;
    tbody.appendChild(tr);
  });

  // wire edit buttons
  tbody.querySelectorAll('.edit-inv').forEach(b=>b.addEventListener('click', e=>{
    const id = e.target.dataset.id;
    const inv = state.invoices.find(x=>x.id===id);
    if(!inv) return;
    const form = qs('#invoiceForm'); if(!form) return;
    form.dataset.editing = id;
    // populate fields
    const leaseSel = form.querySelector('#invoiceLease'); if(leaseSel) leaseSel.value = inv.lease || '';
    const s = qs('#invoiceSupplier'); if(s) s.value = inv.supplier || '';
    const c = qs('#invoiceCompany'); if(c) c.value = inv.company || '';
    const a = qs('#invoiceArrangement'); if(a) a.value = inv.arrangement || '';
    const cat = form.querySelector('#invoiceCategory'); if(cat) cat.value = inv.category || '';
    const unit = form.querySelector('#invoiceUnit'); if(unit) unit.value = inv.unit || '';
    const wd = form.querySelector('#invoiceWD'); if(wd) wd.value = inv.wdNumber || '';
    const doc = form.querySelector('#invoiceDoc'); if(doc) doc.value = inv.docNumber || '';
    const amt = form.querySelector('#invoiceAmount'); if(amt) amt.value = inv.amount || '';
    const ps = form.querySelector('#invoicePeriodStart'); if(ps) ps.value = inv.periodStart || '';
    const pe = form.querySelector('#invoicePeriodEnd'); if(pe) pe.value = inv.periodEnd || '';
    const sub = form.querySelector('#invoiceSubmitted'); if(sub) sub.value = inv.submittedDate || new Date().toISOString().slice(0,10);
    const com = form.querySelector('#invoiceComment'); if(com) com.value = inv.comment || '';
    const submitBtn = form.querySelector('button[type="submit"]'); if(submitBtn) submitBtn.textContent = 'Save';
    const invCancel = qs('#invoiceCancelBtn'); if(invCancel) invCancel.style.display = 'inline-block';
  }));

  // wire delete buttons
  tbody.querySelectorAll('.del').forEach(b=>b.addEventListener('click', e=>{ const id = e.target.dataset.id; if(!confirm('Delete this invoice?')) return; state.invoices = state.invoices.filter(x=>x.id!==id); saveState(); renderInvoices(); renderOverview(); }));

  // lease numbers are plain text (no popup on click)
}

function renderUnits(){
  const tbody = qs('#unitList'); if(!tbody) return; tbody.innerHTML = '';
  state.units.forEach((u, i)=>{
    const tr = document.createElement('tr');
    const tdIndex = document.createElement('td'); tdIndex.textContent = i+1;
    const tdUnit = document.createElement('td'); tdUnit.textContent = u.unitId || '';
    const tdLease = document.createElement('td'); tdLease.textContent = u.lease || '';
    const tdCompany = document.createElement('td'); tdCompany.textContent = u.company || '';
    const tdSupplier = document.createElement('td'); tdSupplier.textContent = u.supplier || '';
    const tdArrangement = document.createElement('td'); tdArrangement.textContent = u.arrangement || '';
    const tdMonthly = document.createElement('td'); tdMonthly.textContent = formatCurrency(u.monthly || '') || '';
    const tdDesc = document.createElement('td'); tdDesc.textContent = u.description || '';
  const tdNotes = document.createElement('td'); tdNotes.textContent = u.notes || '';
  const tdStatus = document.createElement('td'); tdStatus.textContent = u.status || 'Operational';
  const tdActions = document.createElement('td'); tdActions.className = 'dev-actions';

    const editBtn = document.createElement('button'); editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', ()=>{
      const form = qs('#unitForm'); if(!form) return;
      form.unitLease.value = u.lease || '';
      form.unitCompany.value = u.company || '';
      form.unitSupplier.value = u.supplier || '';
      form.unitArrangement.value = u.arrangement || '';
      form.unitIdInput.value = u.unitId || '';
      // show raw number in the input for editing
      form.unitMonthly.value = u.monthly ? Number(u.monthly).toFixed(2) : '';
      form.unitDesc.value = u.description || '';
      form.unitNotes.value = u.notes || '';
      form.dataset.editing = u.id;
      const submitBtn = form.querySelector('button[type="submit"]'); if(submitBtn) submitBtn.textContent = 'Save';
      form.unitIdInput.focus();
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
  tr.appendChild(tdMonthly);
  tr.appendChild(tdDesc);
  tr.appendChild(tdNotes);
  tr.appendChild(tdStatus);
  tr.appendChild(tdActions);

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
    const c = qs('#unitCompany'); const s = qs('#unitSupplier'); const a = qs('#unitArrangement');
    if(!val){
      // clear informational inputs when user selects the empty option
      if(c) c.value = '';
      if(s) s.value = '';
      if(a) a.value = '';
      return;
    }
    const lease = state.leases.find(l => (l.leaseNumber === val) || (l.id === val));
    if(!lease){
      if(c) c.value = '';
      if(s) s.value = '';
      if(a) a.value = '';
      return;
    }
    if(c) c.value = lease.company || '';
    if(s) s.value = lease.supplier || '';
    if(a) a.value = lease.arrangement || '';
  });
}
function syncUnitCompanyOptions(){ const inp = qs('#unitCompany'); if(!inp) return; inp.value = ''; }
function syncUnitSupplierOptions(){ const inp = qs('#unitSupplier'); if(!inp) return; inp.value = ''; }
function syncUnitArrangementOptions(){ const inp = qs('#unitArrangement'); if(!inp) return; inp.value = ''; }

// call initial syncs
syncUnitLeaseOptions(); syncUnitCompanyOptions(); syncUnitSupplierOptions(); syncUnitArrangementOptions();

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
    text.innerHTML = `<strong>${escapeHtml(l.leaseNumber||'')}</strong><div class='small-muted'>${escapeHtml(l.company||'')} &#8212; ${escapeHtml(l.supplier||'')} &#8212; ${escapeHtml(l.arrangement||'')}</div>${datesHtml}`;
    // informational-only lease entry (no edit/delete actions)
    li.appendChild(text);
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

function renderAll(){ renderOverview(); renderInvoices(); renderUnits(); renderLeases(); renderUsers(); }

// init
renderAll();
renderUsers();
syncTabLabels();

// set default submitted date to today
const invoiceSubmittedInput = qs('#invoiceSubmitted'); if(invoiceSubmittedInput) invoiceSubmittedInput.value = new Date().toISOString().slice(0,10);

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
      if(!confirm('Delete this rental?')) return; state.meta.devRentals.splice(i,1); saveState(); renderRentalList();
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
      if(!confirm('Delete this payment arrangement?')) return; state.meta.devPayments.splice(i,1); saveState(); renderPaymentList();
    });
    actions.appendChild(editBtn);
    actions.appendChild(delBtn);
    li.appendChild(text);
    li.appendChild(actions);
    devPaymentListEl.appendChild(li);
  });
  syncLeasePaymentOptions();
}

const savePaymentBtn = qs('#saveDevPayment');
if(savePaymentBtn){
  savePaymentBtn.addEventListener('click', ()=>{
    const v = devPaymentInput && devPaymentInput.value ? devPaymentInput.value.trim() : '';
    if(v === ''){ alert('Please enter a payment arrangement'); return; }
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

// populate lease arrangement select from developer payments
function syncLeasePaymentOptions(){
  const sel = qs('#leaseArrangement');
  if(!sel) return;
  const cur = sel.value;
  sel.innerHTML = '<option value="">(select arrangement)</option>';
  state.meta.devPayments.forEach(p=>{
    const opt = document.createElement('option'); opt.value = p; opt.textContent = p; sel.appendChild(opt);
  });
  if(cur) sel.value = cur;
}

syncLeasePaymentOptions();

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
