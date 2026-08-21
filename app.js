// Simple SPA with localStorage persistence and import/export JSON
const STORAGE_KEY = 'agi_vehicle_lease_v1';

const defaultData = {
  invoices: [],
  units: [],
  leases: [],
  users: [],
  registries: [],
  ccCenters: [],
  comments: {}, // Store comments by unitId
  meta: { createdAt: new Date().toISOString(), registrySeq: 0 }
};

let state = JSON.parse(JSON.stringify(defaultData));

const weatherLocations = [
  { id: 'miami', name: 'Miami', lat: 25.7617, lon: -80.1918, timeZone: 'America/New_York', defaultIcon: '🌴' },
  { id: 'hermosillo', name: 'Hermosillo', lat: 29.0730, lon: -110.9559, timeZone: 'America/Hermosillo', defaultIcon: '🌵' }
];

function updateWeatherClockWidgets(){
  const now = new Date();
  weatherLocations.forEach(city => {
    const timeEl = document.getElementById(`${city.id}Time`);
    if(timeEl){
      const timeText = new Intl.DateTimeFormat('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
        timeZone: city.timeZone
      }).format(now);
      timeEl.textContent = timeText;
    }
  });
}

function weatherCodeToIcon(code){
  if(code === 0) return '☀️';
  if(code <= 3) return '⛅';
  if(code <= 48) return '☁️';
  if(code <= 67) return '🌦️';
  if(code <= 77) return '🌨️';
  if(code <= 82) return '🌧️';
  if(code <= 99) return '⛈️';
  return '🌤️';
}

async function loadWeatherForCity(city){
  const iconEl = document.getElementById(`${city.id}WeatherIcon`);
  const conditionEl = document.getElementById(`${city.id}WeatherCondition`);
  if(!iconEl || !conditionEl) return;
  const controller = new AbortController();
  const timeoutId = setTimeout(()=>controller.abort(), 10000);
  try{
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${city.lat}&longitude=${city.lon}&current=temperature_2m,weathercode&timezone=${encodeURIComponent(city.timeZone)}&forecast_days=1`;
    const res = await fetch(url, { cache: 'no-store', signal: controller.signal });
    if(!res.ok) throw new Error('Weather request failed');
    const data = await res.json();
    const current = data.current || {};
    const temperature = Number(current.temperature_2m);
    const weatherCode = Number(current.weathercode);
    iconEl.textContent = weatherCodeToIcon(weatherCode);
    conditionEl.textContent = Number.isFinite(temperature) ? `${Math.round(temperature)}°C` : 'N/A';
  }catch(e){
    iconEl.textContent = city.defaultIcon;
    conditionEl.textContent = 'N/A';
  }finally{
    clearTimeout(timeoutId);
  }
}

function initWeatherWidgets(){
  weatherLocations.forEach(city => {
    const iconEl = document.getElementById(`${city.id}WeatherIcon`);
    const conditionEl = document.getElementById(`${city.id}WeatherCondition`);
    if(iconEl) iconEl.textContent = city.defaultIcon;
    if(conditionEl) conditionEl.textContent = 'Loading…';
    loadWeatherForCity(city);
  });
  updateWeatherClockWidgets();
  setInterval(updateWeatherClockWidgets, 1000);
  setInterval(() => {
    weatherLocations.forEach(city => loadWeatherForCity(city));
  }, 600000);
}

// --- Tabs ---
document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p=>p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(btn.dataset.tab).classList.add('active');
    // When switching to Overview, ensure the currently selected sub-section renders
    if(btn.dataset.tab === 'overview'){
      try{
        const sec = (state.meta && state.meta.overviewSection) ? state.meta.overviewSection : 'generalOverview';
        if(typeof showOverviewSection === 'function') showOverviewSection(sec);
      }catch(e){ renderOverview(); }
    } else {
      renderOverview();
    }
  });
});

// --- Authentication / Login Gate ---
const SESSION_KEY = 'agi_session';
function isAuthenticated(){
  try{ const s = sessionStorage.getItem(SESSION_KEY); return !!s; }catch(e){ return false; }
}

function showApp(yes){
  const root = qs('#appRoot'); const gate = qs('#loginGate'); const logoutBtn = qs('#logoutBtn');
  const reloadBtn = qs('#reloadDataBtn');
  // ensure CSS variable for header height is set so the login overlay doesn't overlap the header
  setHeaderHeightVar();
  // If true, we don't immediately show the application: first present the AGI Process Menu
  const menu = qs('#agiProcessMenu');
  if(yes){ if(menu) menu.style.display = 'flex'; if(root) root.style.display='none'; if(gate) gate.style.display='none'; if(logoutBtn) logoutBtn.style.display='inline-block'; if(reloadBtn) reloadBtn.style.display='inline-block'; applyRoleRestrictions(); }
  else {
    // show login gate
    if(root) root.style.display='none'; if(gate) gate.style.display='flex'; if(menu) menu.style.display = 'none'; if(logoutBtn) logoutBtn.style.display='none'; if(reloadBtn) reloadBtn.style.display='none';
    updateExportImportVisibility();
    // ensure header title is default when showing login
    updateHeaderTitleForMenu(false);
    // disable brand link while on login page so it cannot open the process menu
    try{ const bl = qs('#brandLink'); if(bl){ bl.classList.add('disabled-brand'); bl.setAttribute('aria-disabled','true'); bl.tabIndex = -1; } }catch(e){}
    return;
  }

  // update header title according to menu visibility
  const menuVisible = !!menu && menu.style.display !== 'none';
  updateHeaderTitleForMenu(menuVisible);
  updateExportImportVisibility();
  if(!menuVisible) applyRoleRestrictions();
  // ensure brandLink is enabled when leaving login
  try{ const bl = qs('#brandLink'); if(bl){ bl.classList.remove('disabled-brand'); bl.removeAttribute('aria-disabled'); bl.tabIndex = 0; } }catch(e){}
}

function updateExportImportVisibility(){ /* buttons now live in Developer tab — no header toggling needed */ }

// --- Update user info display below header title ---
function updateUserInfoDisplay(){
  const userInfoEl = qs('#userInfo');
  if(!userInfoEl) return;
  
  const session = currentSession();
  if(!session){
    userInfoEl.style.display = 'none';
    return;
  }
  
  // Check if we're on the main menu
  const menu = qs('#agiProcessMenu');
  const menuVisible = menu && menu.style.display !== 'none';
  
  // Hide user info on main menu
  if(menuVisible){
    userInfoEl.style.display = 'none';
    return;
  }
  
  const info = getCurrentUserInfo();
  if(!info){
    userInfoEl.style.display = 'none';
    return;
  }
  
  const fullName = (info.firstName || info.username) + (info.lastName ? ' ' + info.lastName : '');
  const role = info.role || 'User';
  userInfoEl.textContent = `${fullName} - ${role}`;
  userInfoEl.style.display = 'block';
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
  if (menuVisible) {
    const info = getCurrentUserInfo();
    if (info) {
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
      showApp(true);
      updateHeaderTitleForMenu(true);
      updateExportImportVisibility(true);
      updateUserInfoDisplay();
      loadStateFromDB();
      return;
    }
    // check users in state — fetch fresh from Google Sheets to validate credentials
    const tryLogin = async () => {
      try {
        showLoadingOverlay('Signing in...');
        const users = await DB.get({ action: 'getAll', sheet: 'users' });
        hideLoadingOverlay();
        const u = (users||[]).find(x=> x.username === username && x.password === password);
        if(u){
          sessionStorage.setItem(SESSION_KEY, JSON.stringify({user: u.username}));
          showApp(true);
          updateExportImportVisibility(true);
          updateUserInfoDisplay();
          loadStateFromDB();
          return;
        }
        alert('Invalid credentials');
      } catch(e) {
        hideLoadingOverlay();
        alert('Login error: ' + e.message);
      }
    };
    tryLogin();
  });
}

// logout
const logoutBtnEl = qs('#logoutBtn');
if(logoutBtnEl){ logoutBtnEl.addEventListener('click', ()=>{ sessionStorage.removeItem(SESSION_KEY); window.location.reload(); }); }

const reloadDataBtn = qs('#reloadDataBtn'); if(reloadDataBtn){ reloadDataBtn.addEventListener('click', ()=>{ loadStateFromDB(); }); }

// On load decide whether to show the app
document.addEventListener('DOMContentLoaded', ()=>{ showApp(isAuthenticated()); if(isAuthenticated()) updateUserInfoDisplay(); initWeatherWidgets(); });

// --- AGI Process Menu wiring ---
const procMenu = qs('#agiProcessMenu');
const procVehicleBtn = qs('#procVehicleLease');
const procManagementBtn = qs('#procManagement');
const brandLink = qs('#brandLink');

if(procVehicleBtn){ procVehicleBtn.addEventListener('click', ()=>{ // open Vehicle Leasing Management (existing appRoot)
  const root = qs('#appRoot'); if(root) root.style.display = 'block'; if(procMenu) procMenu.style.display = 'none';
  updateHeaderTitleForMenu(false); updateExportImportVisibility(false); updateUserInfoDisplay();
  // Switch to Overview tab (Unit Overview)
  const overviewTab = Array.from(document.querySelectorAll('.tab')).find(t=>t.dataset.tab==='overview'); 
  if(overviewTab) overviewTab.click();
  // Load fresh data from Google Sheets
  loadStateFromDB();
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
  // hide user info on main menu
  updateUserInfoDisplay();
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
  // Required field validation: block submission if information is missing
  try{
    const wd = (fd.get('invoiceWD') || '').toString().trim();
    const doc = (fd.get('invoiceDoc') || '').toString().trim();
    const selectedLeases = getSelectedInvoiceLeases();
    const category = (fd.get('invoiceCategory') || '').toString().trim();
    const supplier = ((qs('#invoiceSupplier') && qs('#invoiceSupplier').value) || fd.get('invoiceSupplier') || '').toString().trim();
    const company = ((qs('#invoiceCompany') && qs('#invoiceCompany').value) || fd.get('invoiceCompany') || '').toString().trim();
    const arrangement = ((qs('#invoiceArrangement') && qs('#invoiceArrangement').value) || fd.get('invoiceArrangement') || '').toString().trim();
    const invoicing = ((qs('#invoiceInvoicing') && qs('#invoiceInvoicing').value) || fd.get('invoiceInvoicing') || '').toString().trim();
    const amountStr = (fd.get('invoiceAmount') || '').toString().trim();
    const amountNum = parseCurrency(amountStr);
    const pStart = (fd.get('invoicePeriodStart') || '').toString().trim();
    const pEnd = (fd.get('invoicePeriodEnd') || '').toString().trim();
    const submitted = (fd.get('invoiceSubmitted') || '').toString().trim();

    // Units selection (support multiple selection via getAll)
    let selectedUnits = [];
    if(typeof fd.getAll === 'function'){
      selectedUnits = fd.getAll('invoiceUnit').map(s=> (s||'').toString().trim()).filter(Boolean);
    }
    if(selectedUnits.length === 0){
      const single = (fd.get('invoiceUnit') || '').toString();
      selectedUnits = single.split(/[;,]+/).map(s=> s.trim()).filter(Boolean);
    }

    const missing = [];
    if(!wd) missing.push('WD Invoice Number');
    if(!doc) missing.push('Doc Invoice Number');
    if(selectedLeases.length === 0) missing.push('Lease');
    if(!category) missing.push('Category');
    if(!company) missing.push('Company');
    if(!supplier) missing.push('Supplier');
    if(!arrangement) missing.push('Arrangement');
    if(!invoicing) missing.push('Invoicing');
    // Amount validation: allow negative only for Credit category, require positive otherwise
    const isCreditCategory = (category || '').toString().trim().toLowerCase() === 'credit';
    if(amountNum === null || Number.isNaN(Number(amountNum))) {
      missing.push('Amount');
    } else {
      const amt = Number(amountNum);
      if(isCreditCategory) {
        if(amt >= 0) missing.push('Amount');
      } else {
        if(amt <= 0) missing.push('Amount');
      }
    }
    if(!pStart) missing.push('Period From');
    if(!pEnd) missing.push('Period To');
    if(!submitted) missing.push('Submitted Date');
    if(selectedUnits.length === 0) missing.push('Units');

    // Validate period order if both provided
    if(pStart && pEnd){
      const ps = new Date(pStart);
      const pe = new Date(pEnd);
      if(!isNaN(ps) && !isNaN(pe) && pe < ps){
        alert('Invalid period: "To" date must be after or equal to "From" date.');
        return;
      }
    }

    if(missing.length){
      alert('Please complete the following before submitting:\n- ' + missing.join('\n- '));
      return;
    }
  }catch(err){ alert('Validation error: ' + err.message); return; }
  // The per-unit Charge + Tax breakdown must add up to the declared invoice Amount.
  try{
    if(typeof renderInvoiceUnitBreakdown === 'function') renderInvoiceUnitBreakdown();
    if(!unitBreakdownMatches('invoiceUnitBreakdown')){
      alert('The sum of Charge Amount + Tax Amount for the selected units must equal the declared invoice Amount before submitting.');
      return;
    }
  }catch(err){ alert('Validation error: ' + err.message); return; }
  // New rule: only block submission when an existing invoice has the same
  // Lease, Category, Unit and WD Invoice number. If any of those differs,
  // allow the registration. Editing the same invoice is allowed.
  try{
    // Use FormData.getAll when available to detect multiple selected units
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
      const unitLeaseVal = (resolveInvoiceUnitLeaseInfo(unitVal, getSelectedInvoiceLeases()).lease || '').toString().trim().toLowerCase();
      const clash = (state.invoices || []).find(inv => {
        if(inv.id === (editingId || '')) return false; // ignore self when editing
        const aLease = (inv.lease || '').toString().trim().toLowerCase();
        const aCat = (inv.category || '').toString().trim().toLowerCase();
        const aUnit = (inv.unit || '').toString().trim().toLowerCase();
        const aWd = (inv.wdNumber || '').toString().trim().toLowerCase();
        return aLease === unitLeaseVal && aCat === catVal.toLowerCase() && aUnit === unitVal.toLowerCase() && aWd === wdVal.toLowerCase();
      });
      if(clash){ alert('An invoice with the same Lease, Category, Unit and WD Invoice number already exists. Submission blocked.'); return; }
    }
    // If creating multiple units, we'll handle uniqueness per-unit below (do not block whole submission here)
  }catch(err){ /* on unexpected error, let submission proceed */ }
  // Build a base invoice object (unit will be replaced per-unit if multiple units provided).
  // lease/supplier/company/arrangement/invoicing are resolved per-unit below since a WD
  // invoice can now span multiple leases; these readonly fields may show "(multiple)".
  const baseInvoice = {
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

    const resolvedInfo = resolveInvoiceUnitLeaseInfo(unitVal, getSelectedInvoiceLeases());
    const editRowData = getInvoiceBreakdownRowsData()[unitVal] || {};
    const editCharge = (function(){ const n = parseCurrency(editRowData.charge||''); return n===null ? '' : n.toFixed(2); })();
    const editTax = (function(){ const n = parseCurrency(editRowData.tax||''); return n===null ? '' : n.toFixed(2); })();
    const invoiceObj = Object.assign({}, baseInvoice, resolvedInfo, { id: editingId, unit: unitVal, amount: editCharge, taxAmount: editTax });
    state.invoices = state.invoices.map(inv => inv.id === editingId ? Object.assign({}, inv, invoiceObj, {id: editingId}) : inv);
    // If there is a registry for this WD/Doc pair, recompute its leases from the leases
    // now used by its member units (a registry can span multiple leases)
    try{
      const targetWd = (invoiceObj.wdNumber || '').toString().trim();
      const targetDoc = (invoiceObj.docNumber || '').toString().trim();
      const regIdx = (state.registries||[]).findIndex(r => (r.wdNumber||'').toString().trim() === targetWd && (r.docNumber||'').toString().trim() === targetDoc);
      if(regIdx !== -1){
        const regUnits = Array.isArray(state.registries[regIdx].units) ? state.registries[regIdx].units : [];
        const leasesSet = new Set();
        regUnits.forEach(uid => {
          const memberInv = (state.invoices||[]).find(i => (i.unit||'').toString().trim().toLowerCase() === (uid||'').toString().trim().toLowerCase() && (i.wdNumber||'').toString().trim() === targetWd);
          const leaseVal = memberInv ? (memberInv.lease||'') : '';
          if(leaseVal) leasesSet.add(leaseVal);
        });
        const leasesArr = Array.from(leasesSet);
        state.registries[regIdx].leases = leasesArr;
        state.registries[regIdx].lease = leasesArr.join(', ');

        // Keep the registry's stored per-unit detail (its durable record) in sync with this edit
        const details = Array.isArray(state.registries[regIdx].unitDetails) ? state.registries[regIdx].unitDetails.slice() : [];
        const unitRecForDetail = (state.units||[]).find(u => (u.unitId||u.id||'').toString().trim() === unitVal.toString().trim());
        const detailIdx = details.findIndex(d => (d.unit||'').toString().trim().toLowerCase() === unitVal.toString().trim().toLowerCase());
        const newDetail = {
          unit: unitVal,
          lease: resolvedInfo.lease || '',
          company: resolvedInfo.company || '',
          supplier: resolvedInfo.supplier || '',
          arrangement: resolvedInfo.arrangement || '',
          invoicing: resolvedInfo.invoicing || '',
          costCenter: unitRecForDetail ? (unitRecForDetail.costCenter||'') : '',
          tax: editTax,
          charge: editCharge
        };
        if(detailIdx !== -1) details[detailIdx] = newDetail; else details.push(newDetail);
        state.registries[regIdx].unitDetails = details;
        DB.updateRegistry(state.registries[regIdx]).catch(e => console.error('Registry sync error:', e));
      }
    }catch(e){}
    saveState(); renderInvoices(); renderRegistries();
    renderUnitOverview(); renderLeaseOverview(); renderOverview();
    form.reset(); delete form.dataset.editing;
    const submitBtn = form.querySelector('button[type="submit"]'); if(submitBtn) submitBtn.textContent = 'Add Invoice';
    const invCancel = qs('#invoiceCancelBtn'); if(invCancel) invCancel.style.display = 'none';
    const sub = qs('#invoiceSubmitted'); if(sub) sub.value = new Date().toISOString().slice(0,10);
    
    // Reset unit selection toggle button
    const unitToggle = qs('#invoiceUnitToggle');
    if(unitToggle) unitToggle.textContent = 'Select units';

    // Reset lease selection toggle button
    const leaseToggle = qs('#invoiceLeaseToggle');
    if(leaseToggle) leaseToggle.textContent = 'Select leases';

    // Reset the per-unit Charge/Tax breakdown table back to its empty default row
    if(typeof renderInvoiceUnitBreakdown === 'function') renderInvoiceUnitBreakdown();

    // Reset comment button
    const commentHiddenInput = qs('#invoiceComment');
    if(commentHiddenInput) commentHiddenInput.value = '';
    const commentBtn = qs('#invoiceCommentBtn');
    if(commentBtn){
      commentBtn.textContent = 'Add Comment';
      commentBtn.title = '';
      try{ commentBtn.classList.remove('btn-warning'); commentBtn.classList.add('btn-primary'); }catch(e){}
    }
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

  const selectedLeases = getSelectedInvoiceLeases();
  const skipped = [];
  const createdIds = [];
  const createdUnits = [];
  const createdLeases = [];
  const createdUnitDetails = [];
  // Per-unit Charge/Tax amounts come from the breakdown table (already validated above
  // to sum to the declared invoice Amount) rather than an automatic even split.
  const breakdownData = getInvoiceBreakdownRowsData();

  units.forEach((uVal, ui) => {
      // each unit carries its own lease (a WD invoice can now span multiple leases),
      // so resolve lease/company/supplier/arrangement/invoicing from the unit's own record
      const resolved = resolveInvoiceUnitLeaseInfo(uVal, selectedLeases);
      // uniqueness check per unit - only block if the invoice exists AND belongs to an active registry
      const clash = (state.invoices || []).find(inv => {
        const aLease = (inv.lease||'').toString().trim().toLowerCase();
        const aCat = (inv.category||'').toString().trim().toLowerCase();
        const aUnit = (inv.unit||'').toString().trim().toLowerCase();
        const aWd = (inv.wdNumber||'').toString().trim().toLowerCase();
        const matches = aLease === (resolved.lease||'').toString().trim().toLowerCase()
          && aCat === (baseInvoice.category||'').toString().trim().toLowerCase()
          && aUnit === uVal.toString().trim().toLowerCase()
          && aWd === (baseInvoice.wdNumber||'').toString().trim().toLowerCase();

        if(!matches) return false;

        // Check if this invoice belongs to an active registry
        const belongsToRegistry = (state.registries || []).some(reg => {
          const regWd = (reg.wdNumber || '').toString().trim().toLowerCase();
          const regUnits = Array.isArray(reg.units) ? reg.units.map(u => (u||'').toString().trim().toLowerCase()) : [];
          return regWd === aWd && regUnits.includes(aUnit);
        });

        return belongsToRegistry;
      });
  if(clash){ skipped.push(uVal); return; }
      // pull this unit's Charge/Tax amounts from the breakdown table
      const rowData = breakdownData[uVal] || {};
      const chargeAmount = (function(){ const n = parseCurrency(rowData.charge||''); return n===null ? '' : n.toFixed(2); })();
      const taxAmount = (function(){ const n = parseCurrency(rowData.tax||''); return n===null ? '' : n.toFixed(2); })();
      const newInv = Object.assign({}, baseInvoice, resolved, { id: id(), unit: uVal, amount: chargeAmount, taxAmount: taxAmount });
      state.invoices.push(newInv); createdIds.push(newInv.id); createdUnits.push(uVal);
      if(resolved.lease) createdLeases.push(resolved.lease);
      // Registries don't round-trip through state.invoices (invoices aren't persisted), so
      // capture the full per-unit detail on the registry itself for durable display/editing.
      const unitRecForDetail = (state.units||[]).find(u => (u.unitId||u.id||'').toString().trim() === uVal.toString().trim());
      createdUnitDetails.push({
        unit: uVal,
        lease: resolved.lease || '',
        company: resolved.company || '',
        supplier: resolved.supplier || '',
        arrangement: resolved.arrangement || '',
        invoicing: resolved.invoicing || '',
        costCenter: unitRecForDetail ? (unitRecForDetail.costCenter||'') : '',
        tax: taxAmount,
        charge: chargeAmount
      });
    });

    // If any invoices were created for this WD submission, record a registry entry
    if(createdIds.length > 0){
      state.meta = state.meta || {};
      state.meta.registrySeq = (state.meta.registrySeq || 0) + 1;
      
      // Prepare comments array with invoice comment if provided
      const comments = [];
      const invoiceComment = (baseInvoice.comment || '').toString().trim();
      if(invoiceComment){
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
        comments.push({
          text: invoiceComment,
          user: userName,
          timestamp: new Date().toISOString()
        });
      }
      
      const uniqueLeases = Array.from(new Set(createdLeases.filter(Boolean)));
      const registry = {
        id: id(),
        seq: state.meta.registrySeq,
        wdNumber: baseInvoice.wdNumber || '',
        docNumber: baseInvoice.docNumber || '',
        category: baseInvoice.category || '',
        totalAmount: baseInvoice.amount || '',
        unitCount: createdIds.length,
        units: createdUnits.slice(),
        periodStart: baseInvoice.periodStart || '',
        periodEnd: baseInvoice.periodEnd || '',
        submittedDate: baseInvoice.submittedDate || (new Date().toISOString().slice(0,10)),
        createdAt: new Date().toISOString(),
        comments: comments,
        leases: uniqueLeases,
        lease: uniqueLeases.join(', '),
        unitDetails: createdUnitDetails.slice()
      };
      state.registries = state.registries || [];
      state.registries.push(registry);

      // Save registry directly to Google Sheets
      DB.saveRegistry(registry).catch(e => console.error('Registry save error:', e));

      // Save the registry ID to keep it expanded after rendering
      window.__newlyCreatedRegistryId = registry.id;
    }

    saveState(); renderInvoices(); 
    // Keep the newly created registry expanded
    if(window.__newlyCreatedRegistryId){
      renderRegistries(window.__newlyCreatedRegistryId);
      delete window.__newlyCreatedRegistryId;
    } else {
      renderRegistries();
    }
    renderUnitOverview(); renderLeaseOverview(); renderOverview();
    form.reset(); const submitBtn = form.querySelector('button[type="submit"]'); if(submitBtn) submitBtn.textContent = 'Add Invoice';
    const invCancel = qs('#invoiceCancelBtn'); if(invCancel) invCancel.style.display = 'none';
    const sub = qs('#invoiceSubmitted'); if(sub) sub.value = new Date().toISOString().slice(0,10);
    
    // Reset unit selection toggle button
    const unitToggle = qs('#invoiceUnitToggle');
    if(unitToggle) unitToggle.textContent = 'Select units';

    // Reset lease selection toggle button
    const leaseToggle = qs('#invoiceLeaseToggle');
    if(leaseToggle) leaseToggle.textContent = 'Select leases';

    // Reset the per-unit Charge/Tax breakdown table back to its empty default row
    if(typeof renderInvoiceUnitBreakdown === 'function') renderInvoiceUnitBreakdown();

    // Reset comment button
    const commentHiddenInput = qs('#invoiceComment');
    if(commentHiddenInput) commentHiddenInput.value = '';
    const commentBtn = qs('#invoiceCommentBtn');
    if(commentBtn){
      commentBtn.textContent = 'Add Comment';
      commentBtn.title = '';
      try{ commentBtn.classList.remove('btn-warning'); commentBtn.classList.add('btn-primary'); }catch(e){}
    }

    if(skipped.length && createdIds.length){ alert('Some units were skipped because a matching registry already exists: ' + skipped.join(', ')); }
    else if(skipped.length && createdIds.length===0){ alert('No invoices were created — all provided units already have an invoice with the same Lease, Category and WD number.'); }
  }

});

// Prevent submitting invoice via Enter key on inputs; only allow button click
const invFormEl = qs('#invoiceForm');
if(invFormEl){
  invFormEl.addEventListener('keydown', (e)=>{
    if(e.key === 'Enter'){
      const target = e.target;
      const isSubmitBtn = target && target.tagName === 'BUTTON' && (target.type || '').toLowerCase() === 'submit';
      if(!isSubmitBtn){
        e.preventDefault();
        e.stopPropagation();
      }
    }
  });
}

// sync invoice selects
// Multi-select lease picker: a single WD invoice can cover units across several leases.
function getSelectedInvoiceLeases(){
  const panel = qs('#invoiceLeasePanel'); if(!panel) return [];
  return Array.from(panel.querySelectorAll('input[type="checkbox"][name="invoiceLease"]:checked')).map(cb => cb.value);
}

// Resolve the lease (and that lease's company/supplier/arrangement/invoicing) that a given
// unit actually belongs to. Each invoice mirrors its own unit's lease rather than a single
// shared value, since the units picked for one WD invoice may now come from different leases.
function resolveInvoiceUnitLeaseInfo(unitVal, fallbackLeases){
  const unitRec = (state.units||[]).find(u => (u.unitId||u.id||'').toString().trim().toLowerCase() === (unitVal||'').toString().trim().toLowerCase());
  const leaseVal = unitRec ? (unitRec.lease || '') : ((Array.isArray(fallbackLeases) && fallbackLeases[0]) || '');
  const leaseRec = (state.leases||[]).find(l => (l.leaseNumber === leaseVal) || (l.id === leaseVal));
  return {
    lease: leaseVal,
    company: leaseRec ? (leaseRec.company||'') : '',
    supplier: leaseRec ? (leaseRec.supplier||'') : '',
    arrangement: leaseRec ? (leaseRec.arrangement||'') : '',
    invoicing: leaseRec ? (leaseRec.invoicing||'') : ''
  };
}

// Recompute the readonly Supplier/Company/Arrangement/Invoicing fields and the unit picker
// whenever the selected lease set changes. When selected leases disagree on a value, show
// "(multiple)" instead of guessing.
function onInvoiceLeaseSelectionChange(){
  const selected = getSelectedInvoiceLeases();
  const c = qs('#invoiceCompany'); const a = qs('#invoiceArrangement'); const s = qs('#invoiceSupplier'); const inv = qs('#invoiceInvoicing');
  if(selected.length === 0){
    if(c) c.value=''; if(a) a.value=''; if(s) s.value=''; if(inv) inv.value='';
    if(typeof syncInvoiceUnitOptions === 'function') syncInvoiceUnitOptions([]);
    return;
  }
  const matchedLeases = selected.map(val => (state.leases||[]).find(l => (l.leaseNumber === val) || (l.id === val))).filter(Boolean);
  function distinctOrMultiple(getter){
    const distinct = Array.from(new Set(matchedLeases.map(getter).map(v => (v||'').toString()).filter(v => v !== '')));
    if(distinct.length === 0) return '';
    if(distinct.length === 1) return distinct[0];
    return '(multiple)';
  }
  if(c) c.value = distinctOrMultiple(l => l.company);
  if(s) s.value = distinctOrMultiple(l => l.supplier);
  if(a) a.value = distinctOrMultiple(l => l.arrangement);
  if(inv) inv.value = distinctOrMultiple(l => l.invoicing);
  if(typeof syncInvoiceUnitOptions === 'function') syncInvoiceUnitOptions(selected);
  // ensure the Submitted date is prefilled to today's date (predetermined actual date)
  const sub = qs('#invoiceSubmitted'); if(sub) sub.value = new Date().toISOString().slice(0,10);
}

function syncInvoiceLeaseOptions(selectedValues){
  selectedValues = Array.isArray(selectedValues) ? selectedValues.map(s=>String(s)) : (selectedValues ? [String(selectedValues)] : getSelectedInvoiceLeases());
  const panel = qs('#invoiceLeasePanel'); const toggle = qs('#invoiceLeaseToggle');
  if(!panel) return;

  const leases = (state.leases || []).filter(l => {
    const status = (l.status || 'Enabled').toString().toLowerCase();
    return status !== 'disabled';
  });

  panel.innerHTML = '';
  if(leases.length === 0){ const none = document.createElement('div'); none.className = 'small-muted'; none.textContent = '(no leases available)'; panel.appendChild(none); if(toggle) toggle.textContent = 'Select leases'; return; }

  // Add search box
  const searchContainer = document.createElement('div'); searchContainer.style.padding = '8px'; searchContainer.style.borderBottom = '1px solid #e6e6e6';
  const searchBox = document.createElement('input'); searchBox.type = 'text'; searchBox.placeholder = 'Search leases...'; searchBox.id = 'invoiceLeaseSearch';
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
  const checkboxContainer = document.createElement('div'); checkboxContainer.id = 'invoiceLeaseCheckboxContainer';
  panel.appendChild(checkboxContainer);

  leases.forEach(l => {
    const val = (l.leaseNumber || l.id || '').toString();
    const row = document.createElement('div'); row.style.display = 'flex'; row.style.alignItems = 'center'; row.style.gap = '8px'; row.style.padding = '6px 4px';
    row.className = 'lease-checkbox-row';
    row.setAttribute('data-lease-id', val.toLowerCase());
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.name = 'invoiceLease'; cb.value = val; cb.id = 'invoiceLease_cb_' + val.replace(/[^a-z0-9_-]/gi,'_');
    if(selectedValues.length && selectedValues.indexOf(val) !== -1) cb.checked = true;
    const lab = document.createElement('label'); lab.htmlFor = cb.id; lab.style.flex = '1 1 auto';
    lab.textContent = val;
    cb.addEventListener('change', ()=>{ updateInvoiceLeaseToggleLabel(); onInvoiceLeaseSelectionChange(); });
    row.appendChild(cb); row.appendChild(lab); checkboxContainer.appendChild(row);
  });

  // Add search functionality
  searchBox.addEventListener('input', () => {
    const searchTerm = searchBox.value.toLowerCase().trim();
    const rows = checkboxContainer.querySelectorAll('.lease-checkbox-row');
    rows.forEach(row => {
      const leaseId = row.getAttribute('data-lease-id') || '';
      row.style.display = (searchTerm === '' || leaseId.includes(searchTerm)) ? 'flex' : 'none';
    });
  });

  // wiring for Select all / Clear
  btnAll.addEventListener('click', ()=>{
    checkboxContainer.querySelectorAll('.lease-checkbox-row').forEach(row => {
      if(row.style.display !== 'none'){
        const cb = row.querySelector('input[type="checkbox"][name="invoiceLease"]');
        if(cb) cb.checked = true;
      }
    });
    updateInvoiceLeaseToggleLabel(); onInvoiceLeaseSelectionChange();
  });
  btnClear.addEventListener('click', ()=>{
    panel.querySelectorAll('input[type="checkbox"][name="invoiceLease"]').forEach(i=> i.checked = false);
    updateInvoiceLeaseToggleLabel(); onInvoiceLeaseSelectionChange();
  });

  function updateInvoiceLeaseToggleLabel(){
    const tbtn = qs('#invoiceLeaseToggle'); if(!tbtn) return;
    const checked = panel.querySelectorAll('input[type="checkbox"][name="invoiceLease"]:checked').length;
    if(checked === 0) tbtn.textContent = 'Select leases';
    else if(checked === 1) tbtn.textContent = panel.querySelector('input[type="checkbox"][name="invoiceLease"]:checked').value;
    else tbtn.textContent = checked + ' leases selected';
  }

  updateInvoiceLeaseToggleLabel();

  if(toggle){
    try{ toggle.setAttribute('aria-expanded','false'); }catch(e){}
    const nt = toggle.cloneNode(true);
    toggle.parentNode.replaceChild(nt, toggle);
    nt.addEventListener('click', ()=>{
      const isOpen = panel.style.display !== 'none';
      panel.style.display = isOpen ? 'none' : 'block';
      nt.setAttribute('aria-expanded', String(!isOpen));
    });

    if(!window.__agi_invoiceLease_dropdown_init){
      window.__agi_invoiceLease_dropdown_init = true;
      document.addEventListener('click', (ev)=>{
        const panelEl = qs('#invoiceLeasePanel'); const toggleEl = qs('#invoiceLeaseToggle');
        if(!panelEl || !toggleEl) return;
        const within = panelEl.contains(ev.target) || toggleEl.contains(ev.target);
        if(!within){ panelEl.style.display = 'none'; toggleEl.setAttribute('aria-expanded','false'); }
      });
      document.addEventListener('keydown', (ev)=>{ if(ev.key === 'Escape'){ const panelEl = qs('#invoiceLeasePanel'); const toggleEl = qs('#invoiceLeaseToggle'); if(panelEl){ panelEl.style.display = 'none'; if(toggleEl) toggleEl.setAttribute('aria-expanded','false'); } } });
    }
  }
}
function syncInvoiceCompanyOptions(){ const sel = qs('#invoiceCompany'); if(!sel) return; const cur = sel.value; sel.innerHTML = '<option value="">(select company)</option>'; (state.meta.devCompanies||[]).forEach(c=>{ const opt = document.createElement('option'); opt.value = c; opt.textContent = c; sel.appendChild(opt); }); if(cur) sel.value = cur; }
function syncInvoiceArrangementOptions(){ const sel = qs('#invoiceArrangement'); if(!sel) return; const cur = sel.value; sel.innerHTML = '<option value="">(select arrangement)</option>'; (state.meta.devPayments||[]).forEach(p=>{ const opt = document.createElement('option'); opt.value = p; opt.textContent = p; sel.appendChild(opt); }); if(cur) sel.value = cur; }
function syncInvoiceUnitOptions(leaseVal, selectedValues){
  // selectedValues: optional array of values to pre-check
  // leaseVal: optional lease number, or an array of lease numbers (union filter)
  selectedValues = Array.isArray(selectedValues) ? selectedValues.map(s=>String(s)) : [];
  const panel = qs('#invoiceUnitPanel'); const toggle = qs('#invoiceUnitToggle');
  const leaseFilter = Array.isArray(leaseVal) ? leaseVal.filter(Boolean) : (leaseVal ? [leaseVal] : []);
  const list = leaseFilter.length === 0 ? (state.units || []).slice() : (state.units || []).filter(u => leaseFilter.indexOf(u.lease) !== -1);

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

    // Sort: active units first, disabled units at the bottom
    const sortedList = list.slice().sort((a, b) => {
      const aDisabled = (a.status || '').toLowerCase() === 'disabled';
      const bDisabled = (b.status || '').toLowerCase() === 'disabled';
      if(aDisabled === bDisabled) return 0;
      return aDisabled ? 1 : -1;
    });

    sortedList.forEach(u => {
      const val = (u.unitId || u.id || '').toString();
      const isDisabled = (u.status || '').toLowerCase() === 'disabled';
      const row = document.createElement('div'); row.style.display = 'flex'; row.style.alignItems = 'center'; row.style.gap = '8px'; row.style.padding = '6px 4px';
      row.className = 'unit-checkbox-row';
      row.setAttribute('data-unit-id', val.toLowerCase());
      if(isDisabled){
        row.style.background = '#fee2e2';
        row.style.borderRadius = '4px';
      }
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.name = 'invoiceUnit'; cb.value = val; cb.id = 'invoiceUnit_cb_' + val.replace(/[^a-z0-9_-]/gi,'_');
      if(selectedValues.length && selectedValues.indexOf(val) !== -1) cb.checked = true;
      const lab = document.createElement('label'); lab.htmlFor = cb.id; lab.style.flex = '1 1 auto';
      lab.textContent = val + (isDisabled ? ' (Disabled)' : '');
      if(isDisabled) lab.style.color = '#b91c1c';
      cb.addEventListener('change', ()=>{ updateInvoiceUnitToggleLabel(); refreshInvoiceBreakdownIfVisible(); });
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

    // Add Units button at the bottom: confirms the checked units and renders/refreshes
    // the per-unit Charge/Tax breakdown table below the form.
    const addUnitsContainer = document.createElement('div'); addUnitsContainer.style.padding = '8px'; addUnitsContainer.style.borderTop = '1px solid #e6e6e6'; addUnitsContainer.style.display = 'flex'; addUnitsContainer.style.justifyContent = 'center';
    const addUnitsBtn = document.createElement('button'); addUnitsBtn.type = 'button'; addUnitsBtn.className = 'btn-primary'; addUnitsBtn.textContent = 'Add Units'; addUnitsBtn.style.width = '100%';
    addUnitsBtn.addEventListener('click', (e) => {
      e.stopPropagation(); // Prevent event bubbling
      // Close the dropdown first
      panel.style.display = 'none';
      if(toggle) toggle.setAttribute('aria-expanded', 'false');
      if(typeof renderInvoiceUnitBreakdown === 'function') renderInvoiceUnitBreakdown();
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
      refreshInvoiceBreakdownIfVisible();
    });
    btnClear.addEventListener('click', ()=>{
      panel.querySelectorAll('input[type="checkbox"][name="invoiceUnit"]').forEach(i=> i.checked = false);
      updateInvoiceUnitToggleLabel();
      refreshInvoiceBreakdownIfVisible();
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

function getSelectedInvoiceUnits(){
  const panel = qs('#invoiceUnitPanel'); if(!panel) return [];
  return Array.from(panel.querySelectorAll('input[type="checkbox"][name="invoiceUnit"]:checked')).map(cb => cb.value);
}

// --- Generic sortable Company/UnitId/Lease/Cost Center + Tax/Charge breakdown table ---
// Shared by the invoice creation form and the registry edit modal (each has its own
// container id and its own declared-Amount field to validate against). Sort state and the
// declared-amount field id are stashed as data-* attributes on the wrap element itself, so
// multiple independent tables can coexist without shared JS state.
const UNIT_BREAKDOWN_COLUMNS = [
  { key:'company', label:'Company', width:130, get: (u,uid) => u ? (u.company||'') : '' },
  { key:'unitId', label:'UnitId', width:100, get: (u,uid) => uid },
  { key:'lease', label:'Lease', width:100, get: (u,uid) => u ? (u.lease||'') : '' },
  { key:'costCenter', label:'Cost Center', width:110, get: (u,uid) => u ? (u.costCenter||'') : '' }
];

function getUnitBreakdownRowsData(wrapId){
  const data = {};
  const wrap = qs('#' + wrapId); if(!wrap) return data;
  wrap.querySelectorAll('.unit-breakdown-row').forEach(row => {
    const uid = row.dataset.unitId; if(!uid) return;
    const chargeInput = row.querySelector('.ub-charge');
    const taxInput = row.querySelector('.ub-tax');
    data[uid] = { charge: chargeInput ? chargeInput.value : '', tax: taxInput ? taxInput.value : '' };
  });
  return data;
}

// Build/refresh the breakdown table from `unitIds`. Already-entered Tax/Charge values are
// preserved for units that remain in the list; `seed` provides initial values for units not
// already in the table (e.g. populating from an existing invoice/registry for edit).
// opts.showEmptyRow: when true and unitIds is empty, render the header plus a single
// "(no units selected yet)" placeholder line instead of hiding the table entirely.
function renderUnitBreakdownTable(wrapId, unitIds, amountFieldId, seed, opts){
  const wrap = qs('#' + wrapId); if(!wrap) return;
  wrap.dataset.amountFieldId = amountFieldId || '';

  if(!unitIds || unitIds.length === 0){
    if(!(opts && opts.showEmptyRow)){
      wrap.style.display = 'none';
      wrap.innerHTML = '';
      return;
    }
    wrap.innerHTML = '';
    const header = document.createElement('div');
    header.style.cssText = 'display:flex;gap:8px;font-weight:600;font-size:12px;color:#374151;padding:4px 0;border-bottom:2px solid #e6e9ee;';
    UNIT_BREAKDOWN_COLUMNS.forEach(col => {
      const d = document.createElement('div'); d.textContent = col.label; d.style.cssText = `flex:0 0 ${col.width}px;`; header.appendChild(d);
    });
    [['Tax Amount',110],['Charge Amount',110]].forEach(([label,w]) => {
      const d = document.createElement('div'); d.textContent = label; d.style.cssText = `flex:0 0 ${w}px;`; header.appendChild(d);
    });
    wrap.appendChild(header);

    const emptyRow = document.createElement('div');
    emptyRow.style.cssText = 'display:flex;align-items:center;padding:8px 4px;color:#9ca3af;font-size:12px;font-style:italic;';
    emptyRow.textContent = '(no units selected yet)';
    wrap.appendChild(emptyRow);

    wrap.dataset.matches = 'false';
    wrap.style.display = 'block';
    return;
  }

  const existing = getUnitBreakdownRowsData(wrapId);
  const seedData = seed || {};

  let rows = unitIds.map(uid => ({
    uid,
    unitRec: (state.units||[]).find(u => (u.unitId||u.id||'').toString().trim() === uid.toString().trim())
  }));

  const sortCol = wrap.dataset.sortCol || '';
  const sortDir = wrap.dataset.sortDir || 'asc';
  if(sortCol){
    const col = UNIT_BREAKDOWN_COLUMNS.find(c => c.key === sortCol);
    if(col){
      rows.sort((a,b) => {
        const av = col.get(a.unitRec, a.uid).toString().toLowerCase();
        const bv = col.get(b.unitRec, b.uid).toString().toLowerCase();
        if(av < bv) return sortDir === 'asc' ? -1 : 1;
        if(av > bv) return sortDir === 'asc' ? 1 : -1;
        return 0;
      });
    }
  }

  wrap.innerHTML = '';
  const header = document.createElement('div');
  header.style.cssText = 'display:flex;gap:8px;font-weight:600;font-size:12px;color:#374151;padding:4px 0;border-bottom:2px solid #e6e9ee;';
  UNIT_BREAKDOWN_COLUMNS.forEach(col => {
    const d = document.createElement('div');
    d.textContent = col.label + (sortCol === col.key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '');
    d.style.cssText = `flex:0 0 ${col.width}px;cursor:pointer;user-select:none;`;
    d.title = 'Click to sort';
    d.addEventListener('click', ()=>{
      const newDir = (wrap.dataset.sortCol === col.key && wrap.dataset.sortDir === 'asc') ? 'desc' : 'asc';
      wrap.dataset.sortCol = col.key; wrap.dataset.sortDir = newDir;
      renderUnitBreakdownTable(wrapId, unitIds, amountFieldId, null);
    });
    header.appendChild(d);
  });
  [['Tax Amount',110],['Charge Amount',110]].forEach(([label,w]) => {
    const d = document.createElement('div'); d.textContent = label; d.style.cssText = `flex:0 0 ${w}px;`; header.appendChild(d);
  });
  wrap.appendChild(header);

  rows.forEach(({uid, unitRec}) => {
    const row = document.createElement('div'); row.className = 'unit-breakdown-row'; row.dataset.unitId = uid;
    row.style.cssText = 'display:flex;gap:8px;align-items:center;padding:4px 0;border-bottom:1px solid #f0f0f0;';

    const mkCell = (text, w) => { const d = document.createElement('div'); d.textContent = text; d.style.cssText = `flex:0 0 ${w}px;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;`; return d; };
    UNIT_BREAKDOWN_COLUMNS.forEach(col => row.appendChild(mkCell(col.get(unitRec, uid), col.width)));

    const taxInput = document.createElement('input'); taxInput.type = 'text'; taxInput.className = 'ub-tax money-input'; taxInput.placeholder = 'Tax'; taxInput.inputMode = 'decimal';
    taxInput.style.cssText = 'flex:0 0 110px;padding:4px 6px;border:1px solid #e6e9ee;border-radius:4px;';
    const chargeInput = document.createElement('input'); chargeInput.type = 'text'; chargeInput.className = 'ub-charge money-input'; chargeInput.placeholder = 'Charge'; chargeInput.inputMode = 'decimal';
    chargeInput.style.cssText = 'flex:0 0 110px;padding:4px 6px;border:1px solid #e6e9ee;border-radius:4px;';

    const prior = existing[uid] || seedData[uid] || {};
    if(prior.tax !== undefined) taxInput.value = prior.tax;
    if(prior.charge !== undefined) chargeInput.value = prior.charge;

    taxInput.addEventListener('input', ()=> updateUnitBreakdownTotal(wrapId));
    chargeInput.addEventListener('input', ()=> updateUnitBreakdownTotal(wrapId));

    row.appendChild(taxInput); row.appendChild(chargeInput);
    wrap.appendChild(row);
  });

  const totalRow = document.createElement('div');
  totalRow.className = 'unit-breakdown-total';
  totalRow.style.cssText = 'text-align:right;padding:8px 4px 2px;font-size:14px;font-weight:700;';
  wrap.appendChild(totalRow);

  wrap.style.display = 'block';
  updateUnitBreakdownTotal(wrapId);
}

// The running total is Charge Amount + Tax Amount summed across every unit row; it must equal
// the declared Amount field (red until it matches, green once it does).
function updateUnitBreakdownTotal(wrapId){
  const wrap = qs('#' + wrapId); if(!wrap) return;
  const totalEl = wrap.querySelector('.unit-breakdown-total'); if(!totalEl) return;
  let sum = 0;
  wrap.querySelectorAll('.unit-breakdown-row').forEach(row => {
    const chargeInput = row.querySelector('.ub-charge');
    const taxInput = row.querySelector('.ub-tax');
    sum += (parseCurrency(chargeInput ? chargeInput.value : '') || 0) + (parseCurrency(taxInput ? taxInput.value : '') || 0);
  });
  const amountFieldId = wrap.dataset.amountFieldId;
  const amountField = amountFieldId ? qs('#' + amountFieldId) : null;
  const declared = parseCurrency(amountField ? amountField.value : '');
  const matches = declared !== null && Math.round(sum*100) === Math.round(declared*100);
  totalEl.textContent = 'Total (Charge + Tax): ' + formatCurrency(sum.toFixed(2)) + (declared !== null ? ' / declared ' + formatCurrency(declared.toFixed(2)) : '');
  totalEl.style.color = matches ? '#15803d' : '#dc2626';
  wrap.dataset.matches = matches ? 'true' : 'false';
}

function unitBreakdownMatches(wrapId){
  const wrap = qs('#' + wrapId); if(!wrap) return false;
  return wrap.dataset.matches === 'true';
}

// --- Invoice-form-specific thin wrappers around the generic breakdown table ---
function getInvoiceBreakdownRowsData(){ return getUnitBreakdownRowsData('invoiceUnitBreakdown'); }
function refreshInvoiceBreakdownIfVisible(){
  const wrap = qs('#invoiceUnitBreakdown');
  if(wrap && wrap.style.display !== 'none') renderInvoiceUnitBreakdown();
}
function renderInvoiceUnitBreakdown(seed){
  renderUnitBreakdownTable('invoiceUnitBreakdown', getSelectedInvoiceUnits(), 'invoiceAmount', seed, { showEmptyRow: true });
}

// ensure invoice selects are updated when relevant lists change
if(typeof syncInvoiceLeaseOptions === 'function') syncInvoiceLeaseOptions();
if(typeof syncInvoiceCompanyOptions === 'function') syncInvoiceCompanyOptions();
if(typeof syncInvoiceArrangementOptions === 'function') syncInvoiceArrangementOptions();
if(typeof syncInvoiceUnitOptions === 'function') syncInvoiceUnitOptions();
if(typeof renderInvoiceUnitBreakdown === 'function') renderInvoiceUnitBreakdown();
const invAmountFieldInit = qs('#invoiceAmount');
if(invAmountFieldInit) invAmountFieldInit.addEventListener('input', ()=> updateUnitBreakdownTotal('invoiceUnitBreakdown'));

// Autofill of company/supplier/arrangement/invoicing and the unit picker on lease selection
// is wired directly into the lease checkbox panel via onInvoiceLeaseSelectionChange().

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
  const costCenterVal = (qs('#unitCostCenter') && qs('#unitCostCenter').value) || fd.get('unitCostCenter') || '';
  const supplierVal = (qs('#unitSupplier') && qs('#unitSupplier').value) || fd.get('unitSupplier') || '';
  const arrangementVal = (qs('#unitArrangement') && qs('#unitArrangement').value) || fd.get('unitArrangement') || '';
  const invoicingVal = (qs('#unitInvoicing') && qs('#unitInvoicing').value) || fd.get('unitInvoicing') || '';
  const unitObj = {
    id: editingId || id(),
    lease: fd.get('unitLease') || '',
    company: companyVal,
    costCenter: costCenterVal,
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
    const updatedUnit = state.units.find(u => u.id === editingId);
    if(updatedUnit) DB.updateUnit(updatedUnit).catch(e => console.error('Unit edit save error:', e));
  } else {
    state.units.push(unitObj);
    DB.saveUnit(unitObj).catch(e => console.error('Unit save error:', e));
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

// Money input behaviour, applied to every field with class "money-input": raw editable
// number on focus, formatted as $X,XXX.XX on blur. Delegated (capture phase, since focus/blur
// don't bubble) so it also covers inputs created dynamically later — breakdown table Tax/Charge
// cells, the registry Total Amount field, etc — not just the ones present at page load.
document.addEventListener('focus', (e)=>{
  const t = e.target;
  if(!t || !t.classList || !t.classList.contains('money-input')) return;
  const v = t.value; if(!v) return;
  const n = parseCurrency(v);
  if(n !== null) t.value = n.toFixed(2);
}, true);
document.addEventListener('blur', (e)=>{
  const t = e.target;
  if(!t || !t.classList || !t.classList.contains('money-input')) return;
  const v = t.value;
  const n = parseCurrency(v);
  if(n === null){ t.value = ''; return; }
  t.value = formatCurrency(n);
}, true);

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
    const updatedLease = state.leases.find(l => l.id === editingId);
    if(updatedLease) DB.updateLease(updatedLease).catch(e => console.error('Lease update error:', e));
  } else {
    state.leases.push(leaseObj);
    DB.saveLease(leaseObj).catch(e => console.error('Lease save error:', e));
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
    state.users = state.users.map(u => u.id === editingId ? Object.assign({}, u, userObj) : u);
    const updatedUser = state.users.find(u => u.id === editingId);
    if(updatedUser) DB.updateUser(updatedUser).catch(e => console.error('User update error:', e));
  } else {
    state.users.push(userObj);
    DB.saveUser(userObj).catch(e => console.error('User save error:', e));
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
      if(typeof syncInvoiceLeaseOptions === 'function') syncInvoiceLeaseOptions(inv.lease ? [inv.lease] : []);
      const s = qs('#invoiceSupplier'); if(s) s.value = inv.supplier || '';
      const c = qs('#invoiceCompany'); if(c) c.value = inv.company || '';
      const a = qs('#invoiceArrangement'); if(a) a.value = inv.arrangement || '';
      const invField = qs('#invoiceInvoicing'); if(invField) invField.value = inv.invoicing || '';
      const cat = form.querySelector('#invoiceCategory'); if(cat) cat.value = inv.category || '';
      if(typeof syncInvoiceUnitOptions === 'function') syncInvoiceUnitOptions(inv.lease, [inv.unit]);
      const wd = form.querySelector('#invoiceWD'); if(wd) wd.value = inv.wdNumber || '';
      const doc = form.querySelector('#invoiceDoc'); if(doc) doc.value = inv.docNumber || '';
      // Declared Amount now represents Charge + Tax for the selected unit(s)
      const amt = form.querySelector('#invoiceAmount');
      if(amt){ const chargeN = parseCurrency(inv.amount||'') || 0; const taxN = parseCurrency(inv.taxAmount||'') || 0; amt.value = (chargeN + taxN).toFixed(2); }
      if(typeof renderInvoiceUnitBreakdown === 'function') renderInvoiceUnitBreakdown({ [inv.unit]: { charge: inv.amount || '', tax: inv.taxAmount || '' } });
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
            DB.updateRegistry(inv).catch(e => console.error('Invoice comment save error:', e));
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




// Read-only sortable Company/UnitId/Lease/Cost Center/Tax/Charge detail table for a registry's
// expanded view, built from its stored unitDetails snapshot (captured at registration time so
// it survives reloads, since individual invoice records are not themselves persisted).
function renderRegistryUnitDetailTable(container, unitDetails){
  container.innerHTML = '';
  if(!Array.isArray(unitDetails) || unitDetails.length === 0) return false;

  const sortCol = container.dataset.sortCol || '';
  const sortDir = container.dataset.sortDir || 'asc';
  const columns = [
    { key:'company', label:'Company', width:130 },
    { key:'unit', label:'UnitId', width:100 },
    { key:'lease', label:'Lease', width:100 },
    { key:'costCenter', label:'Cost Center', width:110 },
    { key:'tax', label:'Tax Amount', width:110 },
    { key:'charge', label:'Charge Amount', width:110 }
  ];

  let rows = unitDetails.slice();
  if(sortCol){
    const isNumeric = sortCol === 'tax' || sortCol === 'charge';
    rows.sort((a,b) => {
      if(isNumeric){
        const av = parseFloat(a[sortCol]) || 0; const bv = parseFloat(b[sortCol]) || 0;
        return sortDir === 'asc' ? av - bv : bv - av;
      }
      const av = (a[sortCol]||'').toString().toLowerCase(); const bv = (b[sortCol]||'').toString().toLowerCase();
      if(av < bv) return sortDir === 'asc' ? -1 : 1;
      if(av > bv) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });
  }

  const header = document.createElement('div');
  header.style.cssText = 'display:flex;gap:8px;font-weight:600;font-size:12px;color:#374151;padding:4px 0;border-bottom:2px solid #e6e9ee;';
  columns.forEach(col => {
    const d = document.createElement('div');
    d.textContent = col.label + (sortCol === col.key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '');
    d.style.cssText = `flex:0 0 ${col.width}px;cursor:pointer;user-select:none;`;
    d.title = 'Click to sort';
    d.addEventListener('click', (e) => {
      e.stopPropagation();
      const newDir = (container.dataset.sortCol === col.key && container.dataset.sortDir === 'asc') ? 'desc' : 'asc';
      container.dataset.sortCol = col.key; container.dataset.sortDir = newDir;
      renderRegistryUnitDetailTable(container, unitDetails);
    });
    header.appendChild(d);
  });
  container.appendChild(header);

  let totalCharge = 0, totalTax = 0;
  rows.forEach(d => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;align-items:center;padding:4px 0;border-bottom:1px solid #f0f0f0;';
    const mkCell = (text, w) => { const c = document.createElement('div'); c.textContent = text; c.style.cssText = `flex:0 0 ${w}px;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;`; return c; };
    row.appendChild(mkCell(d.company||'', 130));
    row.appendChild(mkCell(d.unit||'', 100));
    row.appendChild(mkCell(d.lease||'', 100));
    row.appendChild(mkCell(d.costCenter||'', 110));
    row.appendChild(mkCell(formatCurrency(d.tax||'0'), 110));
    row.appendChild(mkCell(formatCurrency(d.charge||'0'), 110));
    container.appendChild(row);
    totalTax += parseFloat(d.tax)||0; totalCharge += parseFloat(d.charge)||0;
  });

  const totalRow = document.createElement('div');
  totalRow.style.cssText = 'text-align:right;padding:8px 4px 2px;font-size:13px;font-weight:700;color:#374151;';
  totalRow.textContent = 'Total (Charge + Tax): ' + formatCurrency((totalCharge+totalTax).toFixed(2));
  container.appendChild(totalRow);
  return true;
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
  
  // Registry menu panels (Edit/Delete) are appended to document.body so they can float over
  // everything; they must be cleaned up explicitly before each re-render or they accumulate
  // (and stay visible/stuck) across every renderRegistries() call.
  document.querySelectorAll('.menu-panel').forEach(el => el.remove());

  // One delegated listener (registered once) closes any open registry menu when clicking
  // elsewhere, instead of adding a new document-level listener per row on every render.
  if(!window.__agi_registryMenuOutsideClickInit){
    window.__agi_registryMenuOutsideClickInit = true;
    document.addEventListener('click', (e) => {
      if(e.target.closest('.menu-panel') || e.target.closest('.registry-menu-btn')) return;
      document.querySelectorAll('.menu-panel').forEach(p => p.style.display = 'none');
    });
  }

  // Wire the registry search bar (comma = OR, semicolon = AND — see parseSearchGroups)
  state.meta = state.meta || {};
  state.meta.registrySearch = state.meta.registrySearch || '';
  const registrySearchInput = qs('#registrySearchInput');
  const registrySearchBtn = qs('#registrySearchBtn');
  if(registrySearchInput && !registrySearchInput.dataset.wired){
    registrySearchInput.dataset.wired = 'true';
    registrySearchInput.value = state.meta.registrySearch;
    registrySearchInput.addEventListener('input', () => {
      if(registrySearchInput.value === ''){
        state.meta.registrySearch = '';
        try{ saveState(); }catch(e){}
        renderRegistries();
      }
    });
    registrySearchInput.addEventListener('keypress', (e) => {
      if(e.key === 'Enter'){
        state.meta.registrySearch = registrySearchInput.value;
        try{ saveState(); }catch(e){}
        renderRegistries();
      }
    });
    if(registrySearchBtn){
      registrySearchBtn.addEventListener('click', () => {
        state.meta.registrySearch = registrySearchInput.value;
        try{ saveState(); }catch(e){}
        renderRegistries();
      });
    }
  }

  wrap.innerHTML = '';
  let regs = (state.registries || []).slice();
  const hadAnyRegistries = regs.length > 0;
  const registrySearchGroups = parseSearchGroups(state.meta.registrySearch);
  if(registrySearchGroups.length > 0){
    regs = regs.filter(r => {
      const wd = (r.wdNumber || '').toString().toLowerCase();
      const doc = (r.docNumber || '').toString().toLowerCase();
      const category = (r.category || '').toString().toLowerCase();
      const leases = Array.isArray(r.leases) && r.leases.length ? r.leases.join(' ') : (r.lease || '').toString();
      const units = Array.isArray(r.units) ? r.units.join(' ') : '';
      const comments = Array.isArray(r.comments) ? r.comments.map(c => (c.text||'').toString()).join(' ') : '';
      return matchesSearchGroups(registrySearchGroups, [wd, doc, category, leases.toLowerCase(), units.toLowerCase(), comments.toLowerCase()]);
    });
  }
  if(regs.length === 0){
    const em = document.createElement('div'); em.className = 'small-muted';
    em.textContent = hadAnyRegistries ? 'No registries match your search.' : 'No registries yet.';
    wrap.appendChild(em);
    return;
  }

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
        // Delete registry from Google Sheets
        DB.deleteRegistry(r.id).catch(e => console.error('Registry delete error:', e));

        // Delete the registry from state
        state.registries = state.registries.filter(reg => reg.id !== r.id);
        
        // Also delete all invoices associated with this registry (matching WD number and units)
        const registryWdNumber = (r.wdNumber || '').toString().trim().toLowerCase();
        const registryUnits = Array.isArray(r.units) ? r.units.map(u => (u||'').toString().trim().toLowerCase()) : [];
        const invoicesToDelete = [];
        
        state.invoices = (state.invoices || []).filter(inv => {
          const invWd = (inv.wdNumber || '').toString().trim().toLowerCase();
          const invUnit = (inv.unit || '').toString().trim().toLowerCase();
          const matchesWd = invWd === registryWdNumber;
          const matchesUnit = registryUnits.includes(invUnit);
          if(matchesWd && matchesUnit){ invoicesToDelete.push(inv.id); return false; }
          return true;
        });

        // Delete matching invoices from Google Sheets
        invoicesToDelete.forEach(invId => {
          DB.deleteRegistry(invId).catch(e => console.error('Invoice delete error:', e));
        });
        
        saveState();
        renderRegistries();
        renderInvoices();
        renderUnitOverview();
        renderLeaseOverview();
        renderOverview();
        try{
          const detailModal = qs('#unitWdNumbersModal');
          if(detailModal && detailModal.style.display !== 'none' && _unitDetailList && _unitDetailList.length > 0){
            renderUnitDetailModal(_unitDetailList[_unitDetailIndex] || _unitDetailList[0]);
          }
        }catch(e){}
      }
    });

    menuPanel.appendChild(editBtn);
    menuPanel.appendChild(deleteBtn);
    
    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = menuPanel.style.display === 'block';
      // Close all other menus (they're body-level, not nested under .registry-row)
      document.querySelectorAll('.menu-panel').forEach(p => p.style.display = 'none');
      menuPanel.style.display = isOpen ? 'none' : 'block';

      if(!isOpen){
        const rect = menuBtn.getBoundingClientRect();
        menuPanel.style.top = (rect.bottom + window.scrollY) + 'px';
        menuPanel.style.left = (rect.left + window.scrollX) + 'px';
      }
    });
    menuBtn.className = 'registry-menu-btn';
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
    const unitsList = document.createElement('div');
    if(Array.isArray(r.unitDetails) && r.unitDetails.length){
      const unitsLabel = document.createElement('div'); unitsLabel.innerHTML = '<strong>Units:</strong>'; unitsLabel.style.marginBottom = '4px';
      unitsList.appendChild(unitsLabel);
      const detailTableEl = document.createElement('div'); detailTableEl.className = 'registry-unit-detail-table';
      unitsList.appendChild(detailTableEl);
      renderRegistryUnitDetailTable(detailTableEl, r.unitDetails);
    } else {
      unitsList.innerHTML = '<strong>Units:</strong> ' + (Array.isArray(r.units) ? escapeHtml((r.units||[]).join(', ')) : '');
    }
    const period = document.createElement('div'); period.innerHTML = `<strong>Period:</strong> ${escapeHtml(formatDate(r.periodStart))} — ${escapeHtml(formatDate(r.periodEnd))}`;
    const submitted = document.createElement('div'); submitted.innerHTML = `<strong>Submitted:</strong> ${escapeHtml(formatDate(r.submittedDate))} <span class="small-muted">(created ${new Date(r.createdAt||'').toLocaleString()})</span>`;
    
    // Get category from registry or fallback to invoices matching this registry's WD number
    const categoryDiv = document.createElement('div');
    let category = r.category || '';
    let supplier = '';
    let company = '';
    let arrangement = '';
    let invoicing = '';
    
    // Prefer details from the selected lease on the registry
    // A registry can span multiple leases; show a value when every lease agrees, "(multiple)" otherwise.
    const registryLeaseList = Array.isArray(r.leases) && r.leases.length ? r.leases : ((r.lease||'').toString().split(',').map(s=>s.trim()).filter(Boolean));
    const matchedLeaseRecs = registryLeaseList.map(lv => {
      const key = (lv||'').toString().trim().toLowerCase();
      return (state.leases||[]).find(l => (l.leaseNumber || l.id || '').toString().trim().toLowerCase() === key);
    }).filter(Boolean);
    function distinctLeaseField(getter){
      const distinct = Array.from(new Set(matchedLeaseRecs.map(getter).map(v=>(v||'').toString()).filter(v=>v!=='')));
      if(distinct.length === 0) return '';
      if(distinct.length === 1) return distinct[0];
      return '(multiple)';
    }
    if(matchedLeaseRecs.length){
      supplier = distinctLeaseField(l => l.supplier);
      company = distinctLeaseField(l => l.company);
      arrangement = distinctLeaseField(l => l.arrangement);
      invoicing = distinctLeaseField(l => l.invoicing);
    }

    // Fallback: Find matching invoice to get category if registry doesn't have it
    const matchingInvoice = (state.invoices || []).find(inv => {
      const invWd = (inv.wdNumber || '').toString().trim().toLowerCase();
      const regWd = (r.wdNumber || '').toString().trim().toLowerCase();
      return invWd === regWd;
    });
    if(matchingInvoice){
      if(!category) category = matchingInvoice.category || '';
      // If no lease matched (rare), use invoice fields as last resort
      if(matchedLeaseRecs.length === 0){
        supplier = supplier || (matchingInvoice.supplier || '');
        company = company || (matchingInvoice.company || '');
        arrangement = arrangement || (matchingInvoice.arrangement || '');
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
                DB.updateRegistry(r).catch(e => console.error('Registry comment delete error:', e));
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
  
  // Initialize all units with status history
  (state.units || []).forEach(unit => {
    if(!unit.statusHistory || unit.statusHistory.length === 0){
      // Check if this is a legacy disabled unit
      if(unit.status === 'Disabled' && unit.disabledDate){
        // Create status history based on legacy data
        unit.statusHistory = [
          {
            status: 'Operational',
            date: '2025-01-01',
            changedBy: 'System',
            timestamp: '2025-01-01T00:00:00.000Z'
          },
          {
            status: 'Disabled',
            date: unit.disabledDate,
            changedBy: 'System',
            timestamp: new Date(unit.disabledDate).toISOString()
          }
        ];
      } else {
        // Default to operational
        unit.statusHistory = [{
          status: 'Operational',
          date: '2025-01-01',
          changedBy: 'System',
          timestamp: '2025-01-01T00:00:00.000Z'
        }];
        if(!unit.status) unit.status = 'Operational';
        if(!unit.enabledDate) unit.enabledDate = '2025-01-01';
      }
    }
  });
  
  // Initialize meta for search and sorting
  state.meta = state.meta || {};
  state.meta.unitSearch = state.meta.unitSearch || '';
  state.meta.unitSort = state.meta.unitSort || { column: 'unitId', ascending: true };
  
  // Get or create search box
  let searchContainer = qs('#unitSearchContainer');
  if(!searchContainer){
    const table = tbody.closest('table');
    if(table && table.parentNode){
      searchContainer = document.createElement('div');
      searchContainer.id = 'unitSearchContainer';
      searchContainer.style.marginBottom = '12px';
      searchContainer.style.display = 'flex';
      searchContainer.style.gap = '8px';
      searchContainer.style.alignItems = 'center';
      
      const searchLabel = document.createElement('label');
      searchLabel.style.fontWeight = '600';
      searchLabel.textContent = 'Search:';
      
      const searchInput = document.createElement('input');
      searchInput.type = 'text';
      searchInput.id = 'unitSearchInput';
      searchInput.placeholder = 'Filter by unit, lease, company, supplier, comments... ("," = or, ";" = and)';
      searchInput.style.padding = '6px 10px';
      searchInput.style.border = '1px solid #e6e9ee';
      searchInput.style.borderRadius = '6px';
      searchInput.style.fontSize = '13px';
      searchInput.style.flex = '1';
      searchInput.value = state.meta.unitSearch;
      
      searchInput.addEventListener('input', () => {
        if(searchInput.value === ''){
          state.meta.unitSearch = '';
          try{ saveState(); }catch(e){}
          renderUnits();
        }
      });
      
      searchInput.addEventListener('keypress', (e) => {
        if(e.key === 'Enter'){
          state.meta.unitSearch = searchInput.value;
          try{ saveState(); }catch(e){}
          renderUnits();
        }
      });
      
      const searchBtn = document.createElement('button');
      searchBtn.textContent = 'Search';
      searchBtn.style.padding = '6px 16px';
      searchBtn.style.borderRadius = '6px';
      searchBtn.style.fontSize = '13px';
      searchBtn.style.cursor = 'pointer';
      searchBtn.addEventListener('click', () => {
        state.meta.unitSearch = searchInput.value;
        try{ saveState(); }catch(e){}
        renderUnits();
      });
      
      searchContainer.appendChild(searchLabel);
      searchContainer.appendChild(searchInput);
      searchContainer.appendChild(searchBtn);
      table.parentNode.insertBefore(searchContainer, table);
    }
  }
  
  // Add click handlers to table headers for sorting
  const thead = tbody.closest('table')?.querySelector('thead');
  if(thead){
    const headers = thead.querySelectorAll('th');
    const sortableColumns = [
      { index: 1,  key: 'unitId',      text: 'Unit' },
      { index: 2,  key: 'lease',       text: 'Lease' },
      { index: 3,  key: 'costCenter',  text: 'Cost Center' },
      { index: 4,  key: 'company',     text: 'Company' },
      { index: 5,  key: 'supplier',    text: 'Supplier' },
      { index: 6,  key: 'arrangement', text: 'Arrangement' },
      { index: 7,  key: 'invoicing',   text: 'Invoicing' },
      { index: 8,  key: 'monthly',     text: 'Monthly' },
      { index: 9,  key: 'description', text: 'Description' },
      { index: 10, key: 'notes',       text: 'Notes' },
      { index: 11, key: 'status',      text: 'Status' }
    ];
    
    sortableColumns.forEach(col => {
      if(headers[col.index]){
        headers[col.index].style.cursor = 'pointer';
        headers[col.index].style.userSelect = 'none';
        
        // Update header text with sort indicator
        let headerText = col.text;
        if(state.meta.unitSort.column === col.key){
          headerText += state.meta.unitSort.ascending ? ' ▲' : ' ▼';
        }
        headers[col.index].textContent = headerText;
        
        // Remove old listener and add new one
        const newHeader = headers[col.index].cloneNode(true);
        headers[col.index].parentNode.replaceChild(newHeader, headers[col.index]);
        
        newHeader.addEventListener('click', () => {
          if(state.meta.unitSort.column === col.key){
            state.meta.unitSort.ascending = !state.meta.unitSort.ascending;
          } else {
            state.meta.unitSort.column = col.key;
            state.meta.unitSort.ascending = true;
          }
          try{ saveState(); }catch(e){}
          renderUnits();
        });
      }
    });
  }
  
  // Filter units by search term(s) — comma = OR, semicolon = AND (see parseSearchGroups)
  let units = state.units.slice();
  const searchGroups = parseSearchGroups(state.meta.unitSearch);
  if(searchGroups.length > 0){
    units = units.filter(u => {
      const unitId = (u.unitId || '').toString().toLowerCase();
      const lease = (u.lease || '').toString().toLowerCase();
      const company = (u.company || '').toString().toLowerCase();
      const supplier = (u.supplier || '').toString().toLowerCase();
      const arrangement = (u.arrangement || '').toString().toLowerCase();
      const invoicing = (u.invoicing || '').toString().toLowerCase();
      const description = (u.description || '').toString().toLowerCase();
      const notes = (u.notes || '').toString().toLowerCase();
      const status = (u.status || '').toString().toLowerCase();
      const comments = (u.comments || []).map(c => (c.text || '').toString().toLowerCase()).join(' ');

      return matchesSearchGroups(searchGroups, [unitId, lease, company, supplier, arrangement, invoicing, description, notes, status, comments]);
    });
  }
  
  // Sort units
  const sortCol = state.meta.unitSort.column;
  const sortAsc = state.meta.unitSort.ascending;
  units.sort((a, b) => {
    let valA = (a[sortCol] || '').toString().toLowerCase();
    let valB = (b[sortCol] || '').toString().toLowerCase();
    
    // Special handling for numeric monthly column
    if(sortCol === 'monthly'){
      valA = parseFloat(a[sortCol]) || 0;
      valB = parseFloat(b[sortCol]) || 0;
    }
    
    if(valA < valB) return sortAsc ? -1 : 1;
    if(valA > valB) return sortAsc ? 1 : -1;
    return 0;
  });
  
  units.forEach((u, i)=>{
    const tr = document.createElement('tr');
    const tdIndex = document.createElement('td'); tdIndex.textContent = i+1;
  const tdUnit = document.createElement('td'); tdUnit.innerHTML = `<strong style="cursor:pointer;color:#0b74de;" title="View unit detail">${escapeHtml(u.unitId || '')}</strong>`;
  tdUnit.querySelector('strong').addEventListener('click', (e)=>{ e.stopPropagation(); openUnitWdNumbersModal(u.unitId, new Date().getFullYear(), new Date().getMonth(), units.map(x => x.unitId)); });
    const tdLease = document.createElement('td'); tdLease.textContent = u.lease || '';
    const tdCompany = document.createElement('td'); tdCompany.textContent = u.company || '';
    const tdCostCenter = document.createElement('td'); tdCostCenter.textContent = u.costCenter || '';
    const tdSupplier = document.createElement('td'); tdSupplier.textContent = u.supplier || '';
    const tdArrangement = document.createElement('td'); tdArrangement.textContent = u.arrangement || '';
    const tdInvoicing = document.createElement('td'); tdInvoicing.textContent = u.invoicing || '';
    const tdMonthly = document.createElement('td'); tdMonthly.textContent = formatCurrency(u.monthly || '') || '';
    const tdDesc = document.createElement('td'); tdDesc.textContent = u.description || '';
  const tdNotes = document.createElement('td'); tdNotes.textContent = u.notes || '';
  const tdStatus = document.createElement('td'); 
  tdStatus.textContent = u.status || 'Operational';
  // Style disabled status
  if(u.status === 'Disabled'){
    tdStatus.style.color = '#dc2626';
    tdStatus.style.fontWeight = '600';
  }
  const tdActions = document.createElement('td'); tdActions.className = 'dev-actions';

    const editBtn = document.createElement('button'); editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', ()=>{
      openUnitEditModal(u);
    });

    // helper to render the disabled date portion (click-to-edit)
    const renderDisabledDateFor = ()=>{
      // Find the actual unit in state.units by unitId
      const actualIndex = state.units.findIndex(unit => unit.unitId === u.unitId || unit.id === u.id);
      if(actualIndex === -1) return;
      
      const unitObj = state.units[actualIndex] || {};
      // reset status text
      tdStatus.innerHTML = '';
      tdStatus.textContent = unitObj.status || 'Operational';
      
      // Apply styling for disabled status
      if(unitObj.status === 'Disabled'){
        tdStatus.style.color = '#dc2626';
        tdStatus.style.fontWeight = '600';
      } else {
        tdStatus.style.color = '#16a34a';
        tdStatus.style.fontWeight = '600';
      }
      
      // Show the last status change date for both disabled and operational units
      const statusHistory = unitObj.statusHistory || [];
      if(statusHistory.length > 0){
        const lastChange = statusHistory[statusHistory.length - 1];
        const dateSpan = document.createElement('div');
        dateSpan.className = 'small-muted status-date';
        dateSpan.textContent = lastChange.date || '';
        dateSpan.style.cursor = 'pointer';
        dateSpan.title = 'Click to view status history';
        dateSpan.addEventListener('click', ()=>{
          openUnitStatusHistoryModal(unitObj);
        });
        tdStatus.appendChild(document.createElement('br'));
        tdStatus.appendChild(dateSpan);
      } else if(unitObj.status === 'Disabled' && unitObj.disabledDate){
        // Legacy support for units with disabledDate but no history
        const dateSpan = document.createElement('div');
        dateSpan.className = 'small-muted disabled-date';
        dateSpan.textContent = unitObj.disabledDate || '';
        dateSpan.style.cursor = 'pointer';
        dateSpan.title = 'Click to edit disable date';
        dateSpan.addEventListener('click', ()=>{
          // replace content with inline date input + save/cancel
          tdStatus.innerHTML = '';
          const statusText = document.createTextNode(unitObj.status || 'Disabled');
          tdStatus.appendChild(statusText);
          tdStatus.appendChild(document.createElement('br'));
          const input = document.createElement('input'); input.type = 'date'; input.value = unitObj.disabledDate || new Date().toISOString().slice(0,10);
          const save = document.createElement('button'); save.textContent = 'Save';
          const cancel = document.createElement('button'); cancel.textContent = 'Cancel';
          tdStatus.appendChild(input); tdStatus.appendChild(save); tdStatus.appendChild(cancel);
          
          // Keep the styling even in edit mode
          tdStatus.style.color = '#dc2626';
          tdStatus.style.fontWeight = '600';
          
          save.addEventListener('click', ()=>{
            const v = input.value;
            if(v) state.units[actualIndex].disabledDate = v; else delete state.units[actualIndex].disabledDate;
            saveState(); renderUnits(); renderOverview();
          });
          cancel.addEventListener('click', ()=>{ renderDisabledDateFor(); });
        });
        tdStatus.appendChild(document.createElement('br'));
        tdStatus.appendChild(dateSpan);
      }
    };

    const toggleBtn = document.createElement('button'); toggleBtn.textContent = (u.status === 'Disabled' ? 'Enable' : 'Disable');
    toggleBtn.addEventListener('click', ()=>{
      handleUnitStatusChange(u.unitId || u.id);
    });

    const delBtn = document.createElement('button'); delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', ()=>{ if(!confirm('Delete this unit?')) return; const deletedUnit = state.units[i]; state.units.splice(i,1); DB.deleteUnit(deletedUnit.id).catch(e => console.error('Unit delete error:', e)); saveState(); renderUnits(); renderOverview(); });

  tdActions.appendChild(editBtn); tdActions.appendChild(toggleBtn); tdActions.appendChild(delBtn);

    tr.appendChild(tdIndex);
    tr.appendChild(tdUnit);
    tr.appendChild(tdLease);
    tr.appendChild(tdCostCenter);
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
      // Get current user role for restrictions
      const session = currentSession();
      let userRole = null;
      if(session && session.user === 'Master'){ 
        userRole = 'Master'; 
      } else if(session) {
        const currentUser = (state.users||[]).find(x=> x.username === session.user);
        userRole = currentUser ? (currentUser.role || null) : null;
      }
      
      const moreWrap = document.createElement('span'); moreWrap.style.position = 'relative'; moreWrap.style.display = 'inline-block'; moreWrap.style.marginLeft = '8px';
      const moreBtn = document.createElement('button'); moreBtn.type = 'button'; moreBtn.textContent = '⋯'; moreBtn.title = 'Actions'; moreBtn.className = 'lease-more-btn';
      moreWrap.appendChild(moreBtn);

      const moreMenu = document.createElement('div'); moreMenu.className = 'unit-more-menu'; moreMenu.style.position = 'absolute'; moreMenu.style.display = 'none'; moreMenu.style.right = '0'; moreMenu.style.top = 'calc(100% + 6px)'; moreMenu.style.background = '#fff'; moreMenu.style.border = '1px solid #ddd'; moreMenu.style.boxShadow = '0 6px 18px rgba(0,0,0,0.08)'; moreMenu.style.padding = '6px'; moreMenu.style.borderRadius = '6px'; moreMenu.style.zIndex = 9999; moreMenu.style.minWidth = '120px';
      
      // Operator role: only show Comment button
      if(userRole === 'Operator'){
        const mComment = document.createElement('button'); mComment.type = 'button'; mComment.textContent = 'Comment'; mComment.style.display='block'; mComment.style.width='100%';
        moreMenu.appendChild(mComment);
        mComment.addEventListener('click', (ev)=>{ ev.stopPropagation(); openUnitCommentsModal(u); moreMenu.style.display='none'; });
      } else {
        // Manager, Developer, Master: show all options
        const mEdit = document.createElement('button'); mEdit.type = 'button'; mEdit.textContent = 'Edit'; mEdit.style.display='block'; mEdit.style.width='100%'; mEdit.style.marginBottom='6px';
        const mComment = document.createElement('button'); mComment.type = 'button'; mComment.textContent = 'Comment'; mComment.style.display='block'; mComment.style.width='100%'; mComment.style.marginBottom='6px';
        const mToggle = document.createElement('button'); mToggle.type = 'button'; mToggle.textContent = (u.status === 'Disabled' ? 'Enable' : 'Disable'); mToggle.style.display='block'; mToggle.style.width='100%'; mToggle.style.marginBottom='6px';
        const mDel = document.createElement('button'); mDel.type = 'button'; mDel.textContent = 'Delete'; mDel.style.display='block'; mDel.style.width='100%';
        moreMenu.appendChild(mEdit); moreMenu.appendChild(mComment); moreMenu.appendChild(mToggle); moreMenu.appendChild(mDel);
        
        mEdit.addEventListener('click', (ev)=>{ ev.stopPropagation(); moreMenu.style.display='none'; openUnitEditModal(u); });
        mComment.addEventListener('click', (ev)=>{ ev.stopPropagation(); moreMenu.style.display='none'; openUnitCommentsModal(u); });
        mToggle.addEventListener('click', (ev)=>{ ev.stopPropagation(); moreMenu.style.display='none'; handleUnitStatusChange(u.unitId || u.id); });
        mDel.addEventListener('click', (ev)=>{ ev.stopPropagation(); moreMenu.style.display='none'; if(!confirm('Delete this unit?')) return; const deletedUnit = state.units[i]; state.units.splice(i,1); DB.deleteUnit(deletedUnit.id).catch(e => console.error('Unit delete error:', e)); saveState(); renderUnits(); renderOverview(); });
      }
      
      moreWrap.appendChild(moreMenu);

      moreBtn.addEventListener('click', (ev)=>{ ev.stopPropagation(); moreMenu.style.display = moreMenu.style.display === 'none' ? 'block' : 'none'; });

      // close on outside click
      document.addEventListener('click', ()=>{ try{ moreMenu.style.display = 'none'; }catch(e){} });

      strongEl.style.display = 'inline-flex'; strongEl.style.alignItems = 'center';
      strongEl.appendChild(moreWrap);
    }
  }catch(e){ /* non-fatal */ }

    // render the disabled date UI for this row
    try{ renderDisabledDateFor(); }catch(e){}

    tbody.appendChild(tr);
  });
  // after rendering units
}

// overview units removed: no-op


// sync selects used in unit form
function syncUnitLeaseOptions(){
  const input = qs('#unitLease');
  const dropdown = qs('#unitLeaseDropdown');
  if(!input || !dropdown) return;
  
  const currentValue = input.value;
  
  // Build searchable dropdown
  dropdown.innerHTML = '';
  
  // Add search box
  const searchBox = document.createElement('input');
  searchBox.type = 'text';
  searchBox.placeholder = 'Search leases...';
  searchBox.style.cssText = 'width:100%;padding:8px;border:none;border-bottom:1px solid #e6e9ee;box-sizing:border-box;';
  dropdown.appendChild(searchBox);
  
  // Options container
  const optionsContainer = document.createElement('div');
  optionsContainer.style.cssText = 'max-height:200px;overflow-y:auto;';
  dropdown.appendChild(optionsContainer);
  
  // Render options
  const renderOptions = (filterText = '') => {
    optionsContainer.innerHTML = '';
    const filtered = state.leases.filter(l => {
      const leaseNum = (l.leaseNumber || l.id || '').toLowerCase();
      return leaseNum.includes(filterText.toLowerCase());
    });
    
    if(filtered.length === 0){
      const noResult = document.createElement('div');
      noResult.textContent = 'No leases found';
      noResult.style.cssText = 'padding:8px;color:#6b7280;font-size:13px;';
      optionsContainer.appendChild(noResult);
      return;
    }
    
    filtered.forEach(l => {
      const opt = document.createElement('div');
      opt.textContent = l.leaseNumber || l.id;
      opt.style.cssText = 'padding:8px 12px;cursor:pointer;font-size:14px;';
      opt.dataset.value = l.leaseNumber || l.id;
      
      opt.addEventListener('mouseenter', () => {
        opt.style.background = '#f3f4f6';
      });
      opt.addEventListener('mouseleave', () => {
        opt.style.background = '';
      });
      opt.addEventListener('click', () => {
        input.value = opt.dataset.value;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        dropdown.style.display = 'none';
      });
      
      optionsContainer.appendChild(opt);
    });
  };
  
  renderOptions();
  
  searchBox.addEventListener('input', () => {
    renderOptions(searchBox.value);
  });
  
  // Set up click handler only if not already set
  if(!input.dataset.dropdownInitialized){
    input.dataset.dropdownInitialized = 'true';
    
    // Prevent form submission when pressing Enter
    input.addEventListener('keydown', (e) => {
      if(e.key === 'Enter'){
        e.preventDefault();
        e.stopPropagation();
        // Trigger click to open dropdown
        input.click();
      }
    });
    
    // Toggle dropdown on input click
    input.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const isVisible = dropdown.style.display === 'block';
      
      // Close all other dropdowns first
      document.querySelectorAll('.searchable-dropdown').forEach(d => {
        if(d !== dropdown) d.style.display = 'none';
      });
      
      dropdown.style.display = isVisible ? 'none' : 'block';
      
      if(dropdown.style.display === 'block'){
        const search = dropdown.querySelector('input[type="text"]');
        if(search){
          search.value = '';
          // Re-render options when opening
          const container = dropdown.querySelector('div');
          if(container){
            container.innerHTML = '';
            state.leases.forEach(l => {
              const opt = document.createElement('div');
              opt.textContent = l.leaseNumber || l.id;
              opt.style.cssText = 'padding:8px 12px;cursor:pointer;font-size:14px;';
              opt.dataset.value = l.leaseNumber || l.id;
              opt.addEventListener('mouseenter', () => { opt.style.background = '#f3f4f6'; });
              opt.addEventListener('mouseleave', () => { opt.style.background = ''; });
              opt.addEventListener('click', () => {
                input.value = opt.dataset.value;
                input.dispatchEvent(new Event('change', { bubbles: true }));
                dropdown.style.display = 'none';
              });
              container.appendChild(opt);
            });
          }
          setTimeout(() => search.focus(), 10);
        }
      }
    });
    
    // Close dropdown when clicking outside
    document.addEventListener('click', (e) => {
      if(!input.contains(e.target) && !dropdown.contains(e.target)){
        dropdown.style.display = 'none';
      }
    });
  }
  
  if(currentValue) input.value = currentValue;
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
  const tbody = qs('#leaseList'); 
  if(!tbody) return;
  
  // Initialize meta for search and sorting
  state.meta.leaseSearch = state.meta.leaseSearch || '';
  state.meta.leaseSort = state.meta.leaseSort || { column: 'leaseNumber', ascending: true };
  
  const table = tbody.parentElement;
  const thead = table.querySelector('thead');
  
  // Create search box if it doesn't exist
  let searchContainer = table.parentElement.querySelector('.lease-search-container');
  if(!searchContainer){
    searchContainer = document.createElement('div');
    searchContainer.className = 'lease-search-container';
    searchContainer.style.cssText = 'margin-bottom:16px;display:flex;gap:8px;align-items:center;';
    
    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.placeholder = 'Search leases... ("," = or, ";" = and)';
    searchInput.value = state.meta.leaseSearch;
    searchInput.style.cssText = 'flex:1;padding:8px;border:1px solid #ddd;border-radius:6px;';
    
    const searchBtn = document.createElement('button');
    searchBtn.textContent = 'Search';
    searchBtn.type = 'button';
    searchBtn.style.cssText = 'padding:8px 16px;';
    
    const clearBtn = document.createElement('button');
    clearBtn.textContent = 'Clear';
    clearBtn.type = 'button';
    clearBtn.style.cssText = 'padding:8px 16px;';
    
    searchBtn.addEventListener('click', ()=>{
      state.meta.leaseSearch = searchInput.value.toLowerCase();
      saveState();
      renderLeases();
    });
    
    clearBtn.addEventListener('click', ()=>{
      searchInput.value = '';
      state.meta.leaseSearch = '';
      saveState();
      renderLeases();
    });
    
    searchInput.addEventListener('keypress', (e)=>{
      if(e.key === 'Enter'){
        e.preventDefault();
        searchBtn.click();
      }
    });
    
    searchContainer.appendChild(searchInput);
    searchContainer.appendChild(searchBtn);
    searchContainer.appendChild(clearBtn);
    
    table.parentElement.insertBefore(searchContainer, table);
  }
  
  // Add sort handlers to table headers
  if(thead){
    const sortableColumns = [
      { index: 1, key: 'leaseNumber', text: 'Lease Number' },
      { index: 2, key: 'company', text: 'Company' },
      { index: 3, key: 'supplier', text: 'Supplier' },
      { index: 4, key: 'arrangement', text: 'Arrangement' },
      { index: 5, key: 'invoicing', text: 'Invoicing' },
      { index: 6, key: 'status', text: 'Status' }
    ];
    
    const ths = thead.querySelectorAll('th');
    sortableColumns.forEach(col => {
      const th = ths[col.index];
      if(th && !th.dataset.sortHandlerAdded){
        th.dataset.sortHandlerAdded = 'true';
        th.style.cursor = 'pointer';
        th.style.userSelect = 'none';
        th.title = 'Click to sort';
        
        th.addEventListener('click', ()=>{
          if(state.meta.leaseSort.column === col.key){
            state.meta.leaseSort.ascending = !state.meta.leaseSort.ascending;
          } else {
            state.meta.leaseSort = { column: col.key, ascending: true };
          }
          saveState();
          renderLeases();
        });
      }
      
      // Update header text with sort indicator
      if(th){
        const baseText = col.text;
        if(state.meta.leaseSort.column === col.key){
          th.textContent = baseText + (state.meta.leaseSort.ascending ? ' ▲' : ' ▼');
        } else {
          th.textContent = baseText;
        }
      }
    });
  }
  
  // Filter leases by search term(s) — comma = OR, semicolon = AND (see parseSearchGroups)
  const searchGroups = parseSearchGroups(state.meta.leaseSearch);
  let leases = state.leases.filter(l => {
    if(searchGroups.length === 0) return true;
    const leaseNumber = (l.leaseNumber || '').toLowerCase();
    const company = (l.company || '').toLowerCase();
    const supplier = (l.supplier || '').toLowerCase();
    const arrangement = (l.arrangement || '').toLowerCase();
    const invoicing = (l.invoicing || '').toLowerCase();
    const status = (l.status || '').toLowerCase();

    return matchesSearchGroups(searchGroups, [leaseNumber, company, supplier, arrangement, invoicing, status]);
  });
  
  // Sort leases
  const sortCol = state.meta.leaseSort.column;
  const ascending = state.meta.leaseSort.ascending;
  
  leases.sort((a, b) => {
    let valA = (a[sortCol] || '').toString().toLowerCase();
    let valB = (b[sortCol] || '').toString().toLowerCase();
    
    if(valA < valB) return ascending ? -1 : 1;
    if(valA > valB) return ascending ? 1 : -1;
    return 0;
  });
  
  // Clear table body
  tbody.innerHTML = '';
  
  // Render each lease as a table row
  leases.forEach((l, i)=>{
    const tr = document.createElement('tr');
    
    // Index column
    const tdIndex = document.createElement('td');
    tdIndex.textContent = (i + 1);
    
    // Lease Number column
    const tdLease = document.createElement('td');
    tdLease.innerHTML = `<strong>${escapeHtml(l.leaseNumber||'')}</strong>`;
    
    // Company column
    const tdCompany = document.createElement('td');
    tdCompany.textContent = l.company || '';
    
    // Supplier column
    const tdSupplier = document.createElement('td');
    tdSupplier.textContent = l.supplier || '';
    
    // Arrangement column
    const tdArrangement = document.createElement('td');
    tdArrangement.textContent = l.arrangement || '';
    
    // Invoicing column
    const tdInvoicing = document.createElement('td');
    tdInvoicing.textContent = l.invoicing || '';
    
    // Status column
    const tdStatus = document.createElement('td');
    tdStatus.textContent = l.status || 'Enabled';
    if(l.status === 'Disabled'){
      tdStatus.style.color = '#dc2626';
      tdStatus.style.fontWeight = '600';
    }
    
    // Actions column
    const tdActions = document.createElement('td');
    
    // Create action buttons (for reuse in menu)
    const editBtn = document.createElement('button'); 
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', ()=>{
      const form = qs('#leaseForm'); 
      if(!form) return;
      form.leaseNumber.value = l.leaseNumber || '';
      form.leaseCompany.value = l.company || '';
      form.leaseSupplier.value = l.supplier || '';
      form.leaseArrangement.value = l.arrangement || '';
      form.leaseInvoicing.value = l.invoicing || '';
      
      // populate seasonal fields if present
      if(l.fromDate){ 
        const parts = String(l.fromDate).split('-'); 
        if(parts.length===2){ 
          const fm = qs('#leaseFromMonth'); 
          const fdsel = qs('#leaseFromDay'); 
          if(fm) fm.value = parts[0]; 
          if(fdsel) fdsel.value = parts[1]; 
        } 
      }
      if(l.toDate){ 
        const parts2 = String(l.toDate).split('-'); 
        if(parts2.length===2){ 
          const tm = qs('#leaseToMonth'); 
          const tdsel = qs('#leaseToDay'); 
          if(tm) tm.value = parts2[0]; 
          if(tdsel) tdsel.value = parts2[1]; 
        } 
      }
      
      form.dataset.editing = l.id;
      const submitBtn = form.querySelector('button[type="submit"]'); 
      if(submitBtn) submitBtn.textContent = 'Save';
      form.leaseNumber.focus();
    });

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
      DB.updateLease(state.leases[idx]).catch(e => console.error('Lease status save error:', e));
      saveState(); 
      renderLeases(); 
      renderOverview();
      syncLeaseOptions();
    });

    const delBtn = document.createElement('button'); 
    delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', ()=>{
      if(!confirm('Delete this lease? This will not delete units or invoices automatically.')) return;
      state.leases = state.leases.filter(x=>x.id !== l.id);
      state.units = (state.units || []).map(u => (u.lease === l.leaseNumber) ? Object.assign({}, u, { lease: '' }) : u);
      state.invoices = (state.invoices || []).map(inv => (inv.lease === l.leaseNumber) ? Object.assign({}, inv, { lease: '' }) : inv);
      DB.deleteLease(l.id).catch(e => console.error('Lease delete error:', e));
      saveState(); renderLeases(); renderUnits(); renderInvoices(); renderOverview();
    });

    // Create compact 'more' menu
    try{
      const moreWrap = document.createElement('span'); 
      moreWrap.style.position = 'relative'; 
      moreWrap.style.display = 'inline-block';
      
      const moreBtn = document.createElement('button'); 
      moreBtn.type = 'button'; 
      moreBtn.textContent = '⋯'; 
      moreBtn.title = 'Actions';
      moreBtn.className = 'lease-more-btn';
      moreWrap.appendChild(moreBtn);

      const moreMenu = document.createElement('div'); 
      moreMenu.className = 'lease-more-menu'; 
      moreMenu.style.position = 'absolute'; 
      moreMenu.style.display = 'none'; 
      moreMenu.style.right = '0'; 
      moreMenu.style.top = 'calc(100% + 6px)'; 
      moreMenu.style.background = '#fff'; 
      moreMenu.style.border = '1px solid #ddd'; 
      moreMenu.style.boxShadow = '0 6px 18px rgba(0,0,0,0.08)'; 
      moreMenu.style.padding = '6px'; 
      moreMenu.style.borderRadius = '6px'; 
      moreMenu.style.zIndex = 9999; 
      moreMenu.style.minWidth = '120px';
      
      const mEdit = document.createElement('button'); 
      mEdit.type = 'button'; 
      mEdit.textContent = 'Edit'; 
      mEdit.style.display='block'; 
      mEdit.style.width='100%'; 
      mEdit.style.marginBottom='6px';
      
      const mToggle = document.createElement('button'); 
      mToggle.type = 'button'; 
      mToggle.textContent = (l.status === 'Disabled') ? 'Enable' : 'Disable'; 
      mToggle.style.display='block'; 
      mToggle.style.width='100%'; 
      mToggle.style.marginBottom='6px';
      
      const mDel = document.createElement('button'); 
      mDel.type = 'button'; 
      mDel.textContent = 'Delete'; 
      mDel.style.display='block'; 
      mDel.style.width='100%';
      
      moreMenu.appendChild(mEdit); 
      moreMenu.appendChild(mToggle); 
      moreMenu.appendChild(mDel);
      moreWrap.appendChild(moreMenu);

      moreBtn.addEventListener('click', (ev)=>{ 
        ev.stopPropagation(); 
        moreMenu.style.display = moreMenu.style.display === 'none' ? 'block' : 'none'; 
      });
      
      mEdit.addEventListener('click', ()=>{ 
        try{ editBtn.click(); }catch(e){} 
        moreMenu.style.display='none'; 
      });
      
      mToggle.addEventListener('click', ()=>{ 
        try{ toggleBtn.click(); }catch(e){} 
        moreMenu.style.display='none'; 
      });
      
      mDel.addEventListener('click', ()=>{ 
        try{ delBtn.click(); }catch(e){} 
        moreMenu.style.display='none'; 
      });

      document.addEventListener('click', ()=>{ 
        try{ moreMenu.style.display = 'none'; }catch(e){} 
      });

      tdActions.appendChild(moreWrap);
    }catch(e){ /* non-fatal */ }
    
    tr.appendChild(tdIndex);
    tr.appendChild(tdLease);
    tr.appendChild(tdCompany);
    tr.appendChild(tdSupplier);
    tr.appendChild(tdArrangement);
    tr.appendChild(tdInvoicing);
    tr.appendChild(tdStatus);
    tr.appendChild(tdActions);
    
    tbody.appendChild(tr);
  });
  
  // ensure unit lease select is updated when leases change
  if(typeof syncUnitLeaseOptions === 'function') syncUnitLeaseOptions();
  // ensure invoice lease select is updated when leases change
  if(typeof syncInvoiceLeaseOptions === 'function') syncInvoiceLeaseOptions();
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
  tbody.querySelectorAll('.del').forEach(b=>b.addEventListener('click', e=>{ const id=e.target.dataset.id; if(!confirm('Delete this user?')) return; DB.deleteUser(id).catch(e => console.error('User delete error:', e)); state.users = state.users.filter(x=>x.id!==id); saveState(); renderUsers(); renderOverview(); }));
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
  const unitToggle = qs('#invoiceUnitToggle'); if(unitToggle) unitToggle.textContent = 'Select units';
  const leaseToggle = qs('#invoiceLeaseToggle'); if(leaseToggle) leaseToggle.textContent = 'Select leases';
  if(typeof renderInvoiceUnitBreakdown === 'function') renderInvoiceUnitBreakdown();
}); }

// Shared multi-term search parsing, used by every search bar in the app.
// Syntax: comma "," = OR (any term in the group matches), semicolon ";" = AND
// (every group must have at least one matching term). Groups can combine both,
// e.g. "19-10298,ACU-804; Operational" = (19-10298 OR ACU-804) AND Operational.
function parseSearchGroups(raw){
  return (raw || '')
    .split(';')
    .map(group => group.split(',').map(t => t.trim().toLowerCase()).filter(t => t.length > 0))
    .filter(group => group.length > 0);
}

function matchesSearchGroups(groups, fields){
  if(!groups || groups.length === 0) return true;
  return groups.every(orTerms => orTerms.some(term => fields.some(f => f.includes(term))));
}

// small helper to avoid HTML injection in table cells
function escapeHtml(str){
  return String(str).replace(/[&<>"']/g, s => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[s]));
}

// --- Config list protection (Sheets is the only source of truth) ---
// Snapshot of what Sheets returned on last load. Never stored in localStorage.
const _CFG_FIELDS = ['devCompanies','devRentals','devSuppliers','devPayments','devArrangements'];
let _sheetConfigSnapshot = {};
// Set to true only by Developer-tab handlers before calling saveState() for a config change.
let _configChangeIntentional = false;

function _updateSheetConfigSnapshot(){
  _CFG_FIELDS.forEach(f => {
    _sheetConfigSnapshot[f] = Array.isArray(state.meta[f]) ? state.meta[f].slice() : [];
  });
}

// Fetch the current server-side value of a single config list directly from Sheets
// (bypassing whatever this tab's in-memory `state`/snapshot currently holds). Used
// before any Developer-tab add/edit/delete so a stale or long-idle tab can't clobber
// an edit made by someone else moments earlier.
async function fetchFreshConfigArray(field){
  try{
    const freshMeta = await DB.get({ action: 'getMeta' });
    const v = DB.parseField(freshMeta ? freshMeta[field] : null);
    return Array.isArray(v) ? v : [];
  }catch(e){
    console.warn('[Config refresh] Could not fetch fresh "' + field + '" from Sheets, falling back to local snapshot:', e.message);
    if(Array.isArray(_sheetConfigSnapshot[field])) return _sheetConfigSnapshot[field].slice();
    return Array.isArray(state.meta[field]) ? state.meta[field].slice() : [];
  }
}

// Commit a freshly-computed config array (built on top of fetchFreshConfigArray's
// result) as the new source of truth, and persist it.
function commitConfigListChange(field, newArray){
  state.meta[field] = newArray;
  _sheetConfigSnapshot[field] = newArray.slice();
  _configChangeIntentional = true;
  saveState();
}

// Re-pull just the config lists from Sheets and refresh whatever Developer-tab list UI
// is currently rendered. Called when a backgrounded/idle tab regains focus, since the
// 60s auto-refresh timer is throttled or paused while a tab is hidden or the machine
// is asleep, letting its snapshot go stale.
async function refreshConfigSnapshotFromServer(){
  try{
    const freshMeta = await DB.get({ action: 'getMeta' });
    _CFG_FIELDS.forEach(f => {
      const v = DB.parseField(freshMeta ? freshMeta[f] : null);
      if(Array.isArray(v)){
        state.meta[f] = v;
        _sheetConfigSnapshot[f] = v.slice();
      }
    });
    try{ renderCompanyList(); }catch(e){}
    try{ renderRentalList(); }catch(e){}
    try{ renderSupplierList(); }catch(e){}
    try{ renderPaymentList(); }catch(e){}
    try{ renderArrangementList(); }catch(e){}
  }catch(e){
    console.warn('[Visibility refresh] Could not refresh config snapshot:', e.message);
  }
}

document.addEventListener('visibilitychange', ()=>{
  if(document.visibilityState !== 'visible') return;
  if(!isAuthenticated()) return;
  const root = qs('#appRoot');
  if(root && root.style.display !== 'none') refreshConfigSnapshotFromServer();
});

// --- Persistence (Google Sheets) ---
function saveState(){
  try{
    if(_configChangeIntentional){
      // User explicitly changed a config list — update the snapshot to match and allow the save.
      _updateSheetConfigSnapshot();
      _configChangeIntentional = false;
    } else {
      // Regular save (month change, registry edit, search, sort, etc.) — config lists are
      // only ever mutated intentionally, via the fetch-fresh-then-commit flow above. Pin
      // them to the last known-good snapshot unconditionally (not just when locally empty)
      // so a stale or long-idle tab can never carry an outdated copy back to Sheets as a
      // side effect of an unrelated save.
      _CFG_FIELDS.forEach(f => {
        if(Array.isArray(_sheetConfigSnapshot[f])){
          state.meta[f] = _sheetConfigSnapshot[f].slice();
        }
      });
    }
    DB.saveAll(state).catch(e => console.error('DB save error:', e));
    try{ window.dispatchEvent(new Event('agi:stateSaved')); }catch(ev){}
  }catch(e){ console.error('Error saving state:', e); }
}

function loadState(){
  return JSON.parse(JSON.stringify(defaultData));
}

async function loadStateFromDB(){
  try {
    const loaded = await DB.loadAll();
    state = loaded;

    // Correct registrySeq if meta value is behind the highest seq actually in Sheets
    const _maxExistingSeq = loaded.registries.reduce((max, r) => Math.max(max, Number(r.seq) || 0), 0);
    if(_maxExistingSeq > (loaded.meta.registrySeq || 0)){
      console.warn('[registrySeq fix] Meta had', loaded.meta.registrySeq, '— max existing seq is', _maxExistingSeq, '— correcting in Sheets.');
      loaded.meta.registrySeq = _maxExistingSeq;
      DB.saveAll(loaded).catch(e => console.error('Failed to save corrected registrySeq:', e));
    }

    // Warn if everything came back empty — likely a Google Sheets connectivity problem
    const looksEmpty = loaded.units.length === 0 && loaded.registries.length === 0 && loaded.leases.length === 0;
    if(looksEmpty){
      const retry = confirm('No data was received from Google Sheets.\n\nThis usually means the connection timed out or Google is temporarily unavailable.\n\nClick OK to retry, or Cancel to continue with an empty view.');
      if(retry){ loadStateFromDB(); return; }
    }

    // Record what Sheets actually returned — this becomes the reference for the save guard.
    _updateSheetConfigSnapshot();

    renderAll();
    syncTabLabels();
    applyRoleRestrictions();
    updateHeaderTitleForMenu(false);
    updateExportImportVisibility(false);
    updateUserInfoDisplay();
    // Sync all configuration dropdowns after data loads
    try{ syncLeaseCompanyOptions(); }catch(e){}
    try{ syncLeaseSupplierOptions(); }catch(e){}
    try{ syncLeaseArrangementOptions(); }catch(e){}
    try{ syncLeaseInvoicingOptions(); }catch(e){}
    try{ syncInvoiceCategoryOptions(); }catch(e){}
    try{ syncInvoiceLeaseOptions(); }catch(e){}
    try{ syncUnitLeaseOptions(); }catch(e){}
    try{ syncUnitCostCenterOptions(); }catch(e){}
    try{ renderCompanyList(); }catch(e){}
    try{ renderSupplierList(); }catch(e){}
    try{ renderRentalList(); }catch(e){}
    try{ renderArrangementList(); }catch(e){}
    try{ renderPaymentList(); }catch(e){}
    // Start auto-refresh if not already running
    startAutoRefresh();
  } catch(e) {
    alert('Error loading data from Google Sheets: ' + e.message + '\n\nPlease check your connection and refresh.');
  }
}

let _autoRefreshTimer = null;
function startAutoRefresh(){
  if(_autoRefreshTimer) return;

  // Add last-updated indicator to header
  let lastUpdatedEl = qs('#lastUpdatedIndicator');
  if(!lastUpdatedEl){
    const header = document.querySelector('header .actions');
    if(header){
      lastUpdatedEl = document.createElement('span');
      lastUpdatedEl.id = 'lastUpdatedIndicator';
      lastUpdatedEl.style.cssText = 'font-size:11px;color:#9ca3af;margin-right:8px;align-self:center;';
      lastUpdatedEl.textContent = 'Live';
      header.insertBefore(lastUpdatedEl, header.firstChild);
    }
  }

  function updateTimestamp(){
    const el = qs('#lastUpdatedIndicator');
    if(!el) return;
    el.textContent = '🟢 Updated ' + new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
  }

  function isUserActive(){
    // Check if user is focused on any input, textarea or select
    const active = document.activeElement;
    if(!active) return false;
    const tag = active.tagName.toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select';
  }

  let _refreshRunning = false;

  const fetchWithTimeout = (promise, ms=25000) => {
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('timeout')), ms)
    );
    return Promise.race([promise, timeout]);
  };

  _autoRefreshTimer = setInterval(async ()=>{
    if(_refreshRunning) return;
    if(!isAuthenticated()) return;
    const root = qs('#appRoot');
    if(!root || root.style.display === 'none') return;

    _refreshRunning = true;
    try{
      const [registries, units, leases, users, meta] = await fetchWithTimeout(
        Promise.all([
          DB.get({ action: 'getAll', sheet: 'invoices' }),
          DB.get({ action: 'getAll', sheet: 'units' }),
          DB.get({ action: 'getAll', sheet: 'leases' }),
          DB.get({ action: 'getAll', sheet: 'users' }),
          DB.get({ action: 'getMeta' })
        ])
      );

      if(!registries || !units || !leases){ _refreshRunning = false; return; }

      state.registries = registries.map(r => ({
        ...r,
        id: String(r[' '] || r.id || ''),
        seq: Number(r.seq) || 0,
        wdNumber: String(r.wdNumber || ''),
        docNumber: String(r.docNumber || ''),
        category: String(r.category || ''),
        totalAmount: String(r.totalAmount || ''),
        lease: String(r.lease || ''),
        periodStart: String(r.periodStart || '').slice(0,10),
        periodEnd: String(r.periodEnd || '').slice(0,10),
        submittedDate: String(r.submittedDate || '').slice(0,10),
        createdAt: String(r.createdAt || ''),
        units: DB.parseField(r.units),
        comments: DB.parseField(r.comments) || []
      }));

      state.units = units.map(u => ({
        ...u,
        id: String(u.id || ''),
        lease: String(u.lease || ''),
        unitId: String(u.unitId || ''),
        status: String(u.status || ''),
        statusHistory: DB.parseField(u.statusHistory) || [],
        comments: DB.parseField(u.comments) || [],
        overviewComments: DB.parseField(u.overviewComments) || []
      }));

      state.leases = leases.map(l => ({
        ...l,
        id: String(l.id || ''),
        leaseNumber: String(l.leaseNumber || ''),
        status: String(l.status || '')
      }));

      state.users = users.map(u => ({
        ...u,
        id: String(u.id || ''),
        username: String(u.username || ''),
        password: String(u.password || ''),
        role: String(u.role || '')
      }));

      const sanitizedMeta = Object.assign({ createdAt: new Date().toISOString(), registrySeq: 0 }, meta);
      ['unitSearch','unitOverviewSearch','leaseSearch','leaseOverviewSearch','registrySearch'].forEach(f => { sanitizedMeta[f] = String(sanitizedMeta[f] || ''); });
      ['devCompanies','devRentals','devSuppliers','devPayments','devArrangements'].forEach(f => {
        const v = sanitizedMeta[f];
        if(Array.isArray(v)){ /* already parsed */ }
        else if(typeof v === 'string' && v.trim().startsWith('[')){
          try{ sanitizedMeta[f] = JSON.parse(v); }catch(e){ sanitizedMeta[f] = []; }
        } else { sanitizedMeta[f] = []; }
      });
      // Ensure registrySeq never goes backwards relative to existing registries
      const _autoRefreshMaxSeq = state.registries.reduce((max, r) => Math.max(max, Number(r.seq) || 0), 0);
      if(_autoRefreshMaxSeq > (sanitizedMeta.registrySeq || 0)){
        sanitizedMeta.registrySeq = _autoRefreshMaxSeq;
      }
      // Auto-refresh guard: if Sheets returned empty config arrays but we have good data
      // in the snapshot, keep the snapshot values — never let a transient empty response
      // poison the snapshot and bypass the saveState() guard on the next user action.
      _CFG_FIELDS.forEach(f => {
        if((!Array.isArray(sanitizedMeta[f]) || sanitizedMeta[f].length === 0)
           && Array.isArray(_sheetConfigSnapshot[f]) && _sheetConfigSnapshot[f].length > 0){
          console.warn('[Auto-refresh guard] Sheets returned empty "' + f + '" — keeping existing values');
          sanitizedMeta[f] = _sheetConfigSnapshot[f].slice();
        }
      });
      state.meta = sanitizedMeta;
      // Keep snapshot in sync — safe because config fields are already protected above
      _updateSheetConfigSnapshot();

      // Silent state update only — no renderAll() to avoid freezing large datasets
      updateTimestamp();

    }catch(e){
      console.warn('Auto-refresh skipped:', e.message);
    }
    _refreshRunning = false;
  }, 60000);

  updateTimestamp();
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
  // Ensure all meta data is included before export
  state.meta = state.meta || {};
  state.meta.devCompanies = state.meta.devCompanies || [];
  state.meta.devRentals = state.meta.devRentals || [];
  state.meta.devSuppliers = state.meta.devSuppliers || [];
  state.meta.devArrangements = state.meta.devArrangements || [];
  state.meta.devPayments = state.meta.devPayments || [];
  
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

// Login page import button and drag-and-drop
const loginImportInput = qs('#loginImportInput');
const loginGate = qs('#loginGate');

if (loginImportInput) {
  loginImportInput.addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (!confirm('Importing will replace current local data. Continue?')) return;
      // basic validation
      if (typeof parsed !== 'object') throw new Error('Invalid JSON root');
      state = Object.assign(JSON.parse(JSON.stringify(defaultData)), parsed);
      saveState();
      alert('Import successful! You can now log in.');
    } catch (err) {
      alert('Failed to import: ' + err.message);
    }
    e.target.value = '';
  });
}

// Add drag-and-drop functionality to login page
if (loginGate) {
  let dragCounter = 0;
  
  loginGate.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragCounter++;
    if (dragCounter === 1) {
      loginGate.style.backgroundColor = '#e0f2fe';
      loginGate.style.border = '2px dashed #0b74de';
    }
  });
  
  loginGate.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragCounter--;
    if (dragCounter === 0) {
      loginGate.style.backgroundColor = '';
      loginGate.style.border = '';
    }
  });
  
  loginGate.addEventListener('dragover', (e) => {
    e.preventDefault();
  });
  
  loginGate.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragCounter = 0;
    loginGate.style.backgroundColor = '';
    loginGate.style.border = '';
    
    const files = e.dataTransfer.files;
    if (!files || files.length === 0) return;
    
    const file = files[0];
    if (!file.name.endsWith('.json')) {
      alert('Please drop a JSON file');
      return;
    }
    
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (!confirm('Importing will replace current local data. Continue?')) return;
      // basic validation
      if (typeof parsed !== 'object') throw new Error('Invalid JSON root');
      state = Object.assign(JSON.parse(JSON.stringify(defaultData)), parsed);
      saveState();
      alert('Import successful! You can now log in.');
    } catch (err) {
      alert('Failed to import: ' + err.message);
    }
  });
}

// Clear data button removed by user request

// ========================
// CC Control
// ========================
let _ccEditId = null;

function syncUnitCostCenterOptions(){
  ['#unitCostCenter', '#editUnitCostCenter'].forEach(sel => {
    const el = qs(sel);
    if(!el) return;
    const cur = el.value;
    el.innerHTML = '<option value="">(Cost Center)</option>';
    (state.ccCenters || []).forEach(cc => {
      const opt = document.createElement('option');
      opt.value = cc.costCenter;
      opt.textContent = cc.costCenter + (cc.referenceId ? ' — ' + cc.referenceId : '');
      el.appendChild(opt);
    });
    if(cur) el.value = cur;
  });
}

function syncCCCompanyOptions(){
  const wrap = qs('#ccCompanyMultiWrap');
  if(!wrap) return;
  if(!wrap._selected) wrap._selected = [];

  // Build the toggle display + dropdown once
  if(!wrap._displayEl){
    const displayEl = document.createElement('div');
    displayEl.style.cssText = 'padding:8px 10px;border:1px solid #000;border-radius:6px;background:#fff;cursor:pointer;font-size:14px;color:#000;min-width:180px;user-select:none;display:flex;justify-content:space-between;align-items:center;gap:8px;';
    const textSpan = document.createElement('span');
    textSpan.id = 'ccCompanyDisplayText';
    textSpan.textContent = '(Company)';
    textSpan.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    const arrow = document.createElement('span');
    arrow.textContent = '▾';
    arrow.style.cssText = 'opacity:0.5;font-size:11px;flex-shrink:0;';
    displayEl.appendChild(textSpan);
    displayEl.appendChild(arrow);
    wrap.appendChild(displayEl);

    const dropdownEl = document.createElement('div');
    dropdownEl.style.cssText = 'display:none;position:absolute;top:calc(100% + 2px);left:0;z-index:9999;background:#fff;border:1px solid #e6e9ee;border-radius:6px;box-shadow:0 4px 16px rgba(0,0,0,0.1);min-width:220px;max-height:220px;overflow-y:auto;padding:4px 0;';
    wrap.appendChild(dropdownEl);
    wrap._displayEl = displayEl;
    wrap._dropdownEl = dropdownEl;

    displayEl.addEventListener('click', e => {
      e.stopPropagation();
      dropdownEl.style.display = dropdownEl.style.display === 'none' ? 'block' : 'none';
    });
    dropdownEl.addEventListener('click', e => e.stopPropagation());
    document.addEventListener('click', () => { if(dropdownEl) dropdownEl.style.display = 'none'; });
  }

  const dropdownEl = wrap._dropdownEl;
  const textSpan = qs('#ccCompanyDisplayText');

  // Rebuild checkbox list (preserves _selected)
  dropdownEl.innerHTML = '';
  (state.meta.devCompanies || []).forEach(c => {
    const label = document.createElement('label');
    label.style.cssText = 'display:flex;align-items:center;gap:10px;padding:8px 14px;cursor:pointer;font-size:13px;';
    label.onmouseenter = () => label.style.background = '#f3f6fb';
    label.onmouseleave = () => label.style.background = '';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = c;
    cb.checked = wrap._selected.includes(c);
    cb.style.cssText = 'cursor:pointer;width:15px;height:15px;accent-color:#0b74de;flex-shrink:0;';
    cb.addEventListener('change', e => {
      e.stopPropagation();
      if(cb.checked){ if(!wrap._selected.includes(c)) wrap._selected.push(c); }
      else { wrap._selected = wrap._selected.filter(x => x !== c); }
      if(textSpan) textSpan.textContent = wrap._selected.length > 0 ? wrap._selected.join(', ') : '(Company)';
    });

    label.appendChild(cb);
    label.appendChild(document.createTextNode(c));
    dropdownEl.appendChild(label);
  });

  // Keep display text in sync
  if(textSpan) textSpan.textContent = wrap._selected.length > 0 ? wrap._selected.join(', ') : '(Company)';
}

function getCCCompanySelection(){
  const wrap = qs('#ccCompanyMultiWrap');
  return (wrap && wrap._selected && wrap._selected.length > 0) ? wrap._selected.join(', ') : '';
}

function setCCCompanySelection(valueStr){
  const wrap = qs('#ccCompanyMultiWrap');
  if(!wrap) return;
  wrap._selected = (valueStr || '').split(',').map(s => s.trim()).filter(Boolean);
  syncCCCompanyOptions();
}

function renderCCControl(){
  syncCCCompanyOptions();
  syncUnitCostCenterOptions();
  const tbody = qs('#ccTableBody');
  const emptyMsg = qs('#ccEmpty');
  if(!tbody) return;
  if(!state.ccCenters) state.ccCenters = [];
  const centers = state.ccCenters;
  tbody.innerHTML = '';
  if(centers.length === 0){
    if(emptyMsg) emptyMsg.style.display = 'block';
    return;
  }
  if(emptyMsg) emptyMsg.style.display = 'none';
  centers.forEach((cc, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(cc.costCenter||'')}</td>
      <td>${escapeHtml(cc.referenceId||'')}</td>
      <td>${escapeHtml(cc.company||'')}</td>
      <td>${escapeHtml(cc.location||'')}</td>
      <td>${escapeHtml(cc.address||'')}</td>
      <td style="text-align:center;white-space:nowrap;">
        <button class="cc-edit-btn" data-i="${i}" style="margin-right:4px;">Edit</button>
        <button class="cc-del-btn" data-i="${i}">Del</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
  tbody.querySelectorAll('.cc-edit-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const cc = (state.ccCenters || [])[Number(btn.dataset.i)];
      if(!cc) return;
      _ccEditId = cc.id;
      qs('#ccCostCenter').value = cc.costCenter || '';
      qs('#ccReferenceId').value = cc.referenceId || '';
      setCCCompanySelection(cc.company || '');
      qs('#ccLocation').value = cc.location || '';
      qs('#ccAddress').value = cc.address || '';
      qs('#ccAddBtn').textContent = 'Save';
      qs('#ccCancelBtn').style.display = '';
      qs('#ccCostCenter').focus();
    });
  });
  tbody.querySelectorAll('.cc-del-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const i = Number(btn.dataset.i);
      if(!confirm('Delete this cost center?')) return;
      const deleted = state.ccCenters[i];
      state.ccCenters.splice(i, 1);
      DB.deleteCCCenter(deleted.id).catch(e => console.error('CC delete error:', e));
      renderCCControl();
    });
  });
}

(function(){
  function clearCCForm(){
    qs('#ccCostCenter').value = '';
    qs('#ccReferenceId').value = '';
    setCCCompanySelection('');
    qs('#ccLocation').value = '';
    qs('#ccAddress').value = '';
    qs('#ccAddBtn').textContent = 'Add';
    qs('#ccCancelBtn').style.display = 'none';
    _ccEditId = null;
  }
  qs('#ccAddBtn').addEventListener('click', () => {
    const costCenter = qs('#ccCostCenter').value.trim();
    const referenceId = qs('#ccReferenceId').value.trim();
    const company = getCCCompanySelection();
    const location = qs('#ccLocation').value.trim();
    const address = qs('#ccAddress').value.trim();
    if(!costCenter){ alert('Cost Center name is required.'); qs('#ccCostCenter').focus(); return; }
    if(!state.ccCenters) state.ccCenters = [];
    if((state.ccCenters).some(c => c.costCenter.toLowerCase() === costCenter.toLowerCase() && c.id !== _ccEditId)){ alert('"' + costCenter + '" already exists.'); qs('#ccCostCenter').focus(); return; }
    if(_ccEditId){
      const idx = state.ccCenters.findIndex(c => c.id === _ccEditId);
      if(idx !== -1){
        state.ccCenters[idx] = { ...state.ccCenters[idx], costCenter, referenceId, company, location, address };
        DB.updateCCCenter(state.ccCenters[idx]).catch(e => console.error('CC update error:', e));
      }
    } else {
      const newCC = { id: id(), costCenter, referenceId, company, location, address, createdAt: new Date().toISOString() };
      state.ccCenters.push(newCC);
      DB.saveCCCenter(newCC).catch(e => console.error('CC save error:', e));
    }
    clearCCForm();
    renderCCControl();
  });
  qs('#ccCancelBtn').addEventListener('click', () => clearCCForm());
})();

function renderAll(){ renderOverview(); renderInvoices(); renderRegistries(); renderUnits(); renderLeases(); renderUsers(); renderUnitOverview(); renderLeaseOverview(); renderReport(); renderCCControl(); }

// Helper function to format date from YYYY-MM-DD to MM/DD/YYYY
function formatDateToUS(dateStr){
  if(!dateStr) return '';
  const parts = dateStr.split('-');
  if(parts.length !== 3) return dateStr;
  return `${parts[1]}/${parts[2]}/${parts[0]}`;
}

// Helper function to extract disabled periods from unit status history
function getDisabledPeriods(unit){
  const statusHistory = unit.statusHistory || [];
  
  // Check for legacy data first
  if(statusHistory.length === 0){
    // If unit has legacy disabledDate, return it
    if(unit.disabledDate){
      return [{
        fromDate: unit.disabledDate,
        toDate: unit.enabledDate || null,
        isLegacy: true
      }];
    }
    return [];
  }
  
  // Sort history by date
  const sortedHistory = [...statusHistory].sort((a, b) => {
    const dateA = a.date || a.timestamp;
    const dateB = b.date || b.timestamp;
    return new Date(dateA) - new Date(dateB);
  });
  
  const disabledPeriods = [];
  let currentDisabledStart = null;
  
  sortedHistory.forEach(entry => {
    if(entry.status === 'Disabled'){
      if(!currentDisabledStart){
        currentDisabledStart = entry.date;
      }
    } else if(entry.status === 'Operational'){
      if(currentDisabledStart){
        disabledPeriods.push({
          fromDate: currentDisabledStart,
          toDate: entry.date,
          isLegacy: false
        });
        currentDisabledStart = null;
      }
    }
  });
  
  // Open-ended period
  if(currentDisabledStart){
    disabledPeriods.push({
      fromDate: currentDisabledStart,
      toDate: null,
      isLegacy: false
    });
  }

  return disabledPeriods;
}

// Recompute unit.status / disabledDate / enabledDate from the chronologically last
// statusHistory entry. Must be called after any edit/delete of statusHistory entries
// so the current status stays consistent with the (possibly shortened) history —
// otherwise the Unit Control table and coverage views disagree with each other.
function syncUnitStatusFromHistory(unit){
  const statusHistory = unit.statusHistory || [];

  if(statusHistory.length === 0){
    unit.status = 'Operational';
    delete unit.disabledDate;
    delete unit.enabledDate;
    return;
  }

  const sortedHistory = [...statusHistory].sort((a, b) => {
    const dateA = a.date || a.timestamp;
    const dateB = b.date || b.timestamp;
    return new Date(dateA) - new Date(dateB);
  });

  const lastEntry = sortedHistory[sortedHistory.length - 1];

  if(lastEntry.status === 'Disabled'){
    unit.status = 'Disabled';
    unit.disabledDate = lastEntry.date;
    delete unit.enabledDate;
  } else {
    unit.status = 'Operational';
    unit.enabledDate = lastEntry.date;
    delete unit.disabledDate;
  }
}

// Check if a specific date falls within any disabled period
function isDateInDisabledPeriod(year, month, day, disabledPeriods){
  if(disabledPeriods.length === 0) return false;
  
  const monthStr = String(month + 1).padStart(2, '0');
  const dayStr = String(day).padStart(2, '0');
  const checkDateStr = `${year}-${monthStr}-${dayStr}`;
  
  return disabledPeriods.some(period => {
    if(!period.toDate){
      return checkDateStr >= period.fromDate;
    }
    return checkDateStr >= period.fromDate && checkDateStr < period.toDate;
  });
}

// Render the Unit Overview page: year/month selectors and per-unit day grid
function renderUnitOverview(){
  const el = qs('#unitOverview'); if(!el) return;
  el.innerHTML = '';

  // Initialize all units with status history
  (state.units || []).forEach(unit => {
    if(!unit.statusHistory || unit.statusHistory.length === 0){
      // Check if this is a legacy disabled unit
      if(unit.status === 'Disabled' && unit.disabledDate){
        // Create status history based on legacy data
        unit.statusHistory = [
          {
            status: 'Operational',
            date: '2025-01-01',
            changedBy: 'System',
            timestamp: '2025-01-01T00:00:00.000Z'
          },
          {
            status: 'Disabled',
            date: unit.disabledDate,
            changedBy: 'System',
            timestamp: new Date(unit.disabledDate).toISOString()
          }
        ];
      } else {
        // Default to operational
        unit.statusHistory = [{
          status: 'Operational',
          date: '2025-01-01',
          changedBy: 'System',
          timestamp: '2025-01-01T00:00:00.000Z'
        }];
        if(!unit.status) unit.status = 'Operational';
      }
    }
  });

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
  searchInput.placeholder = 'Filter by unit, lease, arrangement, invoicing... ("," = or, ";" = and)';
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
  
  // Visual Status Labels helper (right-aligned clickable label)
  const labelsLink = document.createElement('span');
  labelsLink.textContent = 'Visual Status Labels';
  labelsLink.style.marginLeft = 'auto';
  labelsLink.style.fontSize = '12px';
  labelsLink.style.color = '#6b7280';
  labelsLink.style.cursor = 'pointer';
  labelsLink.style.userSelect = 'none';
  labelsLink.setAttribute('role','button');
  labelsLink.setAttribute('aria-label','Open visual status labels legend');
  labelsLink.addEventListener('mouseenter', () => { labelsLink.style.textDecoration = 'underline'; });
  labelsLink.addEventListener('mouseleave', () => { labelsLink.style.textDecoration = 'none'; });
  labelsLink.addEventListener('click', () => { openVisualLabelsModal(); });
  controls.appendChild(labelsLink);
  
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
    { text: 'Cost Center', key: 'costCenter' },
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
  
  // Filter by search term(s) — comma = OR, semicolon = AND (see parseSearchGroups)
  const searchGroups = parseSearchGroups(state.meta.unitOverviewSearch);
  if(searchGroups.length > 0){
    units = units.filter(u => {
      const unitId = (u.unitId || '').toString().toLowerCase();
      const lease = (u.lease || '').toString().toLowerCase();
      const costCenter = (u.costCenter || '').toString().toLowerCase();
      const supplier = (u.supplier || '').toString().toLowerCase();
      const arrangement = (u.arrangement || '').toString().toLowerCase();
      const invoicing = (u.invoicing || '').toString().toLowerCase();
      const status = (u.status || '').toString().toLowerCase();
      return matchesSearchGroups(searchGroups, [unitId, lease, costCenter, supplier, arrangement, invoicing, status]);
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
    emptyCell.colSpan = headers.length + daysInMonth;
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

      // Show red ! indicator if the unit has comments for the selected month/year
      try {
        const src = [];
        if (Array.isArray(u.overviewComments)) src.push(...u.overviewComments);
        if (Array.isArray(u.comments)) src.push(...u.comments);
        const hasMonthComment = src.some(c => {
          if (c && c.monthYear && typeof c.monthYear.year === 'number' && typeof c.monthYear.month === 'number') {
            return c.monthYear.year === selectedYear && c.monthYear.month === selectedMonth;
          }
          if (c && c.timestamp) {
            const d = new Date(c.timestamp);
            return d.getFullYear() === selectedYear && d.getMonth() === selectedMonth;
          }
          return false;
        });

        if (hasMonthComment) {
          const alertIcon = document.createElement('span');
          alertIcon.textContent = ' !';
          alertIcon.style.color = '#dc2626';
          alertIcon.style.fontWeight = '700';
          alertIcon.style.marginLeft = '6px';
          alertIcon.style.cursor = 'pointer';
          alertIcon.title = 'Comments exist for this month';
          alertIcon.addEventListener('click', (e) => {
            e.stopPropagation();
            try {
              openCommentsModalFromWdNumbers(u.unitId, selectedYear, selectedMonth);
            } catch(err) {}
          });
          tdUnit.appendChild(alertIcon);
        }
      } catch(e) {}
      tdUnit.addEventListener('click', () => {
        openUnitWdNumbersModal(u.unitId, year, month, units.map(x => x.unitId));
      });
      row.appendChild(tdUnit);

      // Lease column
      const tdLease = document.createElement('td');
      tdLease.style.padding = '6px';
      tdLease.style.fontSize = '12px';
      tdLease.style.verticalAlign = 'middle';
      tdLease.textContent = u.lease || '';
      row.appendChild(tdLease);

      // Cost Center column
      const tdCostCenter = document.createElement('td');
      tdCostCenter.style.padding = '6px';
      tdCostCenter.style.fontSize = '12px';
      tdCostCenter.style.verticalAlign = 'middle';
      tdCostCenter.textContent = u.costCenter || '';
      row.appendChild(tdCostCenter);

      // Supplier column
      const tdSupplier = document.createElement('td');
      tdSupplier.style.padding = '6px';
      tdSupplier.style.fontSize = '12px';
      tdSupplier.style.verticalAlign = 'middle';
      tdSupplier.textContent = u.supplier || '';
      row.appendChild(tdSupplier);

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
      const creditDays = new Set(); // Track days covered by credit category
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
        
        // Check if registry or matching invoice has a category
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
        const hasCreditCategory = category === 'credit';
        
        if(isInRegistry && reg.periodStart && reg.periodEnd){
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
                
                // Track rental coverage for count
                if(hasRentalCategory){
                  coveredDays.set(day, (coveredDays.get(day) || 0) + 1);
                }
                
                // Track credit coverage separately
                if(hasCreditCategory){
                  creditDays.add(day);
                }
              }
              currentDate.setDate(currentDate.getDate() + 1);
            }
          }
        }
      });

      // Get disabled periods for this unit
      const disabledPeriods = getDisabledPeriods(u);

      // Day columns - create squares for each day with day numbers inside
      for(let d = 1; d <= daysInMonth; d++){
        const tdDay = document.createElement('td');
        tdDay.style.padding = '2px';
        tdDay.style.textAlign = 'center';
        tdDay.style.verticalAlign = 'middle';
        
        // Check if this day is in a disabled period
        const isDisabled = isDateInDisabledPeriod(year, month, d, disabledPeriods);
        
        // Apply red background to the cell if disabled
        if(isDisabled){
          tdDay.style.backgroundColor = '#dc2626';
        }

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
        
        // Check if this day has credit category coverage
        const hasCredit = creditDays.has(d);
        
        // Highlight based on coverage count
        const coverageCount = coveredDays.get(d) || 0;
        
        if(hasCredit){
          // Yellow border and text for credit category (takes priority)
          square.style.borderColor = '#eab308';
          square.style.borderWidth = '2px';
          square.style.color = '#eab308';
          square.style.fontWeight = '700';
          
          // Keep background based on rental coverage
          if(coverageCount > 1){
            square.style.backgroundColor = '#fee2e2';
            square.title = `Credit category | Overlap: ${coverageCount} rental registries`;
          } else if(coverageCount === 1){
            square.style.backgroundColor = '#dcfce7';
            square.title = 'Credit category | Single rental coverage';
          } else {
            square.style.backgroundColor = '#fff';
            square.title = 'Credit category';
          }
        } else if(coverageCount > 1){
          // Red for overlaps (2 or more registries covering the same day)
          square.style.backgroundColor = '#fee2e2';
          square.style.borderColor = '#dc2626';
          square.style.color = '#991b1b';
          square.style.fontWeight = '600';
          square.title = `Overlap: ${coverageCount} registries cover this day`;
        } else if(coverageCount === 1){
          // Green for single coverage (even if disabled)
          square.style.backgroundColor = '#dcfce7';
          square.style.borderColor = '#16a34a';
          square.style.color = '#15803d';
          square.style.fontWeight = '600';
        } else if(isDisabled){
          // White square on red background for disabled periods with no coverage
          square.style.backgroundColor = '#ffffff';
          square.style.borderColor = '#991b1b';
          square.style.color = '#dc2626';
          square.style.fontWeight = '600';
        } else {
          // White for no coverage
          square.style.backgroundColor = '#fff';
          square.style.color = '#6b7280';
        }
        
        // Add tooltip for disabled periods
        if(isDisabled){
          const matchingPeriod = disabledPeriods.find(p => isDateInDisabledPeriod(year, month, d, [p]));
          if(matchingPeriod){
            const fromDate = matchingPeriod.fromDate;
            const toDate = matchingPeriod.toDate || 'Present';
            const disabledMsg = `Unit Disabled: ${fromDate} to ${toDate}`;
            if(square.title){
              square.title += ` | ${disabledMsg}`;
            } else {
              square.title = disabledMsg;
            }
          }
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

// A registry can now span multiple leases (stored in reg.leases); fall back to the legacy
// single reg.lease string for older registries that predate that field.
function registryHasLease(reg, leaseKeyLower){
  if(!reg) return false;
  if(Array.isArray(reg.leases) && reg.leases.length){
    return reg.leases.some(l => (l||'').toString().trim().toLowerCase() === leaseKeyLower);
  }
  return (reg.lease||'').toString().trim().toLowerCase() === leaseKeyLower;
}
function registryHasAnyLease(reg){
  if(!reg) return false;
  if(Array.isArray(reg.leases) && reg.leases.length) return true;
  return (reg.lease||'').toString().trim() !== '';
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
  searchInput.placeholder = 'Filter by lease, company, supplier, invoicing... ("," = or, ";" = and)';
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
  
  // Filter by search term(s) — comma = OR, semicolon = AND (see parseSearchGroups)
  const searchGroups = parseSearchGroups(state.meta.leaseOverviewSearch);
  if(searchGroups.length > 0){
    leases = leases.filter(l => {
      const leaseNumber = (l.leaseNumber || '').toString().toLowerCase();
      const company = (l.company || '').toString().toLowerCase();
      const supplier = (l.supplier || '').toString().toLowerCase();
      const arrangement = (l.arrangement || '').toString().toLowerCase();
      const invoicing = (l.invoicing || '').toString().toLowerCase();
      const status = (l.status || '').toString().toLowerCase();
      return matchesSearchGroups(searchGroups, [leaseNumber, company, supplier, arrangement, invoicing, status]);
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
        if(row.dataset.allUnitsDisabled === 'true') return;
        if(row.style.backgroundColor !== 'rgb(224, 242, 254)') {
          row.style.backgroundColor = '#f3f6fb';
        }
      });
      row.addEventListener('mouseleave', () => {
        if(row.dataset.allUnitsDisabled === 'true') return;
        if(row.style.backgroundColor !== 'rgb(224, 242, 254)') {
          row.style.backgroundColor = '';
        }
      });
      
      // Click handler for row highlighting
      row.addEventListener('click', () => {
        if(row.dataset.allUnitsDisabled === 'true') return;
        // Remove highlight from all rows in this table
        const allRows = tbody.querySelectorAll('tr');
        allRows.forEach(r => {
          r.style.backgroundColor = '';
        });
        // Highlight clicked row
        row.style.backgroundColor = '#e0f2fe';
      });

      // If all units under this lease are Disabled, mark the row with a red background
      try{
        const leaseKey = (lease.leaseNumber||lease.id||'').toString().trim().toLowerCase();
        const unitsForLease = (state.units||[]).filter(u => (u.lease||'').toString().trim().toLowerCase() === leaseKey);
        const allDisabled = unitsForLease.length > 0 && unitsForLease.every(u => (u.status||'Operational').toString().trim() === 'Disabled');
        if(allDisabled){
          row.style.backgroundColor = '#fee2e2';
          row.dataset.allUnitsDisabled = 'true';
        }
      }catch(e){}

      // Lease Number
      const tdLeaseNum = document.createElement('td');
      tdLeaseNum.style.padding = '6px';
      tdLeaseNum.style.fontSize = '12px';
      tdLeaseNum.style.fontWeight = '600';
      tdLeaseNum.textContent = lease.leaseNumber || '(no number)';
      tdLeaseNum.style.color = '#0b74de';
      tdLeaseNum.style.cursor = 'pointer';
      tdLeaseNum.title = 'View lease info';
      tdLeaseNum.addEventListener('click', (ev) => {
        ev.stopPropagation();
        try{ openLeaseOverviewInfo(lease); }catch(e){}
      });
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
        const leaseNum = (lease.leaseNumber || '').toString().trim().toLowerCase();

        if(registryHasLease(reg, leaseNum)){
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
          return regWd === invWd && registryHasAnyLease(reg);
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

// Open informational panel for a lease in Lease Overview
function openLeaseOverviewInfo(lease){
  const modal = qs('#leaseOverviewInfoModal');
  const titleEl = qs('#leaseOverviewInfoTitle');
  const contentEl = qs('#leaseOverviewInfoContent');
  if(!modal || !contentEl) return;
  if(titleEl) titleEl.textContent = `Lease ${escapeHtml(lease.leaseNumber||lease.id||'')}`;
  const status = lease.status || 'Enabled';
  const disabledDate = lease.disabledDate || '';
  const enabledDate = lease.enabledDate || '';

  // Selected month/year from Lease Overview controls
  const now = new Date();
  const selectedYear = (state.meta && typeof state.meta.leaseOverviewYear !== 'undefined') ? parseInt(state.meta.leaseOverviewYear, 10) : now.getFullYear();
  const selectedMonth = (state.meta && typeof state.meta.leaseOverviewMonth !== 'undefined') ? parseInt(state.meta.leaseOverviewMonth, 10) : now.getMonth();
  const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];

  const leaseKey = (lease.leaseNumber||lease.id||'').toString().trim().toLowerCase();

  // Helper: check overlap with selected month/year
  function overlapsSelectedMonth(fromStr, toStr){
    if(!fromStr || !toStr) return false;
    const sp = fromStr.toString().trim().split('-');
    const ep = toStr.toString().trim().split('-');
    if(sp.length < 3 || ep.length < 3) return false;
    const sd = new Date(parseInt(sp[0],10), parseInt(sp[1],10)-1, parseInt(sp[2],10));
    const ed = new Date(parseInt(ep[0],10), parseInt(ep[1],10)-1, parseInt(ep[2],10));
    if(isNaN(sd.getTime()) || isNaN(ed.getTime())) return false;
    const mStart = new Date(selectedYear, selectedMonth, 1);
    const mEnd = new Date(selectedYear, selectedMonth + 1, 0);
    return sd <= mEnd && ed >= mStart;
  }

  // Units under lease
  const units = (state.units||[]).filter(u => {
    const uLease = (u.lease||'').toString().trim().toLowerCase();
    return uLease === leaseKey && (u.unitId || u.id);
  });

  // Registries for this lease overlapping selected month
  const registries = (state.registries||[]).filter(r => {
    return registryHasLease(r, leaseKey) && overlapsSelectedMonth(r.periodStart, r.periodEnd);
  });
  function getRegistryCategory(reg){
    if(reg.category) return (reg.category||'').toString().trim().toLowerCase();
    const inv = (state.invoices||[]).find(inv => {
      const invWd = (inv.wdNumber||'').toString().trim().toLowerCase();
      const regWd = (reg.wdNumber||'').toString().trim().toLowerCase();
      return invWd === regWd;
    });
    return (inv && inv.category) ? inv.category.toString().trim().toLowerCase() : '';
  }

  // Standalone invoices overlapping selected month, not covered by registry with lease
  const regWdWithLease = new Set((state.registries||[])
    .filter(r => registryHasAnyLease(r))
    .map(r => (r.wdNumber||'').toString().trim().toLowerCase()));
  const invoices = (state.invoices||[]).filter(inv => {
    const invLease = (inv.lease||'').toString().trim().toLowerCase();
    const invWd = (inv.wdNumber||'').toString().trim().toLowerCase();
    const hasRegWithLease = regWdWithLease.has(invWd);
    return invLease === leaseKey && overlapsSelectedMonth(inv.periodStart, inv.periodEnd) && !hasRegWithLease;
  });

  // Build content: details grid
  let html = '';
  html += `<div style="display:grid;grid-template-columns:140px 1fr;gap:6px 12px;font-size:13px;margin-bottom:12px;">
      <div style="color:#6b7280;font-weight:600;">Company</div><div>${escapeHtml(lease.company||'')}</div>
      <div style="color:#6b7280;font-weight:600;">Supplier</div><div>${escapeHtml(lease.supplier||'')}</div>
      <div style="color:#6b7280;font-weight:600;">Arrangement</div><div>${escapeHtml(lease.arrangement||'')}</div>
      <div style="color:#6b7280;font-weight:600;">Invoicing</div><div>${escapeHtml(lease.invoicing||'')}</div>
      <div style="color:#6b7280;font-weight:600;">Status</div><div>${escapeHtml(status)}${status==='Disabled' && disabledDate ? ' — Disabled: '+escapeHtml(disabledDate) : (status==='Enabled' && enabledDate ? ' — Enabled: '+escapeHtml(enabledDate) : '')}</div>
    </div>`;

  // Units chips
  html += `<h4 style="margin:8px 0">Units under this lease</h4>`;
  if(units.length === 0){
    html += `<div class="small-muted">No units found for this lease.</div>`;
  } else {
    html += `<div style="display:flex;flex-wrap:wrap;gap:6px;">`;
    units.forEach(u => {
      const isDisabled = ((u.status||'').toString().trim() === 'Disabled');
      const chipStyle = isDisabled
        ? 'display:inline-block;padding:4px 8px;border:1px solid #dc2626;border-radius:999px;background:#fee;color:#dc2626;font-size:12px;font-weight:600;'
        : 'display:inline-block;padding:4px 8px;border:1px solid #e5e7eb;border-radius:999px;background:#f9fafb;font-size:12px;';
      html += `<span style="${chipStyle}">${escapeHtml(u.unitId||u.id||'')}</span>`;
    });
    html += `</div>`;
  }

  // Rental registries list (WD + Amount + Period)
  const rentalRegistries = registries.filter(r => getRegistryCategory(r) === 'rental');
  html += `<h4 style="margin:12px 0 8px">Rental Invoices in ${monthNames[selectedMonth]} ${selectedYear}</h4>`;
  if(rentalRegistries.length === 0){
    html += `<div class="small-muted">No rental invoices for the selected period.</div>`;
  } else {
    html += `<div>`;
    rentalRegistries.forEach(r => {
      const formatDate = (dateStr) => {
        if (!dateStr) return '';
        const parts = dateStr.split('-');
        if (parts.length === 3) {
          const d = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
          return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        }
        return dateStr;
      };
      html += `<div style="padding:10px;border-bottom:1px solid #e5e7eb;">
        <div style="font-weight:600;color:#111827;">${escapeHtml(r.wdNumber||'')}</div>
        <div style="color:#2563eb;font-size:12px;margin-top:2px;font-weight:600;">Amount: ${formatCurrency(r.totalAmount||'')}</div>
        <div style="color:#6b7280;font-size:12px;margin-top:4px;">${formatDate(r.periodStart)} - ${formatDate(r.periodEnd)}</div>
      </div>`;
    });
    html += `</div>`;
  }

  // Credit invoices (Doc + WD + Amount + Period)
  html += `<h4 style="margin:12px 0 8px">Credit Invoices in ${monthNames[selectedMonth]} ${selectedYear}</h4>`;
  const creditInvoices = invoices.filter(inv => (inv.category||'').toString().trim().toLowerCase() === 'credit');
  if(creditInvoices.length === 0){
    html += `<div class="small-muted">No credit invoices for the selected period.</div>`;
  } else {
    html += `<div>`;
    creditInvoices.forEach(inv => {
      const formatDate = (dateStr) => {
        if (!dateStr) return '';
        const parts = dateStr.split('-');
        if (parts.length === 3) {
          const d = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
          return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        }
        return dateStr;
      };
      html += `<div style="padding:10px;border-bottom:1px solid #e5e7eb;">
        <div style="font-weight:600;color:#111827;">Doc: ${escapeHtml(inv.docNumber||'')}</div>
        <div style="color:#6b7280;font-size:12px;margin-top:2px;">WD: ${escapeHtml(inv.wdNumber||'')}</div>
        <div style="color:#ef4444;font-size:12px;margin-top:2px;font-weight:600;">Amount: ${formatCurrency(inv.amount||'')}</div>
        <div style="color:#6b7280;font-size:12px;margin-top:4px;">${formatDate(inv.periodStart)} - ${formatDate(inv.periodEnd)}</div>
      </div>`;
    });
    html += `</div>`;
  }

  contentEl.innerHTML = html;
  modal.style.display = 'flex';

  // Close handlers
  const closeBtn = qs('#closeLeaseOverviewInfoBtn');
  if(closeBtn){
    const newBtn = closeBtn.cloneNode(true);
    closeBtn.parentNode.replaceChild(newBtn, closeBtn);
    newBtn.addEventListener('click', ()=>{ modal.style.display = 'none'; });
  }
}

function renderReport(){
  const el = qs('#report'); if(!el) return;
  el.innerHTML = '';

  // Persist selection
  state.meta = state.meta || {};
  state.meta.reportSimple = state.meta.reportSimple || {
    year: new Date().getFullYear(),
    month: new Date().getMonth()
  };
  const sel = state.meta.reportSimple;

  // Controls: Month / Year
  const controls = document.createElement('div');
  controls.style.cssText = 'display:flex;gap:8px;align-items:center;margin-bottom:12px;';

  const monthSelect = document.createElement('select');
  const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  monthNames.forEach((name, idx)=>{
    const opt = document.createElement('option'); opt.value = String(idx); opt.textContent = name; if(idx === sel.month) opt.selected = true; monthSelect.appendChild(opt);
  });
  const yearSelect = document.createElement('select');
  const now = new Date();
  for(let y = now.getFullYear()-3; y <= now.getFullYear()+1; y++){
    const opt = document.createElement('option'); opt.value = String(y); opt.textContent = String(y); if(y === sel.year) opt.selected = true; yearSelect.appendChild(opt);
  }
  controls.appendChild(monthSelect); controls.appendChild(yearSelect);
  // Download button
  const downloadBtn = document.createElement('button');
  downloadBtn.textContent = 'Download Report';
  downloadBtn.title = 'Export to Excel (tabs per table)';
  downloadBtn.style.padding = '6px 12px';
  downloadBtn.style.border = '1px solid #0b74de';
  downloadBtn.style.background = '#0b74de';
  downloadBtn.style.color = '#fff';
  downloadBtn.style.borderRadius = '6px';
  downloadBtn.style.fontSize = '13px';
  downloadBtn.style.cursor = 'pointer';
  downloadBtn.style.marginLeft = 'auto';
  controls.appendChild(downloadBtn);
  el.appendChild(controls);
  // Auto-refresh on month/year change and persist selection
  monthSelect.addEventListener('change', ()=>{ 
    try{ 
      sel.month = parseInt(monthSelect.value, 10);
      sel.year = parseInt(yearSelect.value, 10);
      saveState();
      run(); 
    }catch(e){}
  });
  yearSelect.addEventListener('change', ()=>{ 
    try{ 
      sel.month = parseInt(monthSelect.value, 10);
      sel.year = parseInt(yearSelect.value, 10);
      saveState();
      run(); 
    }catch(e){}
  });

  const resultsWrap = document.createElement('div');
  el.appendChild(resultsWrap);

  // Computed datasets for export
  let computedFullyCovered = [];
  let computedCoverageMap = new Map();
  let computedMissingUnits = [];
  let computedCoverageMapMissing = new Map();
  let computedOverlapUnits = [];
  let computedOverlapMap = new Map();
  let computedRentalCoveredMap = new Map();
  let computedCreditUnits = [];
  let computedCreditMap = new Map();
  let computedRentalCountsMap = new Map();
  // Disabled + Covered export datasets
  let computedDisabledCoveredUnits = [];
  let computedDisabledMap = new Map();
  let computedDisabledCoverageMap = new Map();
  let computedDisabledCountsMap = new Map();
  // Consecutive months without invoicing export dataset
  let computedNoInvoiceRows = [];

  function extractMonthComments(u, year, month){
    // Consider comments added from both contexts: Unit Overview (overviewComments)
    // and Unit Control (comments). Filter by selected month/year.
    const sources = [];
    if (Array.isArray(u.overviewComments)) sources.push(...u.overviewComments);
    if (Array.isArray(u.comments)) sources.push(...u.comments);
    const monthComments = sources.filter(c => {
      if (c && c.monthYear && typeof c.monthYear.year === 'number' && typeof c.monthYear.month === 'number') {
        return c.monthYear.year === year && c.monthYear.month === month;
      }
      if (c && c.timestamp) {
        const d = new Date(c.timestamp);
        return d.getFullYear() === year && d.getMonth() === month;
      }
      return false;
    }).map(c => (c.text || '').toString());
    return monthComments;
  }

  function exportReport(){
    // Ensure latest computations before exporting
    try{ run(); }catch(e){}
    const year = sel.year; const month = sel.month; const daysInMonth = new Date(year, month+1, 0).getDate();
    if(!(window.XLSX && typeof XLSX === 'object')){ alert('Excel export library not found. Please reload the page.'); return; }
    const wb = XLSX.utils.book_new();

    // Basic workbook properties
    wb.Props = {
      Title: `Vehicle Report ${String(year)}-${String(month+1).padStart(2,'0')}`,
      Subject: 'AGI Vehicle Lease Management Reports',
      Author: 'AGI Vehicle Lease Management',
      Company: 'AGI',
      CreatedDate: new Date()
    };

    // Shared professional styles
    const baseFont = { name: 'Calibri', sz: 11 };
    const styles = {
      header: {
        font: Object.assign({}, baseFont, { bold: true, color: { rgb: 'FFFFFF' } }),
        fill: { fgColor: { rgb: '0B74DE' } },
        alignment: { horizontal: 'center', vertical: 'center' },
        border: { left:{style:'thin',color:{rgb:'0B74DE'}}, right:{style:'thin',color:{rgb:'0B74DE'}}, top:{style:'thin',color:{rgb:'0B74DE'}}, bottom: { style: 'medium', color: { rgb: '0B74DE' } } }
      },
      title: {
        font: Object.assign({}, baseFont, { bold: true, sz: 16, color: { rgb: '0B74DE' } }),
        alignment: { horizontal: 'left', vertical: 'center' }
      },
      info: { alignment: { vertical: 'center' }, font: baseFont },
      zebra: { fill: { fgColor: { rgb: 'F8FAFC' } } },
      dayBase: { alignment: { horizontal: 'center', vertical: 'center' }, font: baseFont, border: { outline: true, left: { style:'thin', color:{rgb:'DDDDDD'} }, right: { style:'thin', color:{rgb:'DDDDDD'} }, top: { style:'thin', color:{rgb:'DDDDDD'} }, bottom: { style:'thin', color:{rgb:'DDDDDD'} } } },
      dayCovered: { fill: { fgColor: { rgb: 'DCFCE7' } }, font: Object.assign({}, baseFont, { color: { rgb: '15803D' }, bold: true }) },
      dayOverlap: { fill: { fgColor: { rgb: 'FEE2E2' } }, font: Object.assign({}, baseFont, { color: { rgb: '991B1B' }, bold: true }) },
      dayNone: { fill: { fgColor: { rgb: 'FFFFFF' } }, font: Object.assign({}, baseFont, { color: { rgb: '6B7280' } }) },
      dayCreditBorder: { border: { left: { style:'medium', color:{rgb:'EAB308'} }, right: { style:'medium', color:{rgb:'EAB308'} }, top: { style:'medium', color:{rgb:'EAB308'} }, bottom: { style:'medium', color:{rgb:'EAB308'} } }, font: Object.assign({}, baseFont, { color: { rgb: 'EAB308' }, bold: true }) },
      // Disabled day styles (Excel reflects disabled periods with red background)
      dayDisabled: { fill: { fgColor: { rgb: 'FEE2E2' } }, font: Object.assign({}, baseFont, { color: { rgb: '991B1B' }, bold: true }) },
      dayDisabledCovered: { fill: { fgColor: { rgb: 'FEE2E2' } }, font: Object.assign({}, baseFont, { color: { rgb: '15803D' }, bold: true }), border: { left: { style:'medium', color:{rgb:'16A34A'} }, right: { style:'medium', color:{rgb:'16A34A'} }, top: { style:'medium', color:{rgb:'16A34A'} }, bottom: { style:'medium', color:{rgb:'16A34A'} } } }
    };

    function mergeStyles(...objs){
      const out = {}; objs.forEach(o=>{ if(!o) return; Object.keys(o).forEach(k=>{ out[k] = Object.assign({}, out[k], o[k]); }); }); return out;
    }

    function buildSheetData(unitsArr, dayStateFn, title){
      const headers = ['Unit','Lease','Supplier','Arrangement','Invoicing','Status'];
      const dayHeaders = Array.from({length: daysInMonth}, (_,i)=> {
        const d = new Date(year, month, i+1);
        return { v: d, s: Object.assign({}, styles.header, { numFmt: 'mmm d' }) };
      });
      // Determine max comments per unit for this sheet
      let maxComments = 0;
      const unitCommentsMap = new Map();
      unitsArr.forEach(u => { const mc = extractMonthComments(u, year, month); unitCommentsMap.set(u.unitId||u.id, mc); if(mc.length>maxComments) maxComments = mc.length; });
      const commentHeaders = Array.from({length: maxComments}, (_,i)=> `Comment ${i+1}`);
      const headerRow = headers.concat(dayHeaders).concat(commentHeaders.map(h => ({ v: h, s: styles.header })));
      const totalCols = headerRow.length;
      const titleText = `${title} — ${new Date(year, month, 1).toLocaleString(undefined, { month:'long' })} ${year}`;
      const titleRow = [{ v: titleText, s: styles.title }].concat(Array.from({length: totalCols-1}, ()=> ({ v: '', s: styles.title })));
      const aoa = [ titleRow, headerRow.map(h => (typeof h === 'string' ? ({ v: h, s: styles.header }) : h)) ];
      unitsArr.forEach((u, idxRow) => {
        const zebra = (idxRow % 2 === 1) ? styles.zebra : null;
        const base = [u.unitId||'', u.lease||'', u.supplier||'', u.arrangement||'', u.invoicing||'', u.status||'Operational']
          .map(v => ({ v, s: mergeStyles(styles.info, zebra) }));
        const days = [];
        for(let d=1; d<=daysInMonth; d++){
          const st = dayStateFn(u, d);
          const isCredit = !!st.credit; const isOverlap = !!st.overlap; const isCovered = !!st.covered; const isDisabled = !!st.disabled;
          const label = (isCredit || isOverlap || isCovered) ? String(d) : '';
          let s = mergeStyles(styles.dayBase, zebra);
          if(isDisabled){
            // Disabled days: red background; if covered, emphasize with green border
            s = mergeStyles(s, styles.dayDisabled);
            if(isCovered){ s = mergeStyles(s, styles.dayDisabledCovered); }
            // if overlap, keep red tone via dayOverlap (will reinforce red styling)
            else if(isOverlap){ s = mergeStyles(s, styles.dayOverlap); }
          } else {
            if(isOverlap){ s = mergeStyles(s, styles.dayOverlap); }
            else if(isCovered){ s = mergeStyles(s, styles.dayCovered); }
            else { s = mergeStyles(s, styles.dayNone); }
          }
          if(isCredit){ s = mergeStyles(s, styles.dayCreditBorder); }
          days.push({ v: label, s });
        }
        const ctexts = unitCommentsMap.get(u.unitId||u.id)||[];
        const commentCells = Array.from({length:maxComments}, (_,i)=> ({ v: ctexts[i]||'', s: mergeStyles({ alignment: { vertical:'top', wrapText: true } }, zebra) }));
        const row = base.concat(days).concat(commentCells);
        aoa.push(row);
      });
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      // Add autofilter and freeze header
      const range = XLSX.utils.encode_range({ s: { r:1, c:0 }, e: { r: aoa.length-1, c: totalCols-1 } });
      ws['!autofilter'] = { ref: range };
      ws['!freeze'] = { xSplit: 0, ySplit: 2, topLeftCell: 'A3', activePane: 'bottomLeft' };
      // Column widths: a bit wider for info columns, compact for days
      ws['!cols'] = [
        {wch:14},{wch:12},{wch:14},{wch:14},{wch:12},{wch:10},
        ...Array.from({length: daysInMonth}, ()=> ({wch:6})),
        ...Array.from({length: maxComments}, ()=> ({wch:28}))
      ];
      // Optional: set row heights for title and header
      ws['!rows'] = [{ hpt: 22 }, { hpt: 18 }];
      // Merge title row across all columns
      ws['!merges'] = [{ s: { r:0, c:0 }, e: { r:0, c: totalCols-1 } }];
      return ws;
    }

    // Legend sheet to explain day styles
    function buildLegendSheet(){
      const aoa = [
        [{ v: 'Legend', s: styles.title }],
        [{ v: 'Style', s: styles.header }, { v: 'Meaning', s: styles.header }],
        [{ v: 'Green', s: styles.dayCovered }, { v: 'Covered (single rental)' }],
        [{ v: 'Red highlight', s: styles.dayOverlap }, { v: 'Overlap (2+ rentals)' }],
        [{ v: 'Yellow border', s: styles.dayCreditBorder }, { v: 'Credit day' }],
        [{ v: 'Red background', s: styles.dayDisabled }, { v: 'Disabled period' }],
        [{ v: 'Red background + Green border', s: styles.dayDisabledCovered }, { v: 'Disabled period with coverage' }]
      ];
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      ws['!rows'] = [{ hpt: 22 }, { hpt: 18 }];
      ws['!freeze'] = { xSplit: 0, ySplit: 2, topLeftCell: 'A3', activePane: 'bottomLeft' };
      ws['!cols'] = [{wch:24},{wch:40}];
      ws['!merges'] = [{ s: { r:0, c:0 }, e: { r:0, c: 1 } }];
      return ws;
    }

    // Full Coverage sheet
    if(computedFullyCovered.length){
      const wsFull = buildSheetData(computedFullyCovered, (u,d)=>{
        const key = (u.id || u.unitId);
        const cov = computedCoverageMap.get(key) || [];
        const counts = computedRentalCountsMap.get(key) || [];
        const creditDays = computedCreditMap.get(key) || [];
        const overlap = (counts[d-1] > 1);
        const covered = !!cov[d-1];
        const periods = getDisabledPeriods(u) || [];
        const disabled = isDateInDisabledPeriod(year, month, d, periods);
        return { covered, overlap, credit: !!creditDays[d-1], disabled };
      }, 'Full Coverage');
      XLSX.utils.book_append_sheet(wb, wsFull, 'Full Coverage');
    }
    // Missing Coverage sheet
    if(computedMissingUnits.length){
      const wsMissing = buildSheetData(computedMissingUnits, (u,d)=>{
        const key = (u.id || u.unitId);
        const cov = computedCoverageMapMissing.get(key) || [];
        const counts = computedRentalCountsMap.get(key) || [];
        const creditDays = computedCreditMap.get(key) || [];
        const overlap = (counts[d-1] > 1);
        const covered = !!cov[d-1];
        // Disabled detection via status history
        const periods = getDisabledPeriods(u) || [];
        const disabled = isDateInDisabledPeriod(year, month, d, periods);
        return { covered, overlap, credit: !!creditDays[d-1], disabled };
      }, 'Missing Coverage');
      XLSX.utils.book_append_sheet(wb, wsMissing, 'Missing Coverage');
    }
    // Overlaps sheet
    if(computedOverlapUnits.length){
      const wsOverlap = buildSheetData(computedOverlapUnits, (u,d)=>{
        const key = (u.id || u.unitId);
        const overlaps = computedOverlapMap.get(key) || [];
        const covered = computedRentalCoveredMap.get(key) || [];
        const periods = getDisabledPeriods(u) || [];
        const disabled = isDateInDisabledPeriod(year, month, d, periods);
        return { covered: !!covered[d-1], overlap: !!overlaps[d-1], credit: false, disabled };
      }, 'Overlaps');
      XLSX.utils.book_append_sheet(wb, wsOverlap, 'Overlaps');
    }
    // Credit sheet
    if(computedCreditUnits.length){
      const wsCredit = buildSheetData(computedCreditUnits, (u,d)=>{
        const key = (u.id || u.unitId);
        const creditDays = computedCreditMap.get(key) || [];
        const counts = computedRentalCountsMap.get(key) || [];
        const overlap = (counts[d-1] > 1);
        const covered = (counts[d-1] === 1);
        const credit = !!creditDays[d-1];
        const periods = getDisabledPeriods(u) || [];
        const disabled = isDateInDisabledPeriod(year, month, d, periods);
        return { covered, overlap, credit, disabled };
      }, 'Credit Days');
      XLSX.utils.book_append_sheet(wb, wsCredit, 'Credit Days');
    }

    // Disabled + Covered sheet
    if(computedDisabledCoveredUnits.length){
      const wsDisabled = buildSheetData(computedDisabledCoveredUnits, (u,d)=>{
        const dis = (computedDisabledMap.get(u.id || u.unitId) || []);
        const cov = (computedDisabledCoverageMap.get(u.id || u.unitId) || []);
        const cnt = (computedDisabledCountsMap.get(u.id || u.unitId) || []);
        return { disabled: !!dis[d-1], covered: !!cov[d-1], overlap: (cnt[d-1] > 1), credit: false };
      }, 'Disabled + Covered');
      XLSX.utils.book_append_sheet(wb, wsDisabled, 'Disabled + Covered');
    }

    // Legend sheet (always append last)
    try{
      const wsLegend = buildLegendSheet();
      XLSX.utils.book_append_sheet(wb, wsLegend, 'Legend');
    }catch(e){}

    // Consecutive Months Without Invoicing sheet
    if(computedNoInvoiceRows.length){
      const headers = ['#','Unit','Lease','Supplier','Description','Invoicing','Last WD Number','Status','Consecutive Months (no rental invoice)','Period'];
      const titleText = `No Rental Invoicing — ${new Date(year, month, 1).toLocaleString(undefined, { month:'long' })} ${year}`;
      const aoa = [];
      // title row merged later
      aoa.push([titleText]);
      aoa.push(headers);
      computedNoInvoiceRows.forEach((row, idx) => {
        aoa.push([
          String(idx + 1),
          row.u.unitId||'',
          row.u.lease||'',
          row.u.supplier||'',
          row.u.description||'',
          row.u.invoicing||'',
          row.lastWd || '',
          row.u.status || 'Operational',
          String(row.streak || 0),
          row.periodText || ''
        ]);
      });
      const wsMonths = XLSX.utils.aoa_to_sheet(aoa);
      // styles: basic header bold
      const totalCols = headers.length;
      wsMonths['!rows'] = [{ hpt: 22 }, { hpt: 18 }];
      wsMonths['!merges'] = [{ s: { r:0, c:0 }, e: { r:0, c: totalCols-1 } }];
      wsMonths['!cols'] = [{wch:6},{wch:14},{wch:12},{wch:18},{wch:12},{wch:16},{wch:12},{wch:14},{wch:20}];
      XLSX.utils.book_append_sheet(wb, wsMonths, 'No Invoicing');
    }

    const fname = `Vehicle_Report_${String(year)}_${String(month+1).padStart(2,'0')}.xlsx`;
    try{ XLSX.writeFile(wb, fname); }catch(e){ alert('Failed to save Excel: ' + (e && e.message || e)); }
  }

  downloadBtn.addEventListener('click', ()=>{ try{ exportReport(); }catch(e){ alert('Export failed: ' + (e && e.message || e)); } });

  // Compute coverage array (boolean per day) for a unit in selected month
  function coverageArrayForUnit(u, year, month){
    const daysInMonth = new Date(year, month+1, 0).getDate();
    const covered = new Array(daysInMonth).fill(false);
    const unitIdNorm = (u.unitId || u.id || '').toString().trim().toLowerCase();

    // Registries (Rental) covering this unit
    (state.registries||[]).forEach(reg => {
      const units = Array.isArray(reg.units) ? reg.units.map(x=> (x||'').toString().trim().toLowerCase()) : [];
      if(!units.includes(unitIdNorm)) return;
      // Determine category
      let cat = (reg.category||'').toString().trim().toLowerCase();
      if(!cat){
        const inv = (state.invoices||[]).find(i => (i.wdNumber||'').toString().trim().toLowerCase() === (reg.wdNumber||'').toString().trim().toLowerCase());
        cat = (inv && inv.category) ? inv.category.toString().trim().toLowerCase() : '';
      }
      if(cat !== 'rental') return;
      if(!reg.periodStart || !reg.periodEnd) return;
      const sp = String(reg.periodStart).split('-'); const ep = String(reg.periodEnd).split('-');
      const start = new Date(parseInt(sp[0]), parseInt(sp[1]) - 1, parseInt(sp[2]));
      const end = new Date(parseInt(ep[0]), parseInt(ep[1]) - 1, parseInt(ep[2]));
      if(isNaN(start) || isNaN(end)) return;
      const cur = new Date(start);
      while(cur <= end){
        if(cur.getFullYear() === year && cur.getMonth() === month){
          const d = cur.getDate(); covered[d-1] = true;
        }
        cur.setDate(cur.getDate()+1);
      }
    });

    // Invoices (Rental) not in registries
    (state.invoices||[]).forEach(inv => {
      const invUnitNorm = (inv.unit||'').toString().trim().toLowerCase();
      if(invUnitNorm !== unitIdNorm) return;
      const cat = (inv.category||'').toString().trim().toLowerCase(); if(cat !== 'rental') return;
      if(!inv.periodStart || !inv.periodEnd) return;
      const sp = String(inv.periodStart).split('-'); const ep = String(inv.periodEnd).split('-');
      const start = new Date(parseInt(sp[0]), parseInt(sp[1]) - 1, parseInt(sp[2]));
      const end = new Date(parseInt(ep[0]), parseInt(ep[1]) - 1, parseInt(ep[2]));
      if(isNaN(start) || isNaN(end)) return;
      const cur = new Date(start);
      while(cur <= end){
        if(cur.getFullYear() === year && cur.getMonth() === month){
          const d = cur.getDate(); covered[d-1] = true;
        }
        cur.setDate(cur.getDate()+1);
      }
    });

    return covered;
  }

  // Count rental coverage sources per day for a unit (for overlap detection)
  function rentalCountsArrayForUnit(u, year, month){
    const daysInMonth = new Date(year, month+1, 0).getDate();
    const counts = new Array(daysInMonth).fill(0);
    const unitIdNorm = (u.unitId || u.id || '').toString().trim().toLowerCase();

    // Use registries membership and category (fallback to matching invoice category)
    const registries = state.registries || [];
    const invoices = state.invoices || [];
    registries.forEach(reg => {
      const unitsArr = Array.isArray(reg.units) ? reg.units.map(x=> (x||'').toString().trim().toLowerCase()) : [];
      if(!unitsArr.includes(unitIdNorm)) return;
      let cat = (reg.category||'').toString().trim().toLowerCase();
      if(!cat){
        const inv = invoices.find(i => (i.wdNumber||'').toString().trim().toLowerCase() === (reg.wdNumber||'').toString().trim().toLowerCase());
        cat = (inv && (inv.category||'').toString().trim().toLowerCase()) || '';
      }
      if(cat !== 'rental') return;
      const ps = reg.periodStart, pe = reg.periodEnd; if(!ps || !pe) return;
      const sp = String(ps).split('-'); const ep = String(pe).split('-');
      const start = new Date(parseInt(sp[0]), parseInt(sp[1]) - 1, parseInt(sp[2]));
      const end = new Date(parseInt(ep[0]), parseInt(ep[1]) - 1, parseInt(ep[2]));
      if(isNaN(start) || isNaN(end)) return;
      const cur = new Date(start);
      while(cur <= end){
        if(cur.getFullYear()===year && cur.getMonth()===month){ counts[cur.getDate()-1] += 1; }
        cur.setDate(cur.getDate()+1);
      }
    });
    return counts;
  }

  // Mark days with credit category coverage for a unit
  function creditArrayForUnit(u, year, month){
    const daysInMonth = new Date(year, month+1, 0).getDate();
    const credit = new Array(daysInMonth).fill(false);
    const unitIdNorm = (u.unitId || u.id || '').toString().trim().toLowerCase();
    const registries = state.registries || [];
    const invoices = state.invoices || [];
    registries.forEach(reg => {
      const unitsArr = Array.isArray(reg.units) ? reg.units.map(x=> (x||'').toString().trim().toLowerCase()) : [];
      if(!unitsArr.includes(unitIdNorm)) return;
      let cat = (reg.category||'').toString().trim().toLowerCase();
      if(!cat){
        const inv = invoices.find(i => (i.wdNumber||'').toString().trim().toLowerCase() === (reg.wdNumber||'').toString().trim().toLowerCase());
        cat = (inv && (inv.category||'').toString().trim().toLowerCase()) || '';
      }
      if(cat !== 'credit') return;
      const ps = reg.periodStart, pe = reg.periodEnd; if(!ps || !pe) return;
      const sp = String(ps).split('-'); const ep = String(pe).split('-');
      const start = new Date(parseInt(sp[0]), parseInt(sp[1]) - 1, parseInt(sp[2]));
      const end = new Date(parseInt(ep[0]), parseInt(ep[1]) - 1, parseInt(ep[2]));
      if(isNaN(start) || isNaN(end)) return;
      const cur = new Date(start);
      while(cur <= end){
        if(cur.getFullYear()===year && cur.getMonth()===month){ credit[cur.getDate()-1] = true; }
        cur.setDate(cur.getDate()+1);
      }
    });
    return credit;
  }

  function run(){
    // Keep sel in sync with controls but do not save here to avoid
    // triggering auto-refresh loops via agi:stateSaved.
    sel.month = parseInt(monthSelect.value, 10);
    sel.year = parseInt(yearSelect.value, 10);

    const year = sel.year; const month = sel.month;
    const units = (state.units||[]).slice();
    // Determine full coverage and keep coverage arrays for rendering
    const fullyCovered = [];
    const coverageMap = new Map();
    units.forEach(u => {
      // Skip units disabled before this month started (day 1 is already in a disabled period)
      if(isDateInDisabledPeriod(year, month, 1, getDisabledPeriods(u))) return;
      const cov = coverageArrayForUnit(u, year, month);
      if(cov.every(Boolean)){
        fullyCovered.push(u);
        coverageMap.set(u.id || u.unitId, cov);
      }
    });

    // Sort handling
    state.meta.reportSimple.sort = state.meta.reportSimple.sort || { column: 'unitId', ascending: true };
    const sort = state.meta.reportSimple.sort;
    fullyCovered.sort((a, b) => {
      const va = (a[sort.column] || '').toString().toLowerCase();
      const vb = (b[sort.column] || '').toString().toLowerCase();
      if(va < vb) return sort.ascending ? -1 : 1;
      if(va > vb) return sort.ascending ? 1 : -1;
      return 0;
    });

    // assign export datasets
    computedFullyCovered = fullyCovered.slice();
    computedCoverageMap = new Map(coverageMap);

    resultsWrap.innerHTML = '';
    // Independent scroll container for the results
    const titleFull = document.createElement('div');
    titleFull.textContent = 'Units Fully Covered';
    titleFull.style.margin = '12px 0 8px';
    titleFull.style.fontWeight = '600';
    resultsWrap.appendChild(titleFull);

    const scroller = document.createElement('div');
    scroller.style.maxHeight = '600px';
    scroller.style.overflowY = 'auto';
    scroller.style.border = '1px solid #eef2f7';
    scroller.style.borderRadius = '6px';
    scroller.style.padding = '8px';
    scroller.style.background = '#fff';

    const table = document.createElement('table');
    table.style.width = '100%'; table.style.borderCollapse = 'collapse'; table.style.marginTop = '0';
    const thead = document.createElement('thead'); const tbody = document.createElement('tbody');

    // Header: info columns + Period colSpan
    const headerRow = document.createElement('tr');
    const headerDefs = [
      { text: 'Unit', key: 'unitId' },
      { text: 'Lease', key: 'lease' },
      { text: 'Supplier', key: 'supplier' },
      { text: 'Arrangement', key: 'arrangement' },
      { text: 'Invoicing', key: 'invoicing' },
      { text: 'Status', key: 'status' }
    ];
    // Counter column
    const thCounter = document.createElement('th');
    thCounter.textContent = '#';
    thCounter.style.textAlign='center'; thCounter.style.padding='6px'; thCounter.style.fontSize='12px'; thCounter.style.borderBottom='2px solid #eef2f7'; thCounter.style.fontWeight='600'; thCounter.style.background='#f9fafb';
    thCounter.style.position = 'sticky'; thCounter.style.top = '0'; thCounter.style.zIndex = '2';
    thCounter.style.width = '40px';
    headerRow.appendChild(thCounter);
    headerDefs.forEach(def => {
      const th = document.createElement('th');
      // Add sort indicator
      let label = def.text;
      if(sort.column === def.key){ label += sort.ascending ? ' ▲' : ' ▼'; }
      th.textContent = label;
      th.style.textAlign='left'; th.style.padding='6px'; th.style.fontSize='12px'; th.style.borderBottom='2px solid #eef2f7'; th.style.fontWeight='600'; th.style.background='#f9fafb';
      // Sticky header
      th.style.position = 'sticky'; th.style.top = '0'; th.style.zIndex = '2';
      th.style.cursor = 'pointer'; th.style.userSelect = 'none';
      th.title = 'Click to sort';
      th.addEventListener('click', ()=>{
        if(state.meta.reportSimple.sort.column === def.key){
          state.meta.reportSimple.sort.ascending = !state.meta.reportSimple.sort.ascending;
        } else {
          state.meta.reportSimple.sort.column = def.key;
          state.meta.reportSimple.sort.ascending = true;
        }
        try{ saveState(); }catch(e){}
        run();
      });
      headerRow.appendChild(th);
    });
    const daysInMonth = new Date(year, month+1, 0).getDate();
    const thPeriod = document.createElement('th');
    thPeriod.textContent = 'Period';
    thPeriod.colSpan = daysInMonth;
    thPeriod.style.textAlign='center'; thPeriod.style.padding='6px'; thPeriod.style.fontSize='12px'; thPeriod.style.borderBottom='2px solid #eef2f7'; thPeriod.style.fontWeight='600'; thPeriod.style.background='#f9fafb';
    // Sticky header
    thPeriod.style.position = 'sticky'; thPeriod.style.top = '0'; thPeriod.style.zIndex = '2';
    headerRow.appendChild(thPeriod);
    thead.appendChild(headerRow);

    if(fullyCovered.length === 0){
      const tr = document.createElement('tr'); const td = document.createElement('td');
      td.colSpan = headerDefs.length + daysInMonth + 1; td.textContent = 'No units have full coverage for the selected month.'; td.className = 'small-muted'; td.style.padding='12px';
      tr.appendChild(td); tbody.appendChild(tr);
    } else {
      // Render all rows; the scroller limits visible height (~20 rows)
      fullyCovered.forEach((u, idx) => {
        const tr = document.createElement('tr');
        // Hover + selection highlight
        tr.addEventListener('mouseenter', () => { if(tr.dataset.selected !== 'true') tr.style.backgroundColor = '#f3f6fb'; });
        tr.addEventListener('mouseleave', () => { if(tr.dataset.selected !== 'true') tr.style.backgroundColor = ''; });
        tr.addEventListener('click', () => {
          const tbodyEl = tr.parentNode;
          if(tbodyEl){ Array.from(tbodyEl.querySelectorAll('tr')).forEach(row => { row.dataset.selected=''; row.style.backgroundColor=''; }); }
          tr.dataset.selected = 'true';
          tr.style.backgroundColor = '#e6f0ff';
        });
        // Counter cell
        const tdCounter = document.createElement('td');
        tdCounter.textContent = String(idx + 1);
        tdCounter.style.textAlign='center'; tdCounter.style.padding='6px'; tdCounter.style.borderBottom='1px solid #eef2f7'; tdCounter.style.fontSize='12px';
        tr.appendChild(tdCounter);
        const infoCells = [u.unitId||'', u.lease||'', u.supplier||'', u.arrangement||'', u.invoicing||'', u.status||'Operational'];
        infoCells.forEach((val, idx) => {
          const td = document.createElement('td');
          td.style.padding='6px'; td.style.borderBottom='1px solid #eef2f7'; td.style.fontSize='12px';
          // Make Unit ID clickable to open detail panel (same as Unit Overview)
          if(idx === 0){
            td.style.cursor = 'pointer';
            td.style.color = '#0b74de';
            td.title = 'View unit details';
            // Unit text
            td.appendChild(document.createTextNode(String(val)));
            // Add red ! indicator if the unit has comments for selected month
            try{
              const monthComments = extractMonthComments(u, year, month);
              if(monthComments && monthComments.length > 0){
                const alertIcon = document.createElement('span');
                alertIcon.textContent = ' !';
                alertIcon.style.color = '#dc2626';
                alertIcon.style.fontWeight = '700';
                alertIcon.style.marginLeft = '6px';
                alertIcon.style.cursor = 'pointer';
                alertIcon.title = 'Comments exist for this month';
                alertIcon.addEventListener('click', (e)=>{ e.stopPropagation(); try{ openCommentsModalFromWdNumbers(u.unitId, year, month); }catch(e){} });
                td.appendChild(alertIcon);
              }
            }catch(e){}
            td.addEventListener('click', (ev)=>{ 
              ev.stopPropagation(); 
              // Select the row
              const trEl = td.parentNode; const tbodyEl = trEl && trEl.parentNode;
              if(tbodyEl){ Array.from(tbodyEl.querySelectorAll('tr')).forEach(row => { row.dataset.selected=''; row.style.backgroundColor=''; }); }
              if(trEl){ trEl.dataset.selected='true'; trEl.style.backgroundColor='#e6f0ff'; }
              try{ openUnitWdNumbersModal(u.unitId, year, month, fullyCovered.map(x => x.unitId)); }catch(e){} 
            });
          } else { td.textContent = String(val); }
          tr.appendChild(td);
        });

        // Day squares with visual statuses (covered, overlap, credit, disabled)
        const cov = coverageMap.get(u.id || u.unitId) || [];
        const counts = rentalCountsArrayForUnit(u, year, month) || [];
        const creditDays = creditArrayForUnit(u, year, month) || [];
        const disabledPeriods = getDisabledPeriods(u) || [];
        for(let d=1; d<=daysInMonth; d++){
          const tdDay = document.createElement('td'); tdDay.style.padding='2px'; tdDay.style.textAlign='center'; tdDay.style.verticalAlign='middle';
          const square = document.createElement('div');
          square.style.width = '20px'; square.style.height = '20px'; square.style.border = '1px solid #ddd'; square.style.borderRadius = '3px';
          square.style.display = 'flex'; square.style.alignItems = 'center'; square.style.justifyContent = 'center'; square.style.fontSize = '9px';
          square.textContent = d;
          const covered = !!cov[d-1];
          const overlap = (counts[d-1] > 1);
          const credit = !!creditDays[d-1];
          const isDisabled = isDateInDisabledPeriod(year, month, d, disabledPeriods);

          // Match Unit Overview: red cell background during disabled periods
          if(isDisabled){ tdDay.style.backgroundColor = '#dc2626'; }

          if(credit){
            // Credit day: yellow frame/text; background reflects overlap or single coverage
            square.style.borderColor = '#eab308';
            square.style.borderWidth = '2px';
            square.style.color = '#eab308';
            square.style.fontWeight = '700';
            if(overlap){ square.style.backgroundColor = '#fee2e2'; }
            else if(covered){ square.style.backgroundColor = '#dcfce7'; }
            else { square.style.backgroundColor = '#ffffff'; }
          } else if(overlap){
            // Overlap rental coverage: red border + light red background
            square.style.backgroundColor = '#fee2e2';
            square.style.borderColor = '#dc2626';
            square.style.color = '#991b1b';
            square.style.fontWeight = '600';
          } else if(covered){
            // Single rental coverage: green highlight
            square.style.backgroundColor = '#dcfce7';
            square.style.borderColor = '#16a34a';
            square.style.color = '#15803d';
            square.style.fontWeight = '600';
          } else if(isDisabled){
            // Disabled but not covered: white square with red border
            square.style.backgroundColor = '#ffffff';
            square.style.borderColor = '#991b1b';
            square.style.color = '#dc2626';
            square.style.fontWeight = '600';
          } else {
            // No coverage
            square.style.backgroundColor = '#fff';
            square.style.color = '#6b7280';
          }
          tdDay.appendChild(square);
          tr.appendChild(tdDay);
        }
        tbody.appendChild(tr);
      });
    }

    table.appendChild(thead); table.appendChild(tbody);
    scroller.appendChild(table);
    resultsWrap.appendChild(scroller);

    // --- Missing coverage table ---
    // Compute units that are not fully covered
    let missingUnits = [];
    const coverageMapMissing = new Map();
    units.forEach(u => {
      const cov = coverageArrayForUnit(u, year, month);
      if(!cov.every(Boolean)){
        missingUnits.push(u);
        coverageMapMissing.set(u.id || u.unitId, cov);
      }
    });

    // Exclude units that were already disabled before this month started (day 1 in a disabled period)
    missingUnits = missingUnits.filter(u => !isDateInDisabledPeriod(year, month, 1, getDisabledPeriods(u)));

    // Sort handling for missing table
    state.meta.reportSimple.sortMissing = state.meta.reportSimple.sortMissing || { column: 'unitId', ascending: true };
    const sortMissing = state.meta.reportSimple.sortMissing;
    missingUnits.sort((a, b) => {
      const va = (a[sortMissing.column] || '').toString().toLowerCase();
      const vb = (b[sortMissing.column] || '').toString().toLowerCase();
      if(va < vb) return sortMissing.ascending ? -1 : 1;
      if(va > vb) return sortMissing.ascending ? 1 : -1;
      return 0;
    });

    // Title
    const titleMissing = document.createElement('div');
    titleMissing.textContent = 'Units Missing Coverage';
    titleMissing.style.margin = '12px 0 8px';
    titleMissing.style.fontWeight = '600';
    resultsWrap.appendChild(titleMissing);

    // Independent scroll for missing table
    const scrollerMissing = document.createElement('div');
    scrollerMissing.style.maxHeight = '600px';
    scrollerMissing.style.overflowY = 'auto';
    scrollerMissing.style.border = '1px solid #eef2f7';
    scrollerMissing.style.borderRadius = '6px';
    scrollerMissing.style.padding = '8px';
    scrollerMissing.style.background = '#fff';

    const tableMissing = document.createElement('table');
    tableMissing.style.width = '100%'; tableMissing.style.borderCollapse = 'collapse'; tableMissing.style.marginTop = '0';
    const theadMissing = document.createElement('thead'); const tbodyMissing = document.createElement('tbody');

    // Header
    const headerRowMissing = document.createElement('tr');
    const headerDefsMissing = [
      { text: 'Unit', key: 'unitId' },
      { text: 'Lease', key: 'lease' },
      { text: 'Supplier', key: 'supplier' },
      { text: 'Arrangement', key: 'arrangement' },
      { text: 'Invoicing', key: 'invoicing' },
      { text: 'Status', key: 'status' }
    ];
    // Counter column
    const thCounterMissing = document.createElement('th');
    thCounterMissing.textContent = '#';
    thCounterMissing.style.textAlign='center'; thCounterMissing.style.padding='6px'; thCounterMissing.style.fontSize='12px'; thCounterMissing.style.borderBottom='2px solid #eef2f7'; thCounterMissing.style.fontWeight='600'; thCounterMissing.style.background='#f9fafb';
    thCounterMissing.style.position = 'sticky'; thCounterMissing.style.top = '0'; thCounterMissing.style.zIndex = '2';
    thCounterMissing.style.width = '40px';
    headerRowMissing.appendChild(thCounterMissing);
    headerDefsMissing.forEach(def => {
      const th = document.createElement('th');
      let label = def.text;
      if(sortMissing.column === def.key){ label += sortMissing.ascending ? ' ▲' : ' ▼'; }
      th.textContent = label;
      th.style.textAlign='left'; th.style.padding='6px'; th.style.fontSize='12px'; th.style.borderBottom='2px solid #eef2f7'; th.style.fontWeight='600'; th.style.background='#f9fafb';
      // Sticky header
      th.style.position = 'sticky'; th.style.top = '0'; th.style.zIndex = '2';
      th.style.cursor = 'pointer'; th.style.userSelect = 'none'; th.title = 'Click to sort';
      th.addEventListener('click', ()=>{
        if(state.meta.reportSimple.sortMissing.column === def.key){
          state.meta.reportSimple.sortMissing.ascending = !state.meta.reportSimple.sortMissing.ascending;
        } else {
          state.meta.reportSimple.sortMissing.column = def.key;
          state.meta.reportSimple.sortMissing.ascending = true;
        }
        try{ saveState(); }catch(e){}
        run();
      });
      headerRowMissing.appendChild(th);
    });
    const thPeriodMissing = document.createElement('th');
    thPeriodMissing.textContent = 'Period';
    thPeriodMissing.colSpan = daysInMonth;
    thPeriodMissing.style.textAlign='center'; thPeriodMissing.style.padding='6px'; thPeriodMissing.style.fontSize='12px'; thPeriodMissing.style.borderBottom='2px solid #eef2f7'; thPeriodMissing.style.fontWeight='600'; thPeriodMissing.style.background='#f9fafb';
    // Sticky header
    thPeriodMissing.style.position = 'sticky'; thPeriodMissing.style.top = '0'; thPeriodMissing.style.zIndex = '2';
    headerRowMissing.appendChild(thPeriodMissing);
    theadMissing.appendChild(headerRowMissing);

    // Pre-compute additional visual states for Missing Coverage (overlap, credit, disabled periods)
    const rentalCountsMapMissing = new Map();
    const creditMapMissing = new Map();
    const disabledPeriodsMapMissing = new Map();
    missingUnits.forEach(u => {
      const key = (u.id || u.unitId);
      try{
        rentalCountsMapMissing.set(key, rentalCountsArrayForUnit(u, year, month));
      }catch(e){ rentalCountsMapMissing.set(key, []); }
      try{
        creditMapMissing.set(key, creditArrayForUnit(u, year, month));
      }catch(e){ creditMapMissing.set(key, []); }
      try{
        disabledPeriodsMapMissing.set(key, getDisabledPeriods(u));
      }catch(e){ disabledPeriodsMapMissing.set(key, []); }
    });

    if(missingUnits.length === 0){
      const tr = document.createElement('tr'); const td = document.createElement('td');
      td.colSpan = headerDefsMissing.length + daysInMonth + 1; td.textContent = 'All units have full coverage for the selected month.'; td.className = 'small-muted'; td.style.padding='12px';
      tr.appendChild(td); tbodyMissing.appendChild(tr);
    } else {
      missingUnits.forEach((u, idx) => {
        const tr = document.createElement('tr');
        // Hover + selection highlight
        tr.addEventListener('mouseenter', () => { if(tr.dataset.selected !== 'true') tr.style.backgroundColor = '#f3f6fb'; });
        tr.addEventListener('mouseleave', () => { if(tr.dataset.selected !== 'true') tr.style.backgroundColor = ''; });
        tr.addEventListener('click', () => {
          const tbodyEl = tr.parentNode;
          if(tbodyEl){ Array.from(tbodyEl.querySelectorAll('tr')).forEach(row => { row.dataset.selected=''; row.style.backgroundColor=''; }); }
          tr.dataset.selected = 'true';
          tr.style.backgroundColor = '#e6f0ff';
        });
        // Counter cell
        const tdCounter = document.createElement('td');
        tdCounter.textContent = String(idx + 1);
        tdCounter.style.textAlign='center'; tdCounter.style.padding='6px'; tdCounter.style.borderBottom='1px solid #eef2f7'; tdCounter.style.fontSize='12px';
        tr.appendChild(tdCounter);
        const infoCells = [u.unitId||'', u.lease||'', u.supplier||'', u.arrangement||'', u.invoicing||'', u.status||'Operational'];
        infoCells.forEach((val, idx) => {
          const td = document.createElement('td');
          td.style.padding='6px'; td.style.borderBottom='1px solid #eef2f7'; td.style.fontSize='12px';
          if(idx === 0){
            td.style.cursor = 'pointer'; td.style.color = '#0b74de'; td.title = 'View unit details';
            td.appendChild(document.createTextNode(String(val)));
            // Add red ! indicator if the unit has comments for selected month
            try{
              const monthComments = extractMonthComments(u, year, month);
              if(monthComments && monthComments.length > 0){
                const alertIcon = document.createElement('span');
                alertIcon.textContent = ' !';
                alertIcon.style.color = '#dc2626';
                alertIcon.style.fontWeight = '700';
                alertIcon.style.marginLeft = '6px';
                alertIcon.style.cursor = 'pointer';
                alertIcon.title = 'Comments exist for this month';
                alertIcon.addEventListener('click', (e)=>{ e.stopPropagation(); try{ openCommentsModalFromWdNumbers(u.unitId, year, month); }catch(e){} });
                td.appendChild(alertIcon);
              }
            }catch(e){}
            td.addEventListener('click', (ev)=>{ 
              ev.stopPropagation(); 
              // Select the row
              const trEl = td.parentNode; const tbodyEl = trEl && trEl.parentNode;
              if(tbodyEl){ Array.from(tbodyEl.querySelectorAll('tr')).forEach(row => { row.dataset.selected=''; row.style.backgroundColor=''; }); }
              if(trEl){ trEl.dataset.selected='true'; trEl.style.backgroundColor='#e6f0ff'; }
              try{ openUnitWdNumbersModal(u.unitId, year, month, missingUnits.map(x => x.unitId)); }catch(e){} 
            });
          } else { td.textContent = String(val); }
          tr.appendChild(td);
        });

        const cov = coverageMapMissing.get(u.id || u.unitId) || [];
        const counts = rentalCountsMapMissing.get(u.id || u.unitId) || [];
        const creditDays = creditMapMissing.get(u.id || u.unitId) || [];
        const disabledPeriods = disabledPeriodsMapMissing.get(u.id || u.unitId) || [];
        for(let d=1; d<=daysInMonth; d++){
          const tdDay = document.createElement('td'); tdDay.style.padding='2px'; tdDay.style.textAlign='center'; tdDay.style.verticalAlign='middle';
          const square = document.createElement('div');
          square.style.width = '20px'; square.style.height = '20px'; square.style.border = '1px solid #ddd'; square.style.borderRadius = '3px';
          square.style.display = 'flex'; square.style.alignItems = 'center'; square.style.justifyContent = 'center'; square.style.fontSize = '9px';
          square.textContent = d;
          const covered = !!cov[d-1];
          const overlap = (counts[d-1] > 1);
          const credit = !!creditDays[d-1];
          const isDisabled = isDateInDisabledPeriod(year, month, d, disabledPeriods);

          // Match Unit Overview: red cell background during disabled periods
          if(isDisabled){ tdDay.style.backgroundColor = '#dc2626'; }

          if(credit){
            // Credit day: yellow frame/text; background reflects overlap or single coverage
            square.style.borderColor = '#eab308';
            square.style.borderWidth = '2px';
            square.style.color = '#eab308';
            square.style.fontWeight = '700';
            if(overlap){ square.style.backgroundColor = '#fee2e2'; }
            else if(covered){ square.style.backgroundColor = '#dcfce7'; }
            else { square.style.backgroundColor = '#ffffff'; }
          } else if(overlap){
            // Overlap rental coverage: red border + light red background
            square.style.backgroundColor = '#fee2e2';
            square.style.borderColor = '#dc2626';
            square.style.color = '#991b1b';
            square.style.fontWeight = '600';
          } else if(covered){
            // Single rental coverage: green highlight
            square.style.backgroundColor = '#dcfce7';
            square.style.borderColor = '#16a34a';
            square.style.color = '#15803d';
            square.style.fontWeight = '600';
          } else if(isDisabled){
            // Disabled but not covered: white square with red border
            square.style.backgroundColor = '#ffffff';
            square.style.borderColor = '#991b1b';
            square.style.color = '#dc2626';
            square.style.fontWeight = '600';
          } else {
            // No coverage
            square.style.backgroundColor = '#fff';
            square.style.color = '#6b7280';
          }
          tdDay.appendChild(square);
          tr.appendChild(tdDay);
        }
        tbodyMissing.appendChild(tr);
      });
    }

    // assign export datasets
    computedMissingUnits = missingUnits.slice();
    computedCoverageMapMissing = new Map(coverageMapMissing);

    tableMissing.appendChild(theadMissing); tableMissing.appendChild(tbodyMissing);
    scrollerMissing.appendChild(tableMissing);
    resultsWrap.appendChild(scrollerMissing);

    // --- Units Highlighted in Red (Overlaps) ---
    // Collect units that have at least one overlapped rental day in the selected month
    const overlapUnits = [];
    const overlapMap = new Map();
    const rentalCoveredMap = new Map();
    units.forEach(u => {
      const counts = rentalCountsArrayForUnit(u, year, month);
      const hasOverlap = counts.some(c => c > 1);
      if(hasOverlap){
        overlapUnits.push(u);
        overlapMap.set(u.id || u.unitId, counts.map(c => c > 1));
        rentalCoveredMap.set(u.id || u.unitId, counts.map(c => c > 0));
      }
    });

    const titleOverlap = document.createElement('div');
    titleOverlap.textContent = 'Units with Red Highlighted Dates (Overlaps)';
    titleOverlap.style.margin = '12px 0 8px';
    titleOverlap.style.fontWeight = '600';
    resultsWrap.appendChild(titleOverlap);

    // assign export datasets
    computedOverlapUnits = overlapUnits.slice();
    computedOverlapMap = new Map(overlapMap);
    computedRentalCoveredMap = new Map(rentalCoveredMap);

    const scrollerOverlap = document.createElement('div');
    scrollerOverlap.style.maxHeight = '600px';
    scrollerOverlap.style.overflowY = 'auto';
    scrollerOverlap.style.border = '1px solid #eef2f7';
    scrollerOverlap.style.borderRadius = '6px';
    scrollerOverlap.style.padding = '8px';
    scrollerOverlap.style.background = '#fff';

    const tableOverlap = document.createElement('table');
    tableOverlap.style.width = '100%'; tableOverlap.style.borderCollapse = 'collapse'; tableOverlap.style.marginTop = '0';
    const theadOverlap = document.createElement('thead'); const tbodyOverlap = document.createElement('tbody');

    const hdr = document.createElement('tr');
    const headerDefsOverlap = [
      { text: 'Unit', key: 'unitId' },
      { text: 'Lease', key: 'lease' },
      { text: 'Supplier', key: 'supplier' },
      { text: 'Arrangement', key: 'arrangement' },
      { text: 'Invoicing', key: 'invoicing' },
      { text: 'Status', key: 'status' }
    ];
    // Counter column
    const thCounterOverlap = document.createElement('th');
    thCounterOverlap.textContent = '#';
    thCounterOverlap.style.textAlign='center'; thCounterOverlap.style.padding='6px'; thCounterOverlap.style.fontSize='12px'; thCounterOverlap.style.borderBottom='2px solid #eef2f7'; thCounterOverlap.style.fontWeight='600'; thCounterOverlap.style.background='#f9fafb';
    thCounterOverlap.style.position='sticky'; thCounterOverlap.style.top='0'; thCounterOverlap.style.zIndex='2'; thCounterOverlap.style.width='40px';
    hdr.appendChild(thCounterOverlap);
    headerDefsOverlap.forEach(def => {
      const th = document.createElement('th'); th.textContent = def.text;
      th.style.textAlign='left'; th.style.padding='6px'; th.style.fontSize='12px'; th.style.borderBottom='2px solid #eef2f7'; th.style.fontWeight='600'; th.style.background='#f9fafb';
      th.style.position='sticky'; th.style.top='0'; th.style.zIndex='2';
      hdr.appendChild(th);
    });
    const thP = document.createElement('th'); thP.textContent = 'Period'; thP.colSpan = daysInMonth; thP.style.textAlign='center'; thP.style.padding='6px'; thP.style.fontSize='12px'; thP.style.borderBottom='2px solid #eef2f7'; thP.style.fontWeight='600'; thP.style.background='#f9fafb'; thP.style.position='sticky'; thP.style.top='0'; thP.style.zIndex='2';
    hdr.appendChild(thP); theadOverlap.appendChild(hdr);

    if(overlapUnits.length === 0){
      const tr = document.createElement('tr'); const td = document.createElement('td');
      td.colSpan = headerDefsOverlap.length + daysInMonth + 1; td.textContent = 'No units have overlapped rental days for the selected month.'; td.className = 'small-muted'; td.style.padding='12px';
      tr.appendChild(td); tbodyOverlap.appendChild(tr);
    } else {
      overlapUnits.forEach((u, idx) => {
        const tr = document.createElement('tr');
        tr.addEventListener('mouseenter', ()=>{ if(tr.dataset.selected!=='true') tr.style.backgroundColor='#fff5f5'; });
        tr.addEventListener('mouseleave', ()=>{ if(tr.dataset.selected!=='true') tr.style.backgroundColor=''; });
        tr.addEventListener('click', ()=>{ const tb=tr.parentNode; if(tb){ Array.from(tb.querySelectorAll('tr')).forEach(r=>{ r.dataset.selected=''; r.style.backgroundColor=''; }); } tr.dataset.selected='true'; tr.style.backgroundColor='#ffe4e6'; });
        // Counter cell
        const tdCounter = document.createElement('td');
        tdCounter.textContent = String(idx + 1);
        tdCounter.style.textAlign='center'; tdCounter.style.padding='6px'; tdCounter.style.borderBottom='1px solid #eef2f7'; tdCounter.style.fontSize='12px';
        tr.appendChild(tdCounter);
        const info = [u.unitId||'', u.lease||'', u.supplier||'', u.arrangement||'', u.invoicing||'', u.status||'Operational'];
        info.forEach((val, idx) => { 
          const td=document.createElement('td'); 
          td.style.padding='6px'; td.style.borderBottom='1px solid #eef2f7'; td.style.fontSize='12px'; 
          if(idx===0){ 
            td.style.cursor='pointer'; td.style.color='#0b74de'; td.title='View unit details';
            td.appendChild(document.createTextNode(String(val)));
            // Add red ! indicator if the unit has comments for selected month
            try{
              const monthComments = extractMonthComments(u, year, month);
              if(monthComments && monthComments.length > 0){
                const alertIcon = document.createElement('span');
                alertIcon.textContent = ' !';
                alertIcon.style.color = '#dc2626';
                alertIcon.style.fontWeight = '700';
                alertIcon.style.marginLeft = '6px';
                alertIcon.style.cursor = 'pointer';
                alertIcon.title = 'Comments exist for this month';
                alertIcon.addEventListener('click', (e)=>{ e.stopPropagation(); try{ openCommentsModalFromWdNumbers(u.unitId, year, month); }catch(e){} });
                td.appendChild(alertIcon);
              }
            }catch(e){}
            td.addEventListener('click',(ev)=>{ ev.stopPropagation(); const trEl=td.parentNode, tb=trEl&&trEl.parentNode; if(tb){ Array.from(tb.querySelectorAll('tr')).forEach(r=>{ r.dataset.selected=''; r.style.backgroundColor=''; }); } if(trEl){ trEl.dataset.selected='true'; trEl.style.backgroundColor='#ffe4e6'; } try{ openUnitWdNumbersModal(u.unitId, year, month, overlapUnits.map(x => x.unitId));}catch(e){} }); 
          } else { td.textContent = String(val); }
          tr.appendChild(td); 
        });

        const overlaps = overlapMap.get(u.id || u.unitId) || [];
        const covered = rentalCoveredMap.get(u.id || u.unitId) || [];
        const disabledPeriods = getDisabledPeriods(u) || [];
        for(let d=1; d<=daysInMonth; d++){
          const tdDay = document.createElement('td'); tdDay.style.padding='2px'; tdDay.style.textAlign='center'; tdDay.style.verticalAlign='middle';
          const square = document.createElement('div'); square.style.width='20px'; square.style.height='20px'; square.style.border='1px solid #ddd'; square.style.borderRadius='3px'; square.style.display='flex'; square.style.alignItems='center'; square.style.justifyContent='center'; square.style.fontSize='9px'; square.textContent=d;
          const isDisabled = isDateInDisabledPeriod(year, month, d, disabledPeriods);
          if(isDisabled){ tdDay.style.backgroundColor = '#dc2626'; }
          if(overlaps[d-1]){
            square.style.backgroundColor='#fee2e2'; square.style.borderColor='#dc2626'; square.style.color='#991b1b'; square.style.fontWeight='600';
          }
          else if(covered[d-1]){
            square.style.backgroundColor='#dcfce7'; square.style.borderColor='#16a34a'; square.style.color='#15803d'; square.style.fontWeight='600';
          }
          else if(isDisabled){
            square.style.backgroundColor='#ffffff'; square.style.borderColor='#991b1b'; square.style.color='#dc2626'; square.style.fontWeight='600';
          }
          else { square.style.backgroundColor='#fff'; square.style.color='#6b7280'; }
          tdDay.appendChild(square); tr.appendChild(tdDay);
        }
        tbodyOverlap.appendChild(tr);
      });
    }

    tableOverlap.appendChild(theadOverlap); tableOverlap.appendChild(tbodyOverlap);
    scrollerOverlap.appendChild(tableOverlap);
    resultsWrap.appendChild(scrollerOverlap);

    // --- Units with Yellow Frame Dates (Credit) ---
    const creditUnits = [];
    const creditMap = new Map();
    const rentalCountsMap = new Map();
    units.forEach(u => {
      const creditDays = creditArrayForUnit(u, year, month);
      if(creditDays.some(Boolean)){
        creditUnits.push(u);
        creditMap.set(u.id || u.unitId, creditDays);
        rentalCountsMap.set(u.id || u.unitId, rentalCountsArrayForUnit(u, year, month));
      }
    });

    const titleCredit = document.createElement('div');
    titleCredit.textContent = 'Units with Yellow Frame Dates (Credit)';
    titleCredit.style.margin = '12px 0 8px';
    titleCredit.style.fontWeight = '600';
    resultsWrap.appendChild(titleCredit);

    // assign export datasets
    computedCreditUnits = creditUnits.slice();
    computedCreditMap = new Map(creditMap);
    computedRentalCountsMap = new Map(rentalCountsMap);

    const scrollerCredit = document.createElement('div');
    scrollerCredit.style.maxHeight = '600px';
    scrollerCredit.style.overflowY = 'auto';
    scrollerCredit.style.border = '1px solid #eef2f7';
    scrollerCredit.style.borderRadius = '6px';
    scrollerCredit.style.padding = '8px';
    scrollerCredit.style.background = '#fff';

    const tableCredit = document.createElement('table');
    tableCredit.style.width = '100%'; tableCredit.style.borderCollapse = 'collapse'; tableCredit.style.marginTop = '0';
    const theadCredit = document.createElement('thead'); const tbodyCredit = document.createElement('tbody');

    const hdrC = document.createElement('tr');
    const headerDefsCredit = [
      { text: 'Unit', key: 'unitId' },
      { text: 'Lease', key: 'lease' },
      { text: 'Supplier', key: 'supplier' },
      { text: 'Arrangement', key: 'arrangement' },
      { text: 'Invoicing', key: 'invoicing' },
      { text: 'Status', key: 'status' }
    ];
    // Counter column
    const thCounterCredit = document.createElement('th');
    thCounterCredit.textContent = '#';
    thCounterCredit.style.textAlign='center'; thCounterCredit.style.padding='6px'; thCounterCredit.style.fontSize='12px'; thCounterCredit.style.borderBottom='2px solid #eef2f7'; thCounterCredit.style.fontWeight='600'; thCounterCredit.style.background='#f9fafb';
    thCounterCredit.style.position='sticky'; thCounterCredit.style.top='0'; thCounterCredit.style.zIndex='2'; thCounterCredit.style.width='40px';
    hdrC.appendChild(thCounterCredit);
    headerDefsCredit.forEach(def => {
      const th = document.createElement('th'); th.textContent = def.text;
      th.style.textAlign='left'; th.style.padding='6px'; th.style.fontSize='12px'; th.style.borderBottom='2px solid #eef2f7'; th.style.fontWeight='600'; th.style.background='#f9fafb';
      th.style.position='sticky'; th.style.top='0'; th.style.zIndex='2';
      hdrC.appendChild(th);
    });
    const thPC = document.createElement('th'); thPC.textContent = 'Period'; thPC.colSpan = daysInMonth; thPC.style.textAlign='center'; thPC.style.padding='6px'; thPC.style.fontSize='12px'; thPC.style.borderBottom='2px solid #eef2f7'; thPC.style.fontWeight='600'; thPC.style.background='#f9fafb'; thPC.style.position='sticky'; thPC.style.top='0'; thPC.style.zIndex='2';
    hdrC.appendChild(thPC); theadCredit.appendChild(hdrC);

    if(creditUnits.length === 0){
      const tr = document.createElement('tr'); const td = document.createElement('td');
      td.colSpan = headerDefsCredit.length + daysInMonth + 1; td.textContent = 'No units have credit-covered days for the selected month.'; td.className = 'small-muted'; td.style.padding='12px';
      tr.appendChild(td); tbodyCredit.appendChild(tr);
    } else {
      creditUnits.forEach((u, idx) => {
        const tr = document.createElement('tr');
        tr.addEventListener('mouseenter', ()=>{ if(tr.dataset.selected!=='true') tr.style.backgroundColor='#fffaf0'; });
        tr.addEventListener('mouseleave', ()=>{ if(tr.dataset.selected!=='true') tr.style.backgroundColor=''; });
        tr.addEventListener('click', ()=>{ const tb=tr.parentNode; if(tb){ Array.from(tb.querySelectorAll('tr')).forEach(r=>{ r.dataset.selected=''; r.style.backgroundColor=''; }); } tr.dataset.selected='true'; tr.style.backgroundColor='#fff4e5'; });
        // Counter cell
        const tdCounter = document.createElement('td');
        tdCounter.textContent = String(idx + 1);
        tdCounter.style.textAlign='center'; tdCounter.style.padding='6px'; tdCounter.style.borderBottom='1px solid #eef2f7'; tdCounter.style.fontSize='12px';
        tr.appendChild(tdCounter);
        const info = [u.unitId||'', u.lease||'', u.supplier||'', u.arrangement||'', u.invoicing||'', u.status||'Operational'];
        info.forEach((val, idx) => { 
          const td=document.createElement('td'); 
          td.style.padding='6px'; td.style.borderBottom='1px solid #eef2f7'; td.style.fontSize='12px'; 
          if(idx===0){ 
            td.style.cursor='pointer'; td.style.color='#0b74de'; td.title='View unit details';
            td.appendChild(document.createTextNode(String(val)));
            // Add red ! indicator if the unit has comments for selected month
            try{
              const monthComments = extractMonthComments(u, year, month);
              if(monthComments && monthComments.length > 0){
                const alertIcon = document.createElement('span');
                alertIcon.textContent = ' !';
                alertIcon.style.color = '#dc2626';
                alertIcon.style.fontWeight = '700';
                alertIcon.style.marginLeft = '6px';
                alertIcon.style.cursor = 'pointer';
                alertIcon.title = 'Comments exist for this month';
                alertIcon.addEventListener('click', (e)=>{ e.stopPropagation(); try{ openCommentsModalFromWdNumbers(u.unitId, year, month); }catch(e){} });
                td.appendChild(alertIcon);
              }
            }catch(e){}
            td.addEventListener('click',(ev)=>{ ev.stopPropagation(); const trEl=td.parentNode, tb=trEl&&trEl.parentNode; if(tb){ Array.from(tb.querySelectorAll('tr')).forEach(r=>{ r.dataset.selected=''; r.style.backgroundColor=''; }); } if(trEl){ trEl.dataset.selected='true'; trEl.style.backgroundColor='#fff4e5'; } try{ openUnitWdNumbersModal(u.unitId, year, month, creditUnits.map(x => x.unitId));}catch(e){} }); 
          } else { td.textContent = String(val); }
          tr.appendChild(td); 
        });

        const creditDays = creditMap.get(u.id || u.unitId) || [];
        const counts = rentalCountsMap.get(u.id || u.unitId) || [];
        const disabledPeriods = getDisabledPeriods(u) || [];
        for(let d=1; d<=daysInMonth; d++){
          const tdDay = document.createElement('td'); tdDay.style.padding='2px'; tdDay.style.textAlign='center'; tdDay.style.verticalAlign='middle';
          const square = document.createElement('div'); square.style.width='20px'; square.style.height='20px'; square.style.border='1px solid #ddd'; square.style.borderRadius='3px'; square.style.display='flex'; square.style.alignItems='center'; square.style.justifyContent='center'; square.style.fontSize='9px'; square.textContent=d;
          const isDisabled = isDateInDisabledPeriod(year, month, d, disabledPeriods);
          if(isDisabled){ tdDay.style.backgroundColor = '#dc2626'; }
          if(creditDays[d-1]){
            square.style.borderColor='#eab308'; square.style.borderWidth='2px'; square.style.color='#eab308'; square.style.fontWeight='700';
            if(counts[d-1] > 1){ square.style.backgroundColor='#fee2e2'; square.style.borderColor='#eab308'; }
            else if(counts[d-1] === 1){ square.style.backgroundColor='#dcfce7'; }
            else { square.style.backgroundColor='#ffffff'; }
          } else {
            if(counts[d-1] > 1){ square.style.backgroundColor='#fee2e2'; square.style.borderColor='#dc2626'; square.style.color='#991b1b'; square.style.fontWeight='600'; }
            else if(counts[d-1] === 1){ square.style.backgroundColor='#dcfce7'; square.style.borderColor='#16a34a'; square.style.color='#15803d'; square.style.fontWeight='600'; }
            else if(isDisabled){ square.style.backgroundColor='#ffffff'; square.style.borderColor='#991b1b'; square.style.color='#dc2626'; square.style.fontWeight='600'; }
            else { square.style.backgroundColor='#fff'; square.style.color='#6b7280'; }
          }
          tdDay.appendChild(square); tr.appendChild(tdDay);
        }
        tbodyCredit.appendChild(tr);
      });
    }

    tableCredit.appendChild(theadCredit); tableCredit.appendChild(tbodyCredit);
    scrollerCredit.appendChild(tableCredit);
    resultsWrap.appendChild(scrollerCredit);

    // --- Disabled + Covered (Red background + Green highlight) ---
    // Identify units that have at least one day in the selected month where
    // the unit is disabled (red background) and has rental coverage (green square).
    const disabledCoveredUnits = [];
    const disabledCoveredData = new Map(); // id -> { disabledPeriods, coverage }
    units.forEach(u => {
      const disabledPeriods = getDisabledPeriods(u);
      const cov = coverageArrayForUnit(u, year, month);
      const daysInMonthLocal = new Date(year, month+1, 0).getDate();
      let hasDisabledCovered = false;
      for(let d=1; d<=daysInMonthLocal; d++){
        const isDisabled = isDateInDisabledPeriod(year, month, d, disabledPeriods);
        if(isDisabled && !!cov[d-1]){ hasDisabledCovered = true; break; }
      }
      if(hasDisabledCovered){
        disabledCoveredUnits.push(u);
        disabledCoveredData.set(u.id || u.unitId, { disabledPeriods, coverage: cov });
      }
    });

    // assign export datasets
    computedDisabledCoveredUnits = disabledCoveredUnits.slice();
    // Build maps for export
    const disabledArrayForUnit = (u, y, m) => {
      const days = new Date(y, m+1, 0).getDate();
      const arr = new Array(days).fill(false);
      const periods = getDisabledPeriods(u);
      for(let d=1; d<=days; d++){
        if(isDateInDisabledPeriod(y, m, d, periods)) arr[d-1] = true;
      }
      return arr;
    };
    computedDisabledMap = new Map();
    computedDisabledCoverageMap = new Map();
    computedDisabledCountsMap = new Map();
    disabledCoveredUnits.forEach(u => {
      computedDisabledMap.set(u.id || u.unitId, disabledArrayForUnit(u, year, month));
      computedDisabledCoverageMap.set(u.id || u.unitId, coverageArrayForUnit(u, year, month));
      computedDisabledCountsMap.set(u.id || u.unitId, rentalCountsArrayForUnit(u, year, month));
    });

    // Note: Excel export for Disabled + Covered is handled in exportReport();
    // avoid invoking XLSX here to prevent runtime errors.

    // Disabled + Covered UI section

    const titleDisabledCovered = document.createElement('div');
    titleDisabledCovered.textContent = 'Disabled Units with Rental Coverage (Red Background + Green Highlight)';
    titleDisabledCovered.style.margin = '12px 0 8px';
    titleDisabledCovered.style.fontWeight = '600';
    const sectionDisabledCovered = document.createElement('div');
    sectionDisabledCovered.id = 'report-disabled-covered';
    sectionDisabledCovered.appendChild(titleDisabledCovered);

    const scrollerDisabledCovered = document.createElement('div');
    scrollerDisabledCovered.style.maxHeight = '600px';
    scrollerDisabledCovered.style.overflowY = 'auto';
    scrollerDisabledCovered.style.border = '1px solid #eef2f7';
    scrollerDisabledCovered.style.borderRadius = '6px';
    scrollerDisabledCovered.style.padding = '8px';
    scrollerDisabledCovered.style.background = '#fff';

    const tableDisabledCovered = document.createElement('table');
    tableDisabledCovered.style.width = '100%';
    tableDisabledCovered.style.borderCollapse = 'collapse';
    tableDisabledCovered.style.marginTop = '0';
    const theadDC = document.createElement('thead');
    const tbodyDC = document.createElement('tbody');

    const hdrDC = document.createElement('tr');
    const headerDefsDC = [
      { text: 'Unit', key: 'unitId' },
      { text: 'Lease', key: 'lease' },
      { text: 'Supplier', key: 'supplier' },
      { text: 'Arrangement', key: 'arrangement' },
      { text: 'Invoicing', key: 'invoicing' },
      { text: 'Status', key: 'status' },
      { text: 'Labels', key: 'labels' }
    ];
    // Counter column
    const thCounterDC = document.createElement('th');
    thCounterDC.textContent = '#';
    thCounterDC.style.textAlign='center'; thCounterDC.style.padding='6px'; thCounterDC.style.fontSize='12px'; thCounterDC.style.borderBottom='2px solid #eef2f7'; thCounterDC.style.fontWeight='600'; thCounterDC.style.background='#f9fafb';
    thCounterDC.style.position='sticky'; thCounterDC.style.top='0'; thCounterDC.style.zIndex='2'; thCounterDC.style.width='40px';
    hdrDC.appendChild(thCounterDC);
    headerDefsDC.forEach(def => {
      const th = document.createElement('th'); th.textContent = def.text;
      th.style.textAlign='left'; th.style.padding='6px'; th.style.fontSize='12px'; th.style.borderBottom='2px solid #eef2f7'; th.style.fontWeight='600'; th.style.background='#f9fafb';
      th.style.position='sticky'; th.style.top='0'; th.style.zIndex='2';
      hdrDC.appendChild(th);
    });
    const thPeriodDC = document.createElement('th');
    const daysInMonthDC = new Date(year, month+1, 0).getDate();
    thPeriodDC.textContent = 'Period'; thPeriodDC.colSpan = daysInMonthDC;
    thPeriodDC.style.textAlign='center'; thPeriodDC.style.padding='6px'; thPeriodDC.style.fontSize='12px'; thPeriodDC.style.borderBottom='2px solid #eef2f7'; thPeriodDC.style.fontWeight='600'; thPeriodDC.style.background='#f9fafb'; thPeriodDC.style.position='sticky'; thPeriodDC.style.top='0'; thPeriodDC.style.zIndex='2';
    hdrDC.appendChild(thPeriodDC);
    theadDC.appendChild(hdrDC);

    if(disabledCoveredUnits.length === 0){
      const tr = document.createElement('tr'); const td = document.createElement('td');
      td.colSpan = headerDefsDC.length + daysInMonthDC + 1; td.textContent = 'No disabled units with rental-covered days in the selected month.'; td.className = 'small-muted'; td.style.padding='12px';
      tr.appendChild(td); tbodyDC.appendChild(tr);
    } else {
      disabledCoveredUnits.forEach((u, idx) => {
        const tr = document.createElement('tr');
        tr.addEventListener('mouseenter', ()=>{ if(tr.dataset.selected!=='true') tr.style.backgroundColor='#f3f6fb'; });
        tr.addEventListener('mouseleave', ()=>{ if(tr.dataset.selected!=='true') tr.style.backgroundColor=''; });
        tr.addEventListener('click', ()=>{ const tb=tr.parentNode; if(tb){ Array.from(tb.querySelectorAll('tr')).forEach(r=>{ r.dataset.selected=''; r.style.backgroundColor=''; }); } tr.dataset.selected='true'; tr.style.backgroundColor='#e6f0ff'; });
        // Counter cell
        const tdCounter = document.createElement('td');
        tdCounter.textContent = String(idx + 1);
        tdCounter.style.textAlign='center'; tdCounter.style.padding='6px'; tdCounter.style.borderBottom='1px solid #eef2f7'; tdCounter.style.fontSize='12px';
        tr.appendChild(tdCounter);
        const info = [u.unitId||'', u.lease||'', u.supplier||'', u.arrangement||'', u.invoicing||'', u.status||'Operational'];
        info.forEach((val, idx) => {
          const td=document.createElement('td');
          td.style.padding='6px'; td.style.borderBottom='1px solid #eef2f7'; td.style.fontSize='12px';
          if(idx===0){
            td.style.cursor='pointer'; td.style.color='#0b74de'; td.title='View unit details';
            td.appendChild(document.createTextNode(String(val)));
            // Red ! indicator if comments exist for selected month
            try{
              const monthComments = extractMonthComments(u, year, month);
              if(monthComments && monthComments.length>0){
                const alertIcon = document.createElement('span');
                alertIcon.textContent = ' !'; alertIcon.style.color = '#dc2626'; alertIcon.style.fontWeight='700'; alertIcon.style.marginLeft='6px'; alertIcon.style.cursor='pointer'; alertIcon.title='Comments exist for this month';
                alertIcon.addEventListener('click', (e)=>{ e.stopPropagation(); try{ openCommentsModalFromWdNumbers(u.unitId, year, month); }catch(e){} });
                td.appendChild(alertIcon);
              }
            }catch(e){}
            td.addEventListener('click',(ev)=>{ ev.stopPropagation(); try{ openUnitWdNumbersModal(u.unitId, year, month, disabledCoveredUnits.map(x => x.unitId));}catch(e){} });
          } else {
            td.textContent = String(val);
          }
          tr.appendChild(td);
        });

        // Labels column: show other visual labels present this month (Overlap, Credit)
        try{
          const counts = rentalCountsArrayForUnit(u, year, month) || [];
          const hasOverlap = counts.some(c => c > 1);
          const creditDays = creditArrayForUnit(u, year, month) || [];
          const hasCredit = creditDays.some(Boolean);
          const labels = [];
          if(hasOverlap) labels.push('Overlap');
          if(hasCredit) labels.push('Credit');
          const tdLabels = document.createElement('td');
          tdLabels.style.padding='6px'; tdLabels.style.borderBottom='1px solid #eef2f7'; tdLabels.style.fontSize='12px';
          tdLabels.textContent = labels.length ? labels.join(', ') : '-';
          tr.appendChild(tdLabels);
        }catch(e){
          const tdLabels = document.createElement('td');
          tdLabels.style.padding='6px'; tdLabels.style.borderBottom='1px solid #eef2f7'; tdLabels.style.fontSize='12px';
          tdLabels.textContent = '-';
          tr.appendChild(tdLabels);
        }

        const data = disabledCoveredData.get(u.id || u.unitId) || { disabledPeriods: [], coverage: [] };
        // Compute per-day overlap counts and credit markers like Unit Overview
        const counts = rentalCountsArrayForUnit(u, year, month) || [];
        const creditDays = creditArrayForUnit(u, year, month) || [];
        for(let d=1; d<=daysInMonthDC; d++){
          const tdDay = document.createElement('td'); tdDay.style.padding='2px'; tdDay.style.textAlign='center'; tdDay.style.verticalAlign='middle';
          const isDisabled = isDateInDisabledPeriod(year, month, d, data.disabledPeriods || []);
          if(isDisabled){ tdDay.style.backgroundColor = '#dc2626'; }
          const square = document.createElement('div'); square.style.width='20px'; square.style.height='20px'; square.style.border='1px solid #ddd'; square.style.borderRadius='3px'; square.style.display='flex'; square.style.alignItems='center'; square.style.justifyContent='center'; square.style.fontSize='9px'; square.textContent=d;
          const covered = !!(data.coverage && data.coverage[d-1]);
          const overlap = (counts[d-1] > 1);
          const credit = !!creditDays[d-1];

          if(credit){
            // Credit day: yellow frame/text; background reflects overlap or single coverage
            square.style.borderColor = '#eab308';
            square.style.borderWidth = '2px';
            square.style.color = '#eab308';
            square.style.fontWeight = '700';
            if(overlap){
              square.style.backgroundColor = '#fee2e2';
            } else if(covered){
              square.style.backgroundColor = '#dcfce7';
            } else {
              square.style.backgroundColor = '#ffffff';
            }
          } else if(overlap){
            // Overlap rental coverage: red border + light red background
            square.style.backgroundColor = '#fee2e2';
            square.style.borderColor = '#dc2626';
            square.style.color = '#991b1b';
            square.style.fontWeight = '600';
          } else if(covered){
            // Single rental coverage: green highlight
            square.style.backgroundColor = '#dcfce7';
            square.style.borderColor = '#16a34a';
            square.style.color = '#15803d';
            square.style.fontWeight = '600';
          } else if(isDisabled){
            // Disabled but not covered: white square with red border
            square.style.backgroundColor = '#ffffff';
            square.style.borderColor = '#991b1b';
            square.style.color = '#dc2626';
            square.style.fontWeight = '600';
          } else {
            // No coverage
            square.style.backgroundColor = '#fff';
            square.style.color = '#6b7280';
          }

          tdDay.appendChild(square); tr.appendChild(tdDay);
        }
        tbodyDC.appendChild(tr);
      });
    }

    tableDisabledCovered.appendChild(theadDC); tableDisabledCovered.appendChild(tbodyDC);
    scrollerDisabledCovered.appendChild(tableDisabledCovered);
    sectionDisabledCovered.appendChild(scrollerDisabledCovered);
    // Append Disabled + Covered between Credit and Consecutive Months
    resultsWrap.appendChild(sectionDisabledCovered);

    // --- Units tagged "First of the Month" (preview of NEXT month's coverage) ---
    {
      let nextMonthFOM = month + 1;
      let nextYearFOM = year;
      if(nextMonthFOM > 11){ nextMonthFOM = 0; nextYearFOM = year + 1; }

      const firstOfMonthUnits = units.filter(u => {
        const invoicingVal = (u.invoicing || '').toString().trim();
        if(invoicingVal !== 'First of the Month') return false;
        // Skip units already disabled before next month starts — nothing to invoice
        if(isDateInDisabledPeriod(nextYearFOM, nextMonthFOM, 1, getDisabledPeriods(u))) return false;
        return true;
      });

      const daysInMonthFOM = new Date(nextYearFOM, nextMonthFOM + 1, 0).getDate();
      const monthNameFOM = monthNames[nextMonthFOM];

      const titleFOM = document.createElement('div');
      titleFOM.textContent = `Units Tagged "First of the Month" — Preview for ${monthNameFOM} ${nextYearFOM}`;
      titleFOM.style.margin = '12px 0 8px';
      titleFOM.style.fontWeight = '600';
      resultsWrap.appendChild(titleFOM);

      const scrollerFOM = document.createElement('div');
      scrollerFOM.style.maxHeight = '600px';
      scrollerFOM.style.overflowY = 'auto';
      scrollerFOM.style.border = '1px solid #eef2f7';
      scrollerFOM.style.borderRadius = '6px';
      scrollerFOM.style.padding = '8px';
      scrollerFOM.style.background = '#fff';

      const tableFOM = document.createElement('table');
      tableFOM.style.width = '100%'; tableFOM.style.borderCollapse = 'collapse'; tableFOM.style.marginTop = '0';
      const theadFOM = document.createElement('thead'); const tbodyFOM = document.createElement('tbody');

      const hdrFOM = document.createElement('tr');
      const headerDefsFOM = [
        { text: 'Unit', key: 'unitId' },
        { text: 'Lease', key: 'lease' },
        { text: 'Supplier', key: 'supplier' },
        { text: 'Arrangement', key: 'arrangement' },
        { text: 'Invoicing', key: 'invoicing' },
        { text: 'Status', key: 'status' }
      ];
      const thCounterFOM = document.createElement('th');
      thCounterFOM.textContent = '#';
      thCounterFOM.style.textAlign='center'; thCounterFOM.style.padding='6px'; thCounterFOM.style.fontSize='12px'; thCounterFOM.style.borderBottom='2px solid #eef2f7'; thCounterFOM.style.fontWeight='600'; thCounterFOM.style.background='#f9fafb';
      thCounterFOM.style.position='sticky'; thCounterFOM.style.top='0'; thCounterFOM.style.zIndex='2'; thCounterFOM.style.width='40px';
      hdrFOM.appendChild(thCounterFOM);
      headerDefsFOM.forEach(def => {
        const th = document.createElement('th'); th.textContent = def.text;
        th.style.textAlign='left'; th.style.padding='6px'; th.style.fontSize='12px'; th.style.borderBottom='2px solid #eef2f7'; th.style.fontWeight='600'; th.style.background='#f9fafb';
        th.style.position='sticky'; th.style.top='0'; th.style.zIndex='2';
        hdrFOM.appendChild(th);
      });
      const thPeriodFOM = document.createElement('th');
      thPeriodFOM.textContent = 'Period'; thPeriodFOM.colSpan = daysInMonthFOM;
      thPeriodFOM.style.textAlign='center'; thPeriodFOM.style.padding='6px'; thPeriodFOM.style.fontSize='12px'; thPeriodFOM.style.borderBottom='2px solid #eef2f7'; thPeriodFOM.style.fontWeight='600'; thPeriodFOM.style.background='#f9fafb'; thPeriodFOM.style.position='sticky'; thPeriodFOM.style.top='0'; thPeriodFOM.style.zIndex='2';
      hdrFOM.appendChild(thPeriodFOM);
      theadFOM.appendChild(hdrFOM);

      if(firstOfMonthUnits.length === 0){
        const tr = document.createElement('tr'); const td = document.createElement('td');
        td.colSpan = headerDefsFOM.length + daysInMonthFOM + 1; td.textContent = `No units tagged "First of the Month" for ${monthNameFOM} ${nextYearFOM}.`; td.className = 'small-muted'; td.style.padding='12px';
        tr.appendChild(td); tbodyFOM.appendChild(tr);
      } else {
        firstOfMonthUnits.forEach((u, idx) => {
          const tr = document.createElement('tr');
          tr.addEventListener('mouseenter', () => { if(tr.dataset.selected !== 'true') tr.style.backgroundColor = '#f3f6fb'; });
          tr.addEventListener('mouseleave', () => { if(tr.dataset.selected !== 'true') tr.style.backgroundColor = ''; });
          tr.addEventListener('click', () => {
            const tbodyEl = tr.parentNode;
            if(tbodyEl){ Array.from(tbodyEl.querySelectorAll('tr')).forEach(row => { row.dataset.selected=''; row.style.backgroundColor=''; }); }
            tr.dataset.selected = 'true';
            tr.style.backgroundColor = '#e6f0ff';
          });
          const tdCounter = document.createElement('td');
          tdCounter.textContent = String(idx + 1);
          tdCounter.style.textAlign='center'; tdCounter.style.padding='6px'; tdCounter.style.borderBottom='1px solid #eef2f7'; tdCounter.style.fontSize='12px';
          tr.appendChild(tdCounter);
          const infoCellsFOM = [u.unitId||'', u.lease||'', u.supplier||'', u.arrangement||'', u.invoicing||'', u.status||'Operational'];
          infoCellsFOM.forEach((val, cIdx) => {
            const td = document.createElement('td');
            td.style.padding='6px'; td.style.borderBottom='1px solid #eef2f7'; td.style.fontSize='12px';
            if(cIdx === 0){
              td.style.cursor = 'pointer';
              td.style.color = '#0b74de';
              td.title = 'View unit details';
              td.appendChild(document.createTextNode(String(val)));
              try{
                const monthComments = extractMonthComments(u, nextYearFOM, nextMonthFOM);
                if(monthComments && monthComments.length > 0){
                  const alertIcon = document.createElement('span');
                  alertIcon.textContent = ' !';
                  alertIcon.style.color = '#dc2626';
                  alertIcon.style.fontWeight = '700';
                  alertIcon.style.marginLeft = '6px';
                  alertIcon.style.cursor = 'pointer';
                  alertIcon.title = 'Comments exist for this month';
                  alertIcon.addEventListener('click', (e)=>{ e.stopPropagation(); try{ openCommentsModalFromWdNumbers(u.unitId, nextYearFOM, nextMonthFOM); }catch(e){} });
                  td.appendChild(alertIcon);
                }
              }catch(e){}
              td.addEventListener('click', (ev)=>{
                ev.stopPropagation();
                const trEl = td.parentNode; const tbodyEl = trEl && trEl.parentNode;
                if(tbodyEl){ Array.from(tbodyEl.querySelectorAll('tr')).forEach(row => { row.dataset.selected=''; row.style.backgroundColor=''; }); }
                if(trEl){ trEl.dataset.selected='true'; trEl.style.backgroundColor='#e6f0ff'; }
                try{ openUnitWdNumbersModal(u.unitId, nextYearFOM, nextMonthFOM, firstOfMonthUnits.map(x => x.unitId)); }catch(e){}
              });
            } else { td.textContent = String(val); }
            tr.appendChild(td);
          });

          const covFOM = coverageArrayForUnit(u, nextYearFOM, nextMonthFOM) || [];
          const countsFOM = rentalCountsArrayForUnit(u, nextYearFOM, nextMonthFOM) || [];
          const creditDaysFOM = creditArrayForUnit(u, nextYearFOM, nextMonthFOM) || [];
          const disabledPeriodsFOM = getDisabledPeriods(u) || [];
          for(let d=1; d<=daysInMonthFOM; d++){
            const tdDay = document.createElement('td'); tdDay.style.padding='2px'; tdDay.style.textAlign='center'; tdDay.style.verticalAlign='middle';
            const square = document.createElement('div');
            square.style.width = '20px'; square.style.height = '20px'; square.style.border = '1px solid #ddd'; square.style.borderRadius = '3px';
            square.style.display = 'flex'; square.style.alignItems = 'center'; square.style.justifyContent = 'center'; square.style.fontSize = '9px';
            square.textContent = d;
            const covered = !!covFOM[d-1];
            const overlap = (countsFOM[d-1] > 1);
            const credit = !!creditDaysFOM[d-1];
            const isDisabled = isDateInDisabledPeriod(nextYearFOM, nextMonthFOM, d, disabledPeriodsFOM);

            if(isDisabled){ tdDay.style.backgroundColor = '#dc2626'; }

            if(credit){
              square.style.borderColor = '#eab308';
              square.style.borderWidth = '2px';
              square.style.color = '#eab308';
              square.style.fontWeight = '700';
              if(overlap){ square.style.backgroundColor = '#fee2e2'; }
              else if(covered){ square.style.backgroundColor = '#dcfce7'; }
              else { square.style.backgroundColor = '#ffffff'; }
            } else if(overlap){
              square.style.backgroundColor = '#fee2e2';
              square.style.borderColor = '#dc2626';
              square.style.color = '#991b1b';
              square.style.fontWeight = '600';
            } else if(covered){
              square.style.backgroundColor = '#dcfce7';
              square.style.borderColor = '#16a34a';
              square.style.color = '#15803d';
              square.style.fontWeight = '600';
            } else if(isDisabled){
              square.style.backgroundColor = '#ffffff';
              square.style.borderColor = '#991b1b';
              square.style.color = '#dc2626';
              square.style.fontWeight = '600';
            } else {
              square.style.backgroundColor = '#fff';
              square.style.color = '#6b7280';
            }
            tdDay.appendChild(square);
            tr.appendChild(tdDay);
          }
          tbodyFOM.appendChild(tr);
        });
      }

      tableFOM.appendChild(theadFOM); tableFOM.appendChild(tbodyFOM);
      scrollerFOM.appendChild(tableFOM);
      resultsWrap.appendChild(scrollerFOM);
    }

    // --- Bottom: Units with 2+ consecutive months without invoicing ---
    try{
      const streakMonthsRows = [];
      // Anchor the counting start date to Jan 2022
      const ANCHOR_YEAR = 2022;
      const ANCHOR_MONTH = 0; // Jan
      const monthsSinceAnchor = (year - ANCHOR_YEAR) * 12 + (month - ANCHOR_MONTH) + 1;
      const MAX_LOOKBACK_MONTHS = Math.max(36, monthsSinceAnchor);
      function hasAnyInvoiceInMonth(u, y, m){
        const unitIdNorm = (u.unitId || u.id || '').toString().trim().toLowerCase();
        const monthStart = new Date(y, m, 1);
        const monthEnd = new Date(y, m+1, 0);
        return (state.invoices||[]).some(inv => {
          const invUnitNorm = (inv.unit||'').toString().trim().toLowerCase();
          if(invUnitNorm !== unitIdNorm) return false;
          const cat = (inv.category || '').toString().trim().toLowerCase();
          if(!cat.includes('rental')) return false; // consider Rental invoices only
          if(!inv.periodStart || !inv.periodEnd) return false;
          const sp = String(inv.periodStart).split('-'); const ep = String(inv.periodEnd).split('-');
          const start = new Date(parseInt(sp[0]), parseInt(sp[1]) - 1, parseInt(sp[2]));
          const end = new Date(parseInt(ep[0]), parseInt(ep[1]) - 1, parseInt(ep[2]));
          if(isNaN(start) || isNaN(end)) return false;
          return !(end < monthStart || start > monthEnd);
        });
      }
      function shiftMonth(y, m, delta){
        let yy = y, mm = m + delta;
        while(mm < 0){ mm += 12; yy -= 1; }
        while(mm > 11){ mm -= 12; yy += 1; }
        return [yy, mm];
      }
      function parseDateSafe(d){
        if(!d) return null;
        const t = new Date(d);
        if(!isNaN(t)) return t;
        const parts = String(d).split('-');
        if(parts.length === 3){
          const n = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
          if(!isNaN(n)) return n;
        }
        return null;
      }
      function getLastWdForUnit(u){
        const uid = (u.unitId || u.id || '').toString().trim().toLowerCase();
        let latest = null;
        (state.invoices||[]).forEach(inv => {
          const invUnit = (inv.unit||'').toString().trim().toLowerCase();
          if(invUnit !== uid) return;
          const cat = (inv.category||'').toString().trim().toLowerCase();
          // Only consider Rental category invoices
          if(!(cat.includes('rental'))) return;
          const wd = (inv.wdNumber||'').toString().trim();
          if(!wd) return;
          let dt = parseDateSafe(inv.submittedDate);
          if(!dt) dt = parseDateSafe(inv.periodEnd);
          if(!dt) dt = parseDateSafe(inv.periodStart);
          if(!dt) return;
          if(!latest || dt > latest.date){ latest = { wdNumber: wd, date: dt }; }
        });
        return latest;
      }
      // Exclude disabled units from the no-invoicing streak report
      const eligibleUnits = (units||[]).filter(u => {
        const status = (u.status || '').toString().trim().toLowerCase();
        return status !== 'disabled';
      });
      eligibleUnits.forEach(u => {
        let m = month; let y = year; let streak = 0;
        for(let i=0; i<MAX_LOOKBACK_MONTHS; i++){
          // Stop if we would go earlier than Jan 2022
          if (y < ANCHOR_YEAR || (y === ANCHOR_YEAR && m < ANCHOR_MONTH)) break;
          const cov = coverageArrayForUnit(u, y, m);
          const hasAnyCoverage = Array.isArray(cov) && cov.some(Boolean);
          const hasInvoice = hasAnyInvoiceInMonth(u, y, m);
          if(hasAnyCoverage || hasInvoice) break;
          streak++;
          m -= 1; if(m < 0){ m = 11; y -= 1; }
        }
        if(streak >= 2){
          let [startY, startM] = shiftMonth(year, month, -(streak-1));
          // Cap the displayed start period at Jan 2022
          if (startY < ANCHOR_YEAR || (startY === ANCHOR_YEAR && startM < ANCHOR_MONTH)){
            startY = ANCHOR_YEAR; startM = ANCHOR_MONTH;
          }
          const startLabel = `${monthNames[startM]} ${startY}`;
          const endLabel = `${monthNames[month]} ${year}`;
          const periodText = `${startLabel} - ${endLabel}`;
          const lastWd = getLastWdForUnit(u);
          const lastWdNumber = lastWd ? lastWd.wdNumber : '';
          const lastWdAt = lastWd ? lastWd.date.getTime() : 0;
          streakMonthsRows.push({ u, streak, periodText, lastWd: lastWdNumber, lastWdAt });
        }
      });

      // Always render the section with a table, even if empty
      // Sorting state for monthly no-invoice streak table
      state.meta.reportSimple.sortNoInvoiceMonths = state.meta.reportSimple.sortNoInvoiceMonths || { column: 'streak', ascending: false };
      const sortMonths = state.meta.reportSimple.sortNoInvoiceMonths;
      // Apply sort when rows exist
      if(streakMonthsRows.length){
        const getVal = (row, key) => {
          if(key === 'streak') return row.streak || 0;
          if(key === 'lastWd') return row.lastWdAt || 0;
          if(key === 'unitId') return (row.u.unitId || row.u.id || '').toString();
          if(key === 'lease') return (row.u.lease || '').toString();
          if(key === 'supplier') return (row.u.supplier || '').toString();
          if(key === 'description') return (row.u.description || '').toString();
          if(key === 'invoicing') return (row.u.invoicing || '').toString();
          if(key === 'status') return (row.u.status || 'Operational').toString();
          if(key === 'periodText') return (row.periodText || '').toString();
          return '';
        };
        streakMonthsRows.sort((a,b)=>{
          const va = getVal(a, sortMonths.column);
          const vb = getVal(b, sortMonths.column);
          let cmp = 0;
          if(sortMonths.column === 'streak'){
            cmp = (va - vb);
          } else {
            const sa = va.toString().toLowerCase();
            const sb = vb.toString().toLowerCase();
            if(sa < sb) cmp = -1; else if(sa > sb) cmp = 1; else cmp = 0;
          }
          if(!sortMonths.ascending) cmp = -cmp;
          if(cmp !== 0) return cmp;
          // tie-breaker by unitId asc
          const ua = (a.u.unitId || a.u.id || '').toString().toLowerCase();
          const ub = (b.u.unitId || b.u.id || '').toString().toLowerCase();
          if(ua < ub) return -1; if(ua > ub) return 1; return 0;
        });
      }

      // assign export dataset
      computedNoInvoiceRows = streakMonthsRows.slice();

      const title = document.createElement('div');
      title.textContent = 'Units With \u22652 Consecutive Months Without Invoicing';
      title.style.margin = '12px 0 8px';
      title.style.fontWeight = '600';
      const sectionConsecutive = document.createElement('div');
      sectionConsecutive.id = 'report-consecutive-without-invoicing';
      sectionConsecutive.appendChild(title);

      const cont = document.createElement('div');
      cont.style.maxHeight = '400px';
      cont.style.overflowY = 'auto';
      cont.style.border = '1px solid #eef2f7';
      cont.style.borderRadius = '6px';
      cont.style.padding = '8px';
      cont.style.background = '#fff';

      const tbl = document.createElement('table');
      tbl.style.width = '100%'; tbl.style.borderCollapse = 'collapse';
      const theadM = document.createElement('thead'); const tbodyM = document.createElement('tbody');
      const hr = document.createElement('tr');
      const headerDefsMonths = [
        { text: 'Unit', key: 'unitId' },
        { text: 'Lease', key: 'lease' },
        { text: 'Supplier', key: 'supplier' },
        { text: 'Description', key: 'description' },
        { text: 'Invoicing', key: 'invoicing' },
        { text: 'Last WD Number', key: 'lastWd' },
        { text: 'Status', key: 'status' },
        { text: 'Consecutive Months (no rental invoice)', key: 'streak' },
        { text: 'Period', key: 'periodText' }
      ];
      // Counter column
      const thCounterMonths = document.createElement('th');
      thCounterMonths.textContent = '#';
      thCounterMonths.style.textAlign='center'; thCounterMonths.style.padding='6px'; thCounterMonths.style.fontSize='12px'; thCounterMonths.style.borderBottom='2px solid #eef2f7'; thCounterMonths.style.fontWeight='600'; thCounterMonths.style.background='#f9fafb';
      thCounterMonths.style.position='sticky'; thCounterMonths.style.top='0'; thCounterMonths.style.zIndex='2'; thCounterMonths.style.width='40px';
      hr.appendChild(thCounterMonths);
      headerDefsMonths.forEach(def => {
        const th = document.createElement('th');
        let label = def.text;
        if(sortMonths.column === def.key){ label += sortMonths.ascending ? ' ▲' : ' ▼'; }
        th.textContent = label;
        th.style.textAlign='left'; th.style.padding='6px'; th.style.fontSize='12px'; th.style.borderBottom='2px solid #eef2f7'; th.style.fontWeight='600'; th.style.background='#f9fafb';
        th.style.position='sticky'; th.style.top='0'; th.style.zIndex='2';
        th.style.cursor='pointer'; th.style.userSelect='none'; th.title='Click to sort';
        th.addEventListener('click', ()=>{
          if(state.meta.reportSimple.sortNoInvoiceMonths.column === def.key){
            state.meta.reportSimple.sortNoInvoiceMonths.ascending = !state.meta.reportSimple.sortNoInvoiceMonths.ascending;
          } else {
            state.meta.reportSimple.sortNoInvoiceMonths.column = def.key;
            state.meta.reportSimple.sortNoInvoiceMonths.ascending = true;
          }
          try{ saveState(); }catch(e){}
          run();
        });
        hr.appendChild(th);
      });
      theadM.appendChild(hr); tbl.appendChild(theadM);

      if(streakMonthsRows.length === 0){
        const tr = document.createElement('tr'); const td = document.createElement('td');
        td.colSpan = headerDefsMonths.length + 1; td.textContent = 'No units with consecutive months without rental invoicing.'; td.className = 'small-muted'; td.style.padding='12px';
        tr.appendChild(td); tbodyM.appendChild(tr);
      } else {
        streakMonthsRows.forEach((row, idx) => {
          const tr = document.createElement('tr');
          tr.addEventListener('mouseenter', ()=>{ if(tr.dataset.selected!=='true') tr.style.backgroundColor='#f3f6fb'; });
          tr.addEventListener('mouseleave', ()=>{ if(tr.dataset.selected!=='true') tr.style.backgroundColor=''; });
          tr.addEventListener('click', ()=>{ const tb=tr.parentNode; if(tb){ Array.from(tb.querySelectorAll('tr')).forEach(x=>{ x.dataset.selected=''; x.style.backgroundColor=''; }); } tr.dataset.selected='true'; tr.style.backgroundColor='#e6f0ff'; });
          // Counter cell
          const tdCounter = document.createElement('td');
          tdCounter.textContent = String(idx + 1);
          tdCounter.style.textAlign='center'; tdCounter.style.padding='6px'; tdCounter.style.borderBottom='1px solid #eef2f7'; tdCounter.style.fontSize='12px';
          tr.appendChild(tdCounter);
          const cells = [
            row.u.unitId||'',
            row.u.lease||'',
            row.u.supplier||'',
            row.u.description||'',
            row.u.invoicing||'',
            row.lastWd || '',
            row.u.status||'Operational',
            String(row.streak),
            row.periodText
          ];
          cells.forEach((val, idx)=>{
            const td = document.createElement('td');
            td.style.padding='6px'; td.style.borderBottom='1px solid #eef2f7'; td.style.fontSize='12px';
            if(idx===0){
              td.style.cursor='pointer'; td.style.color='#0b74de'; td.title='View unit details';
              td.appendChild(document.createTextNode(String(val)));
              // Add red ! indicator if comments exist for selected month
              try{
                const monthComments = extractMonthComments(row.u, year, month);
                if(monthComments && monthComments.length>0){
                  const alertIcon = document.createElement('span');
                  alertIcon.textContent = ' !';
                  alertIcon.style.color = '#dc2626';
                  alertIcon.style.fontWeight = '700';
                  alertIcon.style.marginLeft = '6px';
                  alertIcon.style.cursor = 'pointer';
                  alertIcon.title = 'Comments exist for this month';
                  alertIcon.addEventListener('click', (e)=>{ e.stopPropagation(); try{ openCommentsModalFromWdNumbers(row.u.unitId, year, month); }catch(e){} });
                  td.appendChild(alertIcon);
                }
              }catch(e){}
              td.addEventListener('click',(ev)=>{ ev.stopPropagation(); try{ openUnitWdNumbersModal(row.u.unitId, year, month, streakMonthsRows.map(r => r.u.unitId)); }catch(e){} });
            } else {
              td.textContent = String(val);
            }
            tr.appendChild(td);
          });
          tbodyM.appendChild(tr);
        });
      }

      tbl.appendChild(tbodyM);
      cont.appendChild(tbl);
      sectionConsecutive.appendChild(cont);
      resultsWrap.appendChild(sectionConsecutive);
    }catch(e){}
  }

  // Removed manual Refresh button; report auto-updates on changes and state saves
  // Auto-refresh when state changes (only if Report tab is active)
  if(!window.__reportAutoRefreshInit){
    window.__reportAutoRefreshInit = true;
    window.addEventListener('agi:stateSaved', ()=>{
      const panel = qs('#report');
      const overviewPanel = qs('#overview');
      const isVisible = !!panel && !!overviewPanel && overviewPanel.classList.contains('active') && panel.style.display !== 'none';
      if(isVisible){
        try{ run(); }catch(e){}
      }
    });
  }
  run();
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
      if(saveBtn){ saveBtn.dataset.editIndex = i; saveBtn.dataset.editOriginalValue = c; saveBtn.textContent = 'Save'; }
      devCompanyInput.focus();
    });
    const delBtn = document.createElement('button'); delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', async ()=>{
      if(!confirm('Delete this company?')) return;
      delBtn.disabled = true;
      try{
        const fresh = await fetchFreshConfigArray('devCompanies');
        const idx = fresh.findIndex(x => x === c);
        if(idx !== -1) fresh.splice(idx,1);
        commitConfigListChange('devCompanies', fresh);
        renderCompanyList();
      }catch(e){
        alert('Could not delete — could not reach Google Sheets. Please try again.\n' + (e && e.message || ''));
        delBtn.disabled = false;
      }
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
  saveDevBtn.addEventListener('click', async ()=>{
    const v = (devCompanyInput && devCompanyInput.value || '').trim();
    if(!v){ alert('Please enter a company name'); return; }
    const isEditing = typeof saveDevBtn.dataset.editIndex !== 'undefined';
    const originalValue = saveDevBtn.dataset.editOriginalValue;
    saveDevBtn.disabled = true;
    try{
      const fresh = await fetchFreshConfigArray('devCompanies');
      const dupIdx = fresh.findIndex(x => x.toLowerCase() === v.toLowerCase());
      if(isEditing){
        const idx = fresh.findIndex(x => x === originalValue);
        if(dupIdx !== -1 && fresh[dupIdx] !== originalValue){ alert('"' + v + '" already exists.'); return; }
        if(idx !== -1) fresh[idx] = v; else fresh.push(v);
      } else {
        if(dupIdx !== -1){ alert('"' + v + '" already exists.'); return; }
        fresh.push(v);
      }
      commitConfigListChange('devCompanies', fresh);
      delete saveDevBtn.dataset.editIndex;
      delete saveDevBtn.dataset.editOriginalValue;
      saveDevBtn.textContent = 'New';
      renderCompanyList();
      if(devCompanyInput) devCompanyInput.value = '';
    }catch(e){
      alert('Could not save changes — could not reach Google Sheets. Please try again.\n' + (e && e.message || ''));
    }finally{
      saveDevBtn.disabled = false;
    }
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
      if(saveBtn){ saveBtn.dataset.editIndex = i; saveBtn.dataset.editOriginalValue = r; saveBtn.textContent = 'Save'; }
      devRentalInput.focus();
    });
    const delBtn = document.createElement('button'); delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', async ()=>{
      if(!confirm('Delete this rental?')) return;
      delBtn.disabled = true;
      try{
        const fresh = await fetchFreshConfigArray('devRentals');
        const idx = fresh.findIndex(x => x === r);
        if(idx !== -1) fresh.splice(idx,1);
        commitConfigListChange('devRentals', fresh);
        renderRentalList();
        if(typeof syncInvoiceCategoryOptions === 'function') syncInvoiceCategoryOptions();
      }catch(e){
        alert('Could not delete — could not reach Google Sheets. Please try again.\n' + (e && e.message || ''));
        delBtn.disabled = false;
      }
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
  saveRentalBtn.addEventListener('click', async ()=>{
    const v = devRentalInput && devRentalInput.value ? devRentalInput.value.trim() : '';
    if(v === ''){ alert('Please enter a rental value'); return; }
    const isEditing = typeof saveRentalBtn.dataset.editIndex !== 'undefined';
    const originalValue = saveRentalBtn.dataset.editOriginalValue;
    saveRentalBtn.disabled = true;
    try{
      const fresh = await fetchFreshConfigArray('devRentals');
      const dupIdx = fresh.findIndex(x => x.toLowerCase() === v.toLowerCase());
      if(isEditing){
        const idx = fresh.findIndex(x => x === originalValue);
        if(dupIdx !== -1 && fresh[dupIdx] !== originalValue){ alert('"' + v + '" already exists.'); return; }
        if(idx !== -1) fresh[idx] = v; else fresh.push(v);
      } else {
        if(dupIdx !== -1){ alert('"' + v + '" already exists.'); return; }
        fresh.push(v);
      }
      commitConfigListChange('devRentals', fresh);
      delete saveRentalBtn.dataset.editIndex;
      delete saveRentalBtn.dataset.editOriginalValue;
      saveRentalBtn.textContent = 'new';
      renderRentalList();
      if(typeof syncInvoiceCategoryOptions === 'function') syncInvoiceCategoryOptions();
      if(devRentalInput) devRentalInput.value = '';
    }catch(e){
      alert('Could not save changes — could not reach Google Sheets. Please try again.\n' + (e && e.message || ''));
    }finally{
      saveRentalBtn.disabled = false;
    }
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
      if(saveBtn){ saveBtn.dataset.editIndex = i; saveBtn.dataset.editOriginalValue = s; saveBtn.textContent = 'Save'; }
      devSupplierInput.focus();
    });
    const delBtn = document.createElement('button'); delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', async ()=>{
      if(!confirm('Delete this supplier?')) return;
      delBtn.disabled = true;
      try{
        const fresh = await fetchFreshConfigArray('devSuppliers');
        const idx = fresh.findIndex(x => x === s);
        if(idx !== -1) fresh.splice(idx,1);
        commitConfigListChange('devSuppliers', fresh);
        renderSupplierList();
      }catch(e){
        alert('Could not delete — could not reach Google Sheets. Please try again.\n' + (e && e.message || ''));
        delBtn.disabled = false;
      }
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
  saveSupplierBtn.addEventListener('click', async ()=>{
    const v = devSupplierInput && devSupplierInput.value ? devSupplierInput.value.trim() : '';
    if(v === ''){ alert('Please enter a supplier name'); return; }
    const isEditing = typeof saveSupplierBtn.dataset.editIndex !== 'undefined';
    const originalValue = saveSupplierBtn.dataset.editOriginalValue;
    saveSupplierBtn.disabled = true;
    try{
      const fresh = await fetchFreshConfigArray('devSuppliers');
      const dupIdx = fresh.findIndex(x => x.toLowerCase() === v.toLowerCase());
      if(isEditing){
        const idx = fresh.findIndex(x => x === originalValue);
        if(dupIdx !== -1 && fresh[dupIdx] !== originalValue){ alert('"' + v + '" already exists.'); return; }
        if(idx !== -1) fresh[idx] = v; else fresh.push(v);
      } else {
        if(dupIdx !== -1){ alert('"' + v + '" already exists.'); return; }
        fresh.push(v);
      }
      commitConfigListChange('devSuppliers', fresh);
      delete saveSupplierBtn.dataset.editIndex;
      delete saveSupplierBtn.dataset.editOriginalValue;
      saveSupplierBtn.textContent = 'new';
      renderSupplierList();
      if(devSupplierInput) devSupplierInput.value = '';
    }catch(e){
      alert('Could not save changes — could not reach Google Sheets. Please try again.\n' + (e && e.message || ''));
    }finally{
      saveSupplierBtn.disabled = false;
    }
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
      if(saveBtn){ saveBtn.dataset.editIndex = i; saveBtn.dataset.editOriginalValue = p; saveBtn.textContent = 'Save'; }
      devPaymentInput.focus();
    });
    const delBtn = document.createElement('button'); delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', async ()=>{
      if(!confirm('Delete this invoicing type?')) return;
      delBtn.disabled = true;
      try{
        const fresh = await fetchFreshConfigArray('devPayments');
        const idx = fresh.findIndex(x => x === p);
        if(idx !== -1) fresh.splice(idx,1);
        commitConfigListChange('devPayments', fresh);
        renderPaymentList();
      }catch(e){
        alert('Could not delete — could not reach Google Sheets. Please try again.\n' + (e && e.message || ''));
        delBtn.disabled = false;
      }
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
  savePaymentBtn.addEventListener('click', async ()=>{
    const v = devPaymentInput && devPaymentInput.value ? devPaymentInput.value.trim() : '';
    if(v === ''){ alert('Please enter an invoicing type'); return; }
    const isEditing = typeof savePaymentBtn.dataset.editIndex !== 'undefined';
    const originalValue = savePaymentBtn.dataset.editOriginalValue;
    savePaymentBtn.disabled = true;
    try{
      const fresh = await fetchFreshConfigArray('devPayments');
      const dupIdx = fresh.findIndex(x => x.toLowerCase() === v.toLowerCase());
      if(isEditing){
        const idx = fresh.findIndex(x => x === originalValue);
        if(dupIdx !== -1 && fresh[dupIdx] !== originalValue){ alert('"' + v + '" already exists.'); return; }
        if(idx !== -1) fresh[idx] = v; else fresh.push(v);
      } else {
        if(dupIdx !== -1){ alert('"' + v + '" already exists.'); return; }
        fresh.push(v);
      }
      commitConfigListChange('devPayments', fresh);
      delete savePaymentBtn.dataset.editIndex;
      delete savePaymentBtn.dataset.editOriginalValue;
      savePaymentBtn.textContent = 'new';
      renderPaymentList();
      if(devPaymentInput) devPaymentInput.value = '';
    }catch(e){
      alert('Could not save changes — could not reach Google Sheets. Please try again.\n' + (e && e.message || ''));
    }finally{
      savePaymentBtn.disabled = false;
    }
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
      if(saveBtn){ saveBtn.dataset.editIndex = i; saveBtn.dataset.editOriginalValue = a; saveBtn.textContent = 'Save'; }
      devArrangementInput.focus();
    });
    const delBtn = document.createElement('button'); delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', async ()=>{
      if(!confirm('Delete this arrangement?')) return;
      delBtn.disabled = true;
      try{
        const fresh = await fetchFreshConfigArray('devArrangements');
        const idx = fresh.findIndex(x => x === a);
        if(idx !== -1) fresh.splice(idx,1);
        commitConfigListChange('devArrangements', fresh);
        renderArrangementList();
      }catch(e){
        alert('Could not delete — could not reach Google Sheets. Please try again.\n' + (e && e.message || ''));
        delBtn.disabled = false;
      }
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
  saveArrangementBtn.addEventListener('click', async ()=>{
    const v = devArrangementInput && devArrangementInput.value ? devArrangementInput.value.trim() : '';
    if(v === ''){ alert('Please enter an arrangement'); return; }
    const isEditing = typeof saveArrangementBtn.dataset.editIndex !== 'undefined';
    const originalValue = saveArrangementBtn.dataset.editOriginalValue;
    saveArrangementBtn.disabled = true;
    try{
      const fresh = await fetchFreshConfigArray('devArrangements');
      const dupIdx = fresh.findIndex(x => x.toLowerCase() === v.toLowerCase());
      if(isEditing){
        const idx = fresh.findIndex(x => x === originalValue);
        if(dupIdx !== -1 && fresh[dupIdx] !== originalValue){ alert('"' + v + '" already exists.'); return; }
        if(idx !== -1) fresh[idx] = v; else fresh.push(v);
      } else {
        if(dupIdx !== -1){ alert('"' + v + '" already exists.'); return; }
        fresh.push(v);
      }
      commitConfigListChange('devArrangements', fresh);
      delete saveArrangementBtn.dataset.editIndex;
      delete saveArrangementBtn.dataset.editOriginalValue;
      saveArrangementBtn.textContent = 'new';
      renderArrangementList();
      if(devArrangementInput) devArrangementInput.value = '';
    }catch(e){
      alert('Could not save changes — could not reach Google Sheets. Please try again.\n' + (e && e.message || ''));
    }finally{
      saveArrangementBtn.disabled = false;
    }
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
  const sections = ['generalOverview','unitOverview','leaseOverview','report','anualOverview'];
  sections.forEach(s => {
    const el = qs('#'+s);
    if(!el) return;
    el.style.display = (s === sectionId) ? '' : 'none';
  });
  // toggle active-sub class on buttons
  document.querySelectorAll('.overview-tab').forEach(b=>{
    if(b.dataset.section === sectionId) b.classList.add('active-sub'); else b.classList.remove('active-sub');
  });
  // Render the section now to ensure data is fresh without extra clicks
  try{
    if(sectionId === 'generalOverview'){ renderOverview(); }
    else if(sectionId === 'unitOverview'){ renderUnitOverview(); }
    else if(sectionId === 'leaseOverview'){ renderLeaseOverview(); }
    else if(sectionId === 'report'){ renderReport(); }
    else if(sectionId === 'anualOverview'){ renderAnualOverview(); }
  }catch(e){ /* ignore render errors */ }
      if(sec === 'anualOverview') renderAnualOverview();
}

function initOverviewSubtabs(){
  state.meta = state.meta || {};

// --- Annual Overview placeholder ---
function renderAnualOverview(){
  const el = qs('#anualOverview'); if(!el) return;
  el.innerHTML = '';
  const container = document.createElement('div');
  container.style.cssText = 'padding:10px;border:1px solid #eef2f7;border-radius:6px;';
  const title = document.createElement('div');
  title.style.fontWeight = '600';
  title.textContent = 'Annual Overview';
  const desc = document.createElement('div');
  desc.className = 'small-muted';
  desc.style.marginTop = '6px';
  desc.textContent = 'This section is a placeholder for annual summaries.';
  container.appendChild(title);
  container.appendChild(desc);
  el.appendChild(container);
}
  // Default to Report so users immediately see the report tables
  const defaultSection = state.meta.overviewSection || 'report';
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
// Multi-select lease picker for the Registry Edit modal (a registry can span multiple leases).
function getSelectedRegistryLeases(){
  const panel = qs('#editRegistryLeasePanel'); if(!panel) return [];
  return Array.from(panel.querySelectorAll('input[type="checkbox"][name="editRegistryLease"]:checked')).map(cb => cb.value);
}
function getSelectedRegistryUnits(){
  const container = qs('#editRegistryUnits'); if(!container) return [];
  return Array.from(container.querySelectorAll('input[type="checkbox"]:checked')).map(cb => cb.value);
}
function renderRegistryUnitBreakdown(seed){
  renderUnitBreakdownTable('registryUnitBreakdown', getSelectedRegistryUnits(), 'editRegistryAmount', seed);
}

// Renders as an always-visible bordered checkbox list (same format as the Units box below it),
// with its own search box, rather than a toggle + floating dropdown.
function syncRegistryLeaseOptions(selectedValues){
  selectedValues = Array.isArray(selectedValues) ? selectedValues.map(s=>String(s)) : (selectedValues ? [String(selectedValues)] : getSelectedRegistryLeases());
  const panel = qs('#editRegistryLeasePanel');
  if(!panel) return;

  const leases = (state.leases || []).filter(l => {
    const status = (l.status || 'Enabled').toString().toLowerCase();
    return status !== 'disabled';
  });

  panel.innerHTML = '';
  if(leases.length === 0){ const none = document.createElement('div'); none.className = 'small-muted'; none.textContent = '(no leases available)'; panel.appendChild(none); return; }

  leases.forEach(l => {
    const val = (l.leaseNumber || l.id || '').toString();
    const label = document.createElement('label');
    label.className = 'edit-registry-lease-row';
    label.setAttribute('data-lease-id', val.toLowerCase());
    label.style.display = 'flex';
    label.style.alignItems = 'center';
    label.style.gap = '8px';
    label.style.cursor = 'pointer';
    label.style.padding = '4px';
    label.style.borderRadius = '4px';
    label.style.transition = 'background 0.2s';

    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.name = 'editRegistryLease'; cb.value = val; cb.style.cursor = 'pointer';
    if(selectedValues.length && selectedValues.indexOf(val) !== -1) cb.checked = true;
    const text = document.createElement('span'); text.textContent = val; text.style.fontSize = '13px';

    label.appendChild(cb); label.appendChild(text);
    label.addEventListener('mouseenter', () => { label.style.background = '#f3f6fb'; });
    label.addEventListener('mouseleave', () => { label.style.background = 'transparent'; });
    cb.addEventListener('change', ()=>{ onRegistryLeaseSelectionChange(); });

    panel.appendChild(label);
  });

  // Wire the search box once; it filters whatever rows are currently rendered
  const searchBox = qs('#editRegistryLeaseSearch');
  if(searchBox && !searchBox.dataset.wired){
    searchBox.dataset.wired = 'true';
    searchBox.addEventListener('input', () => {
      const term = searchBox.value.toLowerCase().trim();
      const rows = qs('#editRegistryLeasePanel') ? qs('#editRegistryLeasePanel').querySelectorAll('.edit-registry-lease-row') : [];
      rows.forEach(row => {
        const lid = row.getAttribute('data-lease-id') || '';
        row.style.display = (term === '' || lid.includes(term)) ? 'flex' : 'none';
      });
    });
  }
  if(searchBox && searchBox.value){
    // Re-apply any active filter after the list has been rebuilt
    searchBox.dispatchEvent(new Event('input'));
  }
}

// When the selected lease set changes, refresh the union of available units and the breakdown.
function onRegistryLeaseSelectionChange(){
  const selectedLeases = getSelectedRegistryLeases();
  const currentlySelectedUnits = getSelectedRegistryUnits();
  if(typeof syncRegistryUnitOptions === 'function') syncRegistryUnitOptions(selectedLeases, currentlySelectedUnits);
  if(typeof renderRegistryUnitBreakdown === 'function') renderRegistryUnitBreakdown();
}

// Populate registry edit units checkboxes based on the union of selected leases
function syncRegistryUnitOptions(leaseVals, selectedUnits){
  const container = qs('#editRegistryUnits'); if(!container) return;
  selectedUnits = Array.isArray(selectedUnits) ? selectedUnits : [];
  const leaseFilter = Array.isArray(leaseVals) ? leaseVals.filter(Boolean) : (leaseVals ? [leaseVals] : []);

  container.innerHTML = '';
  const units = leaseFilter.length === 0 ? (state.units || []) : (state.units || []).filter(u => leaseFilter.indexOf(u.lease) !== -1);

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
    label.className = 'edit-registry-unit-row';
    label.setAttribute('data-unit-id', unitId.toString().toLowerCase());
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
    const normalizedSelected = selectedUnits.map(s => String(s).trim().toLowerCase());
    if(normalizedSelected.includes(String(unitId).trim().toLowerCase())) checkbox.checked = true;

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

    checkbox.addEventListener('change', ()=>{ if(typeof renderRegistryUnitBreakdown === 'function') renderRegistryUnitBreakdown(); });

    container.appendChild(label);
  });

  // Wire the search box once; it filters whatever rows are currently rendered
  const searchBox = qs('#editRegistryUnitSearch');
  if(searchBox && !searchBox.dataset.wired){
    searchBox.dataset.wired = 'true';
    searchBox.addEventListener('input', () => {
      const term = searchBox.value.toLowerCase().trim();
      const rows = qs('#editRegistryUnits') ? qs('#editRegistryUnits').querySelectorAll('.edit-registry-unit-row') : [];
      rows.forEach(row => {
        const uid = row.getAttribute('data-unit-id') || '';
        row.style.display = (term === '' || uid.includes(term)) ? 'flex' : 'none';
      });
    });
  }
  if(searchBox && searchBox.value){
    // Re-apply any active filter after the list has been rebuilt (e.g. lease selection changed)
    searchBox.dispatchEvent(new Event('input'));
  }
}

function openRegistryEditModal(registry){
  const modal = qs('#registryEditModal');
  if(!modal) return;

  // Clear any leftover breakdown rows/sort-state from a previously edited registry so its
  // Tax/Charge values can't leak in as false "existing" data ahead of this registry's own seed.
  const breakdownWrap = qs('#registryUnitBreakdown');
  if(breakdownWrap){
    breakdownWrap.innerHTML = '';
    delete breakdownWrap.dataset.sortCol;
    delete breakdownWrap.dataset.sortDir;
  }
  const unitSearchBox = qs('#editRegistryUnitSearch');
  if(unitSearchBox) unitSearchBox.value = '';
  const leaseSearchBox = qs('#editRegistryLeaseSearch');
  if(leaseSearchBox) leaseSearchBox.value = '';

  // A registry can span multiple leases; fall back to the legacy single lease string,
  // and further to the first unit's lease for very old registries that predate both.
  let registryLeases = Array.isArray(registry.leases) && registry.leases.length
    ? registry.leases.slice()
    : (registry.lease || '').toString().split(',').map(s=>s.trim()).filter(Boolean);
  if(registryLeases.length === 0){
    const registryUnits = Array.isArray(registry.units) ? registry.units : [];
    if(registryUnits.length > 0){
      const firstUnit = (state.units || []).find(u => (u.unitId || u.id) === registryUnits[0]);
      if(firstUnit && firstUnit.lease) registryLeases = [firstUnit.lease];
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

  // Set category value before sync so it can be preserved
  const categorySelect = qs('#editRegistryCategory');
  if(categorySelect) categorySelect.value = registry.category || '';

  // Sync dropdown options
  if(typeof syncRegistryCategoryOptions === 'function') syncRegistryCategoryOptions();
  syncRegistryLeaseOptions(registryLeases);

  // Populate form fields
  qs('#editRegistryId').value = registry.id || '';
  qs('#editRegistryWD').value = registry.wdNumber || '';
  qs('#editRegistryDoc').value = registry.docNumber || '';
  qs('#editRegistryAmount').value = registry.totalAmount || '';

  // Re-set category value after sync to ensure it's selected
  if(categorySelect) categorySelect.value = registry.category || '';

  // Disable the lease picker for Operator role
  const leasePanel = qs('#editRegistryLeasePanel');
  const leaseSearch = qs('#editRegistryLeaseSearch');
  const isOperator = (userRole === 'Operator');
  if(leasePanel) leasePanel.querySelectorAll('input[type="checkbox"]').forEach(cb => { cb.disabled = isOperator; });
  if(leaseSearch){
    leaseSearch.disabled = isOperator;
    leaseSearch.style.backgroundColor = isOperator ? '#f5f5f5' : '';
    leaseSearch.style.cursor = isOperator ? 'not-allowed' : '';
  }

  syncRegistryUnitOptions(registryLeases, Array.isArray(registry.units) ? registry.units : []);

  qs('#editRegistryPeriodStart').value = registry.periodStart || '';
  qs('#editRegistryPeriodEnd').value = registry.periodEnd || '';
  qs('#editRegistrySubmitted').value = registry.submittedDate || '';

  // Seed the editable breakdown table from this registry's stored per-unit detail
  const seedFromDetails = {};
  (Array.isArray(registry.unitDetails) ? registry.unitDetails : []).forEach(d => {
    if(d && d.unit) seedFromDetails[d.unit] = { tax: d.tax || '', charge: d.charge || '' };
  });
  renderRegistryUnitBreakdown(seedFromDetails);

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

const editRegistryAmountField = qs('#editRegistryAmount');
if(editRegistryAmountField) editRegistryAmountField.addEventListener('input', ()=> updateUnitBreakdownTotal('registryUnitBreakdown'));

const registryEditSaveBtn = qs('#registryEditSaveBtn');
if(registryEditSaveBtn){
  registryEditSaveBtn.addEventListener('click', async () => {
    const registryId = qs('#editRegistryId').value;
    const registry = state.registries.find(r => r.id === registryId);
    console.log('Registry save - ID:', registryId, 'Found:', !!registry);
    if(!registry){ alert('Registry not found - please close and reopen the edit modal'); return; }

    // Read the new field values without mutating the registry yet, so a blocked
    // (mismatched-total) save leaves the in-memory registry untouched.
    const newWd = qs('#editRegistryWD').value.trim();
    const newDoc = qs('#editRegistryDoc').value.trim();
    const newTotalAmount = qs('#editRegistryAmount').value.trim();
    const newCategory = qs('#editRegistryCategory').value.trim();
    const newPeriodStart = qs('#editRegistryPeriodStart').value.trim();
    const newPeriodEnd = qs('#editRegistryPeriodEnd').value.trim();
    const newSubmittedDate = qs('#editRegistrySubmitted').value.trim();
    const newUnits = getSelectedRegistryUnits();
    const selectedLeases = getSelectedRegistryLeases();

    // The per-unit Charge + Tax breakdown must add up to the declared Total Amount.
    renderRegistryUnitBreakdown();
    if(!unitBreakdownMatches('registryUnitBreakdown')){
      alert('The sum of Charge Amount + Tax Amount for the selected units must equal the Total Amount. Edit not saved.');
      return;
    }

    const oldWd = registry.wdNumber;
    const breakdownData = getUnitBreakdownRowsData('registryUnitBreakdown');
    const newUnitDetails = [];
    const uniqueLeasesSet = new Set();

    newUnits.forEach(uid => {
      const resolved = resolveInvoiceUnitLeaseInfo(uid, selectedLeases);
      const unitRec = (state.units||[]).find(u => (u.unitId||u.id||'').toString().trim() === uid.toString().trim());
      const rowData = breakdownData[uid] || {};
      const chargeAmount = (function(){ const n = parseCurrency(rowData.charge||''); return n===null ? '' : n.toFixed(2); })();
      const taxAmount = (function(){ const n = parseCurrency(rowData.tax||''); return n===null ? '' : n.toFixed(2); })();
      if(resolved.lease) uniqueLeasesSet.add(resolved.lease);
      newUnitDetails.push({
        unit: uid,
        lease: resolved.lease || '',
        company: resolved.company || '',
        supplier: resolved.supplier || '',
        arrangement: resolved.arrangement || '',
        invoicing: resolved.invoicing || '',
        costCenter: unitRec ? (unitRec.costCenter||'') : '',
        tax: taxAmount,
        charge: chargeAmount
      });

      // Reconcile the in-session invoice record for this unit (create if missing, update if present)
      const existingInv = (state.invoices||[]).find(i => (i.unit||'').toString().trim().toLowerCase() === uid.toString().trim().toLowerCase() && (i.wdNumber||'').toString().trim() === oldWd);
      const invFields = {
        wdNumber: newWd, docNumber: newDoc, category: newCategory,
        periodStart: newPeriodStart, periodEnd: newPeriodEnd, submittedDate: newSubmittedDate,
        lease: resolved.lease || '', company: resolved.company || '', supplier: resolved.supplier || '',
        arrangement: resolved.arrangement || '', invoicing: resolved.invoicing || '',
        amount: chargeAmount, taxAmount: taxAmount
      };
      if(existingInv){
        Object.assign(existingInv, invFields);
      } else {
        state.invoices.push(Object.assign({ id: id(), unit: uid, comment: '' }, invFields));
      }
    });

    // Remove in-session invoice records for units that were dropped from the registry
    const newUnitsLower = newUnits.map(u => u.toString().trim().toLowerCase());
    state.invoices = (state.invoices||[]).filter(inv => {
      const invWd = (inv.wdNumber||'').toString().trim();
      const invUnit = (inv.unit||'').toString().trim().toLowerCase();
      if(invWd !== oldWd) return true; // not part of this registry
      return newUnitsLower.indexOf(invUnit) !== -1;
    });

    const uniqueLeases = Array.from(uniqueLeasesSet);

    // All validated — now commit the changes onto the registry itself
    registry.wdNumber = newWd;
    registry.docNumber = newDoc;
    registry.totalAmount = newTotalAmount;
    registry.category = newCategory;
    registry.periodStart = newPeriodStart;
    registry.periodEnd = newPeriodEnd;
    registry.submittedDate = newSubmittedDate;
    registry.units = newUnits;
    registry.unitCount = newUnits.length;
    registry.unitDetails = newUnitDetails;
    registry.leases = uniqueLeases;
    registry.lease = uniqueLeases.join(', ');

    // Save to Google Sheets and wait for confirmation before rendering
    const saveBtn = qs('#registryEditSaveBtn');
    if(saveBtn){ saveBtn.disabled = true; saveBtn.textContent = 'Saving...'; }
    try {
      await DB.updateRegistry(registry);
    } catch(e) {
      console.error('Registry edit save error:', e);
      alert('Failed to save to Google Sheets: ' + e.message);
      if(saveBtn){ saveBtn.disabled = false; saveBtn.textContent = 'Save Changes'; }
      return;
    }
    if(saveBtn){ saveBtn.disabled = false; saveBtn.textContent = 'Save Changes'; }

    saveState();
    renderRegistries(registry.id);
    renderInvoices();
    renderUnitOverview();
    renderLeaseOverview();
    renderOverview();

    // Rebuild the Unit Detail Modal if it is currently open (it holds a stale snapshot)
    try{
      const detailModal = qs('#unitWdNumbersModal');
      if(detailModal && detailModal.style.display !== 'none' && _unitDetailList && _unitDetailList.length > 0){
        renderUnitDetailModal(_unitDetailList[_unitDetailIndex] || _unitDetailList[0]);
      }
    }catch(e){}

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

  // Populate Cost Center dropdown
  syncUnitCostCenterOptions();
  const ccSel = qs('#editUnitCostCenter');
  if(ccSel) ccSel.value = unit.costCenter || '';

  // Update readonly fields based on selected lease
  updateUnitEditLeaseInfo(unit.lease || '');

  // Add lease change handler
  if(leaseSelect){
    const newLeaseSelect = leaseSelect.cloneNode(true);
    leaseSelect.parentNode.replaceChild(newLeaseSelect, leaseSelect);
    newLeaseSelect.value = unit.lease || '';
    newLeaseSelect.addEventListener('change', () => {
      updateUnitEditLeaseInfo(newLeaseSelect.value);
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
    
    // Update unit fields — only update editable fields, NEVER touch status/statusHistory
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
    unit.costCenter = qs('#editUnitCostCenter') ? qs('#editUnitCostCenter').value : '';
    unit.description = qs('#editUnitDesc').value.trim();
    unit.notes = qs('#editUnitNotes').value.trim();
    // NOTE: status is intentionally NOT updated here — use the Disable/Enable button instead

    // Save to Google Sheets immediately
    DB.updateUnit(unit).catch(e => console.error('Unit edit save error:', e));

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
  if(currentCommentsSource === 'overview'){
    if(!unit.overviewComments) unit.overviewComments = [];
  } else {
    if(!unit.comments) unit.comments = [];
    // default source when opened outside overview
    if(!currentCommentsSource) currentCommentsSource = 'unit';
  }
  
  renderUnitComments();
  modal.style.display = 'flex';
}

function closeUnitCommentsModal(){
  const modal = qs('#unitCommentsModal');
  if(modal) modal.style.display = 'none';
  currentUnitForComments = null;
  currentCommentMonthYear = null; // Clear month/year context
  currentCommentsSource = null; // Clear source context
  const textarea = qs('#newUnitComment');
  if(textarea) textarea.value = '';
}

function renderUnitComments(){
  const list = qs('#unitCommentsList');
  if(!list || !currentUnitForComments) return;
  
  list.innerHTML = '';
  
  let comments = (currentCommentsSource === 'overview') ? (currentUnitForComments.overviewComments || []) : (currentUnitForComments.comments || []);
  
  // If viewing from WD Numbers modal with month/year context, filter comments
  if (currentCommentMonthYear) {
    comments = comments.filter(comment => {
      // Prefer explicit monthYear tagging; fallback to timestamp for older comments
      if (comment.monthYear && typeof comment.monthYear.year === 'number' && typeof comment.monthYear.month === 'number') {
        return comment.monthYear.year === currentCommentMonthYear.year && 
               comment.monthYear.month === currentCommentMonthYear.month;
      }
      if (comment.timestamp) {
        const d = new Date(comment.timestamp);
        return d.getFullYear() === currentCommentMonthYear.year && d.getMonth() === currentCommentMonthYear.month;
      }
      return false;
    });
  }
  
  if(comments.length === 0){
    const emptyMsg = document.createElement('div');
    emptyMsg.style.padding = '16px';
    emptyMsg.style.textAlign = 'center';
    emptyMsg.style.color = '#9ca3af';
    emptyMsg.style.fontSize = '13px';
    const contextText = currentCommentMonthYear ? 
      `No comments for ${new Date(currentCommentMonthYear.year, currentCommentMonthYear.month).toLocaleString('en-US', { month: 'long', year: 'numeric' })}` :
      'No comments yet';
    emptyMsg.textContent = contextText;
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
          // Remove from the correct array based on source
          if(currentCommentsSource === 'overview'){
            let originalIndex = (currentUnitForComments.overviewComments || []).indexOf(comment);
            if(originalIndex === -1){
              originalIndex = (currentUnitForComments.overviewComments || []).findIndex(c => c.timestamp === comment.timestamp && c.text === comment.text);
            }
            if(originalIndex !== -1){
              currentUnitForComments.overviewComments.splice(originalIndex, 1);
            }
          } else {
            let originalIndex = (currentUnitForComments.comments || []).indexOf(comment);
            if(originalIndex === -1){
              originalIndex = (currentUnitForComments.comments || []).findIndex(c => c.timestamp === comment.timestamp && c.text === comment.text);
            }
            if(originalIndex !== -1){
              currentUnitForComments.comments.splice(originalIndex, 1);
            }
          }
          // Update the unit in state (match by unitId or id)
          const unitIndex = (state.units || []).findIndex(u => {
            const uid = (u.unitId || '').toString().trim().toLowerCase();
            const alt = (u.id || '').toString().trim().toLowerCase();
            const curUid = (currentUnitForComments.unitId || '').toString().trim().toLowerCase();
            const curAlt = (currentUnitForComments.id || '').toString().trim().toLowerCase();
            return uid && uid === curUid || (alt && alt === curAlt);
          });
          if(unitIndex !== -1){
            state.units[unitIndex] = currentUnitForComments;
            DB.updateUnit(state.units[unitIndex]).catch(e => console.error('Unit comment delete error:', e));
          }
          saveState();
          renderUnitComments();
          renderUnits(); // Refresh units table (last comment column)
          renderUnitOverview(); // Refresh overview to update the red ! indicator
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
    
    const commentObj = {
      text: text,
      userName: userName,
      timestamp: new Date().toISOString()
    };
    
    // If comment was added from WD Numbers modal with month/year context, store it
    if(currentCommentMonthYear){
      commentObj.monthYear = currentCommentMonthYear;
    }
    
    if(currentCommentsSource === 'overview'){
      if(!currentUnitForComments.overviewComments) currentUnitForComments.overviewComments = [];
      // Ensure monthYear is present
      if(!commentObj.monthYear){
        const d = new Date(commentObj.timestamp);
        commentObj.monthYear = { year: d.getFullYear(), month: d.getMonth() };
      }
      currentUnitForComments.overviewComments.push(commentObj);
    } else {
      if(!currentUnitForComments.comments) currentUnitForComments.comments = [];
      currentUnitForComments.comments.push(commentObj);
    }
    
    // Update the unit in state
    const unitIndex = state.units.findIndex(u => u.id === currentUnitForComments.id);
    if(unitIndex !== -1){
      state.units[unitIndex] = currentUnitForComments;
      DB.updateUnit(state.units[unitIndex]).catch(e => console.error('Unit comment save error:', e));
    }

    saveState();
    textarea.value = '';
    renderUnitComments();
    renderUnits(); // Refresh the units table to show the new comment
    renderUnitOverview(); // Refresh overview to update indicator
    try{ if(typeof renderReport === 'function') renderReport(); }catch(e){}
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

// ==================== UNIT STATUS CHANGE MODAL (REBUILT) ====================

function handleUnitStatusChange(unitId){
  console.log('\n=== handleUnitStatusChange called for unitId:', unitId);
  
  // Find unit by unitId
  const unitIndex = state.units.findIndex(u => u.unitId === unitId || u.id === unitId);
  if(unitIndex === -1){
    console.error('Unit not found:', unitId);
    alert('Error: Unit not found');
    return;
  }
  
  const unit = state.units[unitIndex];
  console.log('Found unit at index', unitIndex, ':', unit);
  
  // Get the modal elements
  const modal = qs('#unitStatusChangeModal');
  const title = qs('#statusChangeTitle');
  const dateInput = qs('#statusChangeDate');
  const okBtn = qs('#statusChangeOkBtn');
  const cancelBtn = qs('#statusChangeCancelBtn');
  const closeBtn = qs('#closeStatusChangeBtn');
  
  if(!modal || !title || !dateInput || !okBtn){
    console.error('Modal elements not found');
    return;
  }
  
  // Set modal title based on current status
  const newStatus = unit.status === 'Disabled' ? 'Operational' : 'Disabled';
  title.textContent = `${newStatus === 'Disabled' ? 'Disable' : 'Enable'} Unit - ${unit.unitId || 'Unit'}`;
  
  // Set today's date
  dateInput.value = new Date().toISOString().slice(0,10);
  
  // Show modal
  modal.style.display = 'flex';
  
  // Remove any existing listeners
  const newOkBtn = okBtn.cloneNode(true);
  okBtn.parentNode.replaceChild(newOkBtn, okBtn);
  
  // Add new click handler
  newOkBtn.addEventListener('click', () => {
    console.log('=== OK button clicked ===');
    const selectedDate = dateInput.value;
    
    if(!selectedDate){
      alert('Please select a date');
      return;
    }
    
    console.log('Processing status change...');
    console.log('Before:', {unitId: unit.unitId, status: unit.status});
    
    // Get current user
    const session = currentSession();
    const currentUser = session ? session.user : 'Unknown';
    
    // Initialize status history
    if(!unit.statusHistory) unit.statusHistory = [];
    
    // Toggle status
    if(unit.status === 'Disabled'){
      unit.status = 'Operational';
      unit.enabledDate = selectedDate;
      delete unit.disabledDate;
    } else {
      unit.status = 'Disabled';
      unit.disabledDate = selectedDate;
      delete unit.enabledDate;
    }
    
    // Add history entry
    unit.statusHistory.push({
      status: unit.status,
      date: selectedDate,
      changedBy: currentUser,
      timestamp: new Date().toISOString()
    });
    
    console.log('After:', {unitId: unit.unitId, status: unit.status, historyLength: unit.statusHistory.length});
    
    // Update the unit in the state array
    state.units[unitIndex] = unit;
    DB.updateUnit(unit).catch(e => console.error('Unit status change error:', e));

    // Save and refresh
    saveState();
    console.log('State saved');
    
    // Close modal first
    modal.style.display = 'none';
    
    // Force complete re-render
    renderUnits();
    renderOverview();
    if(typeof renderUnitOverview === 'function') renderUnitOverview();
    
    console.log('Renders complete');
    
    alert(`Unit ${unit.unitId} status changed to: ${unit.status}`);
    
    console.log('=== Status change complete ===\n');
  });
  
  // Cancel and close handlers
  const closeModal = () => { modal.style.display = 'none'; };
  if(cancelBtn) cancelBtn.onclick = closeModal;
  if(closeBtn) closeBtn.onclick = closeModal;
}

// ==================== UNIT STATUS HISTORY MODAL ====================
// Clear legacy disabled/enabled date fields
function clearLegacyData(unitId) {
  if (!confirm('Clear legacy disabled/enabled dates from this unit? This will remove the red background highlighting.')) return;
  
  const unitIndex = state.units.findIndex(u => u.id === unitId);
  if (unitIndex !== -1) {
    delete state.units[unitIndex].disabledDate;
    delete state.units[unitIndex].enabledDate;
    DB.updateUnit(state.units[unitIndex]).catch(e => console.error('Clear legacy data error:', e));
    saveState();
    renderUnits();
    if (typeof renderUnitOverview === 'function') renderUnitOverview();
    openUnitStatusHistoryModal(state.units[unitIndex]);
  }
}

function openUnitStatusHistoryModal(unit) {
  const modal = qs('#unitStatusHistoryModal');
  const title = qs('#statusHistoryTitle');
  const listDiv = qs('#statusHistoryList');
  
  if (!modal || !title || !listDiv) return;
  
  title.textContent = `Status Change History - ${unit.unitId || 'Unknown'}`;
  listDiv.innerHTML = '';
  
  const statusHistory = unit.statusHistory || [];
  
  // Show warning for legacy data
  if (statusHistory.length === 0 && (unit.disabledDate || unit.enabledDate)) {
    const legacyInfo = document.createElement('div');
    legacyInfo.style.cssText = 'background:#fef3c7;border:1px solid #f59e0b;border-radius:8px;padding:16px;margin-bottom:12px;';
    
    legacyInfo.innerHTML = `
      <div style="font-weight:600;color:#92400e;margin-bottom:8px;">⚠️ Legacy Data Detected</div>
      <div style="color:#78350f;font-size:13px;margin-bottom:12px;">
        This unit has disabled/enabled dates in an old format:<br>
        ${unit.disabledDate ? `<strong>Disabled Date:</strong> ${formatDateToUS(unit.disabledDate)}<br>` : ''}
        ${unit.enabledDate ? `<strong>Enabled Date:</strong> ${formatDateToUS(unit.enabledDate)}<br>` : ''}
        <strong>Current Status:</strong> ${unit.status || 'Operational'}<br><br>
        <button onclick="clearLegacyData('${unit.id}')" style="background:#dc2626;color:#fff;border:none;padding:8px 16px;border-radius:6px;cursor:pointer;font-size:13px;">
          Clear Legacy Data
        </button>
      </div>
    `;
    
    listDiv.appendChild(legacyInfo);
  }
  
  if (statusHistory.length === 0) {
    const emptyDiv = document.createElement('div');
    emptyDiv.style.cssText = 'color:#6b7280;text-align:center;padding:20px;';
    emptyDiv.textContent = 'No status change history available.';
    listDiv.appendChild(emptyDiv);
  } else {
    // Sort history by timestamp (newest first)
    const sortedHistory = [...statusHistory].sort((a, b) => {
      return new Date(b.timestamp || b.date) - new Date(a.timestamp || a.date);
    });
    
    console.log('>>> Sorted history for display (newest first):', sortedHistory.map(h => `${h.date} - ${h.status}`));
    
    sortedHistory.forEach((entry, index) => {
      console.log(`>>> Rendering entry ${index}:`, {date: entry.date, status: entry.status, changedBy: entry.changedBy});
      
      const entryDiv = document.createElement('div');
      entryDiv.style.cssText = 'background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin-bottom:12px;';
      
      // Top row container
      const topRow = document.createElement('div');
      topRow.style.cssText = 'display:flex;align-items:center;gap:12px;margin-bottom:8px;flex-wrap:wrap;';
      
      // Status badge
      const statusBadge = document.createElement('span');
      statusBadge.textContent = entry.status || 'Unknown';
      statusBadge.style.cssText = `display:inline-block;padding:6px 12px;border-radius:12px;font-size:13px;font-weight:600;
        ${entry.status === 'Disabled' ? 'background:#fee2e2;color:#dc2626;' : 'background:#dcfce7;color:#16a34a;'}`;
      
      // Date display (clickable to edit)
      const dateDisplay = document.createElement('span');
      dateDisplay.textContent = entry.date ? formatDateToUS(entry.date) : 'No date';
      dateDisplay.style.cssText = 'padding:6px 10px;border:1px solid #e5e7eb;border-radius:6px;font-size:13px;background:#fff;cursor:pointer;';
      dateDisplay.title = 'Click to edit date';
      
      // Date input (hidden by default)
      const dateInput = document.createElement('input');
      dateInput.type = 'date';
      dateInput.value = entry.date || '';
      dateInput.style.cssText = 'display:none;padding:6px 10px;border:2px solid #0b74de;border-radius:6px;font-size:13px;';
      
      // Save button
      const saveBtn = document.createElement('button');
      saveBtn.textContent = 'Save';
      saveBtn.style.cssText = 'display:none;padding:6px 12px;border-radius:6px;font-size:12px;background:#0b74de;color:#fff;border:none;cursor:pointer;';
      
      // Cancel button
      const cancelBtn = document.createElement('button');
      cancelBtn.textContent = 'Cancel';
      cancelBtn.style.cssText = 'display:none;padding:6px 12px;border-radius:6px;font-size:12px;background:#6b7280;color:#fff;border:none;cursor:pointer;';
      
      // Delete button
      const deleteBtn = document.createElement('button');
      deleteBtn.textContent = 'Delete';
      deleteBtn.style.cssText = 'padding:6px 12px;border-radius:6px;font-size:12px;background:#dc2626;color:#fff;border:none;cursor:pointer;margin-left:auto;';
      
      // Click handler to edit date
      dateDisplay.addEventListener('click', () => {
        dateDisplay.style.display = 'none';
        dateInput.style.display = 'inline-block';
        saveBtn.style.display = 'inline-block';
        cancelBtn.style.display = 'inline-block';
        deleteBtn.style.display = 'none';
        dateInput.focus();
      });
      
      // Cancel button handler
      cancelBtn.addEventListener('click', () => {
        dateInput.value = entry.date || '';
        dateInput.style.display = 'none';
        saveBtn.style.display = 'none';
        cancelBtn.style.display = 'none';
        dateDisplay.style.display = 'inline-block';
        deleteBtn.style.display = 'inline-block';
      });
      
      // Save button handler
      saveBtn.addEventListener('click', () => {
        const newDate = dateInput.value;
        if (!newDate) {
          alert('Please enter a valid date');
          return;
        }
        
        // Find the unit in state and update the history entry
        const unitIndex = state.units.findIndex(u => u.id === unit.id);
        if (unitIndex !== -1 && state.units[unitIndex].statusHistory) {
          const historyIndex = state.units[unitIndex].statusHistory.findIndex(h => 
            h.status === entry.status && h.timestamp === entry.timestamp
          );
          
          if (historyIndex !== -1) {
            state.units[unitIndex].statusHistory[historyIndex].date = newDate;

            // Recompute current status/dates from the (re-sorted) history —
            // the edited entry may no longer be chronologically last.
            syncUnitStatusFromHistory(state.units[unitIndex]);

            DB.updateUnit(state.units[unitIndex]).catch(e => console.error('Unit status history edit error:', e));
            saveState();
            renderUnits();
            if(typeof renderUnitOverview === 'function') renderUnitOverview();
            if(typeof renderReport === 'function') renderReport();
            openUnitStatusHistoryModal(state.units[unitIndex]); // Refresh modal
          }
        }
      });

      // Delete button handler
      deleteBtn.addEventListener('click', () => {
        if (!confirm('Are you sure you want to delete this status change record?')) return;

        const unitIndex = state.units.findIndex(u => u.id === unit.id);
        if (unitIndex !== -1 && state.units[unitIndex].statusHistory) {
          state.units[unitIndex].statusHistory = state.units[unitIndex].statusHistory.filter(h =>
            !(h.status === entry.status && h.timestamp === entry.timestamp)
          );

          // Recompute current status/dates now that a history entry is gone —
          // otherwise the unit keeps showing its old status/coverage.
          syncUnitStatusFromHistory(state.units[unitIndex]);

          DB.updateUnit(state.units[unitIndex]).catch(e => console.error('Unit status history delete error:', e));
          saveState();
          renderUnits();
          if(typeof renderUnitOverview === 'function') renderUnitOverview();
          if(typeof renderReport === 'function') renderReport();
          openUnitStatusHistoryModal(state.units[unitIndex]); // Refresh modal
        }
      });
      
      // User information
      const userInfo = document.createElement('div');
      userInfo.style.cssText = 'font-size:13px;color:#6b7280;';
      
      // Get full name of user who made the change
      let userName = entry.changedBy || 'Unknown';
      if (entry.changedBy && entry.changedBy !== 'System' && entry.changedBy !== 'Unknown') {
        const user = (state.users || []).find(u => u.username === entry.changedBy);
        if (user) {
          const fullName = (user.firstName || '') + (user.lastName ? ' ' + user.lastName : '');
          userName = fullName.trim() || entry.changedBy;
        }
      }
      
      const timestamp = entry.timestamp ? new Date(entry.timestamp).toLocaleString() : '';
      userInfo.innerHTML = `<strong>Changed by:</strong> ${escapeHtml(userName)}<br><strong>Timestamp:</strong> ${escapeHtml(timestamp)}`;
      
      // Build the top row
      topRow.appendChild(statusBadge);
      topRow.appendChild(dateDisplay);
      topRow.appendChild(dateInput);
      topRow.appendChild(saveBtn);
      topRow.appendChild(cancelBtn);
      topRow.appendChild(deleteBtn);
      
      entryDiv.appendChild(topRow);
      entryDiv.appendChild(userInfo);
      
      listDiv.appendChild(entryDiv);
    });
  }
  
  modal.style.display = 'flex';
}

function closeUnitStatusHistoryModal() {
  const modal = qs('#unitStatusHistoryModal');
  if (modal) {
    modal.style.display = 'none';
  }
}

// Status History Close button
const closeStatusHistoryBtn = qs('#closeStatusHistoryBtn');
if (closeStatusHistoryBtn) {
  closeStatusHistoryBtn.addEventListener('click', closeUnitStatusHistoryModal);
}

// Close modal when clicking backdrop
const statusHistoryModal = qs('#unitStatusHistoryModal');
if (statusHistoryModal) {
  statusHistoryModal.addEventListener('click', (e) => {
    if (e.target === statusHistoryModal) {
      closeUnitStatusHistoryModal();
    }
  });
}

// ==================== WD NUMBERS MODAL ====================
// ==================== UNIT DETAIL MODAL ====================
// Tracks the filtered unit list for navigation
let _unitDetailList = [];
let _unitDetailIndex = 0;

function openUnitWdNumbersModal(unitId, year, month, unitIdList) {
  window.currentWdNumbersYear = year;
  window.currentWdNumbersMonth = month;

  if(Array.isArray(unitIdList) && unitIdList.length > 0){
    // Use the exact list (and order) of units currently shown in whichever view this
    // was opened from — a Report block, Unit Control, a search result set, etc. — so
    // Prev/Next navigate within that list instead of always the full Unit Overview table.
    _unitDetailList = unitIdList.slice();
  } else {
    // Fallback for any caller that doesn't pass an explicit list: try the currently
    // rendered Unit Overview table, else fall back to all units.
    try {
      const tbody = qs('#unitOverview table tbody');
      if(tbody){
        _unitDetailList = Array.from(tbody.querySelectorAll('tr')).map(tr => {
          const firstCell = tr.querySelector('td');
          return firstCell ? (firstCell.textContent || '').trim().replace(/\s*!\s*$/, '').trim() : '';
        }).filter(Boolean);
      } else {
        _unitDetailList = (state.units || []).map(u => u.unitId || '');
      }
    } catch(e) {
      _unitDetailList = (state.units || []).map(u => u.unitId || '');
    }
  }

  _unitDetailIndex = _unitDetailList.findIndex(id =>
    String(id).trim().toLowerCase() === String(unitId).trim().toLowerCase()
  );
  if(_unitDetailIndex === -1) _unitDetailIndex = 0;

  renderUnitDetailModal(unitId);

  const modal = qs('#unitWdNumbersModal');
  if(modal) modal.style.display = 'flex';
}

function renderUnitDetailModal(unitId) {
  const unit = (state.units || []).find(u =>
    String(u.unitId || '').trim().toLowerCase() === String(unitId || '').trim().toLowerCase()
  );
  if(!unit) return;

  window.currentWdNumbersYear = window.currentWdNumbersYear || new Date().getFullYear();
  window.currentWdNumbersMonth = window.currentWdNumbersMonth || new Date().getMonth();

  // --- Header ---
  const titleEl = qs('#unitDetailTitle');
  if(titleEl) titleEl.textContent = unit.unitId || unitId;

  const statusEl = qs('#unitDetailStatus');
  if(statusEl){
    const isDisabled = (unit.status || '').toLowerCase() === 'disabled';
    const fmtStatusDate = (raw) => {
      if(!raw) return '';
      const s = String(raw);
      const d = new Date(s.includes('T') ? s : s + 'T00:00:00');
      return isNaN(d) ? '' : d.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
    };
    if(isDisabled){
      const dd = fmtStatusDate(unit.disabledDate);
      statusEl.textContent = 'Disabled' + (dd ? ' · Disabled Date ' + dd : '');
      statusEl.style.background = 'rgba(220,38,38,0.2)';
      statusEl.style.color = '#f87171';
    } else {
      const ed = fmtStatusDate(unit.enabledDate);
      statusEl.textContent = 'Operational' + (ed ? ' · Since ' + ed : '');
      statusEl.style.background = 'rgba(34,197,94,0.2)';
      statusEl.style.color = '#4ade80';
    }
  }

  // Navigation
  const navEl = qs('#unitDetailNav');
  if(navEl) navEl.textContent = `${_unitDetailIndex + 1} / ${_unitDetailList.length}`;

  // Info grid
  const infoEl = qs('#unitDetailInfo');
  if(infoEl){
    const fields = [
      { label: 'SUPPLIER', value: unit.supplier || '—' },
      { label: 'LEASE', value: unit.lease || '—' },
      { label: 'ARRANGEMENT', value: unit.arrangement || '—' },
      { label: 'INVOICING', value: unit.invoicing || '—' },
      { label: 'COST CENTER', value: unit.costCenter || '—' },
      { label: 'COMPANY', value: unit.company || '—' }
    ];

    infoEl.innerHTML = fields.map(f => `
      <div>
        <div style="font-size:10px;font-weight:700;color:#4b5563;letter-spacing:0.8px;text-transform:uppercase;margin-bottom:3px;">${f.label}</div>
        <div style="font-size:13px;font-weight:600;color:#e2e8f0;">${escapeHtml(f.value)}</div>
      </div>
    `).join('');
  }

  // --- Build coverage history grid ---
  buildUnitCoverageGrid(unit);

  // --- Stats footer ---
  buildUnitStats(unit);

  // --- Navigation buttons ---
  const prevBtn = qs('#unitDetailPrev');
  const nextBtn = qs('#unitDetailNext');
  if(prevBtn){
    prevBtn.onclick = () => {
      if(_unitDetailIndex > 0){
        _unitDetailIndex--;
        renderUnitDetailModal(_unitDetailList[_unitDetailIndex]);
      }
    };
    prevBtn.style.opacity = _unitDetailIndex === 0 ? '0.3' : '1';
  }
  if(nextBtn){
    nextBtn.onclick = () => {
      if(_unitDetailIndex < _unitDetailList.length - 1){
        _unitDetailIndex++;
        renderUnitDetailModal(_unitDetailList[_unitDetailIndex]);
      }
    };
    nextBtn.style.opacity = _unitDetailIndex === _unitDetailList.length - 1 ? '0.3' : '1';
  }
}

function buildUnitCoverageGrid(unit) {
  const gridEl = qs('#unitDetailGrid');
  const popupEl = qs('#unitDetailPopup');
  if(!gridEl) return;
  gridEl.innerHTML = '';
  if(popupEl) popupEl.style.display = 'none';

  const unitIdNorm = String(unit.unitId || unit.id || '').trim().toLowerCase();
  const invoices = state.invoices || [];
  const registries = state.registries || [];

  // Determine date range: from first operational date to latest invoice month
  let startDate = new Date(2025, 0, 1); // fallback Jan 2025
  try{
    const hist = (unit.statusHistory || []).filter(h => h.status === 'Operational');
    if(hist.length > 0){
      const firstOp = hist.sort((a,b) => new Date(a.date) - new Date(b.date))[0];
      const d = new Date(firstOp.date);
      startDate = new Date(d.getFullYear(), d.getMonth(), 1);
    }
  }catch(e){}

  // End at current month by default; extend only if there is a future invoice
  const _today = new Date();
  const _currentMonthDate = new Date(_today.getFullYear(), _today.getMonth(), 1);
  let endDate = new Date(_currentMonthDate);
  try{
    let latestInvoiceDate = null;
    registries.forEach(reg => {
      const units = Array.isArray(reg.units) ? reg.units : [];
      const inReg = units.some(u => String(u).trim().toLowerCase() === unitIdNorm);
      if(!inReg) return;
      if(reg.periodEnd){
        const parts = String(reg.periodEnd).split('-');
        if(parts.length >= 2){
          const d = new Date(parseInt(parts[0]), parseInt(parts[1])-1, 1);
          if(!latestInvoiceDate || d.getTime() > latestInvoiceDate.getTime()) latestInvoiceDate = d;
        }
      }
    });
    if(latestInvoiceDate && latestInvoiceDate.getTime() > _currentMonthDate.getTime()) endDate = latestInvoiceDate;
  }catch(e){}

  // Build month list
  const months = [];
  let cur = new Date(startDate);
  while(cur <= endDate){
    months.push(new Date(cur));
    cur.setMonth(cur.getMonth() + 1);
  }

  // Build table
  const table = document.createElement('table');
  table.style.cssText = 'border-collapse:collapse;font-size:11px;min-width:100%;';

  months.forEach(monthDate => {
    const y = monthDate.getFullYear();
    const m = monthDate.getMonth();
    const daysInMonth = new Date(y, m+1, 0).getDate();
    const monthLabel = monthDate.toLocaleString('en-US', { month: 'short', year: '2-digit' });

    const tr = document.createElement('tr');

    // Month label cell
    const tdMonth = document.createElement('td');
    tdMonth.style.cssText = 'padding:2px 8px 2px 0;color:#6b7280;font-size:11px;font-weight:600;white-space:nowrap;cursor:pointer;min-width:48px;';
    tdMonth.textContent = monthLabel;
    tdMonth.title = 'Click to see all invoices this month';
    tdMonth.addEventListener('mouseenter', () => tdMonth.style.color = '#60a5fa');
    tdMonth.addEventListener('mouseleave', () => tdMonth.style.color = '#6b7280');
    tdMonth.addEventListener('click', () => showMonthDetail(unit, y, m, popupEl));
    tr.appendChild(tdMonth);

    // Day cells
    for(let d = 1; d <= daysInMonth; d++){
      const tdDay = document.createElement('td');
      tdDay.style.cssText = 'padding:1px;';

      const sq = document.createElement('div');
      const dayState = getDayState(unitIdNorm, y, m, d, registries, invoices, unit);

      sq.style.cssText = `
        width:16px;height:16px;border-radius:2px;
        display:flex;align-items:center;justify-content:center;
        font-size:8px;cursor:pointer;transition:transform 0.1s;
        font-weight:600;
      `;
      sq.textContent = d;

      // Apply colors matching existing system
      if(dayState.disabled){
        tdDay.style.background = '#7f1d1d';
        if(dayState.covered){
          sq.style.background = '#166534';
          sq.style.color = '#4ade80';
          sq.style.border = '1px solid #22c55e';
        } else {
          sq.style.background = '#1c0a0a';
          sq.style.color = '#f87171';
          sq.style.border = '1px solid #7f1d1d';
        }
      } else if(dayState.credit){
        sq.style.background = dayState.overlap ? '#fee2e2' : (dayState.covered ? '#dcfce7' : '#fff');
        sq.style.border = '2px solid #eab308';
        sq.style.color = '#eab308';
      } else if(dayState.overlap){
        sq.style.background = '#7f1d1d';
        sq.style.color = '#fca5a5';
        sq.style.border = '1px solid #ef4444';
      } else if(dayState.covered){
        sq.style.background = '#14532d';
        sq.style.color = '#4ade80';
        sq.style.border = '1px solid #166534';
      } else {
        sq.style.background = '#111827';
        sq.style.color = '#374151';
        sq.style.border = '1px solid #1f2937';
      }

      sq.addEventListener('mouseenter', () => { sq.style.transform = 'scale(1.3)'; sq.style.zIndex = '10'; sq.style.position = 'relative'; });
      sq.addEventListener('mouseleave', () => { sq.style.transform = ''; sq.style.zIndex = ''; sq.style.position = ''; });
      sq.addEventListener('click', () => showDayDetail(unit, y, m, d, registries, invoices, popupEl));

      tdDay.appendChild(sq);
      tr.appendChild(tdDay);
    }

    table.appendChild(tr);
  });

  gridEl.appendChild(table);
}

function getDayState(unitIdNorm, y, m, d, registries, invoices, unit){
  const dateStr = `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  const result = { covered: false, overlap: false, credit: false, disabled: false, rentalCount: 0 };

  // Check disabled
  try{
    const periods = getDisabledPeriods(unit);
    result.disabled = isDateInDisabledPeriod(y, m, d, periods);
  }catch(e){}

  // Check registry coverage
  registries.forEach(reg => {
    const units = Array.isArray(reg.units) ? reg.units : [];
    const inReg = units.some(u => String(u).trim().toLowerCase() === unitIdNorm);
    if(!inReg) return;
    if(!reg.periodStart || !reg.periodEnd) return;

    const sp = String(reg.periodStart).split('-');
    const ep = String(reg.periodEnd).split('-');
    if(sp.length < 3 || ep.length < 3) return;

    const start = `${sp[0]}-${sp[1].padStart(2,'0')}-${sp[2].padStart(2,'0')}`;
    const end = `${ep[0]}-${ep[1].padStart(2,'0')}-${ep[2].padStart(2,'0')}`;
    if(dateStr < start || dateStr > end) return;

    let cat = String(reg.category || '').toLowerCase();
    if(!cat){
      const inv = invoices.find(i => String(i.wdNumber||'').trim().toLowerCase() === String(reg.wdNumber||'').trim().toLowerCase());
      cat = inv ? String(inv.category||'').toLowerCase() : '';
    }

    if(cat === 'rental'){ result.rentalCount++; result.covered = true; }
    if(cat === 'credit'){ result.credit = true; }
  });

  if(result.rentalCount > 1) result.overlap = true;
  return result;
}

function showDayDetail(unit, y, m, d, registries, invoices, popupEl){
  if(!popupEl) return;
  const unitIdNorm = String(unit.unitId || unit.id || '').trim().toLowerCase();
  const dateStr = `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  const monthName = new Date(y,m,d).toLocaleString('en-US', { month:'long', day:'numeric', year:'numeric' });

  const matchingRegs = registries.filter(reg => {
    const units = Array.isArray(reg.units) ? reg.units : [];
    if(!units.some(u => String(u).trim().toLowerCase() === unitIdNorm)) return false;
    if(!reg.periodStart || !reg.periodEnd) return false;
    const sp = String(reg.periodStart).split('-');
    const ep = String(reg.periodEnd).split('-');
    if(sp.length < 3 || ep.length < 3) return false;
    const start = `${sp[0]}-${sp[1].padStart(2,'0')}-${sp[2].padStart(2,'0')}`;
    const end = `${ep[0]}-${ep[1].padStart(2,'0')}-${ep[2].padStart(2,'0')}`;
    return dateStr >= start && dateStr <= end;
  });

  popupEl.style.display = 'block';
  if(matchingRegs.length === 0){
    popupEl.innerHTML = `<div style="color:#6b7280;font-size:13px;">No invoice covering <strong style="color:#e2e8f0;">${monthName}</strong></div>`;
    return;
  }

  const fmtDate = (s) => {
    if(!s) return '';
    const p = String(s).split('-');
    if(p.length < 3) return s;
    return new Date(parseInt(p[0]), parseInt(p[1])-1, parseInt(p[2])).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
  };

  popupEl.innerHTML = `
    <div style="font-size:12px;color:#6b7280;margin-bottom:10px;font-weight:600;">${monthName} — Invoice covering this day</div>
    ${matchingRegs.map(reg => {
      const matchInv = invoices.find(i =>
        String(i.wdNumber||'').trim().toLowerCase() === String(reg.wdNumber||'').trim().toLowerCase() &&
        String(i.unit||'').trim().toLowerCase() === unitIdNorm
      );
      const amount = matchInv ? matchInv.amount : reg.totalAmount;
      return `
        <div style="background:#0f1117;border:1px solid #1e2535;border-radius:8px;padding:12px;margin-bottom:8px;">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
            <span style="font-size:13px;font-weight:700;color:#60a5fa;">📄 ${escapeHtml(reg.wdNumber||'')}</span>
            <span style="font-size:11px;color:#4b5563;">${escapeHtml(reg.docNumber||'')}</span>
          </div>
          <div style="font-size:11px;color:#6b7280;">📅 ${fmtDate(reg.periodStart)} — ${fmtDate(reg.periodEnd)}</div>
          <div style="font-size:15px;font-weight:700;color:#4ade80;margin-top:6px;">${formatCurrency(amount||'0')}</div>
          ${reg.category ? `<div style="margin-top:4px;"><span style="font-size:10px;background:#1e2535;color:#9ca3af;padding:2px 8px;border-radius:10px;">${escapeHtml(reg.category)}</span></div>` : ''}
        </div>
      `;
    }).join('')}
  `;
}

function showMonthDetail(unit, y, m, popupEl){
  if(!popupEl) return;
  const unitIdNorm = String(unit.unitId || unit.id || '').trim().toLowerCase();
  const monthName = new Date(y,m,1).toLocaleString('en-US', { month:'long', year:'numeric' });
  const registries = state.registries || [];
  const invoices = state.invoices || [];
  const daysInMonth = new Date(y, m+1, 0).getDate();

  const matchingRegs = registries.filter(reg => {
    const units = Array.isArray(reg.units) ? reg.units : [];
    if(!units.some(u => String(u).trim().toLowerCase() === unitIdNorm)) return false;
    if(!reg.periodStart || !reg.periodEnd) return false;
    const sp = String(reg.periodStart).split('-');
    const ep = String(reg.periodEnd).split('-');
    if(sp.length < 3 || ep.length < 3) return false;
    const start = new Date(parseInt(sp[0]), parseInt(sp[1])-1, parseInt(sp[2]));
    const end = new Date(parseInt(ep[0]), parseInt(ep[1])-1, parseInt(ep[2]));
    const mStart = new Date(y, m, 1);
    const mEnd = new Date(y, m, daysInMonth);
    return start <= mEnd && end >= mStart;
  });

  popupEl.style.display = 'block';

  if(matchingRegs.length === 0){
    popupEl.innerHTML = `<div style="color:#6b7280;font-size:13px;">No invoices found for <strong style="color:#e2e8f0;">${monthName}</strong></div>`;
    return;
  }

  const fmtDate = (s) => {
    if(!s) return '';
    const p = String(s).split('-');
    if(p.length < 3) return s;
    return new Date(parseInt(p[0]), parseInt(p[1])-1, parseInt(p[2])).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
  };

  popupEl.innerHTML = `
    <div style="font-size:12px;color:#6b7280;margin-bottom:10px;font-weight:600;">${monthName} — All invoices (${matchingRegs.length})</div>
    ${matchingRegs.map(reg => {
      const matchInv = invoices.find(i =>
        String(i.wdNumber||'').trim().toLowerCase() === String(reg.wdNumber||'').trim().toLowerCase() &&
        String(i.unit||'').trim().toLowerCase() === unitIdNorm
      );
      const amount = matchInv ? matchInv.amount : reg.totalAmount;
      return `
        <div style="background:#0f1117;border:1px solid #1e2535;border-radius:8px;padding:12px;margin-bottom:8px;">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;">
            <div style="display:flex;align-items:center;gap:8px;">
              <span style="font-size:13px;font-weight:700;color:#60a5fa;">📄 ${escapeHtml(reg.wdNumber||'')}</span>
              <span style="font-size:11px;color:#4b5563;">${escapeHtml(reg.docNumber||'')}</span>
            </div>
            <span style="font-size:11px;background:#1e2535;color:#9ca3af;padding:2px 8px;border-radius:10px;">${escapeHtml(reg.category||'')}</span>
          </div>
          <div style="font-size:11px;color:#6b7280;">📅 ${fmtDate(reg.periodStart)} — ${fmtDate(reg.periodEnd)}</div>
          <div style="font-size:15px;font-weight:700;color:#4ade80;margin-top:6px;">${formatCurrency(amount||'0')}</div>
        </div>
      `;
    }).join('')}
  `;
}

function buildUnitStats(unit){
  const statsEl = qs('#unitDetailStats');
  if(!statsEl) return;

  const unitIdNorm = String(unit.unitId || unit.id || '').trim().toLowerCase();
  const registries = state.registries || [];
  const invoices = state.invoices || [];

  // Build month range same as grid
  let startDate = new Date(2025, 0, 1);
  try{
    const hist = (unit.statusHistory || []).filter(h => h.status === 'Operational');
    if(hist.length > 0){
      const firstOp = hist.sort((a,b) => new Date(a.date) - new Date(b.date))[0];
      const d = new Date(firstOp.date);
      startDate = new Date(d.getFullYear(), d.getMonth(), 1);
    }
  }catch(e){}

  let endDate = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  try{
    let latestMs = 0;
    registries.forEach(reg => {
      const units = Array.isArray(reg.units) ? reg.units : [];
      if(!units.some(u => String(u).trim().toLowerCase() === unitIdNorm)) return;
      if(reg.periodEnd){
        const parts = String(reg.periodEnd).split('-');
        if(parts.length >= 2){
          const d = new Date(parseInt(parts[0]), parseInt(parts[1])-1, 1);
          if(d.getTime() > latestMs){ latestMs = d.getTime(); endDate = d; }
        }
      }
    });
  }catch(e){}

  const months = [];
  let cur = new Date(startDate);
  while(cur <= endDate){ months.push(new Date(cur)); cur.setMonth(cur.getMonth()+1); }

  let monthsCovered = 0, monthsMissing = 0, creditMonths = 0, totalDaysBilled = 0;

  months.forEach(monthDate => {
    const y = monthDate.getFullYear();
    const m = monthDate.getMonth();
    const daysInMonth = new Date(y, m+1, 0).getDate();
    let hasCoverage = false;
    let hasCredit = false;

    registries.forEach(reg => {
      const units = Array.isArray(reg.units) ? reg.units : [];
      if(!units.some(u => String(u).trim().toLowerCase() === unitIdNorm)) return;
      if(!reg.periodStart || !reg.periodEnd) return;
      const sp = String(reg.periodStart).split('-');
      const ep = String(reg.periodEnd).split('-');
      if(sp.length < 3 || ep.length < 3) return;
      const start = new Date(parseInt(sp[0]), parseInt(sp[1])-1, parseInt(sp[2]));
      const end = new Date(parseInt(ep[0]), parseInt(ep[1])-1, parseInt(ep[2]));
      const mStart = new Date(y, m, 1);
      const mEnd = new Date(y, m, daysInMonth);
      if(start > mEnd || end < mStart) return;

      let cat = String(reg.category||'').toLowerCase();
      if(!cat){
        const inv = invoices.find(i => String(i.wdNumber||'').trim().toLowerCase() === String(reg.wdNumber||'').trim().toLowerCase());
        cat = inv ? String(inv.category||'').toLowerCase() : '';
      }
      if(cat === 'rental'){
        hasCoverage = true;
        // Count days overlap with month
        const effectiveStart = start < mStart ? mStart : start;
        const effectiveEnd = end > mEnd ? mEnd : end;
        const days = Math.floor((effectiveEnd - effectiveStart) / 86400000) + 1;
        totalDaysBilled += Math.max(0, days);
      }
      if(cat === 'credit') hasCredit = true;
    });

    if(hasCoverage) monthsCovered++;
    else monthsMissing++;
    if(hasCredit) creditMonths++;
  });

  const stats = [
    { value: monthsCovered, label: 'Months covered', color: '#4ade80' },
    { value: monthsMissing, label: 'Months missing', color: '#f87171' },
    { value: creditMonths, label: 'Credits', color: '#fbbf24' },
    { value: totalDaysBilled, label: 'Days billed', color: '#60a5fa' }
  ];

  statsEl.innerHTML = stats.map((s, i) => `
    <div style="padding:14px 16px;text-align:center;${i < 3 ? 'border-right:1px solid #1e2535;' : ''}">
      <div style="font-size:22px;font-weight:800;color:${s.color};letter-spacing:-0.5px;">${s.value}</div>
      <div style="font-size:11px;color:#4b5563;margin-top:3px;font-weight:500;">${s.label}</div>
    </div>
  `).join('');
}

function closeUnitWdNumbersModal() {
  const modal = qs('#unitWdNumbersModal');
  if(modal) modal.style.display = 'none';
  const popupEl = qs('#unitDetailPopup');
  if(popupEl) popupEl.style.display = 'none';
}

const closeUnitWdNumbersBtn = qs('#closeUnitWdNumbersBtn');
if(closeUnitWdNumbersBtn){
  closeUnitWdNumbersBtn.addEventListener('click', closeUnitWdNumbersModal);
}

// ==================== VISUAL LABELS MODAL ====================
function openVisualLabelsModal(){
  const modal = qs('#visualLabelsModal');
  if(modal){ modal.style.display = 'flex'; }
}

function closeVisualLabelsModal(){
  const modal = qs('#visualLabelsModal');
  if(modal){ modal.style.display = 'none'; }
}

const closeVisualLabelsBtn = qs('#closeVisualLabelsBtn');
if(closeVisualLabelsBtn){
  closeVisualLabelsBtn.addEventListener('click', closeVisualLabelsModal);
}

// ==================== UNIT COMMENTS ====================
let currentCommentUnitId = null;
let currentCommentUnit = null;
let currentCommentMonthYear = null;
// Track comments source context: 'overview' for Unit Overview tab, 'unit' for Unit Control
let currentCommentsSource = null;

function openCommentsModalFromWdNumbers(unitId, year, month) {
  // Find the unit object
  const unit = (state.units || []).find(u => 
    (u.unitId || '').toString().trim().toLowerCase() === (unitId || '').toString().trim().toLowerCase()
  );
  
  if (!unit) return;
  
  // Store the month/year context
  currentCommentMonthYear = { year, month };
  // Mark source as Unit Overview
  currentCommentsSource = 'overview';
  
  // Use the existing openUnitCommentsModal function with the unit
  openUnitCommentsModal(unit);
  
  // Update the title to show the month/year context
  const title = qs('#unitCommentsTitle');
  if (title) {
    const monthName = new Date(year, month).toLocaleString('en-US', { month: 'long', year: 'numeric' });
    title.textContent = `Comments - ${unit.unitId || 'Unit'} (${monthName})`;
  }
}

// Unit menu dropdown toggle
const unitMenuBtn = qs('#unitMenuBtn');
const unitMenuDropdown = qs('#unitMenuDropdown');
if (unitMenuBtn && unitMenuDropdown) {
  unitMenuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    unitMenuDropdown.style.display = unitMenuDropdown.style.display === 'none' ? 'block' : 'none';
  });
  
  document.addEventListener('click', (e) => {
    if (e.target !== unitMenuBtn && !unitMenuBtn.contains(e.target)) {
      unitMenuDropdown.style.display = 'none';
    }
  });
}

const addCommentBtn = qs('#addCommentBtn');
if (addCommentBtn) {
  addCommentBtn.addEventListener('click', () => {
    const unitWdNumbersModal = qs('#unitWdNumbersModal');
    const titleEl = qs('#unitWdNumbersTitle');
    
    // Extract unit ID from title (format: "WD Numbers - UNIT_ID")
    if (titleEl && unitWdNumbersModal && unitWdNumbersModal.style.display !== 'none') {
      const titleText = titleEl.textContent || '';
      const parts = titleText.split(' - ');
      if (parts.length > 1) {
        const unitId = parts[1].trim();
        const year = window.currentWdNumbersYear;
        const month = window.currentWdNumbersMonth;
        closeUnitWdNumbersModal();
        openCommentsModalFromWdNumbers(unitId, year, month);
      }
    }
    
    const unitMenuDropdown = qs('#unitMenuDropdown');
    if (unitMenuDropdown) unitMenuDropdown.style.display = 'none';
  });
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
      
      reader.onload = async (e) => {
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

          if (targetLower === 'leases') {
            // Leases import can auto-add new companies/suppliers/arrangements/invoicing
            // types. Pull the latest config lists from Sheets first so this doesn't
            // build on — and then save over — a stale local copy.
            await refreshConfigSnapshotFromServer();
            _configChangeIntentional = true;
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
  const skippedItems = []; // Track skipped items for report
  
  try {
    switch (target) {
      case 'invoices':
        // Group invoices by WD number to create registries
        const invoicesByWD = new Map();
        
        data.forEach((item, index) => {
          if (!item.unit || !item.wdNumber) {
            skipped++;
            skippedItems.push({ row: index + 2, reason: 'Missing unit or wdNumber', data: item });
            return;
          }
          
          // Check if invoice already exists (by wdNumber + unit + docNumber combination)
          const existingInvoice = state.invoices.find(inv => 
            inv.wdNumber === item.wdNumber && 
            inv.unit === item.unit && 
            inv.docNumber === item.docNumber
          );
          if (existingInvoice) {
            skipped++;
            skippedItems.push({ row: index + 2, reason: 'Duplicate invoice', data: item });
            return;
          }
          
          // Find the associated lease to get company, supplier, arrangement, invoicing
          const associatedLease = state.leases.find(l => l.leaseNumber === item.lease);
          
          // Clean and validate amount field
          let cleanAmount = (item.amount || '').toString().trim();
          
          // Handle negative numbers in parentheses format like (1500.00)
          if (cleanAmount.startsWith('(') && cleanAmount.endsWith(')')) {
            cleanAmount = '-' + cleanAmount.slice(1, -1);
          }
          
          // Remove currency symbols, commas, and spaces
          cleanAmount = cleanAmount.replace(/[$,\s]/g, '');
          
          // Check if amount contains letters (skip if it does)
          if (cleanAmount && /[a-zA-Z]/.test(cleanAmount)) {
            skipped++;
            skippedItems.push({ row: index + 2, reason: 'Amount contains letters', data: item });
            return;
          }
          
          // Validate it's a valid number
          if (cleanAmount && isNaN(parseFloat(cleanAmount))) {
            skipped++;
            skippedItems.push({ row: index + 2, reason: 'Invalid amount format', data: item });
            return;
          }
          
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
            amount: cleanAmount || '0',
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
        
        // Create registries for each WD number group (only if not already exists)
        invoicesByWD.forEach((invoices, wdNumber) => {
          // Check if registry with this WD number already exists
          const existingRegistry = state.registries.find(r => r.wdNumber === wdNumber);
          if (existingRegistry) {
            // Registry already exists, skip creation
            return;
          }
          
          const firstInvoice = invoices[0];
          const units = invoices.map(inv => inv.unit);
          
          // Use the amount from the first invoice as the total (don't sum)
          const totalAmount = parseFloat(firstInvoice.amount) || 0;
          
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
        data.forEach((item, index) => {
          if (!item.unitId || !item.lease) {
            skipped++;
            skippedItems.push({ row: index + 2, reason: 'Missing unitId or lease', data: item });
            return;
          }
          
          // Check if unit already exists (by unitId)
          const existingUnit = state.units.find(u => u.unitId === item.unitId);
          if (existingUnit) {
            skipped++;
            skippedItems.push({ row: index + 2, reason: 'Duplicate unit', data: item });
            return;
          }
          
          // Find the associated lease to get company, supplier, arrangement, invoicing
          const associatedLease = state.leases.find(l => l.leaseNumber === item.lease);
          
          // Clean and validate monthly amount field
          let cleanMonthly = (item.monthly || '').toString().trim();
          
          // Handle negative numbers in parentheses format like (1500.00)
          if (cleanMonthly.startsWith('(') && cleanMonthly.endsWith(')')) {
            cleanMonthly = '-' + cleanMonthly.slice(1, -1);
          }
          
          // Remove currency symbols, commas, and spaces
          cleanMonthly = cleanMonthly.replace(/[$,\s]/g, '');
          
          // Check if monthly contains letters (skip if it does)
          if (cleanMonthly && /[a-zA-Z]/.test(cleanMonthly)) {
            skipped++;
            skippedItems.push({ row: index + 2, reason: 'Monthly amount contains letters', data: item });
            return;
          }
          
          // Validate it's a valid number
          if (cleanMonthly && isNaN(parseFloat(cleanMonthly))) {
            skipped++;
            skippedItems.push({ row: index + 2, reason: 'Invalid monthly amount format', data: item });
            return;
          }
          
          const unit = {
            id: id(),
            lease: item.lease || '',
            company: associatedLease ? associatedLease.company : '',
            supplier: associatedLease ? associatedLease.supplier : '',
            arrangement: associatedLease ? associatedLease.arrangement : '',
            invoicing: associatedLease ? associatedLease.invoicing : '',
            unitId: item.unitId || '',
            monthly: cleanMonthly || '0',
            description: item.description || '',
            notes: item.notes || '',
            status: item.status || 'Operational'
          };
          
          // Handle status history fields
          if (item.disabledDate) unit.disabledDate = item.disabledDate;
          if (item.enabledDate) unit.enabledDate = item.enabledDate;
          
          // Parse statusHistory if provided
          if (item.statusHistory) {
            try {
              unit.statusHistory = typeof item.statusHistory === 'string' 
                ? JSON.parse(item.statusHistory) 
                : item.statusHistory;
            } catch (e) {
              // If parsing fails, ignore the statusHistory
            }
          }
          
          // Auto-initialize status history for new units without it
          if (!unit.statusHistory || unit.statusHistory.length === 0) {
            unit.statusHistory = [{
              status: 'Operational',
              date: '2025-01-01',
              changedBy: 'System',
              timestamp: '2025-01-01T00:00:00.000Z'
            }];
            if (!unit.enabledDate) unit.enabledDate = '2025-01-01';
          }
          
          state.units.push(unit);
          added++;
        });
        renderUnits();
        break;
        
      case 'leases':
        data.forEach((item, index) => {
          if (!item.leaseNumber) {
            skipped++;
            skippedItems.push({ row: index + 2, reason: 'Missing leaseNumber', data: item });
            return;
          }
          
          // Check if lease already exists (by leaseNumber)
          const existingLease = state.leases.find(l => l.leaseNumber === item.leaseNumber);
          if (existingLease) {
            skipped++;
            skippedItems.push({ row: index + 2, reason: 'Duplicate lease', data: item });
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
        data.forEach((item, index) => {
          if (!item.wdNumber || !item.units) {
            skipped++;
            skippedItems.push({ row: index + 2, reason: 'Missing wdNumber or units', data: item });
            return;
          }
          
          // Check if registry already exists (by wdNumber)
          const existingRegistry = state.registries.find(r => r.wdNumber === item.wdNumber);
          if (existingRegistry) {
            skipped++;
            skippedItems.push({ row: index + 2, reason: 'Duplicate registry', data: item });
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
        data.forEach((item, index) => {
          if (!item.username) {
            skipped++;
            skippedItems.push({ row: index + 2, reason: 'Missing username', data: item });
            return;
          }
          
          // Check if user already exists (by username)
          const existingUser = state.users.find(u => u.username === item.username);
          if (existingUser) {
            skipped++;
            skippedItems.push({ row: index + 2, reason: 'Duplicate user', data: item });
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
      message += ` ${skipped} record(s) were skipped (missing required fields or duplicates).`;
      
      // Generate and offer download of skipped items report
      const reportContent = generateSkippedItemsReport(target, skippedItems);
      const blob = new Blob([reportContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      
      // Add download link to status message
      setTimeout(() => {
        const downloadLink = document.createElement('a');
        downloadLink.href = url;
        downloadLink.download = `skipped_${target}_${new Date().toISOString().slice(0, 10)}.csv`;
        downloadLink.textContent = 'Download Report Here';
        downloadLink.style.cssText = 'display:block;margin-top:8px;color:#0b74de;font-weight:600;text-decoration:underline;cursor:pointer;';
        downloadLink.addEventListener('click', () => {
          setTimeout(() => URL.revokeObjectURL(url), 100);
        });
        
        statusDiv.appendChild(document.createElement('br'));
        statusDiv.appendChild(downloadLink);
      }, 100);
    }
    showUploadStatus(statusDiv, message, 'success');
    
  } catch (err) {
    showUploadStatus(statusDiv, `Error uploading data: ${err.message}`, 'error');
  }
}

// Helper function to generate a CSV report of skipped items
function generateSkippedItemsReport(target, skippedItems) {
  if (!skippedItems || skippedItems.length === 0) return '';
  
  // Build headers based on the first skipped item's data (original upload format)
  const firstItem = skippedItems[0].data;
  const dataHeaders = Object.keys(firstItem);
  
  // Build rows with original data only (no Row/Reason columns)
  const rows = skippedItems.map(item => {
    const rowData = dataHeaders.map(header => escapeCSVField(item.data[header] || ''));
    return rowData.join(',');
  });
  
  return [dataHeaders.join(','), ...rows].join('\n');
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
      headers = ['lease', 'unitId', 'monthly', 'description', 'notes', 'company', 'supplier', 'arrangement', 'invoicing', 'status', 'disabledDate', 'enabledDate', 'statusHistory'];
      exampleRow = ['LEASE001', 'UNIT123', '1500.00', 'Equipment description', 'Additional notes', 'Company A', 'Supplier B', 'Arrangement C', 'Invoicing D', 'Operational', '', '', ''];
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
  const unitsHeaders = ['lease', 'unitId', 'monthly', 'description', 'notes', 'company', 'supplier', 'arrangement', 'invoicing', 'status', 'disabledDate', 'enabledDate', 'statusHistory'];
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
    status: u.status || 'Operational',
    disabledDate: u.disabledDate || '',
    enabledDate: u.enabledDate || '',
    statusHistory: u.statusHistory ? JSON.stringify(u.statusHistory) : ''
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
  
  // Download Configuration - Format compatible with upload
  const configHeaders = ['AGI Company', 'Category', 'Supplier', 'Invoicing', 'Arrangement'];
  const configData = [];
  
  // Get the maximum length among all arrays
  const maxLength = Math.max(
    (state.meta.devCompanies || []).length,
    (state.meta.devRentals || []).length,
    (state.meta.devSuppliers || []).length,
    (state.meta.devPayments || []).length,
    (state.meta.devArrangements || []).length
  );
  
  // Create rows with values from each configuration array
  for (let i = 0; i < maxLength; i++) {
    configData.push({
      'AGI Company': (state.meta.devCompanies || [])[i] || '',
      'Category': (state.meta.devRentals || [])[i] || '',
      'Supplier': (state.meta.devSuppliers || [])[i] || '',
      'Invoicing': (state.meta.devPayments || [])[i] || '',
      'Arrangement': (state.meta.devArrangements || [])[i] || ''
    });
  }
  
  downloadCSV(convertToCSV(configData, configHeaders), `configuration_${timestamp}.csv`);
  
  alert(`Downloaded 5 CSV files:\n- invoices_${timestamp}.csv\n- units_${timestamp}.csv\n- leases_${timestamp}.csv\n- users_${timestamp}.csv\n- configuration_${timestamp}.csv`);
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

// Wire up the download configuration template button
const downloadConfigTemplateBtn = qs('#downloadConfigTemplateBtn');
if (downloadConfigTemplateBtn) {
  downloadConfigTemplateBtn.addEventListener('click', () => {
    // Create template with column headers and example data
    const templateData = [
      { 
        'AGI Company': 'Example Company 1',
        'Category': 'Vehicle Lease',
        'Supplier': 'Supplier A',
        'Invoicing': 'NET 30',
        'Arrangement': 'Monthly'
      },
      { 
        'AGI Company': 'Example Company 2',
        'Category': 'Equipment Rental',
        'Supplier': 'Supplier B',
        'Invoicing': 'NET 60',
        'Arrangement': 'Quarterly'
      },
      { 
        'AGI Company': '',
        'Category': '',
        'Supplier': '',
        'Invoicing': '',
        'Arrangement': ''
      }
    ];
    
    const headers = ['AGI Company', 'Category', 'Supplier', 'Invoicing', 'Arrangement'];
    const csvContent = convertToCSV(templateData, headers);
    downloadCSV(csvContent, 'configuration_template.csv');
  });
}

// Wire up the upload configuration button
const uploadConfigBtn = qs('#uploadConfigBtn');
const uploadConfigFile = qs('#uploadConfigFile');
const statusConfig = qs('#statusConfig');

if (uploadConfigBtn && uploadConfigFile && statusConfig) {
  uploadConfigBtn.addEventListener('click', () => {
    const file = uploadConfigFile.files[0];
    if (!file) {
      statusConfig.style.display = 'block';
      statusConfig.style.background = '#fef2f2';
      statusConfig.style.color = '#dc2626';
      statusConfig.textContent = '⚠️ Please select a file first';
      return;
    }
    
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        let data = [];
        const content = e.target.result;

        // Parse CSV or JSON
        if (file.name.endsWith('.json')) {
          data = JSON.parse(content);
        } else {
          // Parse CSV with proper handling of quoted fields
          const lines = content.split('\n').filter(line => line.trim());
          const headers = parseCSVLine(lines[0]);

          for (let i = 1; i < lines.length; i++) {
            const values = parseCSVLine(lines[i]);
            const obj = {};
            headers.forEach((header, idx) => {
              obj[header] = values[idx] || '';
            });
            data.push(obj);
          }
        }

        // Pull the latest config lists from Sheets first so this upload merges into
        // the current server state instead of a possibly-stale local copy.
        await refreshConfigSnapshotFromServer();

        // Process configuration data by columns
        let companiesAdded = 0, categoriesAdded = 0, suppliersAdded = 0, arrangementsAdded = 0, invoicingAdded = 0;

        data.forEach(row => {
          // Process AGI Company column
          const company = (row['AGI Company'] || '').trim();
          if (company && !state.meta.devCompanies.includes(company)) {
            state.meta.devCompanies.push(company);
            companiesAdded++;
          }
          
          // Process Category column
          const category = (row['Category'] || '').trim();
          if (category && !state.meta.devRentals.includes(category)) {
            state.meta.devRentals.push(category);
            categoriesAdded++;
          }
          
          // Process Supplier column
          const supplier = (row['Supplier'] || '').trim();
          if (supplier && !state.meta.devSuppliers.includes(supplier)) {
            state.meta.devSuppliers.push(supplier);
            suppliersAdded++;
          }
          
          // Process Invoicing column
          const invoicing = (row['Invoicing'] || '').trim();
          if (invoicing && !state.meta.devPayments.includes(invoicing)) {
            state.meta.devPayments.push(invoicing);
            invoicingAdded++;
          }
          
          // Process Arrangement column
          const arrangement = (row['Arrangement'] || '').trim();
          if (arrangement && !state.meta.devArrangements.includes(arrangement)) {
            state.meta.devArrangements.push(arrangement);
            arrangementsAdded++;
          }
        });
        
        // Save and refresh all lists
        _configChangeIntentional = true;
        saveState();
        if (typeof renderCompanyList === 'function') renderCompanyList();
        if (typeof renderRentalList === 'function') renderRentalList();
        if (typeof renderSupplierList === 'function') renderSupplierList();
        if (typeof renderArrangementList === 'function') renderArrangementList();
        if (typeof renderPaymentList === 'function') renderPaymentList();
        if (typeof syncInvoiceCategoryOptions === 'function') syncInvoiceCategoryOptions();
        
        // Show success message
        statusConfig.style.display = 'block';
        statusConfig.style.background = '#f0fdf4';
        statusConfig.style.color = '#16a34a';
        statusConfig.textContent = `✅ Configuration loaded successfully!\n` +
          `Companies: ${companiesAdded}, Categories: ${categoriesAdded}, Suppliers: ${suppliersAdded}, ` +
          `Arrangements: ${arrangementsAdded}, Invoicing: ${invoicingAdded}`;
        
        // Clear file input
        uploadConfigFile.value = '';
        
      } catch (error) {
        statusConfig.style.display = 'block';
        statusConfig.style.background = '#fef2f2';
        statusConfig.style.color = '#dc2626';
        statusConfig.textContent = `❌ Error: ${error.message}`;
      }
    };
    
    reader.readAsText(file);
  });
}

// Helper function to parse CSV line with proper handling of quoted fields
function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const nextChar = line[i + 1];
    
    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        // Handle escaped quote (two double quotes)
        current += '"';
        i++; // Skip next quote
      } else {
        // Toggle quote state
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      // Field separator (only when not in quotes)
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  
  // Add the last field
  result.push(current.trim());
  
  return result;
}