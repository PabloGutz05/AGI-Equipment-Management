// Simple SPA with localStorage persistence and import/export JSON
const STORAGE_KEY = 'agi_vehicle_lease_v1';

const defaultData = {
  invoices: [],
  units: [],
  leases: [],
  users: [],
  registries: [],
  ccCenters: [],
  invoiceTracking: [],
  accruals: [],
  comments: {}, // Store comments by unitId
  meta: { createdAt: new Date().toISOString(), registrySeq: 0 }
};

let state = JSON.parse(JSON.stringify(defaultData));

// Invoice Tracking column config — declared up here (not next to the render function further
// down) because renderAll() runs once synchronously at script init (before any DB data loads)
// to paint the initial empty shell, and it calls renderInvoiceTrackingTable(); a const declared
// only near that function's own definition further down the file would still be in its temporal
// dead zone at that point and throw "Cannot access before initialization".
let _invoiceTrackingSort = { column: 'wdInvoiceNum', ascending: true };

// Per-column filter state for the Tracked Invoices table's header filter popovers — never
// persisted (a view convenience, reset on reload), keyed by column key. Shape depends on the
// owning column's filterType: 'multi' -> { type:'multi', values:Set<string> }, 'range'/
// 'daterange' -> { type, min:string, max:string }, 'text' -> { type:'text', value:string }.
// A column key present in this map always means "actively filtering" — a filter that's cleared
// back to its neutral state (empty Set, both bounds blank, empty text) is deleted from the map
// entirely rather than kept around inert, so `Object.keys(_invoiceTrackingFilters).length` alone
// tells whether anything is filtered.
let _invoiceTrackingFilters = {};
let _invoiceTrackingOpenFilterCol = null;
const INVOICE_TRACKING_VISIBLE_ROWS = 20;

const INVOICE_TRACKING_COLUMNS = [
  { key: 'supplier', label: 'Supplier', filterType: 'multi' },
  { key: 'lease', label: 'Lease', get: r => (Array.isArray(r.lease) ? r.lease.join(', ') : ''), filterType: 'multi' },
  { key: 'unitsInDispute', label: 'Units in Dispute', get: r => (Array.isArray(r.unitsInDispute) ? r.unitsInDispute.join(', ') : ''), filterType: 'multi' },
  { key: 'supplierInvoiceDoc', label: 'Supplier Invoice Doc', filterType: 'multi' },
  { key: 'invoiceAmount', label: 'Invoice Amount', numeric: true, filterType: 'range' },
  { key: 'amountInDispute', label: 'Amount in Dispute', numeric: true, filterType: 'range' },
  { key: 'amountDue', label: 'Amount Due', numeric: true, filterType: 'range' },
  { key: 'wdInvoiceNum', label: 'WD Invoice Num', filterType: 'multi' },
  { key: 'wdInvoiceDate', label: 'WD Invoice Date', filterType: 'daterange' },
  { key: 'invoiceStatus', label: 'Invoice Status', filterType: 'multi' },
  { key: 'paymentStatus', label: 'Payment Status', filterType: 'multi' },
  { key: 'fromDate', label: 'From Date', filterType: 'daterange' },
  { key: 'toDate', label: 'To Date', filterType: 'daterange' },
  { key: 'costCenter', label: 'Cost Center', filterType: 'multi' },
  { key: 'descriptionOfIssue', label: 'Description of Issue', filterType: 'text' },
  { key: 'request', label: 'Request', filterType: 'text' },
  { key: 'status', label: 'Status', filterType: 'multi' }
];

// --- Password hashing (PBKDF2-SHA256 via Web Crypto) ---
// Stored format: "pbkdf2$<iterations>$<saltHex>$<hashHex>". Legacy plain-text passwords (no
// "pbkdf2$" prefix) are still accepted on login for backward compatibility with existing
// accounts; a successful legacy match is transparently re-hashed and persisted (see login flow).
// The hardcoded "Master" account is exempt from all of this — it never touches state.users.
const PBKDF2_ITERATIONS = 150000;

function _bufToHex(buf){
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
}
function _hexToBuf(hex){
  const bytes = new Uint8Array(hex.length / 2);
  for(let i=0;i<hex.length;i+=2) bytes[i/2] = parseInt(hex.substr(i,2), 16);
  return bytes;
}
async function hashPassword(password, saltHex, iterations){
  iterations = iterations || PBKDF2_ITERATIONS;
  const salt = saltHex ? _hexToBuf(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const saltHexOut = saltHex || _bufToHex(salt);
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, keyMaterial, 256);
  return `pbkdf2$${iterations}$${saltHexOut}$${_bufToHex(bits)}`;
}
function isHashedPassword(stored){
  return typeof stored === 'string' && stored.startsWith('pbkdf2$');
}
async function verifyPassword(password, stored){
  if(!stored) return false;
  if(isHashedPassword(stored)){
    const parts = stored.split('$');
    if(parts.length !== 4) return false;
    const iterations = parseInt(parts[1], 10);
    const saltHex = parts[2];
    const expectedHash = parts[3];
    const recomputed = await hashPassword(password, saltHex, iterations);
    return recomputed.split('$')[3] === expectedHash;
  }
  // legacy plain-text account: compare directly
  return stored === password;
}

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

// --- Modal scroll lock ---
// Each modal toggles its own `style.display`/`aria-hidden` independently (no single shared
// open/close function to hook into), so instead of touching every call site we just watch all
// `.modal` elements for style changes and lock body/html scroll whenever any of them is visible.
// This stops the page behind a modal from scrolling when the user scrolls over the backdrop.
(function setupModalScrollLock(){
  const modals = Array.from(document.querySelectorAll('.modal'));
  if(modals.length === 0) return;
  // Plain `overflow:hidden` on html/body collapses the scrollable area the instant a modal
  // opens, which snaps the visual scroll position to 0 — the page "jumps to the top" the
  // moment any modal appears. Pin the body at its current scroll offset via position:fixed +
  // a matching negative `top` instead, so the underlying page never actually moves; restore
  // real document scroll on unlock.
  let isLocked = false;
  let lockedScrollY = 0;
  function lock(){
    if(isLocked) return;
    isLocked = true;
    lockedScrollY = window.scrollY || window.pageYOffset || document.documentElement.scrollTop || 0;
    document.body.style.position = 'fixed';
    document.body.style.top = (-lockedScrollY) + 'px';
    document.body.style.left = '0';
    document.body.style.right = '0';
    document.body.style.width = '100%';
    document.documentElement.classList.add('modal-open-lock');
    document.body.classList.add('modal-open-lock');
  }
  function unlock(){
    if(!isLocked) return;
    isLocked = false;
    document.documentElement.classList.remove('modal-open-lock');
    document.body.classList.remove('modal-open-lock');
    document.body.style.position = '';
    document.body.style.top = '';
    document.body.style.left = '';
    document.body.style.right = '';
    document.body.style.width = '';
    window.scrollTo(0, lockedScrollY);
  }
  function refresh(){
    const anyOpen = modals.some(m => getComputedStyle(m).display !== 'none');
    if(anyOpen) lock(); else unlock();
  }
  const observer = new MutationObserver(refresh);
  modals.forEach(m => observer.observe(m, { attributes: true, attributeFilter: ['style'] }));
  refresh();
})();

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
    } else if(btn.dataset.tab === 'accruals'){
      // A forced recompute here calls into renderAccrualsCoveragePanel via each list's own
      // trailing auto-select, which unconditionally resets pending manual-coverage tracking —
      // skip the refresh (not the tab switch itself) while there's unsaved work, so navigating
      // away and back can never silently discard it. The tab panel still becomes visible with
      // whatever it was last showing; accrualsPanelBlockedByPending() also alerts the operator.
      if(typeof accrualsPanelBlockedByPending === 'function' && accrualsPanelBlockedByPending()){
        // still ensure the accrued/not-accruable lists (independent of pending state) reflect reality
        try{ if(typeof renderAccrualsAccruedList === 'function') renderAccrualsAccruedList(); }catch(e){}
        try{ if(typeof renderAccrualsNotAccruableList === 'function') renderAccrualsNotAccruableList(); }catch(e){}
      } else {
        try{ if(typeof switchAccrualsSubTab === 'function') switchAccrualsSubTab(_accrualsActiveSubTab || 'missing', true); }catch(e){}
        try{ if(typeof renderAccrualsAccruedList === 'function') renderAccrualsAccruedList(); }catch(e){}
        try{ if(typeof renderAccrualsNotAccruableList === 'function') renderAccrualsNotAccruableList(); }catch(e){}
      }
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
        const candidate = (users||[]).find(x=> x.username === username);
        const u = (candidate && await verifyPassword(password, candidate.password)) ? candidate : null;
        if(u){
          // Transparently upgrade legacy plain-text passwords to a hashed value on first
          // successful login, without requiring the user to do anything.
          if(!isHashedPassword(u.password)){
            try{
              const upgraded = Object.assign({}, u, { password: await hashPassword(password) });
              await DB.updateUser(upgraded);
              const idx = (state.users||[]).findIndex(x => x.id === u.id);
              if(idx !== -1) state.users[idx] = upgraded;
            }catch(migErr){ console.error('Password migration error:', migErr); }
          }
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
    // hide developer, leaseControl; the Users tab stays enabled but shows only their own
    // account (see renderUsers()) plus Change Password
    const names = ['developer','leaseControl'];
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
    const amountStr = (fd.get('invoiceAmount') || '').toString().trim();
    const amountNum = parseCurrency(amountStr);
    const pStart = (fd.get('invoicePeriodStart') || '').toString().trim();
    const pEnd = (fd.get('invoicePeriodEnd') || '').toString().trim();
    const submitted = (fd.get('invoiceSubmitted') || '').toString().trim();

    // Units selection — read in the order units were actually checked (not the picker's own
    // display order), so the stored order matches the physical invoice's line order.
    let selectedUnits = getSelectedInvoiceUnits();
    if(selectedUnits.length === 0){
      const single = (fd.get('invoiceUnit') || '').toString();
      selectedUnits = single.split(/[;,]+/).map(s=> s.trim()).filter(Boolean);
    }

    const missing = [];
    if(!wd) missing.push('WD Invoice Number');
    if(!doc) missing.push('Doc Invoice Number');
    if(selectedLeases.length === 0) missing.push('Lease');
    if(!category) missing.push('Category');
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
  // The per-unit Charge + Tax breakdown must add up to the declared invoice Amount — for a
  // quarterly invoice with additional periods, that's the sum across every period's table.
  try{
    if(typeof renderInvoiceUnitBreakdown === 'function') renderInvoiceUnitBreakdown();
    if(_invoiceQuarterlyPeriod1Active){
      const missingP1Dates = !_invoicePeriod1.fromDate || !_invoicePeriod1.toDate;
      const missingDates = missingP1Dates || _invoicePeriods.some(p => !p.fromDate || !p.toDate);
      if(missingDates){
        alert('Every period (including Period 1) needs both a From and To date before submitting.');
        return;
      }
      if(!validateInvoicePeriodRanges()){
        alert('Period date ranges must fall within the invoice\'s overall declared period (From/To above) and must not overlap each other.');
        return;
      }
      if(!invoicePeriodsCoverFullDeclaredRange()){
        alert('The periods together must cover the invoice\'s entire declared period (From/To above), with no gaps.');
        return;
      }
      if(!invoiceQuarterlyPeriodsMatchDeclared()){
        alert('The sum of Charge Amount + Tax Amount across all periods must equal the declared invoice Amount before submitting.');
        return;
      }
    } else if(!unitBreakdownMatches('invoiceUnitBreakdown')){
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

    let unitsForCheck = getSelectedInvoiceUnits();
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
    invoiceDate: fd.get('invoiceSupplierInvoiceDate') || '',
    periodStart: fd.get('invoicePeriodStart') || '',
    periodEnd: fd.get('invoicePeriodEnd') || '',
    submittedDate: fd.get('invoiceSubmitted') || '',
    comment: fd.get('invoiceComment') || ''
  };

  const editingId = form.dataset.editing || null;
  let editingGroupIds = null;
  if(form.dataset.editingGroupIds){
    try{ editingGroupIds = JSON.parse(form.dataset.editingGroupIds); }catch(e){ editingGroupIds = null; }
  }

  if(editingGroupIds && editingGroupIds.length){
    // Editing every invoice in a WD group at once (see the "Edit" action in the invoice list):
    // reconcile whichever units are now selected against the group's original member invoices,
    // updating in place, adding newly-checked units, and dropping any that were unchecked.
    let units = getSelectedInvoiceUnits();
    if(units.length === 0){
      const single = (fd.get('invoiceUnit') || '').toString();
      units = single.split(/[;,]+/).map(s=> s.trim()).filter(Boolean);
    }

    const selectedLeases = getSelectedInvoiceLeases();
    const breakdownData = getInvoiceBreakdownRowsData();
    const originalInvoices = (state.invoices||[]).filter(inv => editingGroupIds.indexOf(inv.id) !== -1);

    const skippedGroup = [];
    const keepIds = new Set();
    const finalUnits = [];
    const finalLeases = [];
    const finalUnitDetails = [];

    units.forEach(uVal => {
      const existingForUnit = originalInvoices.find(i => (i.unit||'').toString().trim().toLowerCase() === uVal.toString().trim().toLowerCase());
      const resolved = resolveInvoiceUnitLeaseInfo(uVal, selectedLeases);

      // Only newly-added units (not already part of this group) need a clash check —
      // re-saving a unit that was already here is expected, not a duplicate.
      if(!existingForUnit){
        const clash = (state.invoices || []).find(inv => {
          if(editingGroupIds.indexOf(inv.id) !== -1) return false;
          const aLease = (inv.lease||'').toString().trim().toLowerCase();
          const aCat = (inv.category||'').toString().trim().toLowerCase();
          const aUnit = (inv.unit||'').toString().trim().toLowerCase();
          const aWd = (inv.wdNumber||'').toString().trim().toLowerCase();
          return aLease === (resolved.lease||'').toString().trim().toLowerCase()
            && aCat === (baseInvoice.category||'').toString().trim().toLowerCase()
            && aUnit === uVal.toString().trim().toLowerCase()
            && aWd === (baseInvoice.wdNumber||'').toString().trim().toLowerCase();
        });
        if(clash){ skippedGroup.push(uVal); return; }
      }

      const rowData = breakdownData[uVal] || {};
      const chargeAmount = (function(){ const n = parseCurrency(rowData.charge||''); return n===null ? '' : n.toFixed(2); })();
      const taxAmount = (function(){ const n = parseCurrency(rowData.tax||''); return n===null ? '' : n.toFixed(2); })();
      const otherCharges = (function(){ const n = parseCurrency(rowData.other||''); return n===null ? '' : n.toFixed(2); })();
      const targetId = existingForUnit ? existingForUnit.id : id();
      const invoiceObj = Object.assign({}, baseInvoice, resolved, { id: targetId, unit: uVal, amount: chargeAmount, taxAmount: taxAmount, otherCharges: otherCharges, otherChargeDetails: rowData.otherChargeDetails || [] });

      if(existingForUnit){
        state.invoices = state.invoices.map(inv => inv.id === targetId ? Object.assign({}, inv, invoiceObj) : inv);
      } else {
        state.invoices.push(invoiceObj);
      }
      keepIds.add(targetId);
      finalUnits.push(uVal);
      if(resolved.lease) finalLeases.push(resolved.lease);

      const unitRecForDetail = (state.units||[]).find(u => (u.unitId||u.id||'').toString().trim() === uVal.toString().trim());
      finalUnitDetails.push({
        unit: uVal,
        lease: resolved.lease || '',
        company: resolved.company || '',
        supplier: resolved.supplier || '',
        arrangement: resolved.arrangement || '',
        invoicing: resolved.invoicing || '',
        costCenter: unitRecForDetail ? (unitRecForDetail.costCenter||'') : '',
        tax: taxAmount,
        other: otherCharges,
        otherChargeDetails: rowData.otherChargeDetails || [],
        charge: chargeAmount
      });
    });

    // Units that were part of the original group but got unchecked during this edit are removed
    originalInvoices.forEach(inv => {
      if(!keepIds.has(inv.id)) state.invoices = state.invoices.filter(i => i.id !== inv.id);
    });

    // Keep the matching registry (by WD/Doc) in sync with the reconciled unit/lease/detail set —
    // registries carry their own durable snapshot since individual invoices aren't persisted.
    try{
      const targetWd = (baseInvoice.wdNumber || '').toString().trim();
      const targetDoc = (baseInvoice.docNumber || '').toString().trim();
      const regIdx = (state.registries||[]).findIndex(r => (r.wdNumber||'').toString().trim() === targetWd && (r.docNumber||'').toString().trim() === targetDoc);
      if(regIdx !== -1){
        const uniqueLeases = Array.from(new Set(finalLeases.filter(Boolean)));
        state.registries[regIdx].units = finalUnits.slice();
        state.registries[regIdx].unitCount = finalUnits.length;
        state.registries[regIdx].leases = uniqueLeases;
        state.registries[regIdx].lease = uniqueLeases.join(', ');
        state.registries[regIdx].unitDetails = finalUnitDetails.slice();
        state.registries[regIdx].totalAmount = baseInvoice.amount || state.registries[regIdx].totalAmount;
        state.registries[regIdx].invoiceDate = baseInvoice.invoiceDate || '';
        DB.updateRegistry(state.registries[regIdx]).catch(e => console.error('Registry sync error:', e));
      }
    }catch(e){}

    saveState(); renderInvoices(); renderRegistries();
    renderUnitOverview(); renderLeaseOverview(); renderOverview();
    form.reset(); delete form.dataset.editing; delete form.dataset.editingGroupIds;
    const submitBtn = form.querySelector('button[type="submit"]'); if(submitBtn) submitBtn.textContent = 'Add Invoice';
    const invCancel = qs('#invoiceCancelBtn'); if(invCancel) invCancel.style.display = 'none';
    const sub = qs('#invoiceSubmitted'); if(sub) sub.value = new Date().toISOString().slice(0,10);

    const leaseSearchEl = qs('#invoiceLeaseSearch'); if(leaseSearchEl){ leaseSearchEl.value=''; leaseSearchEl.dispatchEvent(new Event('input')); }
    const unitSearchEl = qs('#invoiceUnitSearch'); if(unitSearchEl){ unitSearchEl.value=''; unitSearchEl.dispatchEvent(new Event('input')); }
    if(typeof renderInvoiceLeaseDetailTable === 'function') renderInvoiceLeaseDetailTable();
    if(typeof renderInvoiceUnitBreakdown === 'function') renderInvoiceUnitBreakdown();

    const commentHiddenInput = qs('#invoiceComment');
    if(commentHiddenInput) commentHiddenInput.value = '';
    const commentBtn = qs('#invoiceCommentBtn');
    if(commentBtn){
      commentBtn.textContent = 'Add Comment';
      commentBtn.title = '';
      try{ commentBtn.classList.remove('btn-warning'); commentBtn.classList.add('btn-primary'); }catch(e){}
    }
    if(typeof resetInvoiceQuarterlyPeriods === 'function') resetInvoiceQuarterlyPeriods();

    if(skippedGroup.length){ alert('Some units were skipped because a matching invoice already exists elsewhere: ' + skippedGroup.join(', ')); }
  } else if(editingId){
    // editing an existing single invoice: prefer first selected unit when available
    const alls = getSelectedInvoiceUnits();
    let unitVal = (alls.length ? alls[0] : (fd.get('invoiceUnit') || '')).toString().trim();

    const resolvedInfo = resolveInvoiceUnitLeaseInfo(unitVal, getSelectedInvoiceLeases());
    const editRowData = getInvoiceBreakdownRowsData()[unitVal] || {};
    const editCharge = (function(){ const n = parseCurrency(editRowData.charge||''); return n===null ? '' : n.toFixed(2); })();
    const editTax = (function(){ const n = parseCurrency(editRowData.tax||''); return n===null ? '' : n.toFixed(2); })();
    const editOther = (function(){ const n = parseCurrency(editRowData.other||''); return n===null ? '' : n.toFixed(2); })();
    const invoiceObj = Object.assign({}, baseInvoice, resolvedInfo, { id: editingId, unit: unitVal, amount: editCharge, taxAmount: editTax, otherCharges: editOther, otherChargeDetails: editRowData.otherChargeDetails || [] });
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
        state.registries[regIdx].invoiceDate = baseInvoice.invoiceDate || state.registries[regIdx].invoiceDate || '';

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
          other: editOther,
          otherChargeDetails: editRowData.otherChargeDetails || [],
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
    
    // Clear any active search filters on the lease/unit pickers and hide the (now empty)
    // lease detail table — form.reset() already unchecked the underlying checkboxes.
    const leaseSearchEl = qs('#invoiceLeaseSearch'); if(leaseSearchEl){ leaseSearchEl.value=''; leaseSearchEl.dispatchEvent(new Event('input')); }
    const unitSearchEl = qs('#invoiceUnitSearch'); if(unitSearchEl){ unitSearchEl.value=''; unitSearchEl.dispatchEvent(new Event('input')); }
    if(typeof renderInvoiceLeaseDetailTable === 'function') renderInvoiceLeaseDetailTable();

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
    let units = getSelectedInvoiceUnits();
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
      // pull this unit's Tax/Other Charges/Amount from the breakdown table
      const rowData = breakdownData[uVal] || {};
      const chargeAmount = (function(){ const n = parseCurrency(rowData.charge||''); return n===null ? '' : n.toFixed(2); })();
      const taxAmount = (function(){ const n = parseCurrency(rowData.tax||''); return n===null ? '' : n.toFixed(2); })();
      const otherCharges = (function(){ const n = parseCurrency(rowData.other||''); return n===null ? '' : n.toFixed(2); })();
      const newInv = Object.assign({}, baseInvoice, resolved, { id: id(), unit: uVal, amount: chargeAmount, taxAmount: taxAmount, otherCharges: otherCharges, otherChargeDetails: rowData.otherChargeDetails || [] });
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
        other: otherCharges,
        otherChargeDetails: rowData.otherChargeDetails || [],
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
        invoiceDate: baseInvoice.invoiceDate || '',
        periodStart: baseInvoice.periodStart || '',
        periodEnd: baseInvoice.periodEnd || '',
        submittedDate: baseInvoice.submittedDate || (new Date().toISOString().slice(0,10)),
        createdAt: new Date().toISOString(),
        comments: comments,
        leases: uniqueLeases,
        lease: uniqueLeases.join(', '),
        unitDetails: createdUnitDetails.slice()
      };

      // Quarterly leases: any additional periods added via "Add Period" get attached here,
      // each with its own From/To dates and its own per-unit Tax/Other/Amount breakdown —
      // separate from the registry's own (first) period above, and from state.invoices (which
      // only ever represents the first period), so existing per-unit/per-month coverage logic
      // elsewhere in the app is unaffected.
      if(_invoicePeriods.length > 0){
        registry.periods = _invoicePeriods.map(p => {
          const periodRowData = getUnitBreakdownRowsData(p.wrapId);
          const periodUnitDetails = p.units.map(uid => {
            const resolved = resolveInvoiceUnitLeaseInfo(uid, selectedLeases);
            const unitRecForDetail = (state.units||[]).find(u => (u.unitId||u.id||'').toString().trim() === uid.toString().trim());
            const r = periodRowData[uid] || {};
            const chargeAmount = (function(){ const n = parseCurrency(r.charge||''); return n===null ? '' : n.toFixed(2); })();
            const taxAmount = (function(){ const n = parseCurrency(r.tax||''); return n===null ? '' : n.toFixed(2); })();
            const otherAmount = (function(){ const n = parseCurrency(r.other||''); return n===null ? '' : n.toFixed(2); })();
            return {
              unit: uid,
              lease: resolved.lease || '',
              company: resolved.company || '',
              supplier: resolved.supplier || '',
              arrangement: resolved.arrangement || '',
              invoicing: resolved.invoicing || '',
              costCenter: unitRecForDetail ? (unitRecForDetail.costCenter||'') : '',
              tax: taxAmount,
              other: otherAmount,
              otherChargeDetails: r.otherChargeDetails || [],
              charge: chargeAmount
            };
          });
          return { fromDate: p.fromDate, toDate: p.toDate, unitDetails: periodUnitDetails };
        });
      }
      // Period 1's own declared sub-range (distinct from registry.periodStart/periodEnd, which
      // stays the invoice's overall declared period).
      if(_invoiceQuarterlyPeriod1Active){
        registry.period1From = _invoicePeriod1.fromDate || '';
        registry.period1To = _invoicePeriod1.toDate || '';
      }

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
    
    // Clear any active search filters on the lease/unit pickers and hide the (now empty)
    // lease detail table — form.reset() already unchecked the underlying checkboxes.
    const leaseSearchEl = qs('#invoiceLeaseSearch'); if(leaseSearchEl){ leaseSearchEl.value=''; leaseSearchEl.dispatchEvent(new Event('input')); }
    const unitSearchEl = qs('#invoiceUnitSearch'); if(unitSearchEl){ unitSearchEl.value=''; unitSearchEl.dispatchEvent(new Event('input')); }
    if(typeof renderInvoiceLeaseDetailTable === 'function') renderInvoiceLeaseDetailTable();

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
    if(typeof resetInvoiceQuarterlyPeriods === 'function') resetInvoiceQuarterlyPeriods();

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

// Refresh the unit picker and the informational lease detail table whenever the selected
// lease set changes. Company/Supplier/Arrangement/Invoicing are no longer mirrored into
// readonly form fields — that info is shown directly in the lease detail table instead.
function onInvoiceLeaseSelectionChange(){
  const selected = getSelectedInvoiceLeases();
  if(typeof syncInvoiceUnitOptions === 'function') syncInvoiceUnitOptions(selected);
  if(typeof renderInvoiceLeaseDetailTable === 'function') renderInvoiceLeaseDetailTable();
  // ensure the Submitted date is prefilled to today's date (predetermined actual date)
  const sub = qs('#invoiceSubmitted'); if(sub) sub.value = new Date().toISOString().slice(0,10);
  if(typeof updateInvoiceAddPeriodAvailability === 'function') updateInvoiceAddPeriodAvailability();
  if(typeof updateInvoiceQuarterlyPeriod1Mode === 'function') updateInvoiceQuarterlyPeriod1Mode();
}

// ========== Quarterly leases: multiple invoice periods per WD invoice ==========
// A lease invoiced quarterly is billed every 4 months and covers 3 separate periods per unit
// in that one invoice. "Add Period" (enabled only while a Quarterly-arrangement lease is
// selected) adds another full Tax/Other/Amount breakdown table with its own editable From/To
// sub-period, seeded with whichever units are currently checked at the moment it's clicked.
// Each period is independent after that — units can be individually removed from just one
// period. The form's own Period From/To fields stay put as the invoice's overall declared
// period (general information); every period table — including Period 1 — declares its own
// From/To sub-range, which must fall inside that overall range and never overlap another.
let _invoicePeriods = [];
let _invoicePeriodSeq = 0;
let _invoicePeriod1 = { fromDate: '', toDate: '', fromInputEl: null, toInputEl: null };
let _invoiceQuarterlyPeriod1Active = false;

function invoiceHasQuarterlyLeaseSelected(){
  const selectedLeases = getSelectedInvoiceLeases();
  return selectedLeases.some(lv => {
    const rec = (state.leases||[]).find(l => (l.leaseNumber||l.id||'').toString().trim().toLowerCase() === lv.toString().trim().toLowerCase());
    return rec && (rec.arrangement||'').toString().trim().toLowerCase() === 'quarterly';
  });
}

function updateInvoiceAddPeriodAvailability(){
  const btn = qs('#invoiceAddPeriodBtn'); if(!btn) return;
  const enabled = invoiceHasQuarterlyLeaseSelected();
  btn.disabled = !enabled;
  btn.style.opacity = enabled ? '1' : '0.5';
  btn.style.cursor = enabled ? 'pointer' : 'not-allowed';
  btn.style.background = enabled ? '' : '#e5e7eb';
  btn.style.color = enabled ? '' : '#9ca3af';
}

// Builds one period card's header row (title + From/To date inputs, optionally a Remove
// button) — shared by Period 1 and every additional period so they're all visually identical.
function buildInvoicePeriodCardHeader(opts){
  const headerRow = document.createElement('div');
  headerRow.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap;';
  const titleEl = document.createElement('strong'); titleEl.textContent = opts.label;
  const fromLabel = document.createElement('span'); fromLabel.className = 'small-muted'; fromLabel.textContent = 'From';
  const fromInput = document.createElement('input'); fromInput.type = 'date'; fromInput.value = opts.fromValue || '';
  const toLabel = document.createElement('span'); toLabel.className = 'small-muted'; toLabel.textContent = 'To';
  const toInput = document.createElement('input'); toInput.type = 'date'; toInput.value = opts.toValue || '';
  fromInput.addEventListener('input', () => { opts.onFromChange(fromInput.value); validateInvoicePeriodRanges(); });
  toInput.addEventListener('input', () => { opts.onToChange(toInput.value); validateInvoicePeriodRanges(); });
  headerRow.appendChild(titleEl);
  headerRow.appendChild(fromLabel); headerRow.appendChild(fromInput);
  headerRow.appendChild(toLabel); headerRow.appendChild(toInput);
  if(opts.onRemove){
    const removePeriodBtn = document.createElement('button');
    removePeriodBtn.type = 'button';
    removePeriodBtn.textContent = 'Remove Period';
    removePeriodBtn.style.cssText = 'margin-left:auto;color:#dc2626;';
    removePeriodBtn.addEventListener('click', opts.onRemove);
    headerRow.appendChild(removePeriodBtn);
  }
  return { headerRow, fromInput, toInput };
}

// While a quarterly lease AND at least one unit are selected, the plain default breakdown
// table is wrapped in a "Period 1" card — identical in style to the cards "Add Period"
// creates, with its own dedicated From/To sub-period (separate from the invoice's overall
// declared From/To above). Leaving quarterly mode puts the table back exactly where it was.
function updateInvoiceQuarterlyPeriod1Mode(){
  const shouldBeActive = invoiceHasQuarterlyLeaseSelected() && getSelectedInvoiceUnits().length > 0;
  if(shouldBeActive === _invoiceQuarterlyPeriod1Active) return;
  _invoiceQuarterlyPeriod1Active = shouldBeActive;

  const breakdownEl = qs('#invoiceUnitBreakdown');
  const breakdownAnchor = qs('#invoiceUnitBreakdownAnchor');
  if(!breakdownEl || !breakdownAnchor) return;

  if(shouldBeActive){
    let periodCard = qs('#invoicePeriod1Card');
    if(!periodCard){
      periodCard = document.createElement('div');
      periodCard.id = 'invoicePeriod1Card';
      periodCard.className = 'invoice-period-block';
      periodCard.style.cssText = 'border:1px solid #e6e9ee;border-radius:8px;padding:10px;margin-top:6px;background:#fafbfc;';
      const { headerRow, fromInput, toInput } = buildInvoicePeriodCardHeader({
        label: 'Period 1',
        fromValue: _invoicePeriod1.fromDate,
        toValue: _invoicePeriod1.toDate,
        onFromChange: (v) => { _invoicePeriod1.fromDate = v; if(typeof renderInvoiceUnitBreakdown === 'function') renderInvoiceUnitBreakdown(); },
        onToChange: (v) => { _invoicePeriod1.toDate = v; }
      });
      _invoicePeriod1.fromInputEl = fromInput;
      _invoicePeriod1.toInputEl = toInput;
      periodCard.appendChild(headerRow);
      breakdownAnchor.parentNode.insertBefore(periodCard, breakdownAnchor);
    }
    periodCard.appendChild(breakdownEl);
    updateInvoicePeriodDateBounds();
    validateInvoicePeriodRanges();
  } else {
    breakdownAnchor.parentNode.insertBefore(breakdownEl, breakdownAnchor.nextSibling);
    const periodCard = qs('#invoicePeriod1Card');
    if(periodCard) periodCard.remove();
    _invoicePeriod1.fromInputEl = null;
    _invoicePeriod1.toInputEl = null;
  }
}

function renderInvoicePeriodTable(period, seed){
  renderUnitBreakdownTable(period.wrapId, period.units, null, seed, {
    showEmptyRow: true,
    disputeFromDate: period.fromDate || '',
    onRemoveUnit: (uid) => {
      period.units = period.units.filter(u => u !== uid);
      renderInvoicePeriodTable(period);
    }
  });
  updateQuarterlyPeriodsAggregateTotal();
}

function renderInvoicePeriodBlock(period, seed){
  const container = qs('#invoicePeriodsContainer'); if(!container) return;
  const block = document.createElement('div');
  block.className = 'invoice-period-block';
  block.dataset.periodId = period.id;
  block.style.cssText = 'border:1px solid #e6e9ee;border-radius:8px;padding:10px;margin-top:10px;background:#fafbfc;';

  const { headerRow, fromInput, toInput } = buildInvoicePeriodCardHeader({
    label: 'Additional Period',
    fromValue: period.fromDate,
    toValue: period.toDate,
    onFromChange: (v) => { period.fromDate = v; renderInvoicePeriodTable(period); },
    onToChange: (v) => { period.toDate = v; },
    onRemove: () => {
      _invoicePeriods = _invoicePeriods.filter(p => p.id !== period.id);
      block.remove();
      updateQuarterlyPeriodsAggregateTotal();
      validateInvoicePeriodRanges();
    }
  });
  period.fromInputEl = fromInput;
  period.toInputEl = toInput;
  block.appendChild(headerRow);

  const tableWrap = document.createElement('div'); tableWrap.id = period.wrapId; tableWrap.className = 'invoice-unit-breakdown';
  block.appendChild(tableWrap);
  container.appendChild(block);

  renderInvoicePeriodTable(period, seed);
  updateInvoicePeriodDateBounds();
  validateInvoicePeriodRanges();
}

// Every period's date inputs are bounded (native min/max) by the invoice's own overall
// declared From/To — the browser's date picker itself won't offer a date outside that range.
// Deliberately NOT setting native HTML5 min/max on these date inputs: a real click on the
// submit button runs the browser's own constraint validation before our 'submit' handler ever
// sees the event, and if any value violated min/max at that moment, the browser would silently
// block submission and paint its own native invalid styling — a second, uncontrollable "red"
// on top of (and inconsistent with) our own validateInvoicePeriodRanges() below. All the actual
// out-of-range/overlap enforcement already happens there and at submit time, so native min/max
// would only add a confusing, redundant failure mode. Kept as a no-op since it's still called
// from a few places below in case bounds-driven UI is wanted here again later.
function updateInvoicePeriodDateBounds(){
}

function getActiveInvoicePeriodEntries(){
  const list = [];
  if(_invoiceQuarterlyPeriod1Active) list.push({ label: 'Period 1', period: _invoicePeriod1 });
  _invoicePeriods.forEach((p, i) => list.push({ label: 'Period ' + (i + 2), period: p }));
  return list;
}

// Flags (red border) any period whose From/To falls outside the invoice's overall declared
// period, or overlaps another period's range — the hard backstop behind the native min/max
// bounds above (which a manually-typed date could otherwise bypass).
function validateInvoicePeriodRanges(){
  const entries = getActiveInvoicePeriodEntries();
  if(entries.length === 0) return true;
  const declaredFrom = (qs('#invoicePeriodStart')||{}).value || '';
  const declaredTo = (qs('#invoicePeriodEnd')||{}).value || '';
  entries.forEach(({period}) => {
    if(period.fromInputEl) period.fromInputEl.style.borderColor = '';
    if(period.toInputEl) period.toInputEl.style.borderColor = '';
  });
  let allValid = true;
  entries.forEach(({period}, idx) => {
    if(!period.fromDate || !period.toDate) return;
    let invalid = false;
    if(period.fromDate > period.toDate) invalid = true;
    if(declaredFrom && period.fromDate < declaredFrom) invalid = true;
    if(declaredTo && period.toDate > declaredTo) invalid = true;
    entries.forEach((other, oidx) => {
      if(oidx === idx || !other.period.fromDate || !other.period.toDate) return;
      const overlaps = period.fromDate <= other.period.toDate && other.period.fromDate <= period.toDate;
      if(overlaps) invalid = true;
    });
    if(invalid){
      allValid = false;
      if(period.fromInputEl) period.fromInputEl.style.borderColor = '#dc2626';
      if(period.toInputEl) period.toInputEl.style.borderColor = '#dc2626';
    }
  });
  return allValid;
}

function updateQuarterlyPeriodsAggregateTotal(){
  const el = qs('#invoicePeriodsAggregateTotal'); if(!el) return;
  if(!_invoiceQuarterlyPeriod1Active){ el.textContent = ''; return; }
  const wrapIds = ['invoiceUnitBreakdown'].concat(_invoicePeriods.map(p => p.wrapId));
  let sum = 0;
  wrapIds.forEach(wrapId => {
    const wrap = qs('#' + wrapId); if(!wrap) return;
    wrap.querySelectorAll('.unit-breakdown-row').forEach(row => {
      const c = row.querySelector('.ub-charge'); const t = row.querySelector('.ub-tax'); const o = row.querySelector('.ub-other');
      sum += (parseCurrency(c ? c.value : '') || 0) + (parseCurrency(t ? t.value : '') || 0) + (parseCurrency(o ? o.value : '') || 0);
    });
  });
  const amountField = qs('#invoiceAmount');
  const declared = parseCurrency(amountField ? amountField.value : '');
  const matches = declared !== null && Math.round(sum*100) === Math.round(declared*100);
  el.textContent = 'Total across all periods (Tax + Other Charges + Amount): ' + formatCurrency(sum.toFixed(2)) + (declared !== null ? ' / declared ' + formatCurrency(declared.toFixed(2)) : '');
  el.style.color = matches ? '#15803d' : '#dc2626';
  el.style.fontWeight = '700';

  // Reflect the AGGREGATE match on every individual period table's own total bar too, so a
  // table isn't stuck red just because it alone doesn't equal the full invoice amount.
  wrapIds.forEach(wrapId => {
    const wrap = qs('#' + wrapId); if(!wrap) return;
    const totalEl = wrap.querySelector('.unit-breakdown-total-text'); if(!totalEl) return;
    totalEl.style.color = matches ? '#15803d' : '#dc2626';
    wrap.dataset.matches = matches ? 'true' : 'false';
  });
}

function invoiceQuarterlyPeriodsMatchDeclared(){
  if(!_invoiceQuarterlyPeriod1Active) return true;
  let sum = 0;
  ['invoiceUnitBreakdown'].concat(_invoicePeriods.map(p => p.wrapId)).forEach(wrapId => {
    const wrap = qs('#' + wrapId); if(!wrap) return;
    wrap.querySelectorAll('.unit-breakdown-row').forEach(row => {
      const c = row.querySelector('.ub-charge'); const t = row.querySelector('.ub-tax'); const o = row.querySelector('.ub-other');
      sum += (parseCurrency(c ? c.value : '') || 0) + (parseCurrency(t ? t.value : '') || 0) + (parseCurrency(o ? o.value : '') || 0);
    });
  });
  const declared = parseCurrency((qs('#invoiceAmount')||{}).value || '');
  return declared !== null && Math.round(sum*100) === Math.round(declared*100);
}

function addDaysToDateStr(dateStr, days){
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0,10);
}

// The periods together must cover every day of the invoice's overall declared period, with no
// gaps — checked only at submit time (there will naturally be gaps while still adding periods).
function invoicePeriodsCoverFullDeclaredRange(){
  if(!_invoiceQuarterlyPeriod1Active) return true;
  const declaredFrom = (qs('#invoicePeriodStart')||{}).value || '';
  const declaredTo = (qs('#invoicePeriodEnd')||{}).value || '';
  if(!declaredFrom || !declaredTo) return true;
  const entries = getActiveInvoicePeriodEntries().map(e => e.period).filter(p => p.fromDate && p.toDate);
  if(entries.length === 0) return true;
  const sorted = entries.slice().sort((a,b) => a.fromDate < b.fromDate ? -1 : (a.fromDate > b.fromDate ? 1 : 0));
  if(sorted[0].fromDate !== declaredFrom) return false;
  for(let i = 0; i < sorted.length - 1; i++){
    if(addDaysToDateStr(sorted[i].toDate, 1) !== sorted[i+1].fromDate) return false;
  }
  if(sorted[sorted.length - 1].toDate !== declaredTo) return false;
  return true;
}

function resetInvoiceQuarterlyPeriods(){
  _invoicePeriods = [];
  _invoicePeriod1 = { fromDate: '', toDate: '', fromInputEl: null, toInputEl: null };
  const container = qs('#invoicePeriodsContainer'); if(container) container.innerHTML = '';
  const totalEl = qs('#invoicePeriodsAggregateTotal'); if(totalEl) totalEl.textContent = '';
  updateInvoiceAddPeriodAvailability();
  updateInvoiceQuarterlyPeriod1Mode();
}

const invoicePeriodStartEl = qs('#invoicePeriodStart');
const invoicePeriodEndEl = qs('#invoicePeriodEnd');
if(invoicePeriodStartEl) invoicePeriodStartEl.addEventListener('input', () => {
  updateInvoicePeriodDateBounds(); validateInvoicePeriodRanges();
  // Re-render so the "possible dispute" red highlight (unit returned on/after this From Date)
  // updates live as the operator fills the date in — existing entered Tax/Other/Amount values
  // are preserved (renderUnitBreakdownTable reads them back off the DOM before rebuilding).
  if(typeof renderInvoiceUnitBreakdown === 'function') renderInvoiceUnitBreakdown();
});
if(invoicePeriodEndEl) invoicePeriodEndEl.addEventListener('input', () => { updateInvoicePeriodDateBounds(); validateInvoicePeriodRanges(); });

const invoiceAddPeriodBtn = qs('#invoiceAddPeriodBtn');
if(invoiceAddPeriodBtn){
  invoiceAddPeriodBtn.addEventListener('click', () => {
    const units = getSelectedInvoiceUnits();
    if(units.length === 0){ alert('Select the invoice units first, then Add Period.'); return; }
    _invoicePeriodSeq++;
    const period = { id: 'p' + _invoicePeriodSeq, wrapId: 'invoicePeriodBreakdown_' + _invoicePeriodSeq, fromDate: '', toDate: '', units: units.slice() };
    _invoicePeriods.push(period);
    renderInvoicePeriodBlock(period);
  });
}
updateInvoiceAddPeriodAvailability();

// Always-visible box + search input (same format as the Registry Edit modal's lease/unit
// pickers) — no more toggle button / floating dropdown-panel.
function syncInvoiceLeaseOptions(selectedValues){
  selectedValues = Array.isArray(selectedValues) ? selectedValues.map(s=>String(s)) : (selectedValues ? [String(selectedValues)] : getSelectedInvoiceLeases());
  const panel = qs('#invoiceLeasePanel');
  if(!panel) return;

  const leases = (state.leases || []).filter(l => {
    const status = (l.status || 'Enabled').toString().toLowerCase();
    return status !== 'disabled';
  });

  panel.innerHTML = '';
  if(leases.length === 0){ const none = document.createElement('div'); none.className = 'small-muted'; none.textContent = '(no leases available)'; panel.appendChild(none); return; }

  leases.forEach(l => {
    const val = (l.leaseNumber || l.id || '').toString();
    const row = document.createElement('label');
    row.className = 'lease-checkbox-row';
    row.setAttribute('data-lease-id', val.toLowerCase());
    row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 4px;cursor:pointer;border-radius:4px;';
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.name = 'invoiceLease'; cb.value = val; cb.style.cursor = 'pointer';
    if(selectedValues.length && selectedValues.indexOf(val) !== -1) cb.checked = true;
    const text = document.createElement('span'); text.textContent = val; text.style.fontSize = '13px';
    cb.addEventListener('change', ()=>{ onInvoiceLeaseSelectionChange(); });
    row.appendChild(cb); row.appendChild(text); panel.appendChild(row);
  });

  // Wire the (static) search box once; it filters whatever rows are currently rendered
  const searchBox = qs('#invoiceLeaseSearch');
  if(searchBox && !searchBox.dataset.wired){
    searchBox.dataset.wired = 'true';
    searchBox.addEventListener('input', () => {
      const term = searchBox.value.toLowerCase().trim();
      const rows = qs('#invoiceLeasePanel') ? qs('#invoiceLeasePanel').querySelectorAll('.lease-checkbox-row') : [];
      rows.forEach(row => {
        const lid = row.getAttribute('data-lease-id') || '';
        row.style.display = (term === '' || lid.includes(term)) ? 'flex' : 'none';
      });
    });
  }
  if(searchBox && searchBox.value){
    searchBox.dispatchEvent(new Event('input'));
  }

  // Wire the (static) Clear button once
  const clearBtn = qs('#invoiceLeaseClearBtn');
  if(clearBtn && !clearBtn.dataset.wired){
    clearBtn.dataset.wired = 'true';
    clearBtn.addEventListener('click', () => {
      const p = qs('#invoiceLeasePanel'); if(!p) return;
      p.querySelectorAll('input[type="checkbox"][name="invoiceLease"]').forEach(cb => cb.checked = false);
      onInvoiceLeaseSelectionChange();
    });
  }
}
// Informational-only table showing full details of the currently selected leases
// (Lease/Company/Supplier/Arrangement/Invoicing/Status) — no inputs, just for reference.
function renderInvoiceLeaseDetailTable(){
  const wrap = qs('#invoiceLeaseDetail'); if(!wrap) return;
  const selected = getSelectedInvoiceLeases();
  const leaseRecs = selected.map(val => (state.leases||[]).find(l => (l.leaseNumber||l.id) === val)).filter(Boolean);

  wrap.innerHTML = '';
  if(leaseRecs.length === 0){ wrap.style.display = 'none'; return; }

  const columns = [
    { key:'lease', label:'Lease', width:120, get:l => l.leaseNumber||l.id||'' },
    { key:'company', label:'Company', width:150, get:l => l.company||'' },
    { key:'supplier', label:'Supplier', width:150, get:l => l.supplier||'' },
    { key:'arrangement', label:'Arrangement', width:130, get:l => l.arrangement||'' },
    { key:'invoicing', label:'Invoicing', width:110, get:l => l.invoicing||'' },
    { key:'status', label:'Status', width:90, get:l => l.status||'Enabled' }
  ];

  const header = document.createElement('div');
  header.className = 'invoice-lease-detail-header';
  header.style.cssText = 'display:flex;gap:8px;font-weight:600;font-size:12px;color:#374151;padding:4px 0;border-bottom:2px solid #e6e9ee;background:#fff;';
  columns.forEach(col => {
    const d = document.createElement('div'); d.textContent = col.label; d.style.cssText = `flex:0 0 ${getColWidth(wrap, col.key, col.width)}px;`;
    wireColumnAutoFit(d, wrap, col.key, col.label, () => leaseRecs.map(col.get), () => renderInvoiceLeaseDetailTable());
    header.appendChild(d);
  });

  // Header lives inside the same scrollable box as the rows (pinned to the top via
  // position:sticky) instead of as a separate sibling — this locks titles to their column's
  // data natively in both scroll directions, with no drift, since resizing/scrolling only
  // ever moves the one shared box.
  const rowsContainer = document.createElement('div');
  rowsContainer.className = 'invoice-lease-detail-rows';
  wrap.appendChild(rowsContainer);
  rowsContainer.appendChild(header);

  // A lease whose Supplier differs from the first selected lease's Supplier gets flagged —
  // mixing suppliers under one WD invoice is unusual and worth a visual heads-up.
  const referenceSupplier = (leaseRecs[0] && leaseRecs[0].supplier || '').toString().trim().toLowerCase();

  leaseRecs.forEach((l, idx) => {
    const supplierMismatch = idx > 0 && referenceSupplier !== '' && (l.supplier||'').toString().trim().toLowerCase() !== referenceSupplier;
    const row = document.createElement('div');
    row.className = 'registry-unit-detail-row';
    row.style.cssText = 'display:flex;gap:8px;align-items:center;padding:4px 0;border-bottom:1px solid #f0f0f0;cursor:pointer;';
    if(supplierMismatch){
      row.style.background = '#fef9c3';
      row.title = 'This lease has a different Supplier than the first selected lease';
    }
    columns.forEach((col, colIdx) => {
      const c = document.createElement('div'); c.style.cssText = `flex:0 0 ${getColWidth(wrap, col.key, col.width)}px;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;`;
      if(supplierMismatch && colIdx === 0){
        c.textContent = '⚠ ' + col.get(l);
        c.style.color = '#92400e';
        c.style.fontWeight = '600';
      } else {
        c.textContent = col.get(l);
      }
      row.appendChild(c);
    });
    row.addEventListener('click', () => {
      rowsContainer.querySelectorAll('.registry-unit-detail-row').forEach(rr => rr.classList.remove('selected'));
      row.classList.add('selected');
    });
    rowsContainer.appendChild(row);
  });

  wrap.style.display = 'block';
}

// Always-visible box + search input (same format as the Registry Edit modal's unit picker),
// with Select all/Clear kept as a convenience. No more toggle/floating-panel or "Add Units"
// confirm step — the breakdown table below already live-updates on every checkbox change.
// Tracks the order units were actually checked in the Invoice Registration picker — the
// picker itself is sorted (active units first, then alphabetical), but operators need the
// breakdown table and the saved invoice/registry to keep the order units were added in, since
// that's the order line items appear on the physical invoice (easier to copy/paste amounts).
let _invoiceUnitCheckOrder = [];

function syncInvoiceUnitOptions(leaseVal, selectedValues){
  // selectedValues: optional array of values to pre-check
  // leaseVal: optional lease number, or an array of lease numbers (union filter)
  selectedValues = Array.isArray(selectedValues) ? selectedValues.map(s=>String(s)) : [];
  // Every call rebuilds the panel from scratch with only selectedValues pre-checked (nothing
  // else survives the rebuild today), so the check-order tracker resets to match exactly.
  _invoiceUnitCheckOrder = selectedValues.slice();
  const panel = qs('#invoiceUnitPanel');
  const leaseFilter = Array.isArray(leaseVal) ? leaseVal.filter(Boolean) : (leaseVal ? [leaseVal] : []);
  const list = leaseFilter.length === 0 ? (state.units || []).slice() : (state.units || []).filter(u => leaseFilter.indexOf(u.lease) !== -1);

  if(!panel) return;
  panel.innerHTML = '';
  if(list.length === 0){ const none = document.createElement('div'); none.className = 'small-muted'; none.textContent = '(no units available)'; panel.appendChild(none); return; }

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
    const row = document.createElement('label');
    row.className = 'unit-checkbox-row';
    row.setAttribute('data-unit-id', val.toLowerCase());
    row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 4px;cursor:pointer;border-radius:4px;';
    if(isDisabled) row.style.background = '#fee2e2';
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.name = 'invoiceUnit'; cb.value = val; cb.style.cursor = 'pointer';
    if(selectedValues.length && selectedValues.indexOf(val) !== -1) cb.checked = true;
    const text = document.createElement('span'); text.style.fontSize = '13px'; text.textContent = val + (isDisabled ? ' (Disabled)' : '');
    if(isDisabled) text.style.color = '#b91c1c';
    cb.addEventListener('change', ()=>{
      if(cb.checked){
        if(_invoiceUnitCheckOrder.indexOf(val) === -1) _invoiceUnitCheckOrder.push(val);
      } else {
        const orderIdx = _invoiceUnitCheckOrder.indexOf(val);
        if(orderIdx !== -1) _invoiceUnitCheckOrder.splice(orderIdx, 1);
      }
      refreshInvoiceBreakdownIfVisible();
    });
    row.appendChild(cb); row.appendChild(text); panel.appendChild(row);
  });

  // Wire the (static) search box once; it filters whatever rows are currently rendered
  const searchBox = qs('#invoiceUnitSearch');
  if(searchBox && !searchBox.dataset.wired){
    searchBox.dataset.wired = 'true';
    searchBox.addEventListener('input', () => {
      const term = searchBox.value.toLowerCase().trim();
      const rows = qs('#invoiceUnitPanel') ? qs('#invoiceUnitPanel').querySelectorAll('.unit-checkbox-row') : [];
      rows.forEach(row => {
        const uid = row.getAttribute('data-unit-id') || '';
        row.style.display = (term === '' || uid.includes(term)) ? 'flex' : 'none';
      });
    });
  }
  if(searchBox && searchBox.value){
    searchBox.dispatchEvent(new Event('input'));
  }

  // Wire the (static) Select all button once; only checks whatever rows are currently visible
  const selectAllBtn = qs('#invoiceUnitSelectAllBtn');
  if(selectAllBtn && !selectAllBtn.dataset.wired){
    selectAllBtn.dataset.wired = 'true';
    selectAllBtn.addEventListener('click', () => {
      const p = qs('#invoiceUnitPanel'); if(!p) return;
      p.querySelectorAll('.unit-checkbox-row').forEach(row => {
        if(row.style.display !== 'none'){
          const cb = row.querySelector('input[type="checkbox"][name="invoiceUnit"]');
          if(cb && !cb.checked){
            cb.checked = true;
            if(_invoiceUnitCheckOrder.indexOf(cb.value) === -1) _invoiceUnitCheckOrder.push(cb.value);
          }
        }
      });
      refreshInvoiceBreakdownIfVisible();
    });
  }

  // Wire the (static) Clear button once
  const unitClearBtn = qs('#invoiceUnitClearBtn');
  if(unitClearBtn && !unitClearBtn.dataset.wired){
    unitClearBtn.dataset.wired = 'true';
    unitClearBtn.addEventListener('click', () => {
      const p = qs('#invoiceUnitPanel'); if(!p) return;
      p.querySelectorAll('input[type="checkbox"][name="invoiceUnit"]').forEach(cb => cb.checked = false);
      _invoiceUnitCheckOrder = [];
      refreshInvoiceBreakdownIfVisible();
    });
  }
}

function getSelectedInvoiceUnits(){
  const panel = qs('#invoiceUnitPanel'); if(!panel) return [];
  const checked = Array.from(panel.querySelectorAll('input[type="checkbox"][name="invoiceUnit"]:checked')).map(cb => cb.value);
  const checkedSet = new Set(checked);
  // Return in the order units were actually checked (see _invoiceUnitCheckOrder) rather than
  // the picker's own display order — any checked unit the tracker missed is appended at the end.
  const ordered = _invoiceUnitCheckOrder.filter(v => checkedSet.has(v));
  checked.forEach(v => { if(ordered.indexOf(v) === -1) ordered.push(v); });
  return ordered;
}

// --- Excel-style "double-click a column header to fit its widest content" ---
// Shared by every flex-based table in the app (unit breakdown, lease detail, etc). Custom
// widths are stored per table instance (on the wrap element's dataset), so resizing one
// table's columns never affects another table that happens to share column keys.
let _measureCanvasCtx = null;
function measureTextWidth(text, font){
  if(!_measureCanvasCtx){ _measureCanvasCtx = document.createElement('canvas').getContext('2d'); }
  _measureCanvasCtx.font = font || '12px Arial, sans-serif';
  return _measureCanvasCtx.measureText(text === null || text === undefined ? '' : String(text)).width;
}
function getColWidth(wrap, key, defaultWidth){
  const stored = wrap.dataset['colw_' + key];
  const n = stored ? parseInt(stored, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : defaultWidth;
}
function setColWidth(wrap, key, width){
  wrap.dataset['colw_' + key] = String(Math.round(width));
}
// Wires a header cell so double-clicking it resizes the column to fit its widest currently
// visible content (label included), then re-renders via `rerenderFn`.
function wireColumnAutoFit(headerCell, wrap, colKey, label, getValuesFn, rerenderFn){
  headerCell.style.cursor = 'pointer';
  headerCell.style.userSelect = 'none';
  headerCell.title = (headerCell.title ? headerCell.title + ' — ' : '') + 'Double-click to fit column width';
  headerCell.addEventListener('dblclick', (e) => {
    e.preventDefault(); // otherwise the browser's native "double-click selects a word" kicks in
    e.stopPropagation();
    let maxWidth = measureTextWidth(label, '600 12px Arial, sans-serif');
    getValuesFn().forEach(v => {
      const w = measureTextWidth(v, '12px Arial, sans-serif');
      if(w > maxWidth) maxWidth = w;
    });
    setColWidth(wrap, colKey, maxWidth + 26);
    rerenderFn();
  });
}

// Grows a column's width directly on the live DOM (header cell + every rendered cell/input
// sharing that column) without a full table re-render, so the user's typing/focus/cursor
// position in an input is never interrupted. Used for the bounded auto-grow-while-typing
// behavior; a full, exact fit is still only available via the double-click column auto-fit.
function growColumnLive(wrap, colKey, newWidth){
  setColWidth(wrap, colKey, newWidth);
  const px = newWidth + 'px';
  const header = wrap.querySelector('[data-col-key="' + colKey + '"]');
  if(header) header.style.flexBasis = px;
  wrap.querySelectorAll('.ub-' + colKey).forEach(el => { el.style.flexBasis = px; });
}
// Bounded auto-grow: if the input's current value needs more room than the column currently
// has, grow it — but only up to a modest ceiling (a multiple of the column's own default
// width) so one column can't dominate the table just from typing; double-click still gives
// the fully accurate fit beyond that.
function autoGrowAmountColumn(wrap, colKey, input, defaultWidth){
  const needed = measureTextWidth(input.value, '12px Arial, sans-serif') + 22;
  const current = getColWidth(wrap, colKey, defaultWidth);
  if(needed <= current) return;
  const cap = Math.round(defaultWidth * 1.6);
  growColumnLive(wrap, colKey, Math.min(needed, cap));
}

// --- Generic sortable Company/UnitId/Lease/Cost Center + Tax/Charge breakdown table ---
// Shared by the invoice creation form and the registry edit modal (each has its own
// container id and its own declared-Amount field to validate against). Sort state and the
// declared-amount field id are stashed as data-* attributes on the wrap element itself, so
// multiple independent tables can coexist without shared JS state.
const UNIT_BREAKDOWN_COLUMNS = [
  { key:'company', label:'Company', width:150, get: (u,uid) => u ? (u.company||'') : '' },
  { key:'unitId', label:'UnitId', width:110, get: (u,uid) => uid },
  { key:'lease', label:'Lease', width:110, get: (u,uid) => u ? (u.lease||'') : '' },
  { key:'costCenter', label:'Cost Center', width:120, get: (u,uid) => u ? (u.costCenter||'') : '' }
];

// Populates a subcharge's Name <select> from the Developer tab's "Other Charge Types" list.
// If the row's current value isn't in that list (e.g. an option was removed after this
// subcharge was named), it's kept as an extra option instead of being silently dropped.
function populateOtherChargeSelect(selectEl, currentValue){
  selectEl.innerHTML = '<option value="">(select charge type)</option>';
  (state.meta.devOtherCharges || []).forEach(v => {
    const opt = document.createElement('option'); opt.value = v; opt.textContent = v; selectEl.appendChild(opt);
  });
  if(currentValue && (state.meta.devOtherCharges || []).indexOf(currentValue) === -1){
    const opt = document.createElement('option'); opt.value = currentValue; opt.textContent = currentValue + ' (not in list)'; selectEl.appendChild(opt);
  }
  selectEl.value = currentValue || '';
}

function getUnitBreakdownRowsData(wrapId){
  const data = {};
  const wrap = qs('#' + wrapId); if(!wrap) return data;
  wrap.querySelectorAll('.unit-breakdown-row').forEach(row => {
    const uid = row.dataset.unitId; if(!uid) return;
    const chargeInput = row.querySelector('.ub-charge');
    const taxInput = row.querySelector('.ub-tax');
    const otherInput = row.querySelector('.ub-other');
    let otherChargeDetails = [];
    try{ otherChargeDetails = JSON.parse(row.dataset.otherChargeDetails || '[]'); }catch(e){ otherChargeDetails = []; }
    if(!Array.isArray(otherChargeDetails)) otherChargeDetails = [];
    data[uid] = { charge: chargeInput ? chargeInput.value : '', tax: taxInput ? taxInput.value : '', other: otherInput ? otherInput.value : '', otherChargeDetails };
  });
  return data;
}

// Per-row informational total = Tax + Other Charges + Amount for that one unit.
function updateUnitBreakdownRowTotal(row){
  const totalEl = row.querySelector('.ub-row-total'); if(!totalEl) return;
  const taxInput = row.querySelector('.ub-tax');
  const otherInput = row.querySelector('.ub-other');
  const chargeInput = row.querySelector('.ub-charge');
  const sum = (parseCurrency(taxInput ? taxInput.value : '') || 0) + (parseCurrency(otherInput ? otherInput.value : '') || 0) + (parseCurrency(chargeInput ? chargeInput.value : '') || 0);
  totalEl.textContent = formatCurrency(sum.toFixed(2));
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
      const d = document.createElement('div'); d.textContent = col.label; d.style.cssText = `flex:1 0 ${getColWidth(wrap, col.key, col.width)}px;`; header.appendChild(d);
    });
    [['tax','Tax',110],['other','Other Charges',120],['charge','Amount',110],['rowTotal','Total Charge',110]].forEach(([key,label,w]) => {
      const d = document.createElement('div'); d.textContent = label; d.style.cssText = `flex:0 0 ${getColWidth(wrap, key, w)}px;`; header.appendChild(d);
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
  const AMOUNT_SORT_KEYS = ['tax','other','charge','rowTotal'];
  const getAmountSortValue = (uid, key) => {
    const prior = existing[uid] || seedData[uid] || {};
    if(key === 'rowTotal') return (parseCurrency(prior.tax||'')||0) + (parseCurrency(prior.other||'')||0) + (parseCurrency(prior.charge||'')||0);
    return parseCurrency(prior[key]||'') || 0;
  };
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
    } else if(AMOUNT_SORT_KEYS.indexOf(sortCol) !== -1){
      rows.sort((a,b) => {
        const av = getAmountSortValue(a.uid, sortCol), bv = getAmountSortValue(b.uid, sortCol);
        return sortDir === 'asc' ? av - bv : bv - av;
      });
    }
  }

  wrap.innerHTML = '';
  const header = document.createElement('div');
  header.className = 'unit-breakdown-header';
  header.style.cssText = 'display:flex;gap:8px;font-weight:600;font-size:12px;color:#374151;padding:4px 0;border-bottom:2px solid #e6e9ee;background:#fff;';
  UNIT_BREAKDOWN_COLUMNS.forEach(col => {
    const d = document.createElement('div');
    d.textContent = col.label + (sortCol === col.key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '');
    d.style.cssText = `flex:1 0 ${getColWidth(wrap, col.key, col.width)}px;cursor:pointer;user-select:none;`;
    d.title = 'Click to sort';
    d.addEventListener('click', ()=>{
      const newDir = (wrap.dataset.sortCol === col.key && wrap.dataset.sortDir === 'asc') ? 'desc' : 'asc';
      wrap.dataset.sortCol = col.key; wrap.dataset.sortDir = newDir;
      renderUnitBreakdownTable(wrapId, unitIds, amountFieldId, null);
    });
    wireColumnAutoFit(d, wrap, col.key, col.label, () => rows.map(({uid, unitRec}) => col.get(unitRec, uid)), () => renderUnitBreakdownTable(wrapId, unitIds, amountFieldId, null));
    header.appendChild(d);
  });
  [['tax','Tax',110],['other','Other Charges',120],['charge','Amount',110],['rowTotal','Total Charge',110]].forEach(([key,label,w]) => {
    const d = document.createElement('div');
    d.textContent = label + (sortCol === key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '');
    d.style.cssText = `flex:0 0 ${getColWidth(wrap, key, w)}px;cursor:pointer;user-select:none;`;
    d.title = 'Click to sort';
    d.dataset.colKey = key;
    d.addEventListener('click', ()=>{
      const newDir = (wrap.dataset.sortCol === key && wrap.dataset.sortDir === 'asc') ? 'desc' : 'asc';
      wrap.dataset.sortCol = key; wrap.dataset.sortDir = newDir;
      renderUnitBreakdownTable(wrapId, unitIds, amountFieldId, null);
    });
    if(key !== 'rowTotal'){
      wireColumnAutoFit(d, wrap, key, label, () => Array.from(wrap.querySelectorAll('.ub-' + key)).map(inp => inp.value), () => renderUnitBreakdownTable(wrapId, unitIds, amountFieldId, null));
    }
    header.appendChild(d);
  });

  // Header lives inside the same scrollable box as the rows (pinned to the top via
  // position:sticky) instead of as a separate sibling kept in sync via JS — this locks
  // titles to their column's data natively in both scroll directions, with zero drift,
  // since resizing/scrolling now only ever moves a single shared box.
  const rowsContainer = document.createElement('div');
  rowsContainer.className = 'unit-breakdown-rows';
  wrap.appendChild(rowsContainer);
  rowsContainer.appendChild(header);

  // Same "should this probably be disputed?" signal used on the Invoice Dispute Tracking screens
  // (computeUnitReturnDisputeFlag) — opt-in via opts.disputeFromDate so this stays a no-op for
  // every OTHER caller of this shared table (Registry Edit included). When the invoice being
  // registered has a From Date entered, a unit that was still Disabled at or after that date
  // (never returned, or returned on/after it) gets flagged here too — so the operator can catch
  // a likely dispute candidate at registration time, before it ever reaches the Dispute tab.
  const disputeFromDate = opts && opts.disputeFromDate;

  rows.forEach(({uid, unitRec}, rowIdx) => {
    const row = document.createElement('div'); row.className = 'unit-breakdown-row'; row.dataset.unitId = uid;
    row.style.cssText = 'display:flex;gap:8px;align-items:center;padding:4px 0;border-bottom:1px solid #f0f0f0;';
    // Zebra striping so a row stays easy to track across all its columns while entering data —
    // via a CSS class (not inline style) so hover/selected highlighting still overrides it.
    row.classList.add(rowIdx % 2 === 0 ? 'unit-breakdown-row-even' : 'unit-breakdown-row-odd');

    const disputeFlag = (disputeFromDate && unitRec) ? computeUnitReturnDisputeFlag(unitRec, disputeFromDate) : { flagged: false };
    if(disputeFlag.flagged){
      row.style.background = '#fee2e2';
      row.title = disputeFlag.stillDisabled
        ? `Possible dispute — still Disabled (not yet returned) since ${formatDate(disputeFlag.disabledFrom) || disputeFlag.disabledFrom}`
        : `Possible dispute — Disabled ${formatDate(disputeFlag.disabledFrom) || disputeFlag.disabledFrom} → Returned ${formatDate(disputeFlag.returnedDate) || disputeFlag.returnedDate}, on/after this invoice's From Date`;
    }

    const mkCell = (text, w) => { const d = document.createElement('div'); d.textContent = text; d.style.cssText = `flex:1 0 ${w}px;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;`; return d; };
    UNIT_BREAKDOWN_COLUMNS.forEach(col => {
      const cell = mkCell(col.get(unitRec, uid), getColWidth(wrap, col.key, col.width));
      if(col.key === 'unitId' && uid){
        if(disputeFlag.flagged){
          cell.textContent = uid + (disputeFlag.stillDisabled ? ' (Disabled)' : ' (Returned Late)');
          cell.style.color = '#b91c1c';
          cell.style.fontWeight = '600';
        } else {
          cell.style.color = '#0b74de';
        }
        cell.style.cursor = 'pointer';
        cell.title = 'View coverage history';
        cell.addEventListener('click', (e) => {
          e.stopPropagation();
          try{ openUnitWdNumbersModal(uid, new Date().getFullYear(), new Date().getMonth(), unitIds); }catch(err){}
        });
      }
      row.appendChild(cell);
    });

    const taxInput = document.createElement('input'); taxInput.type = 'text'; taxInput.className = 'ub-tax money-input'; taxInput.placeholder = 'Tax'; taxInput.inputMode = 'decimal';
    taxInput.style.cssText = `flex:0 0 ${getColWidth(wrap, 'tax', 110)}px;padding:4px 6px;border:1px solid #e6e9ee;border-radius:4px;`;

    // "Other Charges" is no longer a single number typed directly — some invoices break it out
    // into several distinct, separately-taxed line items (e.g. Freight, Gasoline), so it's now
    // the sum of named subcharges added via the + button below. A hidden .ub-other input still
    // carries that sum so every existing reader (sorting, totals, Divide) keeps working as-is.
    const otherHiddenInput = document.createElement('input'); otherHiddenInput.type = 'hidden'; otherHiddenInput.className = 'ub-other';
    const otherCell = document.createElement('div'); otherCell.style.cssText = `flex:0 0 ${getColWidth(wrap, 'other', 120)}px;display:flex;align-items:center;`;
    const otherAddBtn = document.createElement('button'); otherAddBtn.type = 'button'; otherAddBtn.className = 'ub-other-add-btn';
    otherAddBtn.textContent = '+ Other';
    otherAddBtn.title = 'Add a named other charge (e.g. Freight, Gasoline) with its own Amount and Tax';
    otherAddBtn.style.cssText = 'font-size:11px;padding:3px 8px;border:1px solid #d1d5db;border-radius:4px;background:#f9fafb;cursor:pointer;';
    otherCell.appendChild(otherAddBtn);

    const chargeInput = document.createElement('input'); chargeInput.type = 'text'; chargeInput.className = 'ub-charge money-input'; chargeInput.placeholder = 'Amount'; chargeInput.inputMode = 'decimal';
    chargeInput.style.cssText = `flex:0 0 ${getColWidth(wrap, 'charge', 110)}px;padding:4px 6px;border:1px solid #e6e9ee;border-radius:4px;`;
    const rowTotalEl = document.createElement('div'); rowTotalEl.className = 'ub-row-total'; rowTotalEl.style.cssText = `flex:0 0 ${getColWidth(wrap, 'rowTotal', 110)}px;font-size:12px;color:#374151;font-weight:600;`;

    const prior = existing[uid] || seedData[uid] || {};
    if(prior.tax !== undefined) taxInput.value = prior.tax;
    if(prior.charge !== undefined) chargeInput.value = prior.charge;
    const priorSubcharges = Array.isArray(prior.otherChargeDetails) ? prior.otherChargeDetails.slice() : [];

    const onAmountInput = () => { updateUnitBreakdownTotal(wrapId); updateUnitBreakdownRowTotal(row); };
    taxInput.addEventListener('input', () => { autoGrowAmountColumn(wrap, 'tax', taxInput, 110); onAmountInput(); });
    chargeInput.addEventListener('input', () => { autoGrowAmountColumn(wrap, 'charge', chargeInput, 110); onAmountInput(); });

    // Highlight the row while editing it, and keep it highlighted when clicked anywhere else in it
    const selectRow = () => {
      rowsContainer.querySelectorAll('.unit-breakdown-row').forEach(rr => rr.classList.remove('selected'));
      row.classList.add('selected');
    };
    row.addEventListener('click', selectRow);
    taxInput.addEventListener('focus', selectRow);
    chargeInput.addEventListener('focus', selectRow);

    row.appendChild(taxInput); row.appendChild(otherCell); row.appendChild(otherHiddenInput); row.appendChild(chargeInput); row.appendChild(rowTotalEl);

    // Same trailing Disabled/Returned date text used on the Invoice Dispute Tracking breakdown —
    // lets the operator compare it against the invoice's own From/To Date right here, without
    // switching tabs.
    if(disputeFlag.flagged){
      const returnDateCell = document.createElement('div');
      returnDateCell.textContent = disputeFlag.stillDisabled
        ? `Disabled: ${formatDate(disputeFlag.disabledFrom) || disputeFlag.disabledFrom} (not yet returned)`
        : `Disabled: ${formatDate(disputeFlag.disabledFrom) || disputeFlag.disabledFrom} — Returned: ${formatDate(disputeFlag.returnedDate) || disputeFlag.returnedDate}`;
      returnDateCell.style.cssText = 'flex:1 1 220px;font-size:11px;color:#b91c1c;font-weight:600;white-space:nowrap;';
      row.appendChild(returnDateCell);
    }
    rowsContainer.appendChild(row);

    // Indented sub-rows (one per named subcharge) directly beneath this unit's row — striped
    // to match their parent row so the whole group reads as one visual band.
    const subchargesWrap = document.createElement('div');
    subchargesWrap.className = 'unit-breakdown-subcharges ' + (rowIdx % 2 === 0 ? 'unit-breakdown-row-even' : 'unit-breakdown-row-odd');
    subchargesWrap.dataset.unitId = uid;
    rowsContainer.appendChild(subchargesWrap);

    const recomputeOtherFromSubcharges = () => {
      let sum = 0;
      const details = [];
      subchargesWrap.querySelectorAll('.unit-breakdown-subcharge-row').forEach(subRow => {
        const nameEl = subRow.querySelector('.ub-sub-name');
        const amtEl = subRow.querySelector('.ub-sub-amount');
        const taxEl = subRow.querySelector('.ub-sub-tax');
        const descEl = subRow.querySelector('.ub-sub-description');
        const amt = parseCurrency(amtEl ? amtEl.value : '') || 0;
        const tx = parseCurrency(taxEl ? taxEl.value : '') || 0;
        sum += amt + tx;
        details.push({ name: nameEl ? nameEl.value : '', amount: amtEl ? amtEl.value : '', tax: taxEl ? taxEl.value : '', description: descEl ? descEl.value : '' });
      });
      otherHiddenInput.value = sum ? sum.toFixed(2) : '';
      row.dataset.otherChargeDetails = JSON.stringify(details);
      onAmountInput();
    };

    const addSubchargeRow = (sub) => {
      sub = sub || {};
      const subRow = document.createElement('div');
      subRow.className = 'unit-breakdown-subcharge-row';
      subRow.style.cssText = 'display:flex;gap:6px;align-items:center;padding:2px 0 2px 40px;';

      const branch = document.createElement('span'); branch.textContent = '↳'; branch.style.cssText = 'color:#9ca3af;font-size:12px;flex:0 0 16px;';
      const nameSelect = document.createElement('select'); nameSelect.className = 'ub-sub-name';
      nameSelect.style.cssText = 'flex:0 0 140px;font-size:12px;padding:3px 6px;border:1px solid #e6e9ee;border-radius:4px;';
      populateOtherChargeSelect(nameSelect, sub.name || '');
      const amountInput = document.createElement('input'); amountInput.type = 'text'; amountInput.className = 'ub-sub-amount money-input'; amountInput.placeholder = 'Amount'; amountInput.inputMode = 'decimal';
      amountInput.style.cssText = 'flex:0 0 90px;font-size:12px;padding:3px 6px;border:1px solid #e6e9ee;border-radius:4px;';
      const taxInputSub = document.createElement('input'); taxInputSub.type = 'text'; taxInputSub.className = 'ub-sub-tax money-input'; taxInputSub.placeholder = 'Tax'; taxInputSub.inputMode = 'decimal';
      taxInputSub.style.cssText = 'flex:0 0 90px;font-size:12px;padding:3px 6px;border:1px solid #e6e9ee;border-radius:4px;';
      const descInput = document.createElement('input'); descInput.type = 'text'; descInput.className = 'ub-sub-description'; descInput.placeholder = 'Description (optional) — e.g. what was repaired';
      descInput.style.cssText = 'flex:1 1 160px;min-width:120px;font-size:12px;padding:3px 6px;border:1px solid #e6e9ee;border-radius:4px;';
      const removeBtn = document.createElement('button'); removeBtn.type = 'button'; removeBtn.textContent = '✕'; removeBtn.title = 'Remove this charge';
      removeBtn.style.cssText = 'flex:0 0 20px;border:none;background:none;color:#dc2626;cursor:pointer;font-size:12px;';

      amountInput.value = sub.amount || '';
      taxInputSub.value = sub.tax || '';
      descInput.value = sub.description || '';

      nameSelect.addEventListener('change', recomputeOtherFromSubcharges);
      amountInput.addEventListener('input', recomputeOtherFromSubcharges);
      taxInputSub.addEventListener('input', recomputeOtherFromSubcharges);
      descInput.addEventListener('input', recomputeOtherFromSubcharges);
      nameSelect.addEventListener('focus', selectRow);
      amountInput.addEventListener('focus', selectRow);
      taxInputSub.addEventListener('focus', selectRow);
      descInput.addEventListener('focus', selectRow);
      removeBtn.addEventListener('click', () => { subRow.remove(); recomputeOtherFromSubcharges(); });

      subRow.appendChild(branch); subRow.appendChild(nameSelect); subRow.appendChild(amountInput); subRow.appendChild(taxInputSub); subRow.appendChild(descInput); subRow.appendChild(removeBtn);
      subchargesWrap.appendChild(subRow);
    };

    otherAddBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      selectRow();
      addSubchargeRow({});
      recomputeOtherFromSubcharges();
    });

    priorSubcharges.forEach(sub => addSubchargeRow(sub));
    recomputeOtherFromSubcharges();
    updateUnitBreakdownRowTotal(row);

    // Quarterly-period tables let an operator drop a unit from just that one period without
    // touching the main selection or any other period — not shown unless the caller opts in.
    if(opts && typeof opts.onRemoveUnit === 'function'){
      const removeUnitBtn = document.createElement('button');
      removeUnitBtn.type = 'button';
      removeUnitBtn.textContent = '✕';
      removeUnitBtn.title = 'Remove this unit from this period';
      removeUnitBtn.style.cssText = 'flex:0 0 22px;border:none;background:none;color:#dc2626;cursor:pointer;font-size:13px;margin-left:6px;';
      removeUnitBtn.addEventListener('click', (e) => { e.stopPropagation(); opts.onRemoveUnit(uid); });
      row.appendChild(removeUnitBtn);
    }
  });

  // Expand/collapse arrow, centered on the table's bottom edge: toggles between the capped
  // (~10 row) scroll height and showing every row at once. State persists across re-renders.
  if(rows.length > 0){
    const expandWrap = document.createElement('div');
    expandWrap.style.cssText = 'display:flex;justify-content:center;margin-top:-1px;position:relative;z-index:1;';
    const expandBtn = document.createElement('button');
    expandBtn.type = 'button';
    expandBtn.className = 'unit-breakdown-expand-btn';
    const isExpanded = wrap.dataset.expanded === 'true';
    rowsContainer.classList.toggle('expanded', isExpanded);
    expandBtn.textContent = isExpanded ? '▲' : '▼';
    expandBtn.title = isExpanded ? 'Show fewer rows' : 'Show all rows';
    expandBtn.addEventListener('click', () => {
      const nowExpanded = wrap.dataset.expanded !== 'true';
      wrap.dataset.expanded = nowExpanded ? 'true' : 'false';
      rowsContainer.classList.toggle('expanded', nowExpanded);
      expandBtn.textContent = nowExpanded ? '▲' : '▼';
      expandBtn.title = nowExpanded ? 'Show fewer rows' : 'Show all rows';
    });
    expandWrap.appendChild(expandBtn);
    wrap.appendChild(expandWrap);
  }

  // Bottom bar: "Divide" (only when more than one unit is listed — helps with invoices that
  // don't break the amount out per unit) on the left, running total on the right.
  const totalRow = document.createElement('div');
  totalRow.className = 'unit-breakdown-total';
  totalRow.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:8px 4px 2px;font-size:14px;';
  if(rows.length > 1){
    const divideBtn = document.createElement('button');
    divideBtn.type = 'button';
    divideBtn.className = 'small-link';
    divideBtn.textContent = 'Divide';
    divideBtn.title = "Split an invoice's Tax/Other Charges/Amount evenly across the selected units";
    divideBtn.addEventListener('click', (e) => { e.stopPropagation(); openDivideAmountsModal(wrapId); });
    totalRow.appendChild(divideBtn);
  } else {
    totalRow.appendChild(document.createElement('div'));
  }
  const totalTextEl = document.createElement('div');
  totalTextEl.className = 'unit-breakdown-total-text';
  totalTextEl.style.fontWeight = '700';
  totalRow.appendChild(totalTextEl);
  wrap.appendChild(totalRow);

  wrap.style.display = 'block';
  updateUnitBreakdownTotal(wrapId);
}

// The running total is Tax + Other Charges + Amount summed across every unit row; it must
// equal the declared Amount field (red until it matches, green once it does).
function _isInvoiceQuarterlyPeriodWrap(wrapId){
  return wrapId === 'invoiceUnitBreakdown' || wrapId.indexOf('invoicePeriodBreakdown_') === 0;
}

function updateUnitBreakdownTotal(wrapId){
  const wrap = qs('#' + wrapId); if(!wrap) return;
  const totalEl = wrap.querySelector('.unit-breakdown-total-text'); if(!totalEl) return;
  let sum = 0;
  wrap.querySelectorAll('.unit-breakdown-row').forEach(row => {
    const chargeInput = row.querySelector('.ub-charge');
    const taxInput = row.querySelector('.ub-tax');
    const otherInput = row.querySelector('.ub-other');
    sum += (parseCurrency(chargeInput ? chargeInput.value : '') || 0) + (parseCurrency(taxInput ? taxInput.value : '') || 0) + (parseCurrency(otherInput ? otherInput.value : '') || 0);
  });
  const amountFieldId = wrap.dataset.amountFieldId;
  const amountField = amountFieldId ? qs('#' + amountFieldId) : null;
  // Quarterly invoices: the declared Amount covers the sum across every period's table, not
  // this one table alone — its own color gets set below by updateQuarterlyPeriodsAggregateTotal()
  // instead, based on whether the COMBINED total across every period matches.
  const inMultiPeriodMode = wrapId === 'invoiceUnitBreakdown' && typeof _invoiceQuarterlyPeriod1Active !== 'undefined' && _invoiceQuarterlyPeriod1Active;
  const declared = inMultiPeriodMode ? null : parseCurrency(amountField ? amountField.value : '');
  const matches = declared !== null && Math.round(sum*100) === Math.round(declared*100);
  totalEl.textContent = 'Total (Tax + Other Charges + Amount): ' + formatCurrency(sum.toFixed(2)) + (declared !== null ? ' / declared ' + formatCurrency(declared.toFixed(2)) : '');
  if(!inMultiPeriodMode){
    totalEl.style.color = matches ? '#15803d' : '#dc2626';
    wrap.dataset.matches = matches ? 'true' : 'false';
  }

  if(_isInvoiceQuarterlyPeriodWrap(wrapId) && typeof updateQuarterlyPeriodsAggregateTotal === 'function'){
    updateQuarterlyPeriodsAggregateTotal();
  }
}

function unitBreakdownMatches(wrapId){
  const wrap = qs('#' + wrapId); if(!wrap) return false;
  return wrap.dataset.matches === 'true';
}

// --- "Divide" modal: for invoices that don't break the amount out per unit — splits a
// declared Tax/Other Charges/Amount total evenly across whichever units are currently listed
// in a given breakdown table (invoice creation or the Registry Edit modal, same component). ---
let _divideTargetWrapId = null;

function openDivideAmountsModal(wrapId){
  const modal = qs('#divideAmountsModal'); if(!modal) return;
  const wrap = qs('#' + wrapId); if(!wrap) return;
  _divideTargetWrapId = wrapId;
  const rowCount = wrap.querySelectorAll('.unit-breakdown-row').length;
  const countEl = qs('#divideUnitCount'); if(countEl) countEl.textContent = String(rowCount);
  const form = qs('#divideAmountsForm'); if(form) form.reset();
  const otherNameSelect = qs('#divideOtherName');
  if(otherNameSelect) populateOtherChargeSelect(otherNameSelect, '');
  modal.style.display = 'block';
}
function closeDivideAmountsModal(){
  const modal = qs('#divideAmountsModal'); if(modal) modal.style.display = 'none';
  _divideTargetWrapId = null;
}

// Splits `totalVal` into `n` parts that sum back exactly to it (working in cents to avoid
// floating-point drift), any leftover cent going to the first units.
function splitAmountEvenly(totalVal, n){
  const totalCents = Math.round((totalVal || 0) * 100);
  const q = Math.floor(totalCents / n);
  const rem = totalCents - q * n;
  const parts = [];
  for(let i=0;i<n;i++){ const cents = q + (i < rem ? 1 : 0); parts.push((cents/100).toFixed(2)); }
  return parts;
}

const divideAmountsCancelBtn = qs('#divideAmountsCancelBtn');
if(divideAmountsCancelBtn) divideAmountsCancelBtn.addEventListener('click', closeDivideAmountsModal);
const divideAmountsModalEl = qs('#divideAmountsModal');
if(divideAmountsModalEl){
  const backdrop = divideAmountsModalEl.querySelector('.modal-backdrop');
  if(backdrop) backdrop.addEventListener('click', closeDivideAmountsModal);
}
const divideAmountsForm = qs('#divideAmountsForm');
if(divideAmountsForm){
  divideAmountsForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const wrapId = _divideTargetWrapId;
    const wrap = wrapId ? qs('#' + wrapId) : null;
    if(!wrap){ closeDivideAmountsModal(); return; }

    const rowEls = Array.from(wrap.querySelectorAll('.unit-breakdown-row'));
    if(rowEls.length === 0){ closeDivideAmountsModal(); return; }

    // A blank field parses to null; an explicit 0 is just as much "nothing to divide" as blank
    // — either way the field is skipped entirely rather than distributing $0.00 across every
    // unit, which would otherwise silently blank out whatever was already entered there.
    const taxTotal = parseCurrency(qs('#divideTax').value);
    const chargeTotal = parseCurrency(qs('#divideCharge').value);
    const otherName = ((qs('#divideOtherName') || {}).value || '').trim();
    const otherAmountTotal = parseCurrency(qs('#divideOtherAmount').value);
    const otherTaxTotal = parseCurrency(qs('#divideOtherTax').value);

    if(taxTotal){
      const taxParts = splitAmountEvenly(taxTotal, rowEls.length);
      rowEls.forEach((row, i) => {
        const taxInput = row.querySelector('.ub-tax');
        if(taxInput){ taxInput.value = taxParts[i]; taxInput.dispatchEvent(new Event('input')); }
      });
    }
    if(chargeTotal){
      const chargeParts = splitAmountEvenly(chargeTotal, rowEls.length);
      rowEls.forEach((row, i) => {
        const chargeInput = row.querySelector('.ub-charge');
        if(chargeInput){ chargeInput.value = chargeParts[i]; chargeInput.dispatchEvent(new Event('input')); }
      });
    }
    // Other Charges no longer accepts one flat number for the whole unit — that used to get
    // dumped straight into the hidden rollup field and, on every unit, wipe out any named
    // charges (Freight, Fuel, etc.) already entered there. Instead this adds ONE new named
    // subcharge row per unit (via the same "+ Other" button the operator would click by hand),
    // so existing named charges on every unit are left completely untouched.
    if(otherAmountTotal || otherTaxTotal){
      const otherAmountParts = otherAmountTotal ? splitAmountEvenly(otherAmountTotal, rowEls.length) : null;
      const otherTaxParts = otherTaxTotal ? splitAmountEvenly(otherTaxTotal, rowEls.length) : null;
      rowEls.forEach((row, i) => {
        const addBtn = row.querySelector('.ub-other-add-btn');
        const uid = row.dataset.unitId;
        if(!addBtn || !uid) return;
        addBtn.click();
        const subWrap = wrap.querySelector(`.unit-breakdown-subcharges[data-unit-id="${CSS.escape(uid)}"]`);
        const newSubRow = subWrap ? subWrap.querySelector('.unit-breakdown-subcharge-row:last-child') : null;
        if(!newSubRow) return;
        const nameSelect = newSubRow.querySelector('.ub-sub-name');
        const amountInput = newSubRow.querySelector('.ub-sub-amount');
        const taxInputSub = newSubRow.querySelector('.ub-sub-tax');
        if(nameSelect && otherName){ nameSelect.value = otherName; nameSelect.dispatchEvent(new Event('change')); }
        if(amountInput && otherAmountParts){ amountInput.value = otherAmountParts[i]; amountInput.dispatchEvent(new Event('input')); }
        if(taxInputSub && otherTaxParts){ taxInputSub.value = otherTaxParts[i]; taxInputSub.dispatchEvent(new Event('input')); }
      });
    }

    closeDivideAmountsModal();
  });
}

// --- Invoice-form-specific thin wrappers around the generic breakdown table ---
function getInvoiceBreakdownRowsData(){ return getUnitBreakdownRowsData('invoiceUnitBreakdown'); }
function refreshInvoiceBreakdownIfVisible(){
  const wrap = qs('#invoiceUnitBreakdown');
  if(wrap && wrap.style.display !== 'none') renderInvoiceUnitBreakdown();
}
function renderInvoiceUnitBreakdown(seed){
  if(typeof updateInvoiceQuarterlyPeriod1Mode === 'function') updateInvoiceQuarterlyPeriod1Mode();
  // In quarterly mode this table is scoped to Period 1's own From date (a separate field from
  // the invoice's overall declared From/To above) — same distinction the amount/day math
  // elsewhere in this app already makes between a quarterly registry's overall span and each
  // sub-period's own range.
  const periodStartEl = qs('#invoicePeriodStart');
  const disputeFromDate = _invoiceQuarterlyPeriod1Active ? (_invoicePeriod1.fromDate || '') : (periodStartEl ? periodStartEl.value : '');
  renderUnitBreakdownTable('invoiceUnitBreakdown', getSelectedInvoiceUnits(), 'invoiceAmount', seed, { showEmptyRow: true, disputeFromDate });
}

// Generic "X" quick-clear button for a search input: shown only while it has text, clears
// it and re-fires the filter on click. Reusable for any future search box the same way.
function wireSearchClearButton(inputId, clearBtnId){
  const input = qs('#' + inputId); const clearBtn = qs('#' + clearBtnId);
  if(!input || !clearBtn) return;
  const update = () => { clearBtn.style.display = input.value ? 'block' : 'none'; };
  if(!input.dataset.clearWired){
    input.dataset.clearWired = 'true';
    input.addEventListener('input', update);
    clearBtn.addEventListener('click', () => {
      input.value = '';
      input.dispatchEvent(new Event('input'));
      input.focus();
    });
  }
  update();
}
wireSearchClearButton('invoiceLeaseSearch', 'invoiceLeaseSearchClear');
wireSearchClearButton('invoiceUnitSearch', 'invoiceUnitSearchClear');

// ensure invoice selects are updated when relevant lists change
if(typeof syncInvoiceLeaseOptions === 'function') syncInvoiceLeaseOptions();
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
  try{ if(_itMatchedRegistry && typeof renderInvoiceTrackingUnitBreakdown === 'function') renderInvoiceTrackingUnitBreakdown(); }catch(e){}
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
  try{ if(typeof populateInvoiceTrackingDropdowns === 'function') populateInvoiceTrackingDropdowns(); }catch(e){}
  try{ if(_itMatchedRegistry && typeof lookupInvoiceTrackingWd === 'function') lookupInvoiceTrackingWd(); }catch(e){}
  form.reset();
  delete form.dataset.editing;
  const submitBtn = form.querySelector('button[type="submit"]');
  if(submitBtn) submitBtn.textContent = 'New';
  renderOverview();
  if(typeof renderOverviewUnits === 'function') renderOverviewUnits();
});

qs('#userForm').addEventListener('submit', async e=>{
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
  if(pwd) userObj.password = await hashPassword(pwd); // only set/replace password when provided, always stored hashed

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

    // Edit: open invoice form populated with every invoice in this WD group — not just the
    // first one. Loading only list[0] meant a multi-unit group always showed a single row,
    // which is also why "Divide" (only shown for >1 unit) could never appear here.
    editOpt.addEventListener('click', ()=>{
      if(!list || list.length === 0) return; const inv = list[0];
      const form = qs('#invoiceForm'); if(!form) return;
      delete form.dataset.editing;
      form.dataset.editingGroupIds = JSON.stringify(list.map(i => i.id));

      const groupLeases = Array.from(new Set(list.map(i => i.lease).filter(Boolean)));
      const groupUnits = list.map(i => i.unit).filter(Boolean);

      if(typeof syncInvoiceLeaseOptions === 'function') syncInvoiceLeaseOptions(groupLeases);
      if(typeof renderInvoiceLeaseDetailTable === 'function') renderInvoiceLeaseDetailTable();
      const cat = form.querySelector('#invoiceCategory'); if(cat) cat.value = inv.category || '';
      if(typeof syncInvoiceUnitOptions === 'function') syncInvoiceUnitOptions(groupLeases, groupUnits);
      const wd = form.querySelector('#invoiceWD'); if(wd) wd.value = inv.wdNumber || '';
      const doc = form.querySelector('#invoiceDoc'); if(doc) doc.value = inv.docNumber || '';
      // Declared Amount = Tax + Other Charges + Amount summed across every unit in the group
      const amt = form.querySelector('#invoiceAmount');
      if(amt){
        const groupTotal = list.reduce((s,i) => s + (parseCurrency(i.amount||'')||0) + (parseCurrency(i.taxAmount||'')||0) + (parseCurrency(i.otherCharges||'')||0), 0);
        amt.value = groupTotal.toFixed(2);
      }
      // Prefer the matching registry's own stored unitDetails for otherChargeDetails — it's the
      // durable source (state.invoices is in-session-only), so it's the one guaranteed to still
      // have the named subcharge breakdown intact.
      const seedRegistry = (state.registries||[]).find(r => (r.wdNumber||'').toString().trim() === (inv.wdNumber||'').toString().trim());
      const seedRegistryDetails = seedRegistry ? getRegistryUnitDetails(seedRegistry) : [];
      const seed = {};
      list.forEach(i => {
        if(!i.unit) return;
        const regDetail = seedRegistryDetails.find(d => (d.unit||'').toString().trim().toLowerCase() === i.unit.toString().trim().toLowerCase());
        seed[i.unit] = { charge: i.amount || '', tax: i.taxAmount || '', other: i.otherCharges || '', otherChargeDetails: (regDetail && regDetail.otherChargeDetails) || i.otherChargeDetails || [] };
      });
      if(typeof renderInvoiceUnitBreakdown === 'function') renderInvoiceUnitBreakdown(seed);
      const supInvDate = form.querySelector('#invoiceSupplierInvoiceDate'); if(supInvDate) supInvDate.value = inv.invoiceDate || '';
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




// Prefer the registry's own stored unitDetails snapshot (exact, captured at registration/edit
// time). For older registries that predate that field (or if it didn't round-trip through the
// backend), reconstruct best-effort detail from the current unit records for Company/Lease/Cost
// Center, and from any still-in-session invoice record for Tax/Charge — those may come back
// blank after a reload since individual invoices aren't themselves persisted.
function getRegistryUnitDetails(r){
  if(Array.isArray(r.unitDetails) && r.unitDetails.length) return r.unitDetails;
  const units = Array.isArray(r.units) ? r.units : [];
  const wd = (r.wdNumber||'').toString().trim().toLowerCase();
  return units.map(uid => {
    const uidLower = (uid||'').toString().trim().toLowerCase();
    const unitRec = (state.units||[]).find(u => (u.unitId||u.id||'').toString().trim().toLowerCase() === uidLower);
    const inv = (state.invoices||[]).find(i => (i.unit||'').toString().trim().toLowerCase() === uidLower && (i.wdNumber||'').toString().trim().toLowerCase() === wd);
    return {
      unit: uid,
      lease: unitRec ? (unitRec.lease||'') : (inv ? (inv.lease||'') : ''),
      company: unitRec ? (unitRec.company||'') : (inv ? (inv.company||'') : ''),
      costCenter: unitRec ? (unitRec.costCenter||'') : '',
      tax: inv ? (inv.taxAmount||'') : '',
      other: inv ? (inv.otherCharges||'') : '',
      charge: inv ? (inv.amount||'') : ''
    };
  });
}

// Returns the list of {from, to, units} coverage slices for a registry — one slice for a
// normal invoice (its own declared period + full unit list), or one slice per period for a
// quarterly invoice (Period 1's own sub-range + one per entry in registry.periods, each with
// its own per-unit list) — since quarterly periods can't overlap and a unit can be added or
// removed independently per period, coverage has to be checked per-period, not against the
// registry's single overall periodStart/periodEnd + full unit list.
// unitDetails is included on every slice alongside units (additive — every existing caller
// only reads .from/.to/.units) so a caller that needs each unit's actual tax/other/charge for
// that specific period (e.g. the accrual charge estimate) doesn't have to re-derive which
// period1/periods[] entry a given slice came from all over again.
function getRegistryCoveragePeriods(reg){
  const hasQuarterlyPeriods = !!(reg.period1From || reg.period1To || (Array.isArray(reg.periods) && reg.periods.length > 0));
  if(!hasQuarterlyPeriods){
    return [{ from: reg.periodStart || '', to: reg.periodEnd || '', units: Array.isArray(reg.units) ? reg.units : [], unitDetails: Array.isArray(reg.unitDetails) ? reg.unitDetails : [] }];
  }
  const slices = [];
  const period1Units = Array.isArray(reg.unitDetails) && reg.unitDetails.length
    ? reg.unitDetails.map(d => d.unit)
    : (Array.isArray(reg.units) ? reg.units : []);

  let period1From = reg.period1From || '';
  let period1To = reg.period1To || '';
  const otherPeriods = Array.isArray(reg.periods) ? reg.periods : [];
  if((!period1From || !period1To) && otherPeriods.length > 0){
    // Legacy/malformed data missing period1From/period1To — falling back to the registry's
    // whole overall declared range here would overlap every other period (they're carved out
    // of that same range) and falsely double-count every unit/day they share. Instead, infer
    // Period 1's own bounds as whatever's left once the other periods' own ranges are excluded
    // — assumes Period 1 comes chronologically first, which is the normal case.
    if(!period1From) period1From = reg.periodStart || '';
    if(!period1To){
      const otherFroms = otherPeriods.map(p => p.fromDate).filter(Boolean).sort();
      period1To = otherFroms.length > 0 ? addDaysToDateStr(otherFroms[0], -1) : (reg.periodEnd || '');
    }
  }

  slices.push({ from: period1From || reg.periodStart || '', to: period1To || reg.periodEnd || '', units: period1Units, unitDetails: Array.isArray(reg.unitDetails) ? reg.unitDetails : [] });
  otherPeriods.forEach(p => {
    const pUnitDetails = Array.isArray(p.unitDetails) ? p.unitDetails : [];
    slices.push({ from: p.fromDate || '', to: p.toDate || '', units: pUnitDetails.map(d => d.unit), unitDetails: pUnitDetails });
  });

  // Any slice past Period 1 with a genuinely missing from/to (a period card whose date was never
  // filled in, or malformed source data) left that bound blank until now — which silently zeroes
  // out every day-based calculation built on top of it (accrual charge estimate, dispute
  // pro-ration) with no indication why: the red "possible dispute" highlight elsewhere only ever
  // needs a slice's `from`, so it still shows correctly even when `to` is missing, making a
  // dollar amount that quietly computes to $0 right next to it look like a totally separate bug.
  // Two clean passes rather than one combined pass: forward for every `.from` (each may lean on
  // the PRECEDING slice's own already-resolved `.to`), then backward for every `.to` (each may
  // lean on the FOLLOWING slice's own already-resolved `.from`) — so two ADJACENT slices that are
  // BOTH missing the date on their shared boundary still resolve correctly, instead of one of
  // them reading its neighbor's bound before that neighbor's own fallback ever ran. Only the very
  // ends fall back to the registry's own overall span — exactly what Period 1 above already gets.
  for(let i = 1; i < slices.length; i++){
    if(!slices[i].from) slices[i].from = slices[i-1].to ? addDaysToDateStr(slices[i-1].to, 1) : (reg.periodStart || '');
  }
  for(let i = slices.length - 1; i >= 0; i--){
    if(!slices[i].to) slices[i].to = (i + 1 < slices.length && slices[i+1].from) ? addDaysToDateStr(slices[i+1].from, -1) : (reg.periodEnd || '');
  }
  return slices;
}

// Every unit on a registry (Period 1 + every periods[] sub-period for a quarterly invoice),
// collapsed to ONE row per unit — but a unit invoiced separately in MORE THAN ONE period within
// the SAME quarterly registry (the normal case: e.g. billed once per month across a 3-month WD
// invoice) is no longer reduced to just its FIRST period's charge, discarding the rest. That used
// to silently zero out a dispute for a unit whose actually-relevant charge (the month it was
// really disabled in) wasn't the first one found — the day-proration would run against the WRONG
// month's dates (0 overlap with the real disabled period), landing on $0 with no error, while the
// visible red "possible dispute" flag (which only ever needs SOME disabled period to exist,
// regardless of which month) kept showing correctly right next to it — exactly the kind of silent
// mismatch this function exists to prevent.
//
// tax/other/charge here are the SUM across every period this unit actually appears in — the most
// representative single figure for "how much has this unit been charged on this invoice, total".
// otherChargeDetails is the concatenation of every period's own named subcharges (never summed
// into one blended line — each stays its own separately-selectable, non-prorated charge no matter
// which month it came from). chargePeriods carries each period's own charge+tax+dates SEPARATELY
// (not summed) — computeUnitDisputeShare prorates and taxes EACH one against its own dates, then
// sums the results, so a unit not yet disabled in July but disabled from mid-August naturally
// resolves to $0 for July and a genuine amount for August/September, all from one checkbox.
// __slice (the first period found) is kept only as a rough reference date for
// computeUnitReturnDisputeFlag's "should this probably be disputed?" flag, which only needs ANY
// one of the unit's periods to determine that, not a precise scope.
function getRegistryUnitDetailsWithSlice(reg){
  const periodSlices = getRegistryCoveragePeriods(reg);
  const fallbackSlice = periodSlices[0] || { from: reg.periodStart || '', to: reg.periodEnd || '' };

  const rawEntries = [];
  getRegistryUnitDetails(reg).forEach(d => {
    if((d.unit || '').toString().trim()) rawEntries.push({ d, slice: fallbackSlice });
  });
  periodSlices.slice(1).forEach(slice => {
    (slice.unitDetails || []).forEach(d => {
      if((d.unit || '').toString().trim()) rawEntries.push({ d, slice });
    });
  });

  const byUnit = new Map();
  rawEntries.forEach(({ d, slice }) => {
    const key = d.unit.toString().trim().toLowerCase();
    if(!byUnit.has(key)){
      byUnit.set(key, { unit: d.unit, taxSum: 0, otherSum: 0, chargeSum: 0, otherChargeDetails: [], chargePeriods: [], __slice: slice });
    }
    const agg = byUnit.get(key);
    agg.taxSum += parseCurrency(d.tax || '') || 0;
    agg.otherSum += parseCurrency(d.other || '') || 0;
    agg.chargeSum += parseCurrency(d.charge || '') || 0;
    if(Array.isArray(d.otherChargeDetails)) agg.otherChargeDetails = agg.otherChargeDetails.concat(d.otherChargeDetails);
    agg.chargePeriods.push({ charge: d.charge || '', tax: d.tax || '', periodFrom: slice.from || '', periodTo: slice.to || '' });
  });

  return Array.from(byUnit.values()).map(agg => ({
    unit: agg.unit,
    tax: agg.taxSum ? agg.taxSum.toFixed(2) : '',
    other: agg.otherSum ? agg.otherSum.toFixed(2) : '',
    charge: agg.chargeSum ? agg.chargeSum.toFixed(2) : '',
    otherChargeDetails: agg.otherChargeDetails,
    chargePeriods: agg.chargePeriods,
    __slice: agg.__slice
  }));
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
    { key:'tax', label:'Tax', width:100 },
    { key:'other', label:'Other Charges', width:110 },
    { key:'charge', label:'Amount', width:100 },
    { key:'rowTotal', label:'Total Charge', width:110 }
  ];

  const rowTotalOf = d => (parseFloat(d.tax)||0) + (parseFloat(d.other)||0) + (parseFloat(d.charge)||0);

  let rows = unitDetails.slice();
  if(sortCol){
    const isNumeric = sortCol === 'tax' || sortCol === 'other' || sortCol === 'charge' || sortCol === 'rowTotal';
    rows.sort((a,b) => {
      if(sortCol === 'rowTotal'){
        return sortDir === 'asc' ? rowTotalOf(a) - rowTotalOf(b) : rowTotalOf(b) - rowTotalOf(a);
      }
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

  const allUnitIds = rows.map(d => d.unit).filter(Boolean);
  const rowsContainer = document.createElement('div');
  rowsContainer.className = 'registry-unit-detail-rows';
  container.appendChild(rowsContainer);

  let grandTotal = 0;
  rows.forEach((d, rowIdx) => {
    const row = document.createElement('div');
    row.className = rowIdx % 2 === 0 ? 'unit-breakdown-row-even' : 'unit-breakdown-row-odd';
    row.style.cssText = 'display:flex;gap:8px;align-items:center;padding:4px 0;border-bottom:1px solid #f0f0f0;';
    const mkCell = (text, w) => { const c = document.createElement('div'); c.textContent = text; c.style.cssText = `flex:0 0 ${w}px;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;`; return c; };
    row.appendChild(mkCell(d.company||'', 130));
    // UnitId opens the unit's coverage history window
    const unitCell = mkCell(d.unit||'', 100);
    if(d.unit){
      unitCell.style.color = '#0b74de';
      unitCell.style.cursor = 'pointer';
      unitCell.title = 'View coverage history';
      unitCell.addEventListener('click', (e) => {
        e.stopPropagation();
        try{ openUnitWdNumbersModal(d.unit, new Date().getFullYear(), new Date().getMonth(), allUnitIds); }catch(err){}
      });
    }
    row.appendChild(unitCell);
    row.appendChild(mkCell(d.lease||'', 100));
    row.appendChild(mkCell(d.costCenter||'', 110));
    row.appendChild(mkCell(formatCurrency(d.tax||'0'), 100));
    row.appendChild(mkCell(formatCurrency(d.other||'0'), 110));
    row.appendChild(mkCell(formatCurrency(d.charge||'0'), 100));
    row.appendChild(mkCell(formatCurrency(rowTotalOf(d).toFixed(2)), 110));
    rowsContainer.appendChild(row);
    grandTotal += rowTotalOf(d);

    (Array.isArray(d.otherChargeDetails) ? d.otherChargeDetails : []).forEach(sub => {
      const subAmt = parseCurrency(sub.amount || '') || 0;
      const subTax = parseCurrency(sub.tax || '') || 0;
      if(!sub.name && !subAmt && !subTax) return;
      const subRow = document.createElement('div');
      subRow.className = rowIdx % 2 === 0 ? 'unit-breakdown-row-even' : 'unit-breakdown-row-odd';
      subRow.style.cssText = 'display:flex;gap:6px;align-items:center;padding:2px 0 2px 40px;font-size:11px;color:#6b7280;';
      const descNote = sub.description ? ` <span style="font-style:italic;">— ${escapeHtml(sub.description)}</span>` : '';
      subRow.innerHTML = `<span style="color:#9ca3af;">↳</span><span>${escapeHtml(sub.name || '(unnamed)')}: ${formatCurrency((subAmt + subTax).toFixed(2))}${descNote}</span>`;
      rowsContainer.appendChild(subRow);
    });
  });

  const totalRow = document.createElement('div');
  totalRow.style.cssText = 'text-align:right;padding:8px 4px 2px;font-size:13px;font-weight:700;color:#374151;';
  totalRow.textContent = 'Total (Tax + Other Charges + Amount): ' + formatCurrency(grandTotal.toFixed(2));
  container.appendChild(totalRow);
  return true;
}

// Render registry of grouped submissions (registries created when multiple units are submitted under a WD)
// Matches a registry to any Invoice Tracking dispute entr(y/ies) opened against the same WD
// number — the only link between the two tabs for now (per-unit/lease matching may follow).
function getInvoiceTrackingForRegistry(r){
  const wd = (r.wdNumber || '').toString().trim().toLowerCase();
  if(!wd) return [];
  return (state.invoiceTracking || []).filter(t => (t.wdInvoiceNum || '').toString().trim().toLowerCase() === wd);
}

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
  let displayIdx = 0;
  for(let i = regs.length - 1; i >= 0; i--){
    const r = regs[i];
    const row = document.createElement('div');
    row.className = 'registry-row ' + (displayIdx % 2 === 0 ? 'unit-breakdown-row-even' : 'unit-breakdown-row-odd');
    displayIdx++;
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

    // Dedicated expand/collapse button (before the counter number) — a line ("—") when closed,
    // a slash ("/") when open. Clicking the title text itself no longer toggles, so operators
    // can select/copy the WD/Doc/Lease text without accidentally collapsing the row.
    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'registry-toggle-btn';
    toggleBtn.textContent = '—';
    toggleBtn.title = 'Expand/collapse';
    toggleBtn.style.cssText = 'flex:0 0 24px;height:22px;border:1px solid #d1d5db;border-radius:4px;background:#fff;cursor:pointer;font-size:13px;font-weight:700;color:#374151;display:flex;align-items:center;justify-content:center;margin-right:6px;padding:0;';
    toggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const nowOpen = details.style.display === 'none';
      details.style.display = nowOpen ? 'block' : 'none';
      toggleBtn.textContent = nowOpen ? '/' : '—';
    });

    const infoText = document.createElement('span');
    infoText.innerHTML = `<strong>${r.seq}.</strong> WD: ${escapeHtml(r.wdNumber||'(no WD)')} — Doc: ${escapeHtml(r.docNumber||'')}${leaseNumber ? ' — Lease: ' + escapeHtml(leaseNumber) : ''}`;

    const leftInfo = document.createElement('div');
    leftInfo.style.cssText = 'display:flex;align-items:center;';
    leftInfo.appendChild(toggleBtn);
    leftInfo.appendChild(infoText);
    
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
    deleteBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      menuPanel.style.display = 'none';
      const hasId = !!r.id;
      const confirmMsg = hasId
        ? `Delete registry ${r.seq}?`
        : `Registry ${r.seq} (WD ${r.wdNumber || '(no WD)'}) has no saved identifier in Google Sheets, so this app can't target its row there for deletion. Continuing will remove it from this list only — you'll still need to delete the matching row directly in the "invoices" sheet yourself. Continue?`;
      if(confirm(confirmMsg)){
        // Delete from Google Sheets FIRST and wait for it to actually complete before touching
        // local state. A silent-background (fire-and-forget) auto-refresh runs every 60s and
        // fully overwrites state.registries from whatever Sheets currently has — if we removed
        // this row locally before the server-side delete finished, that auto-refresh could pull
        // the still-there row back in and make it reappear until the next refresh cycle.
        if(hasId){
          try{
            // Falls back to matching by WD/Doc number server-side if the id itself can't be
            // found (e.g. a row whose id ended up blank/mismatched from an earlier write issue)
            // — otherwise that row would be permanently stuck and un-deletable from here.
            await DB.deleteRegistry(r.id, { wdNumber: r.wdNumber || '', docNumber: r.docNumber || '' });
          }catch(err){
            alert('Failed to delete from Google Sheets: ' + err.message);
            return;
          }
        }

        // Delete the registry from local state by exact object identity (not just id) — several
        // registries can end up sharing a blank/duplicate id if their id never made it to Sheets,
        // and matching by id alone would remove all of them at once instead of just this one.
        state.registries = state.registries.filter(reg => reg !== r);

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
    
    const disputeEntries = getInvoiceTrackingForRegistry(r);
    if(disputeEntries.length > 0){
      const disputeBadge = document.createElement('span');
      disputeBadge.textContent = '⚠ Dispute' + (disputeEntries.length > 1 ? ' (' + disputeEntries.length + ')' : '');
      disputeBadge.title = 'This invoice has an open Invoice Tracking entry';
      disputeBadge.style.cssText = 'font-size:11px;font-weight:700;color:#92400e;background:#fef3c7;border:1px solid #fde68a;border-radius:10px;padding:2px 8px;';
      rightInfo.appendChild(disputeBadge);
    }

    rightInfo.appendChild(amountInfo);
    rightInfo.appendChild(menuContainer);
    
    title.appendChild(leftInfo);
    title.appendChild(rightInfo);
    row.appendChild(title);

    const details = document.createElement('div'); details.className = 'registry-details'; details.style.display = 'none'; details.style.marginTop = '8px'; details.style.fontSize = '13px'; details.style.color = '#374151';
    const unitsList = document.createElement('div');
    unitsList.style.marginBottom = '8px';
    const unitsLabel = document.createElement('div'); unitsLabel.innerHTML = '<strong>Units:</strong>'; unitsLabel.style.marginBottom = '4px';
    unitsList.appendChild(unitsLabel);
    // Quarterly invoices carry more than one unit-detail table — Period 1 (this registry's own
    // unitDetails, using its period1From/To sub-range when set) plus one more per entry in
    // registry.periods, each labeled with its own declared From/To.
    const isQuarterlyRegistry = !!(r.period1From || r.period1To || (Array.isArray(r.periods) && r.periods.length > 0));
    const registryPeriodTables = [{
      label: isQuarterlyRegistry ? 'Period 1' : null,
      from: r.period1From || r.periodStart || '',
      to: r.period1To || r.periodEnd || '',
      unitDetails: getRegistryUnitDetails(r)
    }];
    (Array.isArray(r.periods) ? r.periods : []).forEach((p, pIdx) => {
      registryPeriodTables.push({
        label: 'Period ' + (pIdx + 2),
        from: p.fromDate || '',
        to: p.toDate || '',
        unitDetails: Array.isArray(p.unitDetails) ? p.unitDetails : []
      });
    });
    registryPeriodTables.forEach(pt => {
      if(pt.label){
        const ptLabel = document.createElement('div');
        ptLabel.style.cssText = 'font-size:12px;font-weight:700;color:#374151;margin:8px 0 2px;';
        ptLabel.textContent = pt.label + (pt.from && pt.to ? ' (' + formatDate(pt.from) + ' — ' + formatDate(pt.to) + ')' : '');
        unitsList.appendChild(ptLabel);
      }
      if(pt.unitDetails.length){
        const detailTableEl = document.createElement('div'); detailTableEl.className = 'registry-unit-detail-table';
        unitsList.appendChild(detailTableEl);
        renderRegistryUnitDetailTable(detailTableEl, pt.unitDetails);
      } else {
        const noneEl = document.createElement('div'); noneEl.className = 'small-muted'; noneEl.textContent = '(no units)';
        unitsList.appendChild(noneEl);
      }
    });
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
    
    // Registration info (period, submitted, category, supplier, company, arrangement, invoicing)
    // laid out as a wrapping grid so it uses the available width instead of one item per line.
    const infoGrid = document.createElement('div');
    infoGrid.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px 28px;margin-bottom:10px;';
    [period, submitted, categoryDiv, supplierDiv, companyDiv, arrangementDiv, invoicingDiv].forEach(el => {
      el.style.flex = '1 1 180px';
      el.style.minWidth = '160px';
      infoGrid.appendChild(el);
    });
    details.appendChild(infoGrid);

    // Preview of any Invoice Tracking entr(y/ies) opened against this WD number — surfaces
    // the dispute right on the registry itself so it doesn't require cross-checking the
    // separate Invoice Tracking tab. Matched purely by WD number for now.
    if(disputeEntries.length > 0){
      const disputeSection = document.createElement('div');
      disputeSection.style.cssText = 'margin-bottom:10px;';
      disputeEntries.forEach(dt => {
        const card = document.createElement('div');
        card.style.cssText = 'background:#fffbeb;border:1px solid #fde68a;border-radius:6px;padding:8px 10px;margin-bottom:6px;';
        const rowsHtml = [
          ['Units in Dispute', Array.isArray(dt.unitsInDispute) ? dt.unitsInDispute.join(', ') : ''],
          ['Amount in Dispute', dt.amountInDispute ? formatCurrency(dt.amountInDispute) : ''],
          ['Amount Due', formatCurrency(dt.amountDue || 0)],
          ['Invoice Status', dt.invoiceStatus || ''],
          ['Payment Status', dt.paymentStatus || ''],
          ['Description of Issue', dt.descriptionOfIssue || ''],
          ['Request', dt.request || ''],
          ['Status', dt.status || '']
        ].filter(([,v]) => v);
        card.innerHTML = '<div style="font-weight:700;color:#92400e;margin-bottom:4px;">⚠ Invoice Tracking — Open Dispute</div>' +
          '<div style="display:flex;flex-wrap:wrap;gap:4px 20px;">' +
          rowsHtml.map(([label,val]) => `<div style="flex:1 1 160px;min-width:140px;"><strong>${escapeHtml(label)}:</strong> ${escapeHtml(val)}</div>`).join('') +
          '</div>';
        disputeSection.appendChild(card);
      });
      details.appendChild(disputeSection);
    }

    // Per-unit detail table sits at the bottom, right above the comments/Add Comment button
    details.appendChild(unitsList);
    details.appendChild(commentsSection);
    row.appendChild(details);
    
    // Restore open state if this registry was open before
    if(openRegistries.has(r.id)){
      details.style.display = 'block';
      toggleBtn.textContent = '/';
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
      searchInput.placeholder = 'Filter by unit, lease, company, supplier, comments... ("," = or, ";" = and, "term." = exact)';
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
    searchInput.placeholder = 'Search leases... ("," = or, ";" = and, "term." = exact)';
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

// The built-in "Master" account is a hardcoded credential, not a real managed user — it must
// never appear in any list or be editable here, at any access level.
function _isMasterUsername(username){
  return (username || '').toString().trim().toLowerCase() === 'master';
}

function renderUsers(){
  const session = currentSession();
  const isMasterSession = !!session && session.user === 'Master';
  let role = isMasterSession ? 'Master' : null;
  if(!isMasterSession && session){
    const u = (state.users||[]).find(x => x.username === session.user);
    role = u ? (u.role || null) : null;
  }
  const isFullAccess = (role === 'Master' || role === 'Developer');

  const mgmtBlock = qs('#userManagementBlock');
  const myInfoBlock = qs('#myUserInfo');
  const changePwdBlock = qs('#changePasswordBlock');
  if(mgmtBlock) mgmtBlock.style.display = isFullAccess ? '' : 'none';
  if(myInfoBlock) myInfoBlock.style.display = isFullAccess ? 'none' : '';
  // Master's login is hardcoded and isn't a real account, so it has nothing to change here
  if(changePwdBlock) changePwdBlock.style.display = isMasterSession ? 'none' : '';

  if(isFullAccess){
    const tbody = qs('#userList'); if(!tbody) return; tbody.innerHTML='';
    // adjust visibility of the Developer role option based on current session
    try{ updateUserRoleOptionsVisibility(); }catch(e){}
    const managedUsers = (state.users||[]).filter(u => !_isMasterUsername(u.username));
    managedUsers.forEach((u, idx)=>{
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
  } else if(!isMasterSession){
    // Manager/Operator: read-only view of their own account only
    const myBody = qs('#myUserInfoBody'); if(!myBody) return; myBody.innerHTML = '';
    const me = (state.users||[]).find(x => x.username === (session ? session.user : ''));
    if(me){
      [['First Name', me.firstName||''], ['Last Name', me.lastName||''], ['Username', me.username||''], ['Role', me.role||'']].forEach(([label,val]) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td style="font-weight:600;width:140px;">${escapeHtml(label)}</td><td>${escapeHtml(val)}</td>`;
        myBody.appendChild(tr);
      });
    }
  }
}

// Self-service password change for any real logged-in account (not the built-in Master login).
const changePasswordForm = qs('#changePasswordForm');
if(changePasswordForm){
  changePasswordForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const session = currentSession();
    if(!session || session.user === 'Master'){ alert('Password change is not available for this account.'); return; }
    const me = (state.users||[]).find(u => u.username === session.user);
    if(!me){ alert('Could not find your account.'); return; }

    const oldPwd = qs('#cpOldPassword').value;
    const newPwd = qs('#cpNewPassword').value;
    const confirmPwd = qs('#cpConfirmPassword').value;
    if(!oldPwd || !newPwd || !confirmPwd){ alert('Please fill in all password fields.'); return; }
    if(newPwd !== confirmPwd){ alert('New password and confirmation do not match.'); return; }
    if(newPwd.length < 4){ alert('New password must be at least 4 characters.'); return; }

    const isValid = await verifyPassword(oldPwd, me.password);
    if(!isValid){ alert('Current password is incorrect.'); return; }

    const submitBtn = changePasswordForm.querySelector('button[type="submit"]');
    if(submitBtn){ submitBtn.disabled = true; submitBtn.textContent = 'Saving...'; }
    try{
      const updated = Object.assign({}, me, { password: await hashPassword(newPwd) });
      await DB.updateUser(updated);
      const idx = state.users.findIndex(u => u.id === me.id);
      if(idx !== -1) state.users[idx] = updated;
      saveState();
      changePasswordForm.reset();
      alert('Password updated successfully.');
    }catch(err){
      alert('Failed to save new password: ' + err.message);
    }finally{
      if(submitBtn){ submitBtn.disabled = false; submitBtn.textContent = 'Update Password'; }
    }
  });
}

qs('#userCancelBtn').addEventListener('click', ()=>{
  const form = qs('#userForm'); form.reset(); delete form.dataset.editing; qs('#userCancelBtn').style.display='none';
});

// invoice cancel button: clear editing state and reset form
const invCancelBtn = qs('#invoiceCancelBtn'); if(invCancelBtn){ invCancelBtn.addEventListener('click', ()=>{
  const form = qs('#invoiceForm'); if(!form) return; form.reset(); delete form.dataset.editing; delete form.dataset.editingGroupIds; const submitBtn = form.querySelector('button[type="submit"]'); if(submitBtn) submitBtn.textContent = 'Add Invoice'; invCancelBtn.style.display = 'none'; const sub = qs('#invoiceSubmitted'); if(sub) sub.value = new Date().toISOString().slice(0,10);
  const leaseSearchEl2 = qs('#invoiceLeaseSearch'); if(leaseSearchEl2){ leaseSearchEl2.value=''; leaseSearchEl2.dispatchEvent(new Event('input')); }
  const unitSearchEl2 = qs('#invoiceUnitSearch'); if(unitSearchEl2){ unitSearchEl2.value=''; unitSearchEl2.dispatchEvent(new Event('input')); }
  if(typeof renderInvoiceLeaseDetailTable === 'function') renderInvoiceLeaseDetailTable();
  if(typeof renderInvoiceUnitBreakdown === 'function') renderInvoiceUnitBreakdown();
}); }

// Always-visible "Clear" button for the Invoice Registration form — wipes every entered
// field (WD/Doc/Category/Amount/dates/lease & unit selections/breakdown/comment) back to a
// blank Add-new state, whether or not an edit was in progress.
const invoiceClearBtn = qs('#invoiceClearBtn');
if(invoiceClearBtn){
  invoiceClearBtn.addEventListener('click', () => {
    const form = qs('#invoiceForm'); if(!form) return;
    form.reset();
    delete form.dataset.editing;
    delete form.dataset.editingGroupIds;
    const submitBtn = form.querySelector('button[type="submit"]'); if(submitBtn) submitBtn.textContent = 'Add Invoice';
    const invCancel = qs('#invoiceCancelBtn'); if(invCancel) invCancel.style.display = 'none';
    const sub = qs('#invoiceSubmitted'); if(sub) sub.value = new Date().toISOString().slice(0,10);
    _invoiceUnitCheckOrder = [];

    const leaseSearchEl = qs('#invoiceLeaseSearch'); if(leaseSearchEl){ leaseSearchEl.value=''; leaseSearchEl.dispatchEvent(new Event('input')); }
    const unitSearchEl = qs('#invoiceUnitSearch'); if(unitSearchEl){ unitSearchEl.value=''; unitSearchEl.dispatchEvent(new Event('input')); }
    if(typeof renderInvoiceLeaseDetailTable === 'function') renderInvoiceLeaseDetailTable();
    if(typeof renderInvoiceUnitBreakdown === 'function') renderInvoiceUnitBreakdown();

    const commentHiddenInput = qs('#invoiceComment');
    if(commentHiddenInput) commentHiddenInput.value = '';
    const commentBtn = qs('#invoiceCommentBtn');
    if(commentBtn){
      commentBtn.textContent = 'Add Comment';
      commentBtn.title = '';
      try{ commentBtn.classList.remove('btn-warning'); commentBtn.classList.add('btn-primary'); }catch(e){}
    }
    if(typeof resetInvoiceQuarterlyPeriods === 'function') resetInvoiceQuarterlyPeriods();
  });
}

// Shared multi-term search parsing, used by every search bar in the app.
// Syntax: comma "," = OR (any term in the group matches), semicolon ";" = AND
// (every group must have at least one matching term). Groups can combine both,
// e.g. "19-10298,ACU-804; Operational" = (19-10298 OR ACU-804) AND Operational.
// A trailing "." on any individual term makes that one term an exact/whole-value lookup
// instead of a substring match — e.g. searching unit "511" as a plain substring also matches
// "5112565", "5248511", "sdhud511"; searching "511." matches only the unit actually named 511.
// Mixable with the rest: "511.,T10587,T105779" = exact 511, OR substring T10587, OR T105779.
function parseSearchGroups(raw){
  return (raw || '')
    .split(';')
    .map(group => group.split(',').map(t => {
      const trimmed = t.trim();
      const exact = trimmed.length > 1 && trimmed.endsWith('.');
      const term = (exact ? trimmed.slice(0, -1) : trimmed).trim().toLowerCase();
      return { term, exact };
    }).filter(t => t.term.length > 0))
    .filter(group => group.length > 0);
}

function matchesSearchGroups(groups, fields){
  if(!groups || groups.length === 0) return true;
  return groups.every(orTerms => orTerms.some(({ term, exact }) => fields.some(f => {
    if(!exact) return f.includes(term);
    // Exact/whole-token match — split the field on whitespace/comma/semicolon so a composite
    // field (e.g. a joined list of unit ids) matches only a token equal to the term, not a
    // substring buried inside a different token.
    return f.split(/[\s,;]+/).some(tok => tok === term);
  })));
}

// small helper to avoid HTML injection in table cells
function escapeHtml(str){
  return String(str).replace(/[&<>"']/g, s => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[s]));
}

// --- Config list protection (Sheets is the only source of truth) ---
// Snapshot of what Sheets returned on last load. Never stored in localStorage.
const _CFG_FIELDS = ['devCompanies','devRentals','devSuppliers','devPayments','devArrangements','devOtherCharges'];
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
    try{ populateInvoiceTrackingDropdowns(); }catch(e){}
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
  let _autoRefreshCycleCount = 0;
  // "Manual Coverage" is by far the largest sheet (one row per manually-covered day per unit —
  // 200,000+ rows and growing) and dominates every cycle's cost; fetching it only every Nth
  // cycle keeps ITS effective freshness roughly what it always was (~this many × the interval
  // below) while every other, faster-changing sheet (invoices, units, leases, accruals) gets
  // refreshed far more often. On a cycle it's skipped, the code below carries forward whatever
  // manual coverage state is already in memory — the exact same fallback already used when the
  // fetch genuinely fails, just triggered deliberately instead of by an error.
  const MANUAL_COVERAGE_FETCH_EVERY_N_CYCLES = 2;

  // 45s (not the original 25s): measured against the live system, fetching all these sheets in
  // parallel already took ~35s on its own — every request (read or write, from any operator)
  // serializes through one global Apps Script lock, so this isn't optional overhead to shave
  // down, it's the real cost of the current data volume. A timeout shorter than that made
  // ordinary cycles fail silently (just a console warning) well before 60s ever came into play,
  // which is what was actually behind "Updated" going stale for several minutes at a stretch —
  // not the interval itself.
  const fetchWithTimeout = (promise, ms=45000) => {
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
    // Skip this cycle entirely while the Registry Edit modal is open: replacing
    // state.registries with freshly-fetched objects mid-edit would invalidate the exact
    // object reference the edit/save flow holds onto (_registryBeingEdited), causing a
    // "Registry not found" error on save if the modal stays open past this 60s interval.
    const registryModal = qs('#registryEditModal');
    if(registryModal && getComputedStyle(registryModal).display !== 'none') return;
    // Same idea for a pending (not-yet-accepted) manual-coverage edit in the Accruals panel:
    // replacing state.units mid-edit would silently overwrite the in-progress local changes
    // with whatever's still on the sheet (this edit hasn't been saved there yet), discarding
    // the operator's unsaved clicks/drags the moment this interval happens to fire.
    if(typeof _accrualsHasPendingChanges !== 'undefined' && _accrualsHasPendingChanges) return;
    // And even after Accept, the save/delete request itself is still in flight for a moment —
    // a re-fetch of "Manual Coverage" that lands before that request finishes would see the
    // sheet exactly as it was before the edit and silently overwrite the just-accepted local
    // state right back to it.
    if(typeof _accrualsSyncInFlight !== 'undefined' && _accrualsSyncInFlight) return;

    _refreshRunning = true;
    _autoRefreshCycleCount++;
    const shouldFetchManualCoverage = (_autoRefreshCycleCount % MANUAL_COVERAGE_FETCH_EVERY_N_CYCLES) === 1;
    try{
      const [registries, units, leases, users, accrualsRaw, manualCoverageRaw, meta] = await fetchWithTimeout(
        Promise.all([
          DB.get({ action: 'getAll', sheet: 'invoices' }),
          DB.get({ action: 'getAll', sheet: 'units' }),
          DB.get({ action: 'getAll', sheet: 'leases' }),
          DB.get({ action: 'getAll', sheet: 'users' }),
          // Guarded like loadAll()'s own fetch of these — this refresh must keep working even
          // if one of these newer sheets is temporarily unreachable.
          DB.get({ action: 'getAll', sheet: 'Accruals' }).catch(() => null),
          // Skipped on most cycles (see MANUAL_COVERAGE_FETCH_EVERY_N_CYCLES above) — resolves
          // to null exactly like a genuine fetch failure would, so the existing fallback below
          // (carry forward whatever's already in state.units) applies unchanged either way.
          shouldFetchManualCoverage ? DB.get({ action: 'getAll', sheet: 'Manual Coverage' }).catch(() => null) : Promise.resolve(null),
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
        leases: (()=>{ const v = DB.parseField(r.leases); return Array.isArray(v) ? v : []; })(),
        unitDetails: (()=>{ const v = DB.parseField(r.unitDetails); return Array.isArray(v) ? v : []; })(),
        periods: (()=>{ const v = DB.parseField(r.periods); return Array.isArray(v) ? v : []; })(),
        invoiceDate: String(r['Invoice Date'] || r.invoiceDate || ''),
        periodStart: String(r.periodStart || '').slice(0,10),
        periodEnd: String(r.periodEnd || '').slice(0,10),
        submittedDate: String(r.submittedDate || '').slice(0,10),
        createdAt: String(r.createdAt || ''),
        units: DB.parseField(r.units),
        comments: DB.parseField(r.comments) || []
      }));

      // Manual coverage lives in its own "Manual Coverage" sheet (see db.js's loadAll for the
      // full explanation) — this refresh must attach it the exact same way, or every unit
      // object it rebuilds here would silently lose its manualCoverageDates/manualCoverageRowIds
      // every 60 seconds, making any manual coverage marked in the meantime look like it
      // "un-splits" itself back out of the missing-periods table the next time it recomputes.
      if(Array.isArray(manualCoverageRaw)){
        const parsedManualCoverage = manualCoverageRaw.map(mc => ({
          id: String(mc.id || ''), unitId: String(mc.unitId || ''), date: String(mc.date || '')
        }));
        state.units = units.map(u => {
          const uidNorm = String(u.unitId || '').trim().toLowerCase();
          const ownCoverage = parsedManualCoverage.filter(mc => mc.unitId.trim().toLowerCase() === uidNorm);
          return {
            ...u,
            id: String(u.id || ''),
            lease: String(u.lease || ''),
            unitId: String(u.unitId || ''),
            status: String(u.status || ''),
            statusHistory: DB.parseField(u.statusHistory) || [],
            comments: DB.parseField(u.comments) || [],
            overviewComments: DB.parseField(u.overviewComments) || [],
            manualCoverageDates: ownCoverage.map(r => r.date),
            manualCoverageRowIds: ownCoverage.reduce((acc, r) => { acc[r.date] = r.id; return acc; }, {})
          };
        });
      } else {
        // The Manual Coverage fetch itself failed this cycle — rebuild everything else as
        // usual, but carry each unit's existing in-memory manual coverage forward by unitId
        // rather than silently dropping it.
        const existingByUnitId = new Map((state.units || []).map(u => [String(u.unitId || '').trim().toLowerCase(), u]));
        state.units = units.map(u => {
          const uidNorm = String(u.unitId || '').trim().toLowerCase();
          const existing = existingByUnitId.get(uidNorm);
          return {
            ...u,
            id: String(u.id || ''),
            lease: String(u.lease || ''),
            unitId: String(u.unitId || ''),
            status: String(u.status || ''),
            statusHistory: DB.parseField(u.statusHistory) || [],
            comments: DB.parseField(u.comments) || [],
            overviewComments: DB.parseField(u.overviewComments) || [],
            manualCoverageDates: existing ? existing.manualCoverageDates : [],
            manualCoverageRowIds: existing ? existing.manualCoverageRowIds : {}
          };
        });
      }

      if(Array.isArray(accrualsRaw)){
        state.accruals = accrualsRaw.map(a => ({
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
          overrideSourceFrom: String(a.overrideSourceFrom || ''),
          overrideSourceTo: String(a.overrideSourceTo || ''),
          accrualComments: (() => { const v = DB.parseField(a.accrualComments); return Array.isArray(v) ? v : []; })(),
          createdAt: String(a.createdAt || '')
        }));
      }
      // else: Accruals fetch failed this cycle — leave state.accruals exactly as it was.

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
      ['devCompanies','devRentals','devSuppliers','devPayments','devArrangements','devOtherCharges'].forEach(f => {
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

      // Silent state update only — no renderAll() to avoid freezing large datasets. The one
      // exception is the Accruals tab: it caches its computed rows (see
      // _accrualsMissingRowsCache/_accrualsManualRowsCache) rather than recomputing from state
      // on every render, so a change from another session (a new invoice, a status change)
      // pulled in above would otherwise sit in `state` correctly updated but never actually
      // reach the screen until the operator happened to navigate away and back. This repaints
      // it in place, preserving whatever row/unit is currently selected, only when that tab is
      // actually the one on screen right now.
      if(typeof silentlyRefreshAccrualsIfVisible === 'function') silentlyRefreshAccrualsIfVisible();

      updateTimestamp();

    }catch(e){
      console.warn('Auto-refresh skipped:', e.message);
    }
    _refreshRunning = false;
    // 30s (was 60s) — safe now that Manual Coverage (the dominant cost) is staggered out of
    // most cycles and the timeout above has real headroom; _refreshRunning still guards against
    // two cycles ever overlapping if one happens to run long.
  }, 30000);

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
  state.meta.devOtherCharges = state.meta.devOtherCharges || [];

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

function renderAll(){ renderOverview(); renderInvoices(); renderRegistries(); renderUnits(); renderLeases(); renderUsers(); renderUnitOverview(); renderLeaseOverview(); renderReport(); renderCCControl(); if(typeof renderInvoiceTrackingTable === 'function') renderInvoiceTrackingTable(); }

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

// Counts total days in [fromIso, toIso] (inclusive both ends, matching every other period range
// in this app) and how many of those days the unit was Disabled — used to pro-rate an Invoice
// Dispute Tracking amount down to just the days actually affected, rather than disputing the
// unit's whole invoiced amount for a period it was only partly out of service for.
function computeDisabledDaysInPeriod(unit, fromIso, toIso){
  if(!fromIso || !toIso) return { totalDays: 0, disabledDays: 0 };
  const from = new Date(fromIso + 'T00:00:00');
  const to = new Date(toIso + 'T00:00:00');
  if(isNaN(from) || isNaN(to) || from > to) return { totalDays: 0, disabledDays: 0 };
  const disabledPeriods = getDisabledPeriods(unit);
  let totalDays = 0, disabledDays = 0;
  for(let cur = new Date(from); cur <= to; cur.setDate(cur.getDate() + 1)){
    totalDays++;
    if(isDateInDisabledPeriod(cur.getFullYear(), cur.getMonth(), cur.getDate(), disabledPeriods)) disabledDays++;
  }
  return { totalDays, disabledDays };
}

// Flags whether a unit's disabled history overlaps enough of an invoice's own coverage window
// that a return-timing dispute likely applies — a quick "should this probably be disputed?"
// signal an operator can eyeball across the Invoice Registration, Invoice Dispute Tracking, and
// Dispute Detail screens, well before running the actual day-by-day pro-ration. Flags true when
// the unit has a disabled period that either never returned (still disabled today) or returned
// ON OR AFTER the invoice's own From Date — meaning it was still out of service for at least
// part of what that invoice is billing for. Scans every disabled period (not just the current
// one) so a unit with multiple disable/return cycles is still caught correctly; prefers the
// LATEST qualifying period for the returned/disabledFrom dates shown back to the operator, since
// that's the one most likely relevant to a recent invoice.
function computeUnitReturnDisputeFlag(unit, invoiceFromIso){
  const empty = { flagged: false, disabledFrom: '', returnedDate: '', stillDisabled: false };
  if(!unit || !invoiceFromIso) return empty;
  const periods = getDisabledPeriods(unit);
  for(let i = periods.length - 1; i >= 0; i--){
    const p = periods[i];
    if(!p.toDate || p.toDate > invoiceFromIso){
      return { flagged: true, disabledFrom: p.fromDate || '', returnedDate: p.toDate || '', stillDisabled: !p.toDate };
    }
  }
  return empty;
}

// Every date range this unit is covered by an invoice that's currently tracked as disputed
// (Invoice Tracking tab) — mirrors getDisabledPeriods/isDateInDisabledPeriod so day-square
// rendering can flag disputed coverage the same way it already flags disabled periods.
function getDisputedPeriods(unit){
  const unitId = (unit.unitId || unit.id || '').toString().trim().toLowerCase();
  if(!unitId) return [];
  const disputedWds = new Set(
    (state.invoiceTracking || [])
      .filter(t => Array.isArray(t.unitsInDispute) && t.unitsInDispute.some(u => (u||'').toString().trim().toLowerCase() === unitId))
      .map(t => (t.wdInvoiceNum||'').toString().trim().toLowerCase())
      .filter(Boolean)
  );
  if(disputedWds.size === 0) return [];
  const periods = [];
  (state.registries || []).forEach(reg => {
    const regWd = (reg.wdNumber||'').toString().trim().toLowerCase();
    if(!disputedWds.has(regWd)) return;
    getRegistryCoveragePeriods(reg).forEach(slice => {
      const inSlice = (slice.units||[]).some(u => (u||'').toString().trim().toLowerCase() === unitId);
      if(inSlice && slice.from && slice.to) periods.push({ from: slice.from, to: slice.to });
    });
  });
  return periods;
}

function isDateInDisputedPeriod(year, month, day, disputedPeriods){
  if(!disputedPeriods || disputedPeriods.length === 0) return false;
  const monthStr = String(month + 1).padStart(2, '0');
  const dayStr = String(day).padStart(2, '0');
  const checkDateStr = `${year}-${monthStr}-${dayStr}`;
  return disputedPeriods.some(p => checkDateStr >= p.from && checkDateStr <= p.to);
}

// Manual coverage: individual days an operator has confirmed as covered from the Accruals
// coverage panel even though no registry/invoice actually covers them (e.g. one that hasn't
// been entered yet). Once marked, a day counts as ordinary rental coverage everywhere in the
// app — every coverage computation below folds these in through this one shared pair of
// helpers, so nothing needs its own separate "is this manually covered" logic.
function getManualCoverageDates(unit){
  return Array.isArray(unit.manualCoverageDates) ? unit.manualCoverageDates : [];
}
function isManuallyCovered(unit, year, month, day){
  const dates = getManualCoverageDates(unit);
  if(!dates.length) return false;
  const dateStr = `${year}-${String(month+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
  return dates.indexOf(dateStr) !== -1;
}
// Every period this unit already has an accrual OR not-accruable record for — OPEN or CLOSED,
// doesn't matter — is a decision the operator already made and is frozen: it must never be
// recomputed as "missing" again (see computeUnitMissingPeriods). A brand new gap that opens up
// later (an edit uncovers something, or time simply keeps passing with no invoice) is always its
// own separate period to judge, never folded back into an old frozen one. See
// [[accruals_cumulative_history]] for why this replaced the earlier "same gap regrows forever"
// model.
// excludeAccrualId: leaves one specific record's own range out of the freeze set — needed by
// reconcileOpenAccrualsCoverage, which re-runs this same day-by-day check restricted to an open
// record's OWN range to ask "absent this record's own reservation, is there still a genuine gap
// here". Without the exclusion, a record would always see its own days as already frozen/covered
// and get treated as fully resolved (deleted) on every single reconcile pass.
function getAccrualFrozenRanges(unit, excludeAccrualId){
  const unitIdNorm = String(unit.unitId || unit.id || '').trim().toLowerCase();
  if(!unitIdNorm) return [];
  return (state.accruals || [])
    .filter(a => String(a.unitId || '').trim().toLowerCase() === unitIdNorm && a.periodStart && a.periodEnd && a.id !== excludeAccrualId)
    .map(a => ({ start: a.periodStart, end: a.periodEnd }));
}
function isFrozenByAccrualDecision(dateStr, frozenRanges){
  return frozenRanges.some(p => dateStr >= p.start && dateStr <= p.end);
}
// Sets (doesn't toggle) one date's manual-coverage membership without saving/persisting — a
// click or drag applies this locally to however many dates are touched, and persistManualCoverage
// only runs once the operator clicks "Accept manual coverage" in the panel.
function setManualCoverageDate(unit, year, month, day, covered){
  unit.manualCoverageDates = Array.isArray(unit.manualCoverageDates) ? unit.manualCoverageDates.slice() : [];
  unit.manualCoverageRowIds = (unit.manualCoverageRowIds && typeof unit.manualCoverageRowIds === 'object') ? unit.manualCoverageRowIds : {};
  const dateStr = `${year}-${String(month+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
  const idx = unit.manualCoverageDates.indexOf(dateStr);
  if(covered && idx === -1) unit.manualCoverageDates.push(dateStr);
  else if(!covered && idx !== -1) unit.manualCoverageDates.splice(idx, 1);
  // Match by unitId (not the generic sheet "id", which can be blank on older rows) — two units
  // that both happen to have a blank "id" would otherwise match the same findIndex result and
  // silently clobber each other's slot in state.units.
  const uidNorm = String(unit.unitId || unit.id || '').trim().toLowerCase();
  const stateIdx = (state.units || []).findIndex(u => String(u.unitId || u.id || '').trim().toLowerCase() === uidNorm);
  if(stateIdx !== -1) state.units[stateIdx] = unit;
}
// Snapshot of a unit's manual-coverage dates exactly as they were durably saved when the panel
// was last freshly rendered for it (see renderAccrualsCoveragePanel) — lets persistManualCoverage
// tell "genuinely new/removed since last Accept" apart from "toggled back to what it already
// was this session", so it only ever calls the network for an actual net change.
let _accrualsSessionOriginalDates = new Set();

// True from the moment ANY Accruals-tab action (manual-coverage accept, Accrue Unit, its Undo,
// Close Month Accruals, or the per-row Remove button) fires its save/update/delete network
// call(s), until they actually finish (success or failure) — separate from
// _accrualsHasPendingChanges, which goes false the instant Accept is clicked, well before the
// request completes. The background auto-refresh checks THIS flag too and skips its entire
// cycle while it's true, so a re-fetch of "Manual Coverage"/"Accruals"/meta can never land
// mid-save and silently revert whichever of those actions is still in flight.
let _accrualsSyncInFlight = false;

// Saves/deletes exactly the dates that actually changed since the panel was opened for this
// unit — each manually-covered date is its own row in the "Manual Coverage" sheet (see
// db.js's bulkSaveManualCoverage/bulkDeleteManualCoverage), so this never touches any other
// unit field. This replaces an earlier version that called DB.updateUnit(unit) with the unit's
// *entire* record: any other in-flight edit to the same unit (a comment, a status change)
// sends its own full snapshot too, and whichever write reached the sheet last silently won —
// if that snapshot was taken before the manual-coverage edit, it wiped the mark back out.
// Per-date rows can't collide like that, since nothing else in the app ever touches this sheet.
//
// Everything changed this session is batched into ONE save request and ONE delete request,
// not one request per date — a wide drag across several months can touch 100+ dates, and
// firing that many near-simultaneous requests at Apps Script's single LockService queue (30s
// client timeout on top) meant a random subset would silently fail, which is exactly what was
// making only "some" of a large drag actually stick after a refresh.
function persistManualCoverage(unit){
  try{ saveState(); }catch(e){}
  unit.manualCoverageRowIds = (unit.manualCoverageRowIds && typeof unit.manualCoverageRowIds === 'object') ? unit.manualCoverageRowIds : {};
  const uid = (unit.unitId || unit.id || '').toString();
  const current = new Set(unit.manualCoverageDates || []);

  const toSave = [];
  const toDeleteIds = [];

  _accrualsPendingDates.forEach(dateStr => {
    const nowCovered = current.has(dateStr);
    const wasCovered = _accrualsSessionOriginalDates.has(dateStr);
    if(nowCovered && !wasCovered){
      const rowId = unit.manualCoverageRowIds[dateStr] || id();
      unit.manualCoverageRowIds[dateStr] = rowId;
      toSave.push({ id: rowId, unitId: uid, date: dateStr, createdAt: new Date().toISOString() });
    } else if(!nowCovered && wasCovered){
      const rowId = unit.manualCoverageRowIds[dateStr];
      if(rowId) toDeleteIds.push(rowId);
      delete unit.manualCoverageRowIds[dateStr];
    }
    // nowCovered === wasCovered: toggled back to its original state within this same pending
    // session (e.g. marked then unmarked before Accept) — nothing to reconcile remotely.
  });

  const pending = [];
  if(toSave.length > 0){
    pending.push(DB.bulkSaveManualCoverage(toSave).catch(e => console.error('Manual coverage bulk save error:', e)));
  }
  if(toDeleteIds.length > 0){
    pending.push(DB.bulkDeleteManualCoverage(toDeleteIds).catch(e => console.error('Manual coverage bulk delete error:', e)));
  }
  if(pending.length > 0){
    _accrualsSyncInFlight = true;
    Promise.allSettled(pending).finally(() => { _accrualsSyncInFlight = false; });
  }

  _accrualsSessionOriginalDates = new Set(current);
}

// Click-and-drag support for marking a whole run of blank (or a whole run of manual) squares
// in one gesture, instead of one click per day. mousedown on an eligible square starts the
// drag and fixes its "mode" (mark if the square was blank, unmark if it was already manual);
// dragging over other squares only ever touches ones matching that same starting state, so a
// drag can't accidentally cross from marking into unmarking or vice versa.
//
// Nothing is saved, or reflected on any other table, until the operator clicks "Accept manual
// coverage" in the panel — a drag only ever mutates the unit object in memory and repaints the
// touched squares directly, so marking a run of days doesn't trigger the (comparatively
// expensive) missing-periods recompute/re-render on every square or every mouseup. While any
// change is pending, switching units (Prev/Next or picking another row) is blocked so a pending
// edit can never be silently abandoned or overwritten by a fresh render of a different unit.
let _accrualsDrag = null;
let _accrualsPanelUnit = null;
let _accrualsHasPendingChanges = false;
let _accrualsPendingDates = new Set();

function applyManualSquareStyle(sq, tdDay, covered, dayState){
  if(covered){
    sq.style.background = '#581c87';
    sq.style.color = '#e9d5ff';
    sq.style.border = '1px solid #a855f7';
    tdDay.title = 'Manually confirmed coverage (pending) — click to remove';
    return;
  }
  // Un-marking: dayState was computed while the manual mark still counted toward coverage (see
  // getDayState), so back its contribution out before repainting — otherwise a day whose ONLY
  // coverage was the manual mark itself would incorrectly keep showing green/red after being
  // unmarked, and a day that ALSO has a real invoice would incorrectly flash blank/black instead
  // of reverting to that real status's color.
  const realCount = (dayState ? dayState.rentalCount : 0) - (dayState && dayState.manual ? 1 : 0);
  const realCovered = realCount > 0;
  const realOverlap = realCount > 1;
  if(dayState && dayState.disabled){
    sq.style.background = realCovered ? '#166534' : '#1c0a0a';
    sq.style.color = realCovered ? '#4ade80' : '#f87171';
    sq.style.border = realCovered ? '1px solid #22c55e' : '1px solid #7f1d1d';
  } else if(dayState && dayState.credit){
    sq.style.background = realOverlap ? '#fee2e2' : (realCovered ? '#dcfce7' : '#fff');
    sq.style.border = '2px solid #eab308';
    sq.style.color = '#eab308';
  } else if(realOverlap){
    sq.style.background = '#7f1d1d';
    sq.style.color = '#fca5a5';
    sq.style.border = '1px solid #ef4444';
  } else if(realCovered){
    sq.style.background = '#14532d';
    sq.style.color = '#4ade80';
    sq.style.border = '1px solid #166534';
  } else {
    sq.style.background = '#111827';
    sq.style.color = '#374151';
    sq.style.border = '1px solid #1f2937';
  }
  tdDay.title = 'Click, or click and drag, to mark as manually covered';
}

function updateAccrualsAcceptButton(){
  const btn = qs('#accrualsPanelAcceptBtn');
  const clearBtn = qs('#accrualsPanelClearBtn');
  const countEl = qs('#accrualsPanelPendingCount');
  if(btn){
    btn.disabled = !_accrualsHasPendingChanges;
    btn.style.opacity = _accrualsHasPendingChanges ? '1' : '0.4';
    btn.style.cursor = _accrualsHasPendingChanges ? 'pointer' : 'not-allowed';
  }
  if(clearBtn){
    clearBtn.disabled = !_accrualsHasPendingChanges;
    clearBtn.style.opacity = _accrualsHasPendingChanges ? '1' : '0.4';
    clearBtn.style.cursor = _accrualsHasPendingChanges ? 'pointer' : 'not-allowed';
  }
  if(countEl){
    countEl.textContent = _accrualsHasPendingChanges
      ? `${_accrualsPendingDates.size} day(s) pending — accept to save`
      : 'No pending changes';
  }
}

// Blocks switching to a different row/unit while a manual-coverage edit hasn't been accepted
// yet — called at the top of the row-click and Prev/Next handlers.
function accrualsPanelBlockedByPending(){
  if(!_accrualsHasPendingChanges) return false;
  alert('You have pending manual coverage changes — click "Accept manual coverage" first before switching units.');
  return true;
}

function endAccrualsDrag(){
  if(!_accrualsDrag) return;
  _accrualsDrag.touched.forEach(dateStr => _accrualsPendingDates.add(dateStr));
  _accrualsDrag = null;
  _accrualsHasPendingChanges = _accrualsPendingDates.size > 0;
  updateAccrualsAcceptButton();
  if(typeof updateAccrueUnitButton === 'function') updateAccrueUnitButton();
}

function acceptAccrualsManualCoverage(){
  if(!_accrualsHasPendingChanges || !_accrualsPanelUnit) return;
  const unit = _accrualsPanelUnit;
  persistManualCoverage(unit);
  _accrualsHasPendingChanges = false;
  _accrualsPendingDates = new Set();

  // Point Manual Coverage's OWN selection at the unit just edited BEFORE rendering it below —
  // Table 1 already does the equivalent for itself (refreshAccrualsRowsForUnit re-targets
  // _accrualsSelectedRowKey when the old one stops matching a row for this unit), but Manual
  // Coverage's previous selection is for a completely unrelated unit and stays perfectly
  // valid, so without this it silently keeps pointing at whatever was selected there before.
  // That's what made a just-accepted period look like it "isn't marked": the operator was
  // looking at a stale, different unit's row, not the one they'd just worked on. Computed
  // directly from the unit's own dates (not the list cache, which isn't rebuilt until the
  // render call below) so the render's own trailing auto-select picks the right row on its
  // first pass instead of falling back to whatever was selected before.
  //
  // Only reassigns when the edited unit STILL has a manual-coverage period — if it was just
  // fully unmarked (periods.length === 0), its own row is gone and there's nothing to point
  // at here; leaving the key untouched lets renderAccrualsManualPeriods's own "advance to the
  // next remaining row" fallback do its job using the stale (but still meaningful) key,
  // instead of this unconditionally nulling it out and forcing a jump to the first row.
  try{
    const periods = computeUnitManualCoveragePeriods(unit);
    if(periods.length > 0){
      const uidLower = (unit.unitId || unit.id || '').toString().toLowerCase();
      _accrualsManualSelectedRowKey = uidLower + '|' + periods[0].start.getTime();
    }
  }catch(e){}

  // A manual-coverage edit can move a period between these two lists in either direction, so
  // both need refreshing regardless of which sub-tab is currently visible — each render
  // function only auto-selects/drives the shared panel when its own sub-tab is the one
  // actually on screen (see renderAccrualsMissingPeriods/renderAccrualsManualPeriods), so
  // refreshing the one that's hidden can never hijack the panel away from what's showing.
  if(typeof refreshAccrualsRowsForUnit === 'function') refreshAccrualsRowsForUnit(unit);
  if(typeof renderAccrualsManualPeriods === 'function') renderAccrualsManualPeriods(true);

  if(typeof updateAccrueUnitButton === 'function') updateAccrueUnitButton();
}
// Discards every pending (not-yet-accepted) click/drag from this session, reverting each
// touched date back to whatever it was when the panel was last freshly opened for this unit
// (_accrualsSessionOriginalDates) — a day that was already manually covered from an earlier,
// already-accepted session is left exactly as it was unless THIS session touched it. Purely
// local: nothing was ever saved to the sheet for a pending edit, so there's nothing to undo
// remotely, just a plain in-memory revert + repaint.
function clearAccrualsPendingSelection(){
  if(!_accrualsHasPendingChanges || !_accrualsPanelUnit) return;
  const unit = _accrualsPanelUnit;
  unit.manualCoverageDates = Array.isArray(unit.manualCoverageDates) ? unit.manualCoverageDates.slice() : [];

  _accrualsPendingDates.forEach(dateStr => {
    const wasCovered = _accrualsSessionOriginalDates.has(dateStr);
    const idx = unit.manualCoverageDates.indexOf(dateStr);
    if(wasCovered && idx === -1) unit.manualCoverageDates.push(dateStr);
    else if(!wasCovered && idx !== -1) unit.manualCoverageDates.splice(idx, 1);
  });

  _accrualsPendingDates = new Set();
  _accrualsHasPendingChanges = false;
  updateAccrualsAcceptButton();
  if(typeof updateAccrueUnitButton === 'function') updateAccrueUnitButton();

  // Repaint the grid/stats so the squares reflect the reverted state immediately.
  buildUnitCoverageGrid(unit, 'accrualsPanelGrid', 'accrualsPanelPopup', true);
  buildUnitStats(unit, 'accrualsPanelStats');
}

const accrualsPanelAcceptBtnEl = qs('#accrualsPanelAcceptBtn');
if(accrualsPanelAcceptBtnEl) accrualsPanelAcceptBtnEl.addEventListener('click', acceptAccrualsManualCoverage);
const accrualsPanelClearBtnEl = qs('#accrualsPanelClearBtn');
if(accrualsPanelClearBtnEl) accrualsPanelClearBtnEl.addEventListener('click', clearAccrualsPendingSelection);

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
  searchInput.placeholder = 'Filter by unit, lease, arrangement, invoicing... ("," = or, ";" = and, "term." = exact)';
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
        const unitId = (u.unitId || '').toString().trim().toLowerCase();
        const unitIdAlt = (u.id || '').toString().trim().toLowerCase();

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

        // Per-period for a quarterly invoice (see getRegistryCoveragePeriods) — a unit only
        // present in one period's own table must only be marked covered for that period's
        // own dates, not the registry's whole overall declared range.
        getRegistryCoveragePeriods(reg).forEach(slice => {
          const isInSlice = slice.units.some(unitStr => {
            const regUnit = (unitStr || '').toString().trim().toLowerCase();
            return regUnit === unitId || regUnit === unitIdAlt;
          });
          if(!isInSlice || !slice.from || !slice.to) return;

          // Parse dates as local dates to avoid timezone issues
          const startParts = slice.from.toString().trim().split('-');
          const endParts = slice.to.toString().trim().split('-');
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
        });
      });

      // Manual coverage (Accruals coverage panel) counts as ordinary rental coverage everywhere.
      for(let dd = 1; dd <= daysInMonth; dd++){
        if(isManuallyCovered(u, year, month, dd)) coveredDays.set(dd, (coveredDays.get(dd) || 0) + 1);
      }

      // Get disabled periods for this unit
      const disabledPeriods = getDisabledPeriods(u);
      const disputedPeriods = getDisputedPeriods(u);

      // Day columns - create squares for each day with day numbers inside
      for(let d = 1; d <= daysInMonth; d++){
        const tdDay = document.createElement('td');
        tdDay.style.padding = '2px';
        tdDay.style.textAlign = 'center';
        tdDay.style.verticalAlign = 'middle';

        // Check if this day is in a disabled period
        const isDisabled = isDateInDisabledPeriod(year, month, d, disabledPeriods);
        const isDisputed = isDateInDisputedPeriod(year, month, d, disputedPeriods);

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

        // Manual coverage (Accruals coverage panel): a day marked manually can only ever be the
        // sole contributor to a plain single-coverage count (real coverage on the same day
        // would already show as overlap instead), so replace the green with purple here to make
        // it easy to tell apart from a real invoice at a glance.
        if(coverageCount === 1 && !hasCredit && isManuallyCovered(u, year, month, d)){
          square.style.backgroundColor = '#f3e8ff';
          square.style.borderColor = '#a855f7';
          square.style.color = '#6b21a8';
          square.style.fontWeight = '600';
          square.title = 'Manually confirmed coverage — no invoice expected';
        }

        // Disputed invoice coverage: pink + bold just on the day number, layered on top of
        // whatever background/border the coverage/overlap/credit/disabled logic above already
        // set, so it never conflicts with those existing status colors.
        if(isDisputed){
          square.style.color = '#db2777';
          square.style.fontWeight = '800';
          square.title = (square.title ? square.title + ' | ' : '') + 'Invoice under dispute for this day';
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
  searchInput.placeholder = 'Filter by lease, company, supplier, invoicing... ("," = or, ";" = and, "term." = exact)';
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
      const disputedDays = new Set();
      const invoices = state.invoices || [];
      const registries = state.registries || [];
      // Lease-level rollup can't isolate which specific unit a dispute applies to, so a day is
      // flagged disputed here whenever ANY invoice covering it under this lease has an open
      // dispute record for that WD number (coarser than the per-unit checks elsewhere).
      const disputedWdSet = new Set((state.invoiceTracking || []).map(t => (t.wdInvoiceNum||'').toString().trim().toLowerCase()).filter(Boolean));

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
              const regDisputed = disputedWdSet.has((reg.wdNumber||'').toString().trim().toLowerCase());
              // Add all days in the period that fall in the selected month/year
              const currentDate = new Date(startDate);
              while(currentDate <= endDate){
                if(currentDate.getFullYear() === year && currentDate.getMonth() === month){
                  coveredDays.add(currentDate.getDate());
                  if(regDisputed) disputedDays.add(currentDate.getDate());
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
              const invDisputed = disputedWdSet.has((inv.wdNumber||'').toString().trim().toLowerCase());
              // Add all days in the period that fall in the selected month/year
              const currentDate = new Date(startDate);
              while(currentDate <= endDate){
                if(currentDate.getFullYear() === year && currentDate.getMonth() === month){
                  coveredDays.add(currentDate.getDate());
                  if(invDisputed) disputedDays.add(currentDate.getDate());
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
        if(disputedDays.has(d)){ square.style.color = '#db2777'; square.style.fontWeight = '800'; square.title = 'Invoice under dispute for this day'; }

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
      const headers = ['Unit','Lease','AGI Company','Supplier','Arrangement','Invoicing','Status'];
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
        const base = [u.unitId||'', u.lease||'', u.company||'', u.supplier||'', u.arrangement||'', u.invoicing||'', u.status||'Operational']
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
        {wch:14},{wch:12},{wch:14},{wch:14},{wch:14},{wch:12},{wch:10},
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
      const headers = ['#','Unit','Lease','AGI Company','Supplier','Description','Invoicing','Last WD Number','Status','Consecutive Months (no rental invoice)','Period'];
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
          row.u.company||'',
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
      wsMonths['!cols'] = [{wch:6},{wch:14},{wch:12},{wch:14},{wch:18},{wch:12},{wch:16},{wch:12},{wch:14},{wch:20}];
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

    // Registries (Rental) covering this unit — per-period for a quarterly invoice (see
    // getRegistryCoveragePeriods), so a unit only in one period's own table is only marked
    // covered for that period's own dates.
    (state.registries||[]).forEach(reg => {
      // Determine category
      let cat = (reg.category||'').toString().trim().toLowerCase();
      if(!cat){
        const inv = (state.invoices||[]).find(i => (i.wdNumber||'').toString().trim().toLowerCase() === (reg.wdNumber||'').toString().trim().toLowerCase());
        cat = (inv && inv.category) ? inv.category.toString().trim().toLowerCase() : '';
      }
      if(cat !== 'rental') return;
      getRegistryCoveragePeriods(reg).forEach(slice => {
        const units = slice.units.map(x=> (x||'').toString().trim().toLowerCase());
        if(!units.includes(unitIdNorm)) return;
        if(!slice.from || !slice.to) return;
        const sp = String(slice.from).split('-'); const ep = String(slice.to).split('-');
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

    // Manual coverage (Accruals coverage panel) counts as ordinary rental coverage everywhere.
    for(let d = 1; d <= daysInMonth; d++){ if(isManuallyCovered(u, year, month, d)) covered[d-1] = true; }

    return covered;
  }

  // Count rental coverage sources per day for a unit (for overlap detection)
  function rentalCountsArrayForUnit(u, year, month){
    const daysInMonth = new Date(year, month+1, 0).getDate();
    const counts = new Array(daysInMonth).fill(0);
    const unitIdNorm = (u.unitId || u.id || '').toString().trim().toLowerCase();

    // Use registries membership and category (fallback to matching invoice category) —
    // per-period for a quarterly invoice (see getRegistryCoveragePeriods).
    const registries = state.registries || [];
    const invoices = state.invoices || [];
    registries.forEach(reg => {
      let cat = (reg.category||'').toString().trim().toLowerCase();
      if(!cat){
        const inv = invoices.find(i => (i.wdNumber||'').toString().trim().toLowerCase() === (reg.wdNumber||'').toString().trim().toLowerCase());
        cat = (inv && (inv.category||'').toString().trim().toLowerCase()) || '';
      }
      if(cat !== 'rental') return;
      getRegistryCoveragePeriods(reg).forEach(slice => {
        const unitsArr = slice.units.map(x=> (x||'').toString().trim().toLowerCase());
        if(!unitsArr.includes(unitIdNorm)) return;
        if(!slice.from || !slice.to) return;
        const sp = String(slice.from).split('-'); const ep = String(slice.to).split('-');
        const start = new Date(parseInt(sp[0]), parseInt(sp[1]) - 1, parseInt(sp[2]));
        const end = new Date(parseInt(ep[0]), parseInt(ep[1]) - 1, parseInt(ep[2]));
        if(isNaN(start) || isNaN(end)) return;
        const cur = new Date(start);
        while(cur <= end){
          if(cur.getFullYear()===year && cur.getMonth()===month){ counts[cur.getDate()-1] += 1; }
          cur.setDate(cur.getDate()+1);
        }
      });
    });

    // Manual coverage (Accruals coverage panel) counts as ordinary rental coverage everywhere.
    for(let d = 1; d <= daysInMonth; d++){ if(isManuallyCovered(u, year, month, d)) counts[d-1] += 1; }

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
      let cat = (reg.category||'').toString().trim().toLowerCase();
      if(!cat){
        const inv = invoices.find(i => (i.wdNumber||'').toString().trim().toLowerCase() === (reg.wdNumber||'').toString().trim().toLowerCase());
        cat = (inv && (inv.category||'').toString().trim().toLowerCase()) || '';
      }
      if(cat !== 'credit') return;
      getRegistryCoveragePeriods(reg).forEach(slice => {
        const unitsArr = slice.units.map(x=> (x||'').toString().trim().toLowerCase());
        if(!unitsArr.includes(unitIdNorm)) return;
        if(!slice.from || !slice.to) return;
        const sp = String(slice.from).split('-'); const ep = String(slice.to).split('-');
        const start = new Date(parseInt(sp[0]), parseInt(sp[1]) - 1, parseInt(sp[2]));
        const end = new Date(parseInt(ep[0]), parseInt(ep[1]) - 1, parseInt(ep[2]));
        if(isNaN(start) || isNaN(end)) return;
        const cur = new Date(start);
        while(cur <= end){
          if(cur.getFullYear()===year && cur.getMonth()===month){ credit[cur.getDate()-1] = true; }
          cur.setDate(cur.getDate()+1);
        }
      });
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
      { text: 'AGI Company', key: 'company' },
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
        const infoCells = [u.unitId||'', u.lease||'', u.company||'', u.supplier||'', u.arrangement||'', u.invoicing||'', u.status||'Operational'];
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
        const disputedPeriods = getDisputedPeriods(u) || [];
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
          const isDisputed = isDateInDisputedPeriod(year, month, d, disputedPeriods);

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
          if(covered && !overlap && !credit && isManuallyCovered(u, year, month, d)){
            square.style.backgroundColor = '#f3e8ff';
            square.style.borderColor = '#a855f7';
            square.style.color = '#6b21a8';
            square.style.fontWeight = '600';
            square.title = 'Manually confirmed coverage — no invoice expected';
          }
          if(isDisputed){ square.style.color = '#db2777'; square.style.fontWeight = '800'; square.title = (square.title ? square.title + ' | ' : '') + 'Invoice under dispute for this day'; }
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
      { text: 'AGI Company', key: 'company' },
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
    const disputedPeriodsMapMissing = new Map();
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
      try{
        disputedPeriodsMapMissing.set(key, getDisputedPeriods(u));
      }catch(e){ disputedPeriodsMapMissing.set(key, []); }
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
        const infoCells = [u.unitId||'', u.lease||'', u.company||'', u.supplier||'', u.arrangement||'', u.invoicing||'', u.status||'Operational'];
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
        const disputedPeriodsForMissing = disputedPeriodsMapMissing.get(u.id || u.unitId) || [];
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
          const isDisputed = isDateInDisputedPeriod(year, month, d, disputedPeriodsForMissing);

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
          if(covered && !overlap && !credit && isManuallyCovered(u, year, month, d)){
            square.style.backgroundColor = '#f3e8ff';
            square.style.borderColor = '#a855f7';
            square.style.color = '#6b21a8';
            square.style.fontWeight = '600';
            square.title = 'Manually confirmed coverage — no invoice expected';
          }
          if(isDisputed){ square.style.color = '#db2777'; square.style.fontWeight = '800'; square.title = (square.title ? square.title + ' | ' : '') + 'Invoice under dispute for this day'; }
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
      { text: 'AGI Company', key: 'company' },
      { text: 'Supplier', key: 'supplier' },
      { text: 'Arrangement', key: 'arrangement' },
      { text: 'Invoicing', key: 'invoicing' },
      { text: 'Status', key: 'status' },
      { text: 'Labels', key: 'labels' }
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
        const info = [u.unitId||'', u.lease||'', u.company||'', u.supplier||'', u.arrangement||'', u.invoicing||'', u.status||'Operational'];
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

        // Labels column: flags this unit as Disputed when an invoice covering one of its
        // overlapped days this month has an open dispute record (same convention as the
        // Disabled Units with Rental Coverage table).
        try{
          const disputedPeriodsForLabel = getDisputedPeriods(u);
          let hasDispute = false;
          for(let dd=1; dd<=daysInMonth; dd++){ if(isDateInDisputedPeriod(year, month, dd, disputedPeriodsForLabel)){ hasDispute = true; break; } }
          const tdLabels = document.createElement('td');
          tdLabels.style.padding='6px'; tdLabels.style.borderBottom='1px solid #eef2f7'; tdLabels.style.fontSize='12px';
          if(hasDispute){
            tdLabels.textContent = 'Disputed';
            tdLabels.style.color = '#db2777'; tdLabels.style.fontWeight = '700';
          } else {
            tdLabels.textContent = '-';
          }
          tr.appendChild(tdLabels);
        }catch(e){
          const tdLabels = document.createElement('td');
          tdLabels.style.padding='6px'; tdLabels.style.borderBottom='1px solid #eef2f7'; tdLabels.style.fontSize='12px';
          tdLabels.textContent = '-';
          tr.appendChild(tdLabels);
        }

        const overlaps = overlapMap.get(u.id || u.unitId) || [];
        const covered = rentalCoveredMap.get(u.id || u.unitId) || [];
        const disabledPeriods = getDisabledPeriods(u) || [];
        const disputedPeriodsOverlap = getDisputedPeriods(u) || [];
        for(let d=1; d<=daysInMonth; d++){
          const tdDay = document.createElement('td'); tdDay.style.padding='2px'; tdDay.style.textAlign='center'; tdDay.style.verticalAlign='middle';
          const square = document.createElement('div'); square.style.width='20px'; square.style.height='20px'; square.style.border='1px solid #ddd'; square.style.borderRadius='3px'; square.style.display='flex'; square.style.alignItems='center'; square.style.justifyContent='center'; square.style.fontSize='9px'; square.textContent=d;
          const isDisabled = isDateInDisabledPeriod(year, month, d, disabledPeriods);
          const isDisputed = isDateInDisputedPeriod(year, month, d, disputedPeriodsOverlap);
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
          if(!overlaps[d-1] && covered[d-1] && isManuallyCovered(u, year, month, d)){
            square.style.backgroundColor = '#f3e8ff'; square.style.borderColor = '#a855f7'; square.style.color = '#6b21a8'; square.style.fontWeight = '600';
            square.title = 'Manually confirmed coverage — no invoice expected';
          }
          if(isDisputed){ square.style.color = '#db2777'; square.style.fontWeight = '800'; square.title = (square.title ? square.title + ' | ' : '') + 'Invoice under dispute for this day'; }
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
      { text: 'AGI Company', key: 'company' },
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
        const info = [u.unitId||'', u.lease||'', u.company||'', u.supplier||'', u.arrangement||'', u.invoicing||'', u.status||'Operational'];
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
        const disputedPeriodsCredit = getDisputedPeriods(u) || [];
        for(let d=1; d<=daysInMonth; d++){
          const tdDay = document.createElement('td'); tdDay.style.padding='2px'; tdDay.style.textAlign='center'; tdDay.style.verticalAlign='middle';
          const square = document.createElement('div'); square.style.width='20px'; square.style.height='20px'; square.style.border='1px solid #ddd'; square.style.borderRadius='3px'; square.style.display='flex'; square.style.alignItems='center'; square.style.justifyContent='center'; square.style.fontSize='9px'; square.textContent=d;
          const isDisabled = isDateInDisabledPeriod(year, month, d, disabledPeriods);
          const isDisputed = isDateInDisputedPeriod(year, month, d, disputedPeriodsCredit);
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
          if(!creditDays[d-1] && counts[d-1] === 1 && isManuallyCovered(u, year, month, d)){
            square.style.backgroundColor = '#f3e8ff'; square.style.borderColor = '#a855f7'; square.style.color = '#6b21a8'; square.style.fontWeight = '600';
            square.title = 'Manually confirmed coverage — no invoice expected';
          }
          if(isDisputed){ square.style.color = '#db2777'; square.style.fontWeight = '800'; square.title = (square.title ? square.title + ' | ' : '') + 'Invoice under dispute for this day'; }
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

    // Sort handling for Disabled + Covered table
    state.meta.reportSimple.sortDisabledCovered = state.meta.reportSimple.sortDisabledCovered || { column: 'unitId', ascending: true };
    const sortDisabledCovered = state.meta.reportSimple.sortDisabledCovered;
    disabledCoveredUnits.sort((a, b) => {
      const va = (a[sortDisabledCovered.column] || '').toString().toLowerCase();
      const vb = (b[sortDisabledCovered.column] || '').toString().toLowerCase();
      if(va < vb) return sortDisabledCovered.ascending ? -1 : 1;
      if(va > vb) return sortDisabledCovered.ascending ? 1 : -1;
      return 0;
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
      { text: 'AGI Company', key: 'company' },
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
      const th = document.createElement('th');
      let labelDC = def.text;
      if(sortDisabledCovered.column === def.key){ labelDC += sortDisabledCovered.ascending ? ' ▲' : ' ▼'; }
      th.textContent = labelDC;
      th.style.textAlign='left'; th.style.padding='6px'; th.style.fontSize='12px'; th.style.borderBottom='2px solid #eef2f7'; th.style.fontWeight='600'; th.style.background='#f9fafb';
      th.style.position='sticky'; th.style.top='0'; th.style.zIndex='2';
      th.style.cursor = 'pointer'; th.style.userSelect = 'none'; th.title = 'Click to sort';
      th.addEventListener('click', ()=>{
        if(state.meta.reportSimple.sortDisabledCovered.column === def.key){
          state.meta.reportSimple.sortDisabledCovered.ascending = !state.meta.reportSimple.sortDisabledCovered.ascending;
        } else {
          state.meta.reportSimple.sortDisabledCovered.column = def.key;
          state.meta.reportSimple.sortDisabledCovered.ascending = true;
        }
        try{ saveState(); }catch(e){}
        run();
      });
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
        const info = [u.unitId||'', u.lease||'', u.company||'', u.supplier||'', u.arrangement||'', u.invoicing||'', u.status||'Operational'];
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

        // Labels column: show other visual labels present this month (Overlap, Credit, Disputed)
        try{
          const counts = rentalCountsArrayForUnit(u, year, month) || [];
          const hasOverlap = counts.some(c => c > 1);
          const creditDays = creditArrayForUnit(u, year, month) || [];
          const hasCredit = creditDays.some(Boolean);
          const unitDisputedPeriods = getDisputedPeriods(u);
          const daysInMonthForDispute = new Date(year, month+1, 0).getDate();
          let hasDispute = false;
          for(let dd=1; dd<=daysInMonthForDispute; dd++){ if(isDateInDisputedPeriod(year, month, dd, unitDisputedPeriods)){ hasDispute = true; break; } }
          const labels = [];
          if(hasOverlap) labels.push('Overlap');
          if(hasCredit) labels.push('Credit');
          const tdLabels = document.createElement('td');
          tdLabels.style.padding='6px'; tdLabels.style.borderBottom='1px solid #eef2f7'; tdLabels.style.fontSize='12px';
          if(hasDispute){
            tdLabels.textContent = labels.concat(['Disputed']).join(', ');
            tdLabels.style.color = '#db2777'; tdLabels.style.fontWeight = '700';
          } else {
            tdLabels.textContent = labels.length ? labels.join(', ') : '-';
          }
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
        const disputedPeriodsDC = getDisputedPeriods(u);
        for(let d=1; d<=daysInMonthDC; d++){
          const tdDay = document.createElement('td'); tdDay.style.padding='2px'; tdDay.style.textAlign='center'; tdDay.style.verticalAlign='middle';
          const isDisabled = isDateInDisabledPeriod(year, month, d, data.disabledPeriods || []);
          const isDisputed = isDateInDisputedPeriod(year, month, d, disputedPeriodsDC);
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
          if(covered && !overlap && !credit && isManuallyCovered(u, year, month, d)){
            square.style.backgroundColor = '#f3e8ff';
            square.style.borderColor = '#a855f7';
            square.style.color = '#6b21a8';
            square.style.fontWeight = '600';
            square.title = 'Manually confirmed coverage — no invoice expected';
          }
          if(isDisputed){ square.style.color = '#db2777'; square.style.fontWeight = '800'; square.title = (square.title ? square.title + ' | ' : '') + 'Invoice under dispute for this day'; }

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

      const firstOfMonthUnitsAll = units.filter(u => {
        const invoicingVal = (u.invoicing || '').toString().trim();
        if(invoicingVal !== 'First of the Month') return false;
        // Skip units already disabled before next month starts — nothing to invoice
        if(isDateInDisabledPeriod(nextYearFOM, nextMonthFOM, 1, getDisabledPeriods(u))) return false;
        return true;
      });

      // "Only show units with coverage this period" checkbox — persisted, defaults off (shows
      // everything tagged First of the Month, same as before this was added).
      state.meta.reportSimple.fomOnlyCovered = !!state.meta.reportSimple.fomOnlyCovered;
      const firstOfMonthUnits = state.meta.reportSimple.fomOnlyCovered
        ? firstOfMonthUnitsAll.filter(u => (coverageArrayForUnit(u, nextYearFOM, nextMonthFOM) || []).some(Boolean))
        : firstOfMonthUnitsAll;

      // Sort handling for First of the Month table
      state.meta.reportSimple.sortFOM = state.meta.reportSimple.sortFOM || { column: 'unitId', ascending: true };
      const sortFOM = state.meta.reportSimple.sortFOM;
      firstOfMonthUnits.sort((a, b) => {
        const va = (a[sortFOM.column] || '').toString().toLowerCase();
        const vb = (b[sortFOM.column] || '').toString().toLowerCase();
        if(va < vb) return sortFOM.ascending ? -1 : 1;
        if(va > vb) return sortFOM.ascending ? 1 : -1;
        return 0;
      });

      const daysInMonthFOM = new Date(nextYearFOM, nextMonthFOM + 1, 0).getDate();
      const monthNameFOM = monthNames[nextMonthFOM];

      const titleRowFOM = document.createElement('div');
      titleRowFOM.style.cssText = 'display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin:12px 0 8px;';

      const titleFOM = document.createElement('div');
      titleFOM.textContent = `Units Tagged "First of the Month" — Preview for ${monthNameFOM} ${nextYearFOM}`;
      titleFOM.style.fontWeight = '600';
      titleRowFOM.appendChild(titleFOM);

      const filterLabelFOM = document.createElement('label');
      filterLabelFOM.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:12px;font-weight:400;color:#374151;cursor:pointer;';
      const filterCheckboxFOM = document.createElement('input');
      filterCheckboxFOM.type = 'checkbox';
      filterCheckboxFOM.style.cursor = 'pointer';
      filterCheckboxFOM.checked = state.meta.reportSimple.fomOnlyCovered;
      filterCheckboxFOM.addEventListener('change', () => {
        state.meta.reportSimple.fomOnlyCovered = filterCheckboxFOM.checked;
        try{ saveState(); }catch(e){}
        run();
      });
      filterLabelFOM.appendChild(filterCheckboxFOM);
      filterLabelFOM.appendChild(document.createTextNode(`Only show units with coverage in ${monthNameFOM} ${nextYearFOM}`));
      titleRowFOM.appendChild(filterLabelFOM);

      resultsWrap.appendChild(titleRowFOM);

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
        { text: 'AGI Company', key: 'company' },
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
        const th = document.createElement('th');
        let labelFOM = def.text;
        if(sortFOM.column === def.key){ labelFOM += sortFOM.ascending ? ' ▲' : ' ▼'; }
        th.textContent = labelFOM;
        th.style.textAlign='left'; th.style.padding='6px'; th.style.fontSize='12px'; th.style.borderBottom='2px solid #eef2f7'; th.style.fontWeight='600'; th.style.background='#f9fafb';
        th.style.position='sticky'; th.style.top='0'; th.style.zIndex='2';
        th.style.cursor = 'pointer'; th.style.userSelect = 'none'; th.title = 'Click to sort';
        th.addEventListener('click', ()=>{
          if(state.meta.reportSimple.sortFOM.column === def.key){
            state.meta.reportSimple.sortFOM.ascending = !state.meta.reportSimple.sortFOM.ascending;
          } else {
            state.meta.reportSimple.sortFOM.column = def.key;
            state.meta.reportSimple.sortFOM.ascending = true;
          }
          try{ saveState(); }catch(e){}
          run();
        });
        hdrFOM.appendChild(th);
      });
      const thPeriodFOM = document.createElement('th');
      thPeriodFOM.textContent = 'Period'; thPeriodFOM.colSpan = daysInMonthFOM;
      thPeriodFOM.style.textAlign='center'; thPeriodFOM.style.padding='6px'; thPeriodFOM.style.fontSize='12px'; thPeriodFOM.style.borderBottom='2px solid #eef2f7'; thPeriodFOM.style.fontWeight='600'; thPeriodFOM.style.background='#f9fafb'; thPeriodFOM.style.position='sticky'; thPeriodFOM.style.top='0'; thPeriodFOM.style.zIndex='2';
      hdrFOM.appendChild(thPeriodFOM);
      theadFOM.appendChild(hdrFOM);

      if(firstOfMonthUnits.length === 0){
        const tr = document.createElement('tr'); const td = document.createElement('td');
        td.colSpan = headerDefsFOM.length + daysInMonthFOM + 1;
        td.textContent = state.meta.reportSimple.fomOnlyCovered && firstOfMonthUnitsAll.length > 0
          ? `No units tagged "First of the Month" have any coverage in ${monthNameFOM} ${nextYearFOM} — ${firstOfMonthUnitsAll.length} tagged unit(s) hidden by the filter above.`
          : `No units tagged "First of the Month" for ${monthNameFOM} ${nextYearFOM}.`;
        td.className = 'small-muted'; td.style.padding='12px';
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
          const infoCellsFOM = [u.unitId||'', u.lease||'', u.company||'', u.supplier||'', u.arrangement||'', u.invoicing||'', u.status||'Operational'];
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
          const disputedPeriodsFOM = getDisputedPeriods(u) || [];
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
            const isDisputed = isDateInDisputedPeriod(nextYearFOM, nextMonthFOM, d, disputedPeriodsFOM);

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
            if(covered && !overlap && !credit && isManuallyCovered(u, nextYearFOM, nextMonthFOM, d)){
              square.style.backgroundColor = '#f3e8ff';
              square.style.borderColor = '#a855f7';
              square.style.color = '#6b21a8';
              square.style.fontWeight = '600';
              square.title = 'Manually confirmed coverage — no invoice expected';
            }
            if(isDisputed){ square.style.color = '#db2777'; square.style.fontWeight = '800'; square.title = (square.title ? square.title + ' | ' : '') + 'Invoice under dispute for this day'; }
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
          if(key === 'company') return (row.u.company || '').toString();
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
        { text: 'AGI Company', key: 'company' },
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
            row.u.company||'',
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
  try{ if(typeof populateInvoiceTrackingDropdowns === 'function') populateInvoiceTrackingDropdowns(); }catch(e){}
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

// --- Developer "Other Charge Types" list — feeds the named-subcharge dropdown in the per-unit
// Tax/Other/Amount breakdown table (Invoice Registration + Registry Edit), since the actual
// charge names found on invoices (Freight, Gasoline, etc.) vary a lot between suppliers.
state.meta.devOtherCharges = state.meta.devOtherCharges || [];
const devOtherChargeInput = qs('#devOtherChargeInput');
const devOtherChargeListEl = qs('#devOtherChargeList');

function renderOtherChargeList(){
  if(!devOtherChargeListEl) return;
  devOtherChargeListEl.innerHTML = '';
  state.meta.devOtherCharges.forEach((c, i)=>{
    const li = document.createElement('li');
    const text = document.createElement('span'); text.textContent = c;
    const actions = document.createElement('div'); actions.className = 'dev-actions';
    const editBtn = document.createElement('button'); editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', ()=>{
      if(!devOtherChargeInput) return;
      devOtherChargeInput.value = c;
      const saveBtn = qs('#saveDevOtherCharge');
      if(saveBtn){ saveBtn.dataset.editIndex = i; saveBtn.dataset.editOriginalValue = c; saveBtn.textContent = 'Save'; }
      devOtherChargeInput.focus();
    });
    const delBtn = document.createElement('button'); delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', async ()=>{
      if(!confirm('Delete this charge type?')) return;
      delBtn.disabled = true;
      try{
        const fresh = await fetchFreshConfigArray('devOtherCharges');
        const idx = fresh.findIndex(x => x === c);
        if(idx !== -1) fresh.splice(idx,1);
        commitConfigListChange('devOtherCharges', fresh);
        renderOtherChargeList();
      }catch(e){
        alert('Could not delete — could not reach Google Sheets. Please try again.\n' + (e && e.message || ''));
        delBtn.disabled = false;
      }
    });
    actions.appendChild(editBtn);
    actions.appendChild(delBtn);
    li.appendChild(text);
    li.appendChild(actions);
    devOtherChargeListEl.appendChild(li);
  });
}

const saveOtherChargeBtn = qs('#saveDevOtherCharge');
if(saveOtherChargeBtn){
  saveOtherChargeBtn.addEventListener('click', async ()=>{
    const v = devOtherChargeInput && devOtherChargeInput.value ? devOtherChargeInput.value.trim() : '';
    if(v === ''){ alert('Please enter a charge type'); return; }
    const isEditing = typeof saveOtherChargeBtn.dataset.editIndex !== 'undefined';
    const originalValue = saveOtherChargeBtn.dataset.editOriginalValue;
    saveOtherChargeBtn.disabled = true;
    try{
      const fresh = await fetchFreshConfigArray('devOtherCharges');
      const dupIdx = fresh.findIndex(x => x.toLowerCase() === v.toLowerCase());
      if(isEditing){
        const idx = fresh.findIndex(x => x === originalValue);
        if(dupIdx !== -1 && fresh[dupIdx] !== originalValue){ alert('"' + v + '" already exists.'); return; }
        if(idx !== -1) fresh[idx] = v; else fresh.push(v);
      } else {
        if(dupIdx !== -1){ alert('"' + v + '" already exists.'); return; }
        fresh.push(v);
      }
      commitConfigListChange('devOtherCharges', fresh);
      delete saveOtherChargeBtn.dataset.editIndex;
      delete saveOtherChargeBtn.dataset.editOriginalValue;
      saveOtherChargeBtn.textContent = 'new';
      renderOtherChargeList();
      if(devOtherChargeInput) devOtherChargeInput.value = '';
    }catch(e){
      alert('Could not save changes — could not reach Google Sheets. Please try again.\n' + (e && e.message || ''));
    }finally{
      saveOtherChargeBtn.disabled = false;
    }
  });
}

renderOtherChargeList();

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
}

// --- Annual Overview: not built yet, show a clear "under construction" notice ---
function renderAnualOverview(){
  const el = qs('#anualOverview'); if(!el) return;
  el.innerHTML = '';
  const container = document.createElement('div');
  container.style.cssText = 'padding:24px;border:1px dashed #d7dce2;border-radius:8px;text-align:center;background:#f8fafc;';
  const icon = document.createElement('div');
  icon.style.cssText = 'font-size:28px;margin-bottom:8px;';
  icon.textContent = '🚧';
  const title = document.createElement('div');
  title.style.cssText = 'font-weight:600;font-size:15px;color:#374151;';
  title.textContent = 'Under Construction';
  const desc = document.createElement('div');
  desc.className = 'small-muted';
  desc.style.marginTop = '6px';
  desc.textContent = 'The Anual Overview section is not available yet — we\'ll be building this out in the near future.';
  container.appendChild(icon);
  container.appendChild(title);
  container.appendChild(desc);
  el.appendChild(container);
}

function initOverviewSubtabs(){
  state.meta = state.meta || {};
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

  // Wire the (static) Clear button once
  const clearBtn = qs('#editRegistryLeaseClearBtn');
  if(clearBtn && !clearBtn.dataset.wired){
    clearBtn.dataset.wired = 'true';
    clearBtn.addEventListener('click', () => {
      const p = qs('#editRegistryLeasePanel'); if(!p) return;
      p.querySelectorAll('input[type="checkbox"][name="editRegistryLease"]').forEach(cb => cb.checked = false);
      onRegistryLeaseSelectionChange();
    });
  }

  wireSearchClearButton('editRegistryLeaseSearch', 'editRegistryLeaseSearchClear');
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

  // Wire the (static) Select all button once; only checks whatever rows are currently visible
  const selectAllBtn = qs('#editRegistryUnitSelectAllBtn');
  if(selectAllBtn && !selectAllBtn.dataset.wired){
    selectAllBtn.dataset.wired = 'true';
    selectAllBtn.addEventListener('click', () => {
      const p = qs('#editRegistryUnits'); if(!p) return;
      p.querySelectorAll('.edit-registry-unit-row').forEach(row => {
        if(row.style.display !== 'none'){
          const cb = row.querySelector('input[type="checkbox"]');
          if(cb) cb.checked = true;
        }
      });
      if(typeof renderRegistryUnitBreakdown === 'function') renderRegistryUnitBreakdown();
    });
  }

  // Wire the (static) Clear button once
  const unitClearBtn = qs('#editRegistryUnitClearBtn');
  if(unitClearBtn && !unitClearBtn.dataset.wired){
    unitClearBtn.dataset.wired = 'true';
    unitClearBtn.addEventListener('click', () => {
      const p = qs('#editRegistryUnits'); if(!p) return;
      p.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = false);
      if(typeof renderRegistryUnitBreakdown === 'function') renderRegistryUnitBreakdown();
    });
  }

  wireSearchClearButton('editRegistryUnitSearch', 'editRegistryUnitSearchClear');
}

// Tracks the exact registry object currently open in the edit modal. Some registries have no
// (or a blank/duplicate) id in Sheets, so looking them back up by id — as the save handler used
// to — could silently match and overwrite a *different* registry. Holding the direct object
// reference instead sidesteps that entirely.
let _registryBeingEdited = null;

function openRegistryEditModal(registry){
  const modal = qs('#registryEditModal');
  if(!modal) return;
  _registryBeingEdited = registry;

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

  const editSupInvDate = qs('#editRegistrySupplierInvoiceDate'); if(editSupInvDate) editSupInvDate.value = registry.invoiceDate || '';
  qs('#editRegistryPeriodStart').value = registry.periodStart || '';
  qs('#editRegistryPeriodEnd').value = registry.periodEnd || '';
  qs('#editRegistrySubmitted').value = registry.submittedDate || '';

  // Seed the editable breakdown table from this registry's stored per-unit detail (falling
  // back to a best-effort reconstruction for older registries that predate that field)
  const seedFromDetails = {};
  getRegistryUnitDetails(registry).forEach(d => {
    if(d && d.unit) seedFromDetails[d.unit] = { tax: d.tax || '', other: d.other || '', charge: d.charge || '', otherChargeDetails: d.otherChargeDetails || [] };
  });
  renderRegistryUnitBreakdown(seedFromDetails);

  renderEditRegistryQuarterlyPeriodsReadonly(registry);

  modal.style.display = 'block';
}

// Quarterly invoices carry additional periods beyond the one editable table above — shown
// here read-only for now (each with its own declared From/To and per-unit detail table),
// same as the Registries list's expanded view. Editing them isn't supported yet — that's a
// separate follow-up.
function renderEditRegistryQuarterlyPeriodsReadonly(registry){
  const container = qs('#editRegistryPeriodsReadonly'); if(!container) return;
  container.innerHTML = '';
  const periods = Array.isArray(registry.periods) ? registry.periods : [];
  if(periods.length === 0) return;

  const noteEl = document.createElement('div');
  noteEl.className = 'small-muted';
  noteEl.style.cssText = 'margin:8px 0 4px;font-style:italic;';
  noteEl.textContent = 'This is a quarterly invoice with additional periods (shown read-only below — edit them by re-registering, or ask for period-editing support here).';
  container.appendChild(noteEl);

  if(registry.period1From || registry.period1To){
    const p1Label = document.createElement('div');
    p1Label.style.cssText = 'font-size:12px;font-weight:700;color:#374151;margin:8px 0 2px;';
    p1Label.textContent = 'Period 1 (' + formatDate(registry.period1From) + ' — ' + formatDate(registry.period1To) + ')';
    container.appendChild(p1Label);
  }

  periods.forEach((p, i) => {
    const label = document.createElement('div');
    label.style.cssText = 'font-size:12px;font-weight:700;color:#374151;margin:8px 0 2px;';
    label.textContent = 'Period ' + (i + 2) + ' (' + formatDate(p.fromDate) + ' — ' + formatDate(p.toDate) + ')';
    container.appendChild(label);

    const unitDetails = Array.isArray(p.unitDetails) ? p.unitDetails : [];
    if(unitDetails.length){
      const detailTableEl = document.createElement('div'); detailTableEl.className = 'registry-unit-detail-table';
      container.appendChild(detailTableEl);
      renderRegistryUnitDetailTable(detailTableEl, unitDetails);
    } else {
      const noneEl = document.createElement('div'); noneEl.className = 'small-muted'; noneEl.textContent = '(no units)';
      container.appendChild(noneEl);
    }
  });
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
    // Use the exact object reference captured when the modal was opened, not a lookup by id —
    // registries with a blank/missing id in Sheets would otherwise all collide on `id === ''`
    // and this could silently save changes onto the wrong registry.
    let registry = _registryBeingEdited;
    if(registry && !state.registries.includes(registry)){
      // state.registries got replaced out from under us (e.g. the background auto-refresh
      // firing right as the modal was open) — fall back to matching the same logical
      // registry by id (when non-blank; blank ids can collide across multiple rows) or by
      // its stable seq number, rather than failing the whole save.
      registry = (registry.id && state.registries.find(r => r.id === registry.id))
        || (registry.seq !== undefined && state.registries.find(r => r.seq === registry.seq))
        || null;
      if(registry) _registryBeingEdited = registry;
    }
    if(!registry){ alert('Registry not found - please close and reopen the edit modal'); return; }

    // Read the new field values without mutating the registry yet, so a blocked
    // (mismatched-total) save leaves the in-memory registry untouched.
    const newWd = qs('#editRegistryWD').value.trim();
    const newDoc = qs('#editRegistryDoc').value.trim();
    const newTotalAmount = qs('#editRegistryAmount').value.trim();
    const newCategory = qs('#editRegistryCategory').value.trim();
    const newInvoiceDate = (qs('#editRegistrySupplierInvoiceDate') || {}).value || '';
    const newPeriodStart = qs('#editRegistryPeriodStart').value.trim();
    const newPeriodEnd = qs('#editRegistryPeriodEnd').value.trim();
    const newSubmittedDate = qs('#editRegistrySubmitted').value.trim();
    const newUnits = getSelectedRegistryUnits();
    const selectedLeases = getSelectedRegistryLeases();

    // Only enforce the Tax + Other Charges + Amount breakdown matching the declared Total
    // Amount when the user is actually entering per-unit detail here. Many older registries
    // were never broken down per unit and never will be (too much retroactive work) — those
    // should still be editable (WD/Doc/category/dates, etc.) without being forced to fully
    // detail every unit first. The moment any per-unit amount is typed in, the normal strict
    // match requirement kicks back in so a half-entered breakdown can't be saved silently.
    renderRegistryUnitBreakdown();
    const breakdownWrapEl = qs('#registryUnitBreakdown');
    let breakdownSum = 0;
    if(breakdownWrapEl){
      breakdownWrapEl.querySelectorAll('.unit-breakdown-row').forEach(row => {
        const c = row.querySelector('.ub-charge'); const t = row.querySelector('.ub-tax'); const o = row.querySelector('.ub-other');
        breakdownSum += (parseCurrency(c ? c.value : '') || 0) + (parseCurrency(t ? t.value : '') || 0) + (parseCurrency(o ? o.value : '') || 0);
      });
    }
    if(breakdownSum > 0 && !unitBreakdownMatches('registryUnitBreakdown')){
      alert('The sum of Tax + Other Charges + Amount for the selected units must equal the Total Amount. Edit not saved.');
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
      const otherAmount = (function(){ const n = parseCurrency(rowData.other||''); return n===null ? '' : n.toFixed(2); })();
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
        other: otherAmount,
        otherChargeDetails: rowData.otherChargeDetails || [],
        charge: chargeAmount
      });

      // Reconcile the in-session invoice record for this unit (create if missing, update if present)
      const existingInv = (state.invoices||[]).find(i => (i.unit||'').toString().trim().toLowerCase() === uid.toString().trim().toLowerCase() && (i.wdNumber||'').toString().trim() === oldWd);
      const invFields = {
        wdNumber: newWd, docNumber: newDoc, category: newCategory,
        periodStart: newPeriodStart, periodEnd: newPeriodEnd, submittedDate: newSubmittedDate,
        lease: resolved.lease || '', company: resolved.company || '', supplier: resolved.supplier || '',
        arrangement: resolved.arrangement || '', invoicing: resolved.invoicing || '',
        amount: chargeAmount, taxAmount: taxAmount, otherCharges: otherAmount, otherChargeDetails: rowData.otherChargeDetails || []
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
    registry.invoiceDate = newInvoiceDate;
    registry.periodStart = newPeriodStart;
    registry.periodEnd = newPeriodEnd;
    registry.submittedDate = newSubmittedDate;
    registry.units = newUnits;
    registry.unitCount = newUnits.length;
    registry.unitDetails = newUnitDetails;
    registry.leases = uniqueLeases;
    registry.lease = uniqueLeases.join(', ');

    // Save to Google Sheets and wait for confirmation before rendering. Without a saved
    // identifier we can't safely target this row on the backend (it could match the wrong
    // one), so skip the network call and keep the change local-only, with a clear warning.
    const saveBtn = qs('#registryEditSaveBtn');
    if(!registry.id){
      saveState();
      renderRegistries(registry.id);
      renderInvoices();
      renderUnitOverview();
      renderLeaseOverview();
      renderOverview();
      closeRegistryEditModal();
      alert(`Registry ${registry.seq} (WD ${registry.wdNumber || '(no WD)'}) has no saved identifier in Google Sheets, so these changes were only saved in this browser session — they have NOT been synced to Sheets. Add an identifier to that row directly in the "invoices" sheet, then reload, before editing it again.`);
      return;
    }
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

// Drag-to-resize from any border/corner handle. The dialog starts out centered via
// `top:50%;left:50%;transform:translate(-50%,-50%)` (see .modal-dialog in styles.css); the
// first drag snapshots its current on-screen rect and switches it to explicit top/left/width
// /height pixel values (transform:none) so resizing doesn't fight the centering transform.
function makeModalResizable(dialog){
  if(!dialog || dialog.dataset.resizeWired) return;
  dialog.dataset.resizeWired = 'true';

  const MIN_W = 480, MIN_H = 320;
  let dir = null, startX = 0, startY = 0, startRect = null;

  function pinToPixelRect(){
    const r = dialog.getBoundingClientRect();
    dialog.style.transform = 'none';
    dialog.style.top = r.top + 'px';
    dialog.style.left = r.left + 'px';
    dialog.style.width = r.width + 'px';
    dialog.style.height = r.height + 'px';
    dialog.style.maxWidth = 'none';
    return r;
  }

  function onMouseMove(e){
    if(!dir) return;
    const dx = e.clientX - startX, dy = e.clientY - startY;
    let { top, left, width, height } = startRect;

    if(dir.includes('e')) width = Math.max(MIN_W, startRect.width + dx);
    if(dir.includes('s')) height = Math.max(MIN_H, startRect.height + dy);
    if(dir.includes('w')){
      width = Math.max(MIN_W, startRect.width - dx);
      left = startRect.left + (startRect.width - width);
    }
    if(dir.includes('n')){
      height = Math.max(MIN_H, startRect.height - dy);
      top = startRect.top + (startRect.height - height);
    }

    // Keep the dialog fully within the viewport
    left = Math.max(0, Math.min(left, window.innerWidth - MIN_W));
    top = Math.max(0, Math.min(top, window.innerHeight - MIN_H));
    width = Math.min(width, window.innerWidth - left);
    height = Math.min(height, window.innerHeight - top);

    dialog.style.left = left + 'px';
    dialog.style.top = top + 'px';
    dialog.style.width = width + 'px';
    dialog.style.height = height + 'px';
  }

  function onMouseUp(){
    dir = null;
    dialog.classList.remove('resizing');
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
  }

  dialog.querySelectorAll('.modal-resize-handle').forEach(handle => {
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      dir = handle.dataset.dir;
      startX = e.clientX; startY = e.clientY;
      startRect = pinToPixelRect();
      dialog.classList.add('resizing');
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });
  });
}
if(registryEditModal){
  const registryEditDialog = registryEditModal.querySelector('.modal-dialog');
  if(registryEditDialog) makeModalResizable(registryEditDialog);
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

  // ?? (not ||) -- month 0 (January) is a legitimate, meaningful value that || would otherwise
  // treat as "unset" and silently replace with today's month instead.
  window.currentWdNumbersYear = window.currentWdNumbersYear ?? new Date().getFullYear();
  window.currentWdNumbersMonth = window.currentWdNumbersMonth ?? new Date().getMonth();

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

function buildUnitCoverageGrid(unit, gridId, popupId, interactive) {
  const gridEl = qs('#' + (gridId || 'unitDetailGrid'));
  const popupEl = qs('#' + (popupId || 'unitDetailPopup'));
  if(!gridEl) return;
  // `interactive` (Accruals coverage panel only) enables click-to-mark manual coverage on
  // blank days — the calendar itself stays the same size as the popup's; the panel gets more
  // room by making the missing-periods list next to it narrower instead.
  const sqSize = 16;
  const sqFont = '8px';
  const monthFont = '11px';
  const tableFont = '11px';
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
      // isoStrToDate parses "YYYY-MM-DD" using the LOCAL Date(y,m,d) constructor — new
      // Date(firstOp.date) instead parses a bare date string as UTC midnight, which in any
      // timezone behind UTC lands on the LOCAL evening of the PREVIOUS day, so getFullYear/
      // getMonth below would silently roll back a whole month for a 1st-of-month date (this
      // is what was making the coverage panel's calendar start a month early).
      const d = isoStrToDate(firstOp.date);
      startDate = isNaN(d) ? new Date(2025, 0, 1) : new Date(d.getFullYear(), d.getMonth(), 1);
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
  table.style.cssText = `border-collapse:collapse;font-size:${tableFont};min-width:100%;`;

  // Flat, chronologically-ordered list of every day cell built below — lets a drag fill in
  // every day between its start and wherever the mouse currently is (see the mouseenter
  // handler), rather than relying solely on a mouseenter event having fired for each square
  // individually. A fast drag can skip squares the browser never dispatches mouseenter for
  // (16px squares are easy to outrun), which used to leave gaps in the marked range — some
  // days stuck, some silently didn't.
  const dayCellsFlat = [];

  months.forEach(monthDate => {
    const y = monthDate.getFullYear();
    const m = monthDate.getMonth();
    const daysInMonth = new Date(y, m+1, 0).getDate();
    const monthLabel = monthDate.toLocaleString('en-US', { month: 'short', year: '2-digit' });

    const tr = document.createElement('tr');

    // Month label cell
    const tdMonth = document.createElement('td');
    tdMonth.style.cssText = `padding:2px 8px 2px 0;color:#6b7280;font-size:${monthFont};font-weight:600;white-space:nowrap;cursor:pointer;min-width:48px;`;
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
        width:${sqSize}px;height:${sqSize}px;border-radius:2px;
        display:flex;align-items:center;justify-content:center;
        font-size:${sqFont};cursor:pointer;transition:transform 0.1s;
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
      if(dayState.disputed){
        sq.style.color = '#f472b6';
        sq.style.fontWeight = '800';
        tdDay.title = 'Invoice under dispute for this day';
      }

      // Manual coverage marking — Accruals coverage panel only (interactive mode). A NEW mark
      // can only be placed when the day currently has no other status at all (blank), per the
      // rule that manual marking can't override or hide a real one. But REMOVING an existing
      // manual mark must always be possible, even if the day has since also picked up a real
      // status (e.g. an invoice arrived later covering the same day, turning it into an
      // overlap) — otherwise that mark becomes permanently stuck once it collides with
      // anything else, which is exactly the "can't unselect some dates" bug this guards against.
      const isBlankDay = !dayState.disabled && !dayState.credit && !dayState.overlap && !dayState.covered;
      const canToggleManual = interactive && (dayState.manual || isBlankDay);
      const cellIndex = dayCellsFlat.length;
      dayCellsFlat.push({ dateStr: `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`, y, m, d, sq, tdDay, dayState, canToggleManual });
      if(dayState.manual && !dayState.disabled && !dayState.credit && !dayState.overlap){
        sq.style.background = '#581c87';
        sq.style.color = '#e9d5ff';
        sq.style.border = '1px solid #a855f7';
        tdDay.title = 'Manually confirmed coverage — click to remove';
      } else if(dayState.manual){
        // Still manually marked, but a real status (overlap/credit/disabled) now takes visual
        // priority above — the square keeps that color, but stays clickable to remove the mark.
        tdDay.title = 'Manually confirmed coverage (overlapping with a real status) — click to remove';
      }

      sq.addEventListener('mouseenter', (e) => {
        sq.style.transform = 'scale(1.3)'; sq.style.zIndex = '10'; sq.style.position = 'relative';
        // Dragging: fill in every day between the drag's start and wherever the mouse is now,
        // not just this one square — a fast drag can skip mouseenter for squares in between, so
        // reacting to only "the square currently entered" left gaps (some days marked, some
        // not). Each cell in the range is still only touched if it matches the gesture's
        // starting state (blank when marking, already-manual when unmarking); anything else in
        // the range is left alone. Eligibility is checked against unit.manualCoverageDates
        // LIVE (not each cell's own dayState.manual, which was computed once when the grid was
        // built and never updates) — otherwise a day this same drag/session already marked
        // still looks "not manual yet" to this check, and a second pass over it tries to mark
        // it again instead of recognizing it's already covered.
        if(_accrualsDrag && _accrualsDrag.unit === unit && (e.buttons & 1)){
          const wantCovered = _accrualsDrag.mode === 'mark';
          const lo = Math.min(_accrualsDrag.startIndex, cellIndex);
          const hi = Math.max(_accrualsDrag.startIndex, cellIndex);

          // Anything this drag already touched but that's now outside the current [lo,hi]
          // range gets reverted back to its pre-drag state — otherwise moving the cursor back
          // to shrink the selection had no effect, since a cell once marked was never revisited.
          _accrualsDrag.touched.forEach(dateStr => {
            const info = _accrualsDrag.touchedInfo.get(dateStr);
            if(!info || (info.index >= lo && info.index <= hi)) return;
            setManualCoverageDate(unit, info.y, info.m, info.d, !wantCovered);
            applyManualSquareStyle(info.sq, info.tdDay, !wantCovered, info.dayState);
            _accrualsDrag.touched.delete(dateStr);
            _accrualsDrag.touchedInfo.delete(dateStr);
          });

          for(let idx = lo; idx <= hi; idx++){
            const cell = dayCellsFlat[idx];
            if(!cell || !cell.canToggleManual) continue;
            const isCurrentlyManual = (unit.manualCoverageDates || []).indexOf(cell.dateStr) !== -1;
            const isEligibleForDrag = wantCovered ? !isCurrentlyManual : isCurrentlyManual;
            if(isEligibleForDrag && !_accrualsDrag.touched.has(cell.dateStr)){
              _accrualsDrag.touched.add(cell.dateStr);
              _accrualsDrag.touchedInfo.set(cell.dateStr, { index: idx, y: cell.y, m: cell.m, d: cell.d, sq: cell.sq, tdDay: cell.tdDay, dayState: cell.dayState });
              setManualCoverageDate(unit, cell.y, cell.m, cell.d, wantCovered);
              applyManualSquareStyle(cell.sq, cell.tdDay, wantCovered, cell.dayState);
            }
          }
        }
      });
      sq.addEventListener('mouseleave', () => { sq.style.transform = ''; sq.style.zIndex = ''; sq.style.position = ''; });
      if(canToggleManual){
        if(!dayState.manual) tdDay.title = 'Click, or click and drag, to mark as manually covered';
        sq.addEventListener('mousedown', (e) => {
          e.preventDefault();
          const dateStr = `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
          // Checked LIVE against unit.manualCoverageDates, not dayState.manual (frozen at grid-
          // build time) — otherwise clicking a day this same pending session already marked
          // still looks "not manual yet", so a second click tries to mark it again (a no-op)
          // instead of unmarking it.
          const isCurrentlyManual = (unit.manualCoverageDates || []).indexOf(dateStr) !== -1;
          const wantCovered = !isCurrentlyManual;
          _accrualsDrag = {
            unit, mode: wantCovered ? 'mark' : 'unmark', startIndex: cellIndex,
            touched: new Set([dateStr]),
            touchedInfo: new Map([[dateStr, { index: cellIndex, y, m, d, sq, tdDay, dayState }]])
          };
          setManualCoverageDate(unit, y, m, d, wantCovered);
          applyManualSquareStyle(sq, tdDay, wantCovered, dayState);
          document.addEventListener('mouseup', endAccrualsDrag, { once: true });
        });
      } else {
        sq.addEventListener('click', () => showDayDetail(unit, y, m, d, registries, invoices, popupEl));
      }

      tdDay.appendChild(sq);
      tr.appendChild(tdDay);
    }

    table.appendChild(tr);
  });

  gridEl.appendChild(table);
}

function getDayState(unitIdNorm, y, m, d, registries, invoices, unit){
  const dateStr = `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  const result = { covered: false, overlap: false, credit: false, disabled: false, disputed: false, rentalCount: 0 };

  // Check disabled
  try{
    const periods = getDisabledPeriods(unit);
    result.disabled = isDateInDisabledPeriod(y, m, d, periods);
  }catch(e){}

  // Check disputed (invoice covering this day is tracked as in dispute)
  try{
    const disputedPeriods = getDisputedPeriods(unit);
    result.disputed = isDateInDisputedPeriod(y, m, d, disputedPeriods);
  }catch(e){}

  // Check registry coverage — per-period for a quarterly invoice (see getRegistryCoveragePeriods)
  registries.forEach(reg => {
    const slices = getRegistryCoveragePeriods(reg);
    slices.forEach(slice => {
      const inSlice = slice.units.some(u => String(u).trim().toLowerCase() === unitIdNorm);
      if(!inSlice) return;
      if(!slice.from || !slice.to) return;

      const sp = String(slice.from).split('-');
      const ep = String(slice.to).split('-');
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
  });

  // Manual coverage (Accruals coverage panel) counts as ordinary rental coverage everywhere.
  try{
    if(isManuallyCovered(unit, y, m, d)){ result.rentalCount++; result.covered = true; result.manual = true; }
  }catch(e){}

  if(result.rentalCount > 1) result.overlap = true;
  return result;
}

function showDayDetail(unit, y, m, d, registries, invoices, popupEl){
  if(!popupEl) return;
  const unitIdNorm = String(unit.unitId || unit.id || '').trim().toLowerCase();
  const dateStr = `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  const monthName = new Date(y,m,d).toLocaleString('en-US', { month:'long', day:'numeric', year:'numeric' });

  // Match per-period for a quarterly invoice (see getRegistryCoveragePeriods) — the card shown
  // below still displays the invoice's own general WD/period/amount info either way.
  const matchingRegs = registries.filter(reg => getRegistryCoveragePeriods(reg).some(slice => {
    if(!slice.units.some(u => String(u).trim().toLowerCase() === unitIdNorm)) return false;
    if(!slice.from || !slice.to) return false;
    const sp = String(slice.from).split('-');
    const ep = String(slice.to).split('-');
    if(sp.length < 3 || ep.length < 3) return false;
    const start = `${sp[0]}-${sp[1].padStart(2,'0')}-${sp[2].padStart(2,'0')}`;
    const end = `${ep[0]}-${ep[1].padStart(2,'0')}-${ep[2].padStart(2,'0')}`;
    return dateStr >= start && dateStr <= end;
  }));

  // Newest coverage period first
  matchingRegs.sort((a, b) => new Date(b.periodStart || 0) - new Date(a.periodStart || 0));

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

  // Match per-period for a quarterly invoice (see getRegistryCoveragePeriods) — the card shown
  // below still displays the invoice's own general WD/period/amount info either way.
  const matchingRegs = registries.filter(reg => getRegistryCoveragePeriods(reg).some(slice => {
    if(!slice.units.some(u => String(u).trim().toLowerCase() === unitIdNorm)) return false;
    if(!slice.from || !slice.to) return false;
    const sp = String(slice.from).split('-');
    const ep = String(slice.to).split('-');
    if(sp.length < 3 || ep.length < 3) return false;
    const start = new Date(parseInt(sp[0]), parseInt(sp[1])-1, parseInt(sp[2]));
    const end = new Date(parseInt(ep[0]), parseInt(ep[1])-1, parseInt(ep[2]));
    const mStart = new Date(y, m, 1);
    const mEnd = new Date(y, m, daysInMonth);
    return start <= mEnd && end >= mStart;
  }));

  // Newest coverage period first
  matchingRegs.sort((a, b) => new Date(b.periodStart || 0) - new Date(a.periodStart || 0));

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

function buildUnitStats(unit, statsId){
  const statsEl = qs('#' + (statsId || 'unitDetailStats'));
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
      // isoStrToDate parses "YYYY-MM-DD" via the LOCAL Date(y,m,d) constructor — new
      // Date(firstOp.date) instead parses a bare date string as UTC midnight, which in any
      // timezone behind UTC lands on the local evening of the PREVIOUS day, silently rolling
      // this stat panel's own start date back by one (same bug already fixed for the coverage
      // grid's start date and computeUnitMissingPeriods's own clamp — this was a third copy).
      const d = isoStrToDate(firstOp.date);
      if(!isNaN(d)) startDate = new Date(d.getFullYear(), d.getMonth(), 1);
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

  let monthsCovered = 0, monthsMissing = 0, creditMonths = 0, totalDaysBilled = 0, manualCoverageDaysTotal = 0;

  // The day-granular truth Table 1 itself is built from — reused here so "Months missing"
  // can never disagree with what Table 1 actually lists for this unit/range. The month-level
  // check below (manualDays === 0) used to be the only gate, which dropped a month out of
  // "Months missing" entirely the moment it had even ONE manually-covered day, even with many
  // other genuinely-uncovered days left in that same month.
  let missingPeriodsForStats = [];
  try{ missingPeriodsForStats = computeUnitMissingPeriods(unit, startDate, endDate); }catch(e){}
  const isDayStillMissing = (y, m, d) => {
    const t = new Date(y, m, d).getTime();
    return missingPeriodsForStats.some(p => t >= p.start.getTime() && t <= p.end.getTime());
  };

  months.forEach(monthDate => {
    const y = monthDate.getFullYear();
    const m = monthDate.getMonth();
    const daysInMonth = new Date(y, m+1, 0).getDate();
    let hasCoverage = false;
    let hasCredit = false;

    registries.forEach(reg => {
      let cat = String(reg.category||'').toLowerCase();
      if(!cat){
        const inv = invoices.find(i => String(i.wdNumber||'').trim().toLowerCase() === String(reg.wdNumber||'').trim().toLowerCase());
        cat = inv ? String(inv.category||'').toLowerCase() : '';
      }
      // Per-period for a quarterly invoice (see getRegistryCoveragePeriods) — days billed are
      // summed per matching slice so a unit only in one period isn't billed for the others.
      getRegistryCoveragePeriods(reg).forEach(slice => {
        if(!slice.units.some(u => String(u).trim().toLowerCase() === unitIdNorm)) return;
        if(!slice.from || !slice.to) return;
        const sp = String(slice.from).split('-');
        const ep = String(slice.to).split('-');
        if(sp.length < 3 || ep.length < 3) return;
        const start = new Date(parseInt(sp[0]), parseInt(sp[1])-1, parseInt(sp[2]));
        const end = new Date(parseInt(ep[0]), parseInt(ep[1])-1, parseInt(ep[2]));
        const mStart = new Date(y, m, 1);
        const mEnd = new Date(y, m, daysInMonth);
        if(start > mEnd || end < mStart) return;

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
    });

    // Manual coverage is tracked separately here (its own "Manual Coverage Days" stat below) —
    // it deliberately never marks a month as covered or adds to Days Billed, so those two stats
    // stay a read on real, invoice-backed coverage only. But an operator only adds it once
    // they've decided no invoice is actually expected for that period, so a month resolved
    // that way should stop counting as Months Missing too — it just isn't Covered either.
    let manualDays = 0;
    let monthStillHasMissingDay = false;
    for(let dd = 1; dd <= daysInMonth; dd++){
      if(isManuallyCovered(unit, y, m, dd)) manualDays++;
      if(!monthStillHasMissingDay && isDayStillMissing(y, m, dd)) monthStillHasMissingDay = true;
    }
    manualCoverageDaysTotal += manualDays;

    if(hasCoverage) monthsCovered++;
    else if(monthStillHasMissingDay) monthsMissing++;
    // else: every day this month is either disabled or manually covered — fully resolved,
    // counts toward neither stat.
    if(hasCredit) creditMonths++;
  });

  const stats = [
    { value: monthsCovered, label: 'Months covered', color: '#4ade80' },
    { value: monthsMissing, label: 'Months missing', color: '#f87171' },
    { value: creditMonths, label: 'Credits', color: '#fbbf24' },
    { value: totalDaysBilled, label: 'Days billed', color: '#60a5fa' },
    { value: manualCoverageDaysTotal, label: 'Manual coverage days', color: '#c084fc' }
  ];

  statsEl.innerHTML = stats.map((s, i) => `
    <div style="padding:14px 16px;text-align:center;${i < stats.length - 1 ? 'border-right:1px solid #1e2535;' : ''}">
      <div style="font-size:22px;font-weight:800;color:${s.color};letter-spacing:-0.5px;">${s.value}</div>
      <div style="font-size:11px;color:#4b5563;margin-top:3px;font-weight:500;">${s.label}</div>
    </div>
  `).join('');
}

// ========== Accruals tab — provisional working tables ==========
// These are throwaway data-extraction/cleanup aids for building the real Accruals view;
// they intentionally don't share any state/wiring with it and will be deleted later.

// Walks day-by-day from rangeStart to rangeEnd (inclusive) and groups consecutive days that
// are neither disabled nor rental-covered into missing-coverage periods.
//
// This deliberately does NOT call the generic getDayState per day like the Coverage History
// popup does — that rescans every registry in the whole system for every single day, which
// is fine for one unit's popup but far too slow across every unit's full date range (that
// was the actual cause of the Accruals tab feeling slow, not anything to do with Sheets
// storage — this table is computed client-side and was never meant to be persisted). Instead
// each unit's own registries are filtered down once up front, then the day loop only ever
// checks that small per-unit list — same coverage/disabled semantics, far fewer comparisons.
// excludeAccrualId (optional): see getAccrualFrozenRanges — pass an accrual record's own id
// when asking "is this record's own range still genuinely missing", so its own freeze doesn't
// mask the very thing being checked.
function computeUnitMissingPeriods(unit, rangeStart, rangeEnd, excludeAccrualId){
  const unitIdNorm = String(unit.unitId || unit.id || '').trim().toLowerCase();
  const invoices = state.invoices || [];

  const unitRentalPeriods = (state.registries || [])
    .filter(reg => {
      const units = Array.isArray(reg.units) ? reg.units : [];
      return units.some(u => String(u).trim().toLowerCase() === unitIdNorm);
    })
    .map(reg => {
      if(!reg.periodStart || !reg.periodEnd) return null;
      let cat = String(reg.category || '').toLowerCase();
      if(!cat){
        const inv = invoices.find(i => String(i.wdNumber||'').trim().toLowerCase() === String(reg.wdNumber||'').trim().toLowerCase());
        cat = inv ? String(inv.category||'').toLowerCase() : '';
      }
      if(cat !== 'rental') return null;
      const sp = String(reg.periodStart).split('-'), ep = String(reg.periodEnd).split('-');
      if(sp.length < 3 || ep.length < 3) return null;
      return {
        start: `${sp[0]}-${sp[1].padStart(2,'0')}-${sp[2].padStart(2,'0')}`,
        end: `${ep[0]}-${ep[1].padStart(2,'0')}-${ep[2].padStart(2,'0')}`
      };
    })
    .filter(Boolean);

  const disabledPeriods = getDisabledPeriods(unit);

  // Don't flag days before the unit actually existed in the fleet
  let effectiveStart = new Date(rangeStart);
  try{
    const hist = (unit.statusHistory || []).filter(h => h.status === 'Operational');
    if(hist.length > 0){
      const firstOp = hist.sort((a,b) => new Date(a.date) - new Date(b.date))[0];
      // See buildUnitStats/buildUnitCoverageGrid for the same fix and why: new Date(dateStr)
      // parses a bare "YYYY-MM-DD" as UTC midnight, which in any timezone behind UTC rolls
      // back to the local evening of the previous day — silently starting this unit's missing-
      // period scan one day before it actually became operational.
      const d = isoStrToDate(firstOp.date);
      if(!isNaN(d)){
        const firstOpDate = new Date(d.getFullYear(), d.getMonth(), d.getDate());
        if(firstOpDate > effectiveStart) effectiveStart = firstOpDate;
      }
    }
  }catch(e){}

  const frozenRanges = getAccrualFrozenRanges(unit, excludeAccrualId);

  const periods = [];
  if(effectiveStart > rangeEnd) return periods;

  let curStart = null;
  for(let cur = new Date(effectiveStart); cur <= rangeEnd; cur.setDate(cur.getDate()+1)){
    const y = cur.getFullYear(), m = cur.getMonth(), d = cur.getDate();
    const disabled = isDateInDisabledPeriod(y, m, d, disabledPeriods);
    let covered = false;
    if(!disabled){
      const dateStr = `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      covered = unitRentalPeriods.some(p => dateStr >= p.start && dateStr <= p.end);
      // Manual coverage (Accruals coverage panel) counts as ordinary rental coverage everywhere.
      if(!covered) covered = isManuallyCovered(unit, y, m, d);
      // Already accrued or marked not-accruable (open or closed) -- frozen, never re-missing.
      if(!covered) covered = isFrozenByAccrualDecision(dateStr, frozenRanges);
    }
    const missing = !disabled && !covered;
    if(missing){
      if(!curStart) curStart = new Date(cur);
    } else if(curStart){
      const end = new Date(cur); end.setDate(end.getDate() - 1);
      periods.push({ start: curStart, end });
      curStart = null;
    }
  }
  if(curStart) periods.push({ start: curStart, end: new Date(rangeEnd) });

  return periods;
}

// Click-to-sort state for Provisional Table 1 (not persisted — this table is throwaway).
let _accrualsMissingSort = { column: 'unitId', ascending: true };

// Cached result of the (relatively expensive) per-unit computation, so clicking a column
// header to sort just re-sorts and re-renders instead of recomputing every unit's missing
// periods from scratch each time — that recompute-on-every-click was the other big chunk of
// the slowness, on top of the per-day registry scan fixed in computeUnitMissingPeriods.
let _accrualsMissingRowsCache = null;

// Which row's coverage history the panel on the right is currently previewing — identified by
// unit + the missing period's own start date (stable across re-sorts, unlike a row index).
let _accrualsSelectedRowKey = null;

// One entry per currently-rendered row (in on-screen/sorted order): { rowKey, r, tr }. Lets the
// panel's Prev/Next arrows step through the list and re-use the row's own click handler for
// highlighting/selection instead of duplicating that logic.
let _accrualsRowRefs = [];

// The single most recent accrue action, so the "Undo" label can put it straight back — cleared
// whenever a month gets closed, since a closed record can no longer be edited/undone.
let _accrualsLastAccruedUnitId = null;
let _accrualsLastAccruedMissingRows = null; // original {unitId,lease,...,start,end,days} shape, for undo
let _accrualsLastAccruedIds = null; // the state.accruals record ids created (or extended) by that same action
// Set only when the last accrue action merged into an existing OPEN row (continuity with an
// adjacent already-open period) instead of creating a new one — undo then needs to shrink that
// row back to its pre-merge range rather than delete it outright, or it'd also destroy whatever
// was already accrued there before this action. null for an ordinary fresh-row accrue.
let _accrualsLastAccruedMerge = null; // { recordId, priorStart, priorEnd, priorDays }
// Which month/year the "Periods Ready to Accrue" list is currently showing — defaults to
// whichever month is presently open (see getAccrualsOpenMonthYear) whenever the tab is entered.
let _accrualsViewMonth = null;
let _accrualsViewYear = null;

function dateToIsoStr(d){ return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function isoStrToDate(s){
  const p = String(s || '').split('-');
  if(p.length < 3) return new Date(NaN);
  return new Date(parseInt(p[0],10), parseInt(p[1],10) - 1, parseInt(p[2],10));
}
// The accrual "month" currently accepting new Accrue Unit actions — 1-12/year. Starts at
// August 2026 per how this accrual initiative began; advances by one each time a month is
// closed (see closeAccrualsMonth), independent of the real calendar date.
function getAccrualsOpenMonthYear(){
  const month = Number(state.meta.accrualsOpenMonth) || 8;
  const year = Number(state.meta.accrualsOpenYear) || 2026;
  return { month, year };
}
function accrualMonthName(month){
  return ['January','February','March','April','May','June','July','August','September','October','November','December'][month - 1] || '';
}

// Which month/year a comment left on this accrual record right now would belong to: a CLOSED
// record's own stamped accrualMonth/Year (fixed forever, same as its dollar figures), or
// whichever month is presently open for accruals otherwise (covers both still-open accrued
// records and Not Accruable records, which never get an accrualMonth/Year of their own). This is
// what makes "current month" mean the accrual cycle's own current month everywhere in this
// feature, not real wall-clock today.
function getAccrualCommentMonthYear(record){
  if(record.accrualMonth && record.accrualYear){
    return { month: Number(record.accrualMonth), year: Number(record.accrualYear) };
  }
  return getAccrualsOpenMonthYear();
}

// One comment slot per (record, month) — not a growing thread. Reading always looks up
// whichever month getAccrualCommentMonthYear resolves to right now, so a Not Accruable row that
// sits across several closed cycles shows a fresh blank slate each time a new month opens,
// rather than one comment that just persists forever.
function getAccrualComment(record){
  const { month, year } = getAccrualCommentMonthYear(record);
  const list = Array.isArray(record.accrualComments) ? record.accrualComments : [];
  return list.find(c => Number(c.month) === month && Number(c.year) === year) || null;
}

// Upserts (or, for blank text, clears) this record's comment for the CURRENT month only — any
// comment already saved for a different month is left untouched, preserving that history.
// opts.auto marks the entry as system-generated (see applyAccrualOverride below) — editing a
// comment through the modal always saves a plain one, which is how an auto-note gets "promoted"
// to a manual one an operator wrote on top of and clearAccrualOverride will then leave alone.
function setAccrualComment(record, text, opts){
  const { month, year } = getAccrualCommentMonthYear(record);
  const list = (Array.isArray(record.accrualComments) ? record.accrualComments : []).filter(c => !(Number(c.month) === month && Number(c.year) === year));
  const trimmed = (text || '').toString().trim();
  if(trimmed) list.push({ month, year, text: trimmed, timestamp: new Date().toISOString(), auto: !!(opts && opts.auto) });
  record.accrualComments = list;
}

// Shared by both accrual tables' "Disabled Date" column — looks up the unit's CURRENT live
// status/disabledDate (not whatever status the accrual record itself snapshotted when created),
// since a unit can be disabled well after its accrual record already exists.
function getUnitDisabledDateText(unitId){
  const unit = (state.units || []).find(u => (u.unitId || u.id || '').toString().trim().toLowerCase() === (unitId || '').toString().trim().toLowerCase());
  if(!unit || (unit.status || '').toString().trim().toLowerCase() !== 'disabled') return '';
  return unit.disabledDate ? formatDate(unit.disabledDate) : '';
}

// Same lookup pattern as getUnitDisabledDateText above — the accrual record itself doesn't carry
// the unit's AGI Company (only unitId/lease/supplier/costCenter/status were ever snapshotted onto
// it), so it's read live off the current unit record, same as every other "AGI Company" column
// elsewhere in this app (Report All Tables, etc.).
function getUnitCompanyText(unitId){
  const unit = (state.units || []).find(u => (u.unitId || u.id || '').toString().trim().toLowerCase() === (unitId || '').toString().trim().toLowerCase());
  return unit ? (unit.company || '') : '';
}

// Module state for the small "Comment" modal shared by both accrual tables (Periods Ready to
// Accrue and Not Accruable) — one comment slot per (record, current month), see
// getAccrualCommentMonthYear/getAccrualComment/setAccrualComment above.
let _accrualCommentRecord = null;
let _accrualCommentOnSaved = null;
function openAccrualCommentModal(record, onSaved){
  const modal = qs('#accrualCommentModal');
  const titleEl = qs('#accrualCommentTitle');
  const textEl = qs('#accrualCommentText');
  if(!modal || !textEl) return;
  _accrualCommentRecord = record;
  _accrualCommentOnSaved = typeof onSaved === 'function' ? onSaved : null;
  const { month, year } = getAccrualCommentMonthYear(record);
  if(titleEl) titleEl.textContent = `Comment — ${record.unitId} (${accrualMonthName(month)} ${year})`;
  const existing = getAccrualComment(record);
  textEl.value = existing ? existing.text : '';
  modal.style.display = 'flex';
  try{ textEl.focus(); }catch(e){}
}
function closeAccrualCommentModal(){
  const modal = qs('#accrualCommentModal');
  if(modal) modal.style.display = 'none';
  _accrualCommentRecord = null;
  _accrualCommentOnSaved = null;
}
function saveAccrualCommentFromModal(text){
  if(!_accrualCommentRecord) return;
  setAccrualComment(_accrualCommentRecord, text);
  _accrualsSyncInFlight = true;
  DB.updateAccrual(_accrualCommentRecord).catch(e => console.error('Accrual comment save error:', e)).finally(() => { _accrualsSyncInFlight = false; });
  try{ saveState(); }catch(e){}
  const cb = _accrualCommentOnSaved;
  closeAccrualCommentModal();
  if(cb) cb();
}
const accrualCommentSaveBtn = qs('#accrualCommentSaveBtn');
if(accrualCommentSaveBtn) accrualCommentSaveBtn.addEventListener('click', () => {
  const textEl = qs('#accrualCommentText');
  saveAccrualCommentFromModal(textEl ? textEl.value : '');
});
const accrualCommentDeleteBtn = qs('#accrualCommentDeleteBtn');
if(accrualCommentDeleteBtn) accrualCommentDeleteBtn.addEventListener('click', () => { saveAccrualCommentFromModal(''); });
const accrualCommentCancelBtn = qs('#accrualCommentCancelBtn');
if(accrualCommentCancelBtn) accrualCommentCancelBtn.addEventListener('click', closeAccrualCommentModal);
const accrualCommentBackdrop = qs('#accrualCommentModal .modal-backdrop');
if(accrualCommentBackdrop) accrualCommentBackdrop.addEventListener('click', closeAccrualCommentModal);

// Which of the Accruals tab's sub-tabs is currently on screen — both share the one coverage
// panel (physically moved between #accrualsPanelSlotMissing/#accrualsPanelSlotManual by
// switchAccrualsSubTab), so this also decides which row list Prev/Next nav and the height-sync
// helper should operate on.
let _accrualsActiveSubTab = 'missing';

// Manual Coverage sub-tab's own row list state — mirrors _accrualsMissingSort/RowsCache/
// SelectedRowKey/RowRefs above, kept separate so switching sub-tabs doesn't lose either one's
// place in its own list.
let _accrualsManualSort = { column: 'unitId', ascending: true };
let _accrualsManualRowsCache = null;
let _accrualsManualSelectedRowKey = null;
let _accrualsManualRowRefs = [];

// Groups an operator's manually-covered dates (Accruals coverage panel click/drag) into
// contiguous periods, same shape as computeUnitMissingPeriods's output — a manually-covered day
// counts as covered (see isManuallyCovered), so it stops showing up as "missing" above; this is
// what lets the Manual Coverage sub-tab still find and list it for review/editing.
function computeUnitManualCoveragePeriods(unit){
  const dates = getManualCoverageDates(unit);
  if(!dates.length) return [];
  const sorted = Array.from(new Set(dates)).sort();
  const periods = [];
  let curStart = null, curEnd = null;
  sorted.forEach(ds => {
    const d = isoStrToDate(ds);
    if(curEnd){
      const expected = new Date(curEnd); expected.setDate(expected.getDate() + 1);
      if(d.getTime() === expected.getTime()){ curEnd = d; return; }
      periods.push({ start: curStart, end: curEnd });
      curStart = d; curEnd = d;
    } else {
      curStart = d; curEnd = d;
    }
  });
  if(curStart) periods.push({ start: curStart, end: curEnd });
  return periods;
}

// Shared by the full recompute and the single-unit incremental refresh below, so Table 1 stays
// consistent no matter which path last touched it. The actual freeze (never let a day already
// covered by an accrual OR not-accruable record — open or closed — count as "missing" again)
// now happens right at the source in computeUnitMissingPeriods (see getAccrualFrozenRanges),
// so by the time rows reach here they can never overlap an existing accrual/not-accruable
// record in the first place. Kept as the one shared post-processing point for both callers
// anyway — the natural place to hang future "track of sent accrued units/periods/amounts"
// history features on, per [[accruals_cumulative_history]] — but has nothing to filter today.
function applyAccrualHistoryToRows(rows){
  return rows;
}

// Provisional Table 1: every missing coverage period, for every unit, from Jan 1 of the
// current year through the end of the current month. A day only ever counts as "missing"
// when the unit was available (not disabled) that day and not rental-covered — see
// computeUnitMissingPeriods, which never lets a disabled day start or extend a missing
// period in the first place, so a period that falls under a disabled stretch simply never
// produces a row here.
// Pass forceRecompute=true to rebuild from current state (used when entering the tab);
// omit it to just re-sort/re-render the already-computed rows (used when sorting).
function renderAccrualsMissingPeriods(forceRecompute){
  const tableEl = qs('#accrualsMissingPeriodsTable');
  const summaryEl = qs('#accrualsMissingPeriodsSummary');
  if(!tableEl) return;

  if(forceRecompute || !_accrualsMissingRowsCache){
    // Extends as far back as any unit's own operational history goes — matching what that
    // unit's own coverage calendar/stats panel already shows — rather than a fixed cutoff.
    // A gap that started before this initiative's original Jan-2026 anchor is still a real,
    // reviewable gap; computeUnitMissingPeriods already clamps each unit's OWN scan to its own
    // first-Operational date, so this is only the outer floor, never artificially later than
    // any unit's real history (and never earlier than Jan 2026 either, so nothing regresses
    // for units whose history doesn't reach back further).
    let rangeStart = new Date(2026, 0, 1);
    (state.units || []).forEach(unit => {
      try{
        const hist = (unit.statusHistory || []).filter(h => h.status === 'Operational');
        if(hist.length === 0) return;
        const firstOp = hist.sort((a,b) => new Date(a.date) - new Date(b.date))[0];
        const d = isoStrToDate(firstOp.date);
        if(isNaN(d)) return;
        const firstOpMonth = new Date(d.getFullYear(), d.getMonth(), 1);
        if(firstOpMonth < rangeStart) rangeStart = firstOpMonth;
      }catch(e){}
    });
    // Capped at the end of whichever month is currently OPEN for accruals — not real wall-clock
    // "now". Without this, a gap reaching into next month would show up (and be accruable) here
    // before the current month is even closed, letting an operator jump ahead a cycle. Once that
    // month is closed (see closeAccrualsMonth, which force-recomputes this cache), the tracker
    // advances and next month's periods naturally come into view on their own.
    const { month: openMonthForRange, year: openYearForRange } = getAccrualsOpenMonthYear();
    const rangeEnd = new Date(openYearForRange, openMonthForRange, 0);

    const rows = [];
    (state.units || []).forEach(unit => {
      const uid = (unit.unitId || unit.id || '').toString();
      if(!uid) return;
      let periods = [];
      try{ periods = computeUnitMissingPeriods(unit, rangeStart, rangeEnd); }catch(e){ periods = []; }
      const status = (unit.status || 'Operational').toString();
      periods.forEach(p => {
        const days = Math.round((p.end - p.start) / 86400000) + 1;
        rows.push({ unitId: uid, lease: unit.lease || '', supplier: unit.supplier || '', costCenter: unit.costCenter || '', status, start: p.start, end: p.end, days });
      });
    });

    // Once a period has an accrual OR not-accruable record (open or closed), it's frozen —
    // computeUnitMissingPeriods already excludes those exact days (see getAccrualFrozenRanges),
    // so a still-missing gap next to one always shows up here as its own new, separately-judged
    // period rather than the old one silently regrowing. applyAccrualHistoryToRows is kept as
    // the one shared post-processing point for both this full recompute and the single-unit
    // incremental refresh below, in case a future history/audit feature needs it.
    const filteredRows = applyAccrualHistoryToRows(rows);

    _accrualsMissingRowsCache = { rows: filteredRows, rangeStart, rangeEnd };
  }

  const { rows, rangeStart, rangeEnd } = _accrualsMissingRowsCache;
  const fmtMDY = (d) => `${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}/${d.getFullYear()}`;

  const COLUMNS = [
    { key: 'unitId', label: 'UnitId', get: r => r.unitId },
    { key: 'lease', label: 'Lease', get: r => r.lease },
    { key: 'supplier', label: 'Supplier', get: r => r.supplier },
    { key: 'costCenter', label: 'Cost Center', get: r => r.costCenter },
    { key: 'status', label: 'Status', get: r => r.status },
    { key: 'period', label: 'Missing Period', get: r => r.start, numeric: true },
    { key: 'days', label: 'Days', get: r => r.days, numeric: true, alignRight: true }
  ];

  const sortCol = COLUMNS.find(c => c.key === _accrualsMissingSort.column) || COLUMNS[0];
  const ascending = _accrualsMissingSort.ascending;
  rows.sort((a, b) => {
    const av = sortCol.get(a), bv = sortCol.get(b);
    let cmp;
    if(sortCol.numeric){
      cmp = av - bv;
    } else {
      const as = av.toString().toLowerCase(), bs = bv.toString().toLowerCase();
      cmp = as < bs ? -1 : (as > bs ? 1 : 0);
    }
    if(cmp === 0) cmp = a.start - b.start; // stable secondary order: chronological
    return ascending ? cmp : -cmp;
  });

  if(summaryEl){
    const totalDays = rows.reduce((s, r) => s + r.days, 0);
    const uniqueUnits = new Set(rows.map(r => r.unitId.toLowerCase())).size;
    summaryEl.textContent = rows.length === 0
      ? `No missing coverage periods found for ${fmtMDY(rangeStart)} — ${fmtMDY(rangeEnd)}.`
      : `${rows.length} missing period(s) across ${uniqueUnits} unit(s), ${totalDays} total day(s) — range ${fmtMDY(rangeStart)} — ${fmtMDY(rangeEnd)}.`;
  }

  tableEl.innerHTML = '';
  if(rows.length === 0){
    _accrualsSelectedRowKey = null;
    // Also clear the row-ref list and its nav state — left stale otherwise (only cleared
    // further down, on a path this early return skips), so Prev/Next would still see a
    // non-empty ref list pointing at a detached <tr> from the row that just disappeared and
    // "navigate" back to it, resurrecting an already-resolved period into the panel.
    _accrualsRowRefs = [];
    if(typeof updateAccrualsPanelNav === 'function') updateAccrualsPanelNav();
    // Only touch the shared panel's empty state when Table 1 is actually the sub-tab on
    // screen — otherwise this would force the panel into "select a row" even while the
    // operator is looking at (and has a valid selection in) Manual Coverage.
    if(_accrualsActiveSubTab === 'missing'){
      const emptyEl = qs('#accrualsPanelEmpty'); const contentEl = qs('#accrualsPanelContent');
      if(emptyEl) emptyEl.style.display = 'block';
      if(contentEl) contentEl.style.display = 'none';
    }
    return;
  }

  const unitIdList = Array.from(new Set(rows.map(r => r.unitId)));

  const table = document.createElement('table');
  table.style.cssText = 'width:100%;border-collapse:collapse;font-size:11px;';

  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');

  const thCounter = document.createElement('th');
  thCounter.textContent = '#';
  thCounter.style.cssText = 'text-align:left;padding:4px 6px;font-size:10px;font-weight:600;color:#374151;background:#f9fafb;border-bottom:2px solid #eef2f7;position:sticky;top:0;';
  headerRow.appendChild(thCounter);

  COLUMNS.forEach(col => {
    const th = document.createElement('th');
    th.textContent = col.label + (sortCol.key === col.key ? (ascending ? ' ▲' : ' ▼') : '');
    th.style.cssText = `text-align:${col.alignRight ? 'right' : 'left'};padding:4px 6px;font-size:10px;font-weight:600;color:#374151;background:#f9fafb;border-bottom:2px solid #eef2f7;position:sticky;top:0;cursor:pointer;user-select:none;`;
    th.title = 'Click to sort';
    th.addEventListener('click', () => {
      // Re-sorting rebuilds the table and re-selects a row via a programmatic (untrusted)
      // click, which would otherwise bypass the pending-edit guard on the row's own click
      // handler and silently discard an in-progress manual-coverage edit.
      if(accrualsPanelBlockedByPending()) return;
      if(_accrualsMissingSort.column === col.key) _accrualsMissingSort.ascending = !_accrualsMissingSort.ascending;
      else _accrualsMissingSort = { column: col.key, ascending: true };
      renderAccrualsMissingPeriods();
    });
    headerRow.appendChild(th);
  });
  thead.appendChild(headerRow);
  table.appendChild(thead);

  // Where the previously-selected row sat in the list, captured from the OLD _accrualsRowRefs
  // before it gets replaced below — used in the fallback further down so that if that row is
  // gone entirely (its period got fully resolved this cycle), the panel advances to whatever
  // now sits at that same position (the next remaining period in sort order) instead of
  // jumping to the first row of the whole list, which could belong to a completely unrelated
  // unit.
  const previousIndex = _accrualsRowRefs.findIndex(x => x.rowKey === _accrualsSelectedRowKey);

  const tbody = document.createElement('tbody');
  let selectedTr = null;
  _accrualsRowRefs = [];
  rows.forEach((r, i) => {
    const tr = document.createElement('tr');
    tr.style.borderBottom = '1px solid #f0f0f0';
    tr.style.cursor = 'pointer';
    const rowKey = r.unitId.toLowerCase() + '|' + r.start.getTime();
    _accrualsRowRefs.push({ rowKey, r, tr });

    tr.addEventListener('mouseenter', () => { if(tr.dataset.selected !== 'true') tr.style.backgroundColor = '#f3f6fb'; });
    tr.addEventListener('mouseleave', () => { if(tr.dataset.selected !== 'true') tr.style.backgroundColor = ''; });
    tr.addEventListener('click', (e) => {
      // e.isTrusted is false for the programmatic .click() calls this same code uses to
      // restore/auto-select a row after a rebuild — only a real user click should ever be
      // blocked by a pending manual-coverage edit.
      if(e.isTrusted && accrualsPanelBlockedByPending()) return;
      Array.from(tbody.querySelectorAll('tr')).forEach(row => { row.dataset.selected = ''; row.style.backgroundColor = ''; });
      tr.dataset.selected = 'true';
      tr.style.backgroundColor = '#e6f0ff';
      _accrualsSelectedRowKey = rowKey;
      renderAccrualsCoveragePanel(r.unitId, r.start.getFullYear(), r.start.getMonth());
      updateAccrualsPanelNav();
    });

    const tdCounter = document.createElement('td'); tdCounter.textContent = i + 1; tdCounter.style.cssText = 'padding:4px 6px;color:#6b7280;';
    tr.appendChild(tdCounter);

    const tdUnit = document.createElement('td');
    tdUnit.textContent = r.unitId;
    tdUnit.style.cssText = 'padding:4px 6px;color:#0b74de;cursor:pointer;font-weight:600;';
    tdUnit.title = 'View coverage history';
    tdUnit.addEventListener('click', (e) => {
      e.stopPropagation();
      try{ openUnitWdNumbersModal(r.unitId, r.start.getFullYear(), r.start.getMonth(), unitIdList); }catch(e){}
    });
    tr.appendChild(tdUnit);

    const tdLease = document.createElement('td'); tdLease.textContent = r.lease; tdLease.style.padding = '4px 6px';
    tr.appendChild(tdLease);
    const tdSupplier = document.createElement('td'); tdSupplier.textContent = r.supplier; tdSupplier.style.padding = '4px 6px';
    tr.appendChild(tdSupplier);
    const tdCC = document.createElement('td'); tdCC.textContent = r.costCenter; tdCC.style.padding = '4px 6px';
    tr.appendChild(tdCC);
    const tdStatus = document.createElement('td');
    tdStatus.textContent = r.status;
    tdStatus.style.cssText = `padding:4px 6px;font-weight:600;color:${r.status.toLowerCase() === 'disabled' ? '#dc2626' : '#15803d'};`;
    tr.appendChild(tdStatus);
    const tdPeriod = document.createElement('td'); tdPeriod.textContent = `${fmtMDY(r.start)} - ${fmtMDY(r.end)}`; tdPeriod.style.padding = '4px 6px';
    tr.appendChild(tdPeriod);
    const tdDays = document.createElement('td'); tdDays.textContent = r.days; tdDays.style.cssText = 'padding:4px 6px;text-align:right;';
    tr.appendChild(tdDays);

    tbody.appendChild(tr);
    if(rowKey === _accrualsSelectedRowKey) selectedTr = tr;
  });
  table.appendChild(tbody);

  tableEl.appendChild(table);

  // Restore whichever row was previously selected (e.g. re-render after a sort click); if it's
  // gone (its period was fully resolved this cycle), advance to whatever now occupies that
  // same position — the next remaining period in the current sort order — rather than jumping
  // to the first row in the whole list. Only falls all the way back to "first row" when there
  // was no previous selection to advance from at all (e.g. the very first render).
  // Only actually drives the shared coverage panel when Table 1 is the sub-tab currently on
  // screen — this render can also run purely to keep the table/cache accurate while Manual
  // Coverage is what's actually visible (e.g. right after accepting an edit from there), and
  // auto-clicking here would otherwise yank the panel away from whatever that list is showing.
  if(_accrualsActiveSubTab === 'missing'){
    let targetTr = selectedTr;
    if(!targetTr && previousIndex !== -1 && _accrualsRowRefs.length > 0){
      targetTr = _accrualsRowRefs[Math.min(previousIndex, _accrualsRowRefs.length - 1)].tr;
    }
    if(!targetTr) targetTr = tbody.querySelector('tr');
    if(targetTr) targetTr.click();
  }
}

// Manual Coverage sub-tab: every unit's manually-marked (purple) period, so an operator can
// still find and consult/edit them after they vanish from the missing-periods review list above
// (a manually-covered day counts as covered, so it stops showing up there — see
// isManuallyCovered/computeUnitMissingPeriods). Shares the same coverage panel as Table 1 (see
// switchAccrualsSubTab) but with the Accrue Unit box hidden — this list is for consultation, not
// accruing.
function renderAccrualsManualPeriods(forceRecompute){
  const tableEl = qs('#accrualsManualPeriodsTable');
  const summaryEl = qs('#accrualsManualPeriodsSummary');
  if(!tableEl) return;

  if(forceRecompute || !_accrualsManualRowsCache){
    const rows = [];
    (state.units || []).forEach(unit => {
      const uid = (unit.unitId || unit.id || '').toString();
      if(!uid) return;
      let periods = [];
      try{ periods = computeUnitManualCoveragePeriods(unit); }catch(e){ periods = []; }
      const status = (unit.status || 'Operational').toString();
      periods.forEach(p => {
        const days = Math.round((p.end - p.start) / 86400000) + 1;
        rows.push({ unitId: uid, lease: unit.lease || '', supplier: unit.supplier || '', costCenter: unit.costCenter || '', status, start: p.start, end: p.end, days });
      });
    });
    _accrualsManualRowsCache = { rows };
  }

  const { rows } = _accrualsManualRowsCache;
  const fmtMDY = (d) => `${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}/${d.getFullYear()}`;

  const COLUMNS = [
    { key: 'unitId', label: 'UnitId', get: r => r.unitId },
    { key: 'lease', label: 'Lease', get: r => r.lease },
    { key: 'supplier', label: 'Supplier', get: r => r.supplier },
    { key: 'costCenter', label: 'Cost Center', get: r => r.costCenter },
    { key: 'status', label: 'Status', get: r => r.status },
    { key: 'period', label: 'Manual Period', get: r => r.start, numeric: true },
    { key: 'days', label: 'Days', get: r => r.days, numeric: true, alignRight: true }
  ];

  const sortCol = COLUMNS.find(c => c.key === _accrualsManualSort.column) || COLUMNS[0];
  const ascending = _accrualsManualSort.ascending;
  rows.sort((a, b) => {
    const av = sortCol.get(a), bv = sortCol.get(b);
    let cmp;
    if(sortCol.numeric){
      cmp = av - bv;
    } else {
      const as = av.toString().toLowerCase(), bs = bv.toString().toLowerCase();
      cmp = as < bs ? -1 : (as > bs ? 1 : 0);
    }
    if(cmp === 0) cmp = a.start - b.start;
    return ascending ? cmp : -cmp;
  });

  if(summaryEl){
    const totalDays = rows.reduce((s, r) => s + r.days, 0);
    const uniqueUnits = new Set(rows.map(r => r.unitId.toLowerCase())).size;
    summaryEl.textContent = rows.length === 0
      ? 'No manually-covered periods found.'
      : `${rows.length} manual coverage period(s) across ${uniqueUnits} unit(s), ${totalDays} total day(s).`;
  }

  tableEl.innerHTML = '';
  if(rows.length === 0){
    _accrualsManualSelectedRowKey = null;
    // Same reason as the equivalent branch in renderAccrualsMissingPeriods: without this,
    // Prev/Next would still see a stale ref list pointing at a detached <tr> and could
    // "navigate" back to a period that no longer has any manual coverage at all.
    _accrualsManualRowRefs = [];
    if(typeof updateAccrualsPanelNav === 'function') updateAccrualsPanelNav();
    if(_accrualsActiveSubTab === 'manual'){
      const emptyEl = qs('#accrualsPanelEmpty'); const contentEl = qs('#accrualsPanelContent');
      if(emptyEl) emptyEl.style.display = 'block';
      if(contentEl) contentEl.style.display = 'none';
    }
    return;
  }

  const unitIdList = Array.from(new Set(rows.map(r => r.unitId)));

  const table = document.createElement('table');
  table.style.cssText = 'width:100%;border-collapse:collapse;font-size:11px;';

  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');

  const thCounter = document.createElement('th');
  thCounter.textContent = '#';
  thCounter.style.cssText = 'text-align:left;padding:4px 6px;font-size:10px;font-weight:600;color:#374151;background:#f9fafb;border-bottom:2px solid #eef2f7;position:sticky;top:0;';
  headerRow.appendChild(thCounter);

  COLUMNS.forEach(col => {
    const th = document.createElement('th');
    th.textContent = col.label + (sortCol.key === col.key ? (ascending ? ' ▲' : ' ▼') : '');
    th.style.cssText = `text-align:${col.alignRight ? 'right' : 'left'};padding:4px 6px;font-size:10px;font-weight:600;color:#374151;background:#f9fafb;border-bottom:2px solid #eef2f7;position:sticky;top:0;cursor:pointer;user-select:none;`;
    th.title = 'Click to sort';
    th.addEventListener('click', () => {
      // Same reason as Table 1's sort handler: rebuilding this table re-selects a row via a
      // programmatic (untrusted) click, which would otherwise skip the pending-edit guard and
      // silently discard an in-progress manual-coverage edit.
      if(accrualsPanelBlockedByPending()) return;
      if(_accrualsManualSort.column === col.key) _accrualsManualSort.ascending = !_accrualsManualSort.ascending;
      else _accrualsManualSort = { column: col.key, ascending: true };
      renderAccrualsManualPeriods();
    });
    headerRow.appendChild(th);
  });
  thead.appendChild(headerRow);
  table.appendChild(thead);

  // Same reasoning as renderAccrualsMissingPeriods's equivalent capture: lets the fallback
  // below advance to the next remaining period at the same position instead of jumping to the
  // first row of the whole list when the previously-selected one disappears entirely (e.g. its
  // last manually-covered date got unmarked and accepted).
  const previousIndex = _accrualsManualRowRefs.findIndex(x => x.rowKey === _accrualsManualSelectedRowKey);

  const tbody = document.createElement('tbody');
  let selectedTr = null;
  _accrualsManualRowRefs = [];
  rows.forEach((r, i) => {
    const tr = document.createElement('tr');
    tr.style.borderBottom = '1px solid #f0f0f0';
    tr.style.cursor = 'pointer';
    const rowKey = r.unitId.toLowerCase() + '|' + r.start.getTime();
    _accrualsManualRowRefs.push({ rowKey, r, tr });

    tr.addEventListener('mouseenter', () => { if(tr.dataset.selected !== 'true') tr.style.backgroundColor = '#f3f6fb'; });
    tr.addEventListener('mouseleave', () => { if(tr.dataset.selected !== 'true') tr.style.backgroundColor = ''; });
    tr.addEventListener('click', (e) => {
      if(e.isTrusted && accrualsPanelBlockedByPending()) return;
      Array.from(tbody.querySelectorAll('tr')).forEach(row => { row.dataset.selected = ''; row.style.backgroundColor = ''; });
      tr.dataset.selected = 'true';
      tr.style.backgroundColor = '#e6f0ff';
      _accrualsManualSelectedRowKey = rowKey;
      renderAccrualsCoveragePanel(r.unitId, r.start.getFullYear(), r.start.getMonth());
      updateAccrualsPanelNav();
    });

    const tdCounter = document.createElement('td'); tdCounter.textContent = i + 1; tdCounter.style.cssText = 'padding:4px 6px;color:#6b7280;';
    tr.appendChild(tdCounter);

    const tdUnit = document.createElement('td');
    tdUnit.textContent = r.unitId;
    tdUnit.style.cssText = 'padding:4px 6px;color:#0b74de;cursor:pointer;font-weight:600;';
    tdUnit.title = 'View coverage history';
    tdUnit.addEventListener('click', (e) => {
      e.stopPropagation();
      try{ openUnitWdNumbersModal(r.unitId, r.start.getFullYear(), r.start.getMonth(), unitIdList); }catch(e){}
    });
    tr.appendChild(tdUnit);

    const tdLease = document.createElement('td'); tdLease.textContent = r.lease; tdLease.style.padding = '4px 6px';
    tr.appendChild(tdLease);
    const tdSupplier = document.createElement('td'); tdSupplier.textContent = r.supplier; tdSupplier.style.padding = '4px 6px';
    tr.appendChild(tdSupplier);
    const tdCC = document.createElement('td'); tdCC.textContent = r.costCenter; tdCC.style.padding = '4px 6px';
    tr.appendChild(tdCC);
    const tdStatus = document.createElement('td');
    tdStatus.textContent = r.status;
    tdStatus.style.cssText = `padding:4px 6px;font-weight:600;color:${r.status.toLowerCase() === 'disabled' ? '#dc2626' : '#15803d'};`;
    tr.appendChild(tdStatus);
    const tdPeriod = document.createElement('td'); tdPeriod.textContent = `${fmtMDY(r.start)} - ${fmtMDY(r.end)}`; tdPeriod.style.padding = '4px 6px';
    tr.appendChild(tdPeriod);
    const tdDays = document.createElement('td'); tdDays.textContent = r.days; tdDays.style.cssText = 'padding:4px 6px;text-align:right;';
    tr.appendChild(tdDays);

    tbody.appendChild(tr);
    if(rowKey === _accrualsManualSelectedRowKey) selectedTr = tr;
  });
  table.appendChild(tbody);

  tableEl.appendChild(table);

  // Only drives the shared panel when Manual Coverage is actually the sub-tab on screen — this
  // render can also run purely to keep the list/cache accurate while Missing Periods is what's
  // visible (e.g. right after accepting an edit from there).
  if(_accrualsActiveSubTab === 'manual'){
    let targetTr = selectedTr;
    if(!targetTr && previousIndex !== -1 && _accrualsManualRowRefs.length > 0){
      targetTr = _accrualsManualRowRefs[Math.min(previousIndex, _accrualsManualRowRefs.length - 1)].tr;
    }
    if(!targetTr) targetTr = tbody.querySelector('tr');
    if(targetTr) targetTr.click();
  }
}

// Moves the shared coverage panel between the two sub-tabs' own slots, shows/hides the Accrue
// Unit box (Manual Coverage is consult/edit-only — no accrue feature there), and (re)renders
// whichever list is now active. forceRecompute is only meaningful for the Missing Periods list
// (passed through on tab entry); the Manual Coverage list is always recomputed fresh since
// grouping a unit's manualCoverageDates is cheap — no caching benefit worth the staleness risk.
function switchAccrualsSubTab(tab, forceRecompute){
  _accrualsActiveSubTab = tab;

  const missingPanel = qs('#accrualsSubMissing');
  const manualPanel = qs('#accrualsSubManual');
  if(missingPanel) missingPanel.style.display = tab === 'manual' ? 'none' : '';
  if(manualPanel) manualPanel.style.display = tab === 'manual' ? '' : 'none';

  document.querySelectorAll('.accruals-subtab-btn').forEach(b => {
    const active = b.dataset.subtab === tab;
    b.style.background = active ? '#0b74de' : '#eef2f7';
    b.style.color = active ? '#fff' : '#374151';
  });

  const panelEl = qs('#accrualsCoveragePanel');
  const targetSlot = qs(tab === 'manual' ? '#accrualsPanelSlotManual' : '#accrualsPanelSlotMissing');
  if(panelEl && targetSlot && panelEl.parentElement !== targetSlot) targetSlot.appendChild(panelEl);

  const accrueBox = qs('#accrualsAccrueUnitBox');
  if(accrueBox) accrueBox.style.display = tab === 'manual' ? 'none' : '';

  if(tab === 'manual') renderAccrualsManualPeriods(true);
  else renderAccrualsMissingPeriods(!!forceRecompute);
}

document.querySelectorAll('.accruals-subtab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    // Switching sub-tabs forces the target list to recompute, whose trailing auto-select
    // (a programmatic, untrusted click) reaches renderAccrualsCoveragePanel and unconditionally
    // resets pending manual-coverage tracking — block it here the same way row clicks and
    // Prev/Next already are, so a pending edit can't be silently discarded by switching lists.
    if(accrualsPanelBlockedByPending()) return;
    switchAccrualsSubTab(btn.dataset.subtab);
  });
});

// Called after the background auto-refresh (startAutoRefresh, every 60s) pulls in changes from
// other sessions — a new invoice, a status change, another operator's own accrual/manual-
// coverage edit. Everything else in the app renders straight from `state` on demand, so those
// changes show up the next time the operator interacts with that view; the Accruals tab is the
// one place that caches its computed rows instead (see _accrualsMissingRowsCache/
// _accrualsManualRowsCache), so without this it would keep showing whatever was true when the
// tab was last entered, indefinitely, until the operator happened to leave and come back.
// Only touches the screen when the Accruals tab is actually the one visible right now, and the
// auto-refresh interval already skips this entire cycle while a manual-coverage edit is
// pending (see startAutoRefresh) — so this can never interrupt or discard in-progress work.
function silentlyRefreshAccrualsIfVisible(){
  try{
    const panel = qs('#accruals');
    if(!panel || !panel.classList.contains('active')) return;
    // startAutoRefresh's own guard only checks these flags BEFORE its network fetch — an edit
    // that started mid-fetch (a real, if narrow, window) wouldn't be caught there. Re-checking
    // here, right before touching the DOM, closes that gap: state.units/state.accruals may
    // already have been replaced by the caller by this point, but skipping the repaint at
    // least stops it from also visibly resetting the panel's pending-edit UI out from under
    // whatever the operator is doing right now.
    if(typeof _accrualsHasPendingChanges !== 'undefined' && _accrualsHasPendingChanges) return;
    if(typeof _accrualsSyncInFlight !== 'undefined' && _accrualsSyncInFlight) return;

    // Rebuilding a list's <table> resets its own scroll container back to the top — fine for
    // a render the operator just triggered themselves, but a background refresh doing that
    // every 60s while they're reviewing row 200 of 342 would be exactly the kind of disruption
    // this is supposed to avoid. Snapshot and restore each list's scroll position around it.
    const missingList = qs('#accrualsMissingPeriodsTable');
    const manualList = qs('#accrualsManualPeriodsTable');
    const missingScroll = missingList ? missingList.scrollTop : 0;
    const manualScroll = manualList ? manualList.scrollTop : 0;

    switchAccrualsSubTab(_accrualsActiveSubTab || 'missing', true);
    if(typeof renderAccrualsAccruedList === 'function') renderAccrualsAccruedList();
    if(typeof renderAccrualsNotAccruableList === 'function') renderAccrualsNotAccruableList();

    if(missingList) missingList.scrollTop = missingScroll;
    if(manualList) manualList.scrollTop = manualScroll;
  }catch(e){}
}

// Coverage history panel (right side of Provisional Table 1): shows the same interactive
// day/month calendar as the "Coverage history" popup, but reused inline here (see
// buildUnitCoverageGrid/buildUnitStats's optional element-id params) so an operator can check
// a missing period against the actual calendar without leaving the Accruals tab. focusYear/
// focusMonth (the selected row's own missing period) are used only to scroll that month into
// view once the grid is built — they don't change what's rendered.
// Keeps the list's own scroll cap matched to the panel's actual rendered height, so opening
// the day/month detail popup (which lives inside the panel's own fixed-height scroll area and
// therefore never changes the panel's total height) never leaves the two looking mismatched.
function syncAccrualsListHeight(){
  try{
    const panelEl = qs('#accrualsCoveragePanel');
    const listEl = qs(_accrualsActiveSubTab === 'manual' ? '#accrualsManualPeriodsTable' : '#accrualsMissingPeriodsTable');
    if(panelEl && listEl && panelEl.offsetHeight > 0) listEl.style.maxHeight = panelEl.offsetHeight + 'px';
  }catch(e){}
}

// Scrolls `el` into view within `container`'s own scrollbar only, by adjusting container's
// scrollTop directly — unlike Element.scrollIntoView(), this never touches any ancestor beyond
// `container`, so it can't move the outer page's scroll position. align: 'center' pulls the
// element to the container's vertical center (used for the coverage calendar's month scroll);
// 'nearest' only scrolls the minimum needed to bring it fully into view (used for row nav).
function scrollIntoContainerView(el, container, align){
  if(!el || !container) return;
  try{
    const elRect = el.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    if(align === 'center'){
      const elCenter = elRect.top + elRect.height / 2;
      const containerCenter = containerRect.top + containerRect.height / 2;
      container.scrollTop += (elCenter - containerCenter);
    } else if(elRect.top < containerRect.top){
      container.scrollTop -= (containerRect.top - elRect.top);
    } else if(elRect.bottom > containerRect.bottom){
      container.scrollTop += (elRect.bottom - containerRect.bottom);
    }
  }catch(e){}
}

function renderAccrualsCoveragePanel(unitId, focusYear, focusMonth){
  const unit = (state.units || []).find(u => String(u.unitId||'').trim().toLowerCase() === String(unitId||'').trim().toLowerCase());
  const emptyEl = qs('#accrualsPanelEmpty');
  const contentEl = qs('#accrualsPanelContent');
  if(!unit){
    if(emptyEl) emptyEl.style.display = 'block';
    if(contentEl) contentEl.style.display = 'none';
    syncAccrualsListHeight();
    return;
  }
  if(emptyEl) emptyEl.style.display = 'none';
  if(contentEl) contentEl.style.display = 'block';

  // A fresh render always represents the current committed truth for whichever unit is being
  // shown, so any earlier pending manual-coverage edit is cleared here (accrualsPanelBlockedByPending
  // already prevents reaching this point while a real pending edit exists for a different unit).
  _accrualsPanelUnit = unit;
  _accrualsHasPendingChanges = false;
  _accrualsPendingDates = new Set();
  _accrualsSessionOriginalDates = new Set(unit.manualCoverageDates || []);
  updateAccrualsAcceptButton();
  if(typeof updateAccrueUnitButton === 'function') updateAccrueUnitButton();

  const titleEl = qs('#accrualsPanelTitle');
  if(titleEl) titleEl.textContent = unit.unitId || unitId;

  const statusEl = qs('#accrualsPanelStatus');
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

  const infoEl = qs('#accrualsPanelInfo');
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

  buildUnitCoverageGrid(unit, 'accrualsPanelGrid', 'accrualsPanelPopup', true);
  buildUnitStats(unit, 'accrualsPanelStats');

  // Scroll the calendar so the missing period being reviewed is immediately visible — scoped to
  // the panel's own scroll container (see scrollIntoContainerView) rather than a plain
  // scrollIntoView, which walks every scrollable ancestor including the page itself and was
  // moving the whole window's scroll position on every row click / Prev-Next step.
  if(typeof focusYear === 'number' && typeof focusMonth === 'number'){
    try{
      const gridEl = qs('#accrualsPanelGrid');
      const targetLabel = new Date(focusYear, focusMonth, 1).toLocaleString('en-US', { month: 'short', year: '2-digit' });
      const gridRows = gridEl ? Array.from(gridEl.querySelectorAll('tr')) : [];
      const match = gridRows.find(tr => { const cell = tr.querySelector('td'); return cell && cell.textContent === targetLabel; });
      if(match) scrollIntoContainerView(match, qs('#accrualsPanelScroll'), 'center');
    }catch(e){}
  }

  syncAccrualsListHeight();
}

// After marking/unmarking a day as manually covered, recompute just THIS unit's missing
// periods (cheap — one unit) and patch them into the existing cache rather than recomputing
// every unit, then re-render the list. If the exact row it was showing is now gone entirely
// (split/shrank/resolved), _accrualsSelectedRowKey is deliberately left as-is here — that's
// what lets renderAccrualsMissingPeriods's own fallback advance to whatever now sits at that
// same LIST POSITION (the next period in the operator's current review order), instead of this
// function hunting for and re-targeting some OTHER, unrelated row that happens to belong to
// the same unit (e.g. a second, still-open gap for the same unit further down the list) — that
// used to jump the panel sideways to a different period of the same unit rather than moving
// on to the next one in order, which broke reviewing the list top-to-bottom.
// Always safe to re-render here regardless of which sub-tab is currently on screen —
// renderAccrualsMissingPeriods only auto-selects/drives the shared panel when Table 1 is
// actually the visible sub-tab, so this can never hijack the panel away from Manual Coverage.
function refreshAccrualsRowsForUnit(unit){
  if(!_accrualsMissingRowsCache) return;
  const { rangeStart, rangeEnd } = _accrualsMissingRowsCache;
  const uid = (unit.unitId || unit.id || '').toString();
  if(!uid) return;
  const uidLower = uid.toLowerCase();

  _accrualsMissingRowsCache.rows = _accrualsMissingRowsCache.rows.filter(r => r.unitId.toLowerCase() !== uidLower);
  let periods = [];
  try{ periods = computeUnitMissingPeriods(unit, rangeStart, rangeEnd); }catch(e){ periods = []; }
  const status = (unit.status || 'Operational').toString();
  const newRows = periods.map(p => {
    const days = Math.round((p.end - p.start) / 86400000) + 1;
    return { unitId: uid, lease: unit.lease || '', supplier: unit.supplier || '', costCenter: unit.costCenter || '', status, start: p.start, end: p.end, days };
  });
  _accrualsMissingRowsCache.rows = _accrualsMissingRowsCache.rows.concat(applyAccrualHistoryToRows(newRows));

  renderAccrualsMissingPeriods();
}

// Finds the single row in _accrualsMissingRowsCache.rows matching whichever row is currently
// selected in Table 1 (_accrualsSelectedRowKey) — shared by Accrue Period and Not Accruable so
// both act on exactly the one period the operator is looking at. Different periods for the same
// unit can genuinely need different treatment (a lease's arrangement can change between periods,
// or one gap is a real accrual candidate while an older one isn't), so acting unit-wide would
// silently sweep up periods the operator never looked at or decided on.
function findSelectedMissingPeriodRow(){
  if(!_accrualsMissingRowsCache || !_accrualsSelectedRowKey) return -1;
  return _accrualsMissingRowsCache.rows.findIndex(r => (r.unitId.toLowerCase() + '|' + r.start.getTime()) === _accrualsSelectedRowKey);
}

// A newly-judged period that turns out to directly continue an already-OPEN accrual/not-
// accruable row for the same unit gets folded into that same row (extending its dates) instead
// of fragmenting the current open batch into multiple adjacent one-off rows for what's really
// one continuous stretch. Never matches a CLOSED record — those are frozen and must never be
// touched again once closed (see getAccrualFrozenRanges/computeUnitMissingPeriods). Matched by
// "kind" (notAccruableFlag) so an Accrue action only ever merges into an open accrual row, and a
// Not Accruable action only ever merges into an open not-accruable row — never across the two.
function findAdjacentOpenAccrualRecord(unitId, newStartIso, newEndIso, notAccruableFlag){
  const uidNorm = String(unitId || '').trim().toLowerCase();
  // setDate (not raw ms arithmetic) so a day either side of a DST transition still lands
  // exactly on local midnight of the right calendar day — matches computeUnitMissingPeriods's
  // own day-stepping pattern.
  const beforeDate = isoStrToDate(newStartIso); beforeDate.setDate(beforeDate.getDate() - 1);
  const afterDate = isoStrToDate(newEndIso); afterDate.setDate(afterDate.getDate() + 1);
  const dayBefore = dateToIsoStr(beforeDate);
  const dayAfter = dateToIsoStr(afterDate);
  return (state.accruals || []).find(a => {
    if(a.accrualMonth || a.accrualYear) return false; // closed -- frozen, never touched
    if(!!a.notAccruable !== !!notAccruableFlag) return false;
    if(String(a.unitId || '').trim().toLowerCase() !== uidNorm) return false;
    return a.periodEnd === dayBefore || a.periodStart === dayAfter;
  }) || null;
}

// Moves only the currently-selected period out of the review list and into "Periods Ready to
// Accrue" below, saved to the Accruals sheet as an open (accrualMonth/Year blank) record —
// or, if it directly continues an existing open row for this unit, merged into that row instead
// (see findAdjacentOpenAccrualRecord). Blocked while a manual-coverage edit is still pending, so
// nothing gets accrued out from under an unsaved change.
function accrueCurrentUnit(){
  if(accrualsPanelBlockedByPending()) return;
  if(!_accrualsPanelUnit || !_accrualsMissingRowsCache) return;
  const uid = (_accrualsPanelUnit.unitId || _accrualsPanelUnit.id || '').toString();
  if(!uid) return;

  const idx = findSelectedMissingPeriodRow();
  if(idx === -1) return;
  const movedRow = _accrualsMissingRowsCache.rows[idx];
  _accrualsMissingRowsCache.rows = _accrualsMissingRowsCache.rows.filter((_, i) => i !== idx);

  const newStartIso = dateToIsoStr(movedRow.start), newEndIso = dateToIsoStr(movedRow.end);
  const adjacent = findAdjacentOpenAccrualRecord(movedRow.unitId, newStartIso, newEndIso, false);

  let targetRecord, mergeInfo = null;
  if(adjacent){
    mergeInfo = { recordId: adjacent.id, priorStart: adjacent.periodStart, priorEnd: adjacent.periodEnd, priorDays: adjacent.days };
    const mergedStart = adjacent.periodStart < newStartIso ? adjacent.periodStart : newStartIso;
    const mergedEnd = adjacent.periodEnd > newEndIso ? adjacent.periodEnd : newEndIso;
    adjacent.periodStart = mergedStart;
    adjacent.periodEnd = mergedEnd;
    adjacent.days = Math.round((isoStrToDate(mergedEnd) - isoStrToDate(mergedStart)) / 86400000) + 1;
    targetRecord = adjacent;
    _accrualsSyncInFlight = true;
    DB.updateAccrual(adjacent).catch(e => console.error('Accrual merge error:', e)).finally(() => { _accrualsSyncInFlight = false; });
  } else {
    targetRecord = {
      id: id(),
      unitId: movedRow.unitId, lease: movedRow.lease, supplier: movedRow.supplier, costCenter: movedRow.costCenter, status: movedRow.status,
      periodStart: newStartIso, periodEnd: newEndIso, days: movedRow.days,
      accrualMonth: '', accrualYear: '', createdAt: new Date().toISOString()
    };
    state.accruals = (state.accruals || []).concat([targetRecord]);
    // Tracked via _accrualsSyncInFlight the same way persistManualCoverage tracks its own saves —
    // the 60s background auto-refresh checks this flag and skips its cycle entirely while it's
    // true, so a re-fetch of "Accruals" can never land mid-save and silently revert this record
    // back out of state.accruals before it's actually landed on the sheet.
    _accrualsSyncInFlight = true;
    DB.bulkSaveAccruals([targetRecord]).catch(e => console.error('Accrual save error:', e)).finally(() => { _accrualsSyncInFlight = false; });
  }
  try{ saveState(); }catch(e){}

  _accrualsLastAccruedUnitId = uid;
  _accrualsLastAccruedMissingRows = [movedRow];
  _accrualsLastAccruedIds = [targetRecord.id];
  _accrualsLastAccruedMerge = mergeInfo;

  // Jump the "Periods Ready to Accrue" view to the currently-open month so the operator
  // immediately sees what they just accrued land in the list.
  const openMY = getAccrualsOpenMonthYear();
  _accrualsViewMonth = openMY.month; _accrualsViewYear = openMY.year;

  renderAccrualsMissingPeriods();
  renderAccrualsAccruedList();
  updateAccrueUnitButton();
}

// Weekly/Quarterly leases aren't accrued at all, but their units can still need manual coverage
// tracked — without this, their missing periods would sit in the review list above forever with
// no way out (they'll never be genuinely "covered", and accruing them doesn't make sense). Moves
// only the currently-selected period out of Missing Periods and into its own Not Accruable table
// below (saved to the same Accruals sheet, flagged notAccruable:'true', and never given an
// accrualMonth/Year — so it can never be swept into a closed accrual document or silently
// reconciled away just because coverage happens to change later) — or, if it directly continues
// an existing open not-accruable row for this unit, merged into that row instead (see
// findAdjacentOpenAccrualRecord). Reversible any time via that table's own Remove button (which
// removes the whole row, merged range included). Blocked while a manual-coverage edit is still
// pending, same as Accrue Period.
function markCurrentPeriodNotAccruable(){
  if(accrualsPanelBlockedByPending()) return;
  if(!_accrualsPanelUnit || !_accrualsMissingRowsCache) return;
  const uid = (_accrualsPanelUnit.unitId || _accrualsPanelUnit.id || '').toString();
  if(!uid) return;

  const idx = findSelectedMissingPeriodRow();
  if(idx === -1) return;
  const movedRow = _accrualsMissingRowsCache.rows[idx];
  _accrualsMissingRowsCache.rows = _accrualsMissingRowsCache.rows.filter((_, i) => i !== idx);

  const newStartIso = dateToIsoStr(movedRow.start), newEndIso = dateToIsoStr(movedRow.end);
  const adjacent = findAdjacentOpenAccrualRecord(movedRow.unitId, newStartIso, newEndIso, true);

  if(adjacent){
    const mergedStart = adjacent.periodStart < newStartIso ? adjacent.periodStart : newStartIso;
    const mergedEnd = adjacent.periodEnd > newEndIso ? adjacent.periodEnd : newEndIso;
    adjacent.periodStart = mergedStart;
    adjacent.periodEnd = mergedEnd;
    adjacent.days = Math.round((isoStrToDate(mergedEnd) - isoStrToDate(mergedStart)) / 86400000) + 1;
    _accrualsSyncInFlight = true;
    DB.updateAccrual(adjacent).catch(e => console.error('Not Accruable merge error:', e)).finally(() => { _accrualsSyncInFlight = false; });
  } else {
    const newRecord = {
      id: id(),
      unitId: movedRow.unitId, lease: movedRow.lease, supplier: movedRow.supplier, costCenter: movedRow.costCenter, status: movedRow.status,
      periodStart: newStartIso, periodEnd: newEndIso, days: movedRow.days,
      accrualMonth: '', accrualYear: '', notAccruable: 'true', createdAt: new Date().toISOString()
    };
    state.accruals = (state.accruals || []).concat([newRecord]);
    _accrualsSyncInFlight = true;
    DB.bulkSaveAccruals([newRecord]).catch(e => console.error('Not Accruable save error:', e)).finally(() => { _accrualsSyncInFlight = false; });
  }
  try{ saveState(); }catch(e){}

  renderAccrualsMissingPeriods();
  renderAccrualsNotAccruableList();
  updateAccrueUnitButton();
}

// Puts the most recently accrued period straight back into the review list — a single safety-net
// level of undo, not a full history; accruing another period (or closing the month) replaces/
// clears the target. Two shapes, per _accrualsLastAccruedMerge:
//   - ordinary create: deletes the just-created Accruals row entirely.
//   - merge into an existing open row: shrinks that row back to its pre-merge range instead of
//     deleting it — deleting would also destroy whatever was already accrued there before this
//     particular action.
function undoAccrueUnit(){
  if(!_accrualsLastAccruedMissingRows || !_accrualsLastAccruedUnitId || !_accrualsLastAccruedIds) return;
  if(_accrualsLastAccruedMerge){
    const { recordId, priorStart, priorEnd, priorDays } = _accrualsLastAccruedMerge;
    const rec = (state.accruals || []).find(a => a.id === recordId);
    if(rec){
      rec.periodStart = priorStart; rec.periodEnd = priorEnd; rec.days = priorDays;
      _accrualsSyncInFlight = true;
      DB.updateAccrual(rec).catch(e => console.error('Accrual undo/merge-revert error:', e)).finally(() => { _accrualsSyncInFlight = false; });
    }
  } else {
    const idsToRemove = new Set(_accrualsLastAccruedIds);
    _accrualsSyncInFlight = true;
    DB.bulkDeleteAccruals(_accrualsLastAccruedIds).catch(e => console.error('Accrual undo/delete error:', e)).finally(() => { _accrualsSyncInFlight = false; });
    state.accruals = (state.accruals || []).filter(a => !idsToRemove.has(a.id));
  }
  try{ saveState(); }catch(e){}

  if(_accrualsMissingRowsCache) _accrualsMissingRowsCache.rows = _accrualsMissingRowsCache.rows.concat(_accrualsLastAccruedMissingRows);
  _accrualsLastAccruedUnitId = null;
  _accrualsLastAccruedMissingRows = null;
  _accrualsLastAccruedIds = null;
  _accrualsLastAccruedMerge = null;

  renderAccrualsMissingPeriods();
  renderAccrualsAccruedList();
  updateAccrueUnitButton();
}

// Locks in every currently-open accrual as the tracked open month's document, then advances
// the tracker to the next month — irreversible (matches "once closed there's no more editions"),
// so this asks for confirmation first and clears the Undo label (a closed record can't be
// undone from here anymore).
// Exports the currently-OPEN "Periods Ready to Accrue" batch to a two-tab Excel workbook so the
// boss can analyze Accumulated and Current Month amounts separately. Deliberately independent of
// whatever month the table happens to be VIEWING right now (a closed month could be on screen) —
// always the actual open, not-yet-closed batch, the same one "Close Month Accruals" would lock
// in. A unit appears on whichever tab(s) its respective amount is nonzero for: both tabs if it
// has both a real Accumulated and Current Month figure, only one if only one applies, neither if
// both happen to be $0. No sheet protection is applied, so every cell stays freely editable.
function downloadAccrualsDeliverable(){
  if(!(window.XLSX && typeof XLSX === 'object')){ alert('Excel export library not found. Please reload the page.'); return; }

  const { month, year } = getAccrualsOpenMonthYear();
  // Not Accruable records are excluded — same rule as "Periods Ready to Accrue" itself, they're
  // never a dollar figure to deliver.
  const openRecords = (state.accruals || []).filter(a => !a.accrualMonth && !a.accrualYear && !a.notAccruable);
  const fmtMDY = (iso) => { const d = isoStrToDate(iso); return isNaN(d) ? iso : `${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}/${d.getFullYear()}`; };

  const rows = openRecords.map(r => {
    const estimate = computeAccrualChargeEstimate(r);
    const split = splitAccrualAmountByViewMonth(r, estimate.chargePerDay, month, year);
    return {
      unitId: r.unitId, lease: r.lease, supplier: r.supplier, company: getUnitCompanyText(r.unitId), costCenter: r.costCenter, status: r.status,
      disabledDate: getUnitDisabledDateText(r.unitId),
      // "Last WD/Period/Amount" are always the NATURAL closest-prior invoice, regardless of any
      // override — "Actual Cost Per Unit" (accrualAmountUsed) is the amount actually driving
      // Charge/Day and the Accumulated/Current Month figures, which only differs from the
      // natural one when an operator has deliberately picked a different source period
      // ("Use Block to Accrue").
      lastWdInvoiceNumber: estimate.naturalSourceWd,
      lastInvoicePeriodText: estimate.naturalFound ? `${fmtMDY(estimate.naturalSourceFrom)} - ${fmtMDY(estimate.naturalSourceTo)}` : '',
      lastInvoiceAmount: estimate.naturalTotalAmount,
      chargePerDay: estimate.chargePerDay,
      accrualAmountUsed: estimate.totalAmount,
      // No column shows the record's own full raw span (periodStart/periodEnd) here — only each
      // tab's own scoped period below (accumulatedPeriodText/currentMonthPeriodText), which is
      // the exact range that tab's dollar amount actually covers. A record spanning e.g. Apr 1 –
      // Aug 31 would otherwise show that whole range next to its Accumulated figure and read as
      // if the amount covered August too, which is exactly the confusion a live user hit.
      accumulated: split.accumulatedAmount, accumulatedDays: split.accumulatedDays,
      accumulatedPeriodText: split.accumulatedStart ? `${fmtMDY(split.accumulatedStart)} - ${fmtMDY(split.accumulatedEnd)}` : '',
      currentMonth: split.currentMonthAmount, currentMonthDays: split.currentMonthDays,
      currentMonthPeriodText: split.currentMonthStart ? `${fmtMDY(split.currentMonthStart)} - ${fmtMDY(split.currentMonthEnd)}` : '',
      total: split.totalAmount,
      comment: (() => { const c = getAccrualComment(r); return c ? c.text : ''; })()
    };
  });

  const totalAccumulated = rows.reduce((s, r) => s + r.accumulated, 0);
  const totalCurrentMonth = rows.reduce((s, r) => s + r.currentMonth, 0);

  const wb = XLSX.utils.book_new();
  wb.Props = {
    Title: `Accruals Deliverable ${accrualMonthName(month)} ${year}`,
    Subject: 'AGI Vehicle Lease Management — Accruals Deliverable',
    Author: 'AGI Vehicle Lease Management', Company: 'AGI', CreatedDate: new Date()
  };

  // Same visual vocabulary as exportReport's Vehicle_Report styles above, kept local to this
  // function since the two exports don't otherwise share any data/state.
  const baseFont = { name: 'Calibri', sz: 11 };
  const styles = {
    header: {
      font: Object.assign({}, baseFont, { bold: true, color: { rgb: 'FFFFFF' } }),
      fill: { fgColor: { rgb: '0B74DE' } },
      alignment: { horizontal: 'center', vertical: 'center' },
      border: { left:{style:'thin',color:{rgb:'0B74DE'}}, right:{style:'thin',color:{rgb:'0B74DE'}}, top:{style:'thin',color:{rgb:'0B74DE'}}, bottom: { style: 'medium', color: { rgb: '0B74DE' } } }
    },
    title: { font: Object.assign({}, baseFont, { bold: true, sz: 16, color: { rgb: '0B74DE' } }), alignment: { horizontal: 'left', vertical: 'center' } },
    info: { alignment: { vertical: 'center' }, font: baseFont },
    zebra: { fill: { fgColor: { rgb: 'F8FAFC' } } },
    money: { alignment: { horizontal: 'right', vertical: 'center' }, font: baseFont, numFmt: '$#,##0.00' },
    tabTotalLabel: { font: Object.assign({}, baseFont, { bold: true }), alignment: { horizontal: 'right' } },
    tabTotalValue: { font: Object.assign({}, baseFont, { bold: true }), numFmt: '$#,##0.00' },
    infoLabel: { font: Object.assign({}, baseFont, { italic: true, color: { rgb: '6B7280' } }), alignment: { horizontal: 'right' } },
    infoValue: { font: Object.assign({}, baseFont, { italic: true, color: { rgb: '6B7280' } }), numFmt: '$#,##0.00' }
  };
  // Deep-merges object-valued style properties (font/fill/border/alignment) but directly
  // overwrites primitive ones (numFmt is a plain string) — Object.assign({}, ..., aString)
  // treats the string as array-like and iterates its characters into a {0:'$',1:'#',...} object
  // instead of keeping it a string, which is exactly what silently corrupted numFmt here and
  // made the real XLSX library's own numFmt writer crash on a non-string with "e.replace is not
  // a function" the moment a save was actually attempted.
  function mergeStyles(...objs){
    const out = {};
    objs.forEach(o => {
      if(!o) return;
      Object.keys(o).forEach(k => {
        const v = o[k];
        out[k] = (v && typeof v === 'object' && !Array.isArray(v)) ? Object.assign({}, out[k], v) : v;
      });
    });
    return out;
  }
  // aoa_to_sheet doesn't infer a cell's type (.t) from .v for the {v,s} object form the way it
  // does for a bare value — leaving .t unset makes some readers (including XLSX's own
  // sheet_to_json) treat the cell as blank even though .v is set. Always stamp it explicitly.
  function cell(v, s){ return { v, t: (typeof v === 'number') ? 'n' : 's', s }; }
  // A live Excel formula cell (no leading "=" — SheetJS convention) — `v` is a precomputed
  // fallback so the cell still shows something sensible even in a viewer that doesn't
  // recalculate formulas; Excel itself recalculates .f on open and overwrites the cached .v.
  function formulaCellFn(formula, fallbackValue, s){ return { f: formula, v: fallbackValue, t: 's', s }; }

  const HEADERS = ['UnitId', 'Lease', 'Supplier', 'AGI Company', 'Cost Center', 'Status', 'Disabled Date', 'Last WD Invoice Number', 'Last Invoice Period', 'Last Invoice Amount', 'Charge/Day', 'Actual Cost Per Unit'];

  // Rounds UP to the next whole dollar — 7650.58 becomes 7651, and a value already whole (e.g.
  // 100.00) stays put, never bumps to the next dollar. Snaps to the cent first so day-based
  // division's ordinary floating-point noise (e.g. 100.00000000001 from a repeating decimal
  // chargePerDay) can never falsely push an amount that's really exactly $100.00 up to $101.
  function roundUpToDollar(v){
    const cents = Math.round((Number(v) || 0) * 100) / 100;
    return Math.ceil(cents);
  }

  // amountKey/amountLabel: the ONE amount metric this tab is scoped to (Accumulated or Current
  // Month) — kept as the tab's own single dollar column, separate from the other tab's metric,
  // so the boss can analyze each independently rather than one mixed table. periodTextKey/
  // daysKey point at that same tab's own scoped period/day-count fields (see the row-building
  // above), so what's shown always matches exactly what the amount column covers. There is
  // deliberately no "full record period" column here at all — one was tried (both up front, and
  // later demoted to a reference-only column after the amount) and in practice a reader kept
  // reading whichever one they saw first as THE period this amount covers, even when it wasn't.
  // Simplest fix: don't show a period that isn't the one being reported on.
  // amountLabel stays the short form ("Accumulated"/"Current Month") and still drives Period/
  // Days/the Round column's name; amountColumnLabel is ONLY the amount column's own header text
  // ("Accumulated Accrual"/"Current Month Accrual") — kept separate since the Round column is
  // named off the SHORT label ("Accumulated (Round)"), not the Accrual-suffixed one.
  function buildTabSheet(tabTitle, titleDateText, amountLabel, amountColumnLabel, amountKey, periodTextKey, daysKey, tabRows, tabTotal){
    const headerRow = HEADERS.concat([`${amountLabel} Period`, `${amountLabel} Days`, amountColumnLabel, `${amountLabel} (Round)`, 'Comment', 'Accounting Summary']).map(h => cell(h, styles.header));
    const totalCols = headerRow.length;
    const titleText = `${tabTitle} — ${titleDateText}`;
    const blankRow = (s) => Array.from({ length: totalCols }, () => cell('', s));
    const aoa = [
      [cell(titleText, styles.title)].concat(Array.from({ length: totalCols - 1 }, () => cell('', styles.title))),
      headerRow
    ];
    // Column letters for the Accounting Summary formula below — computed once from HEADERS'
    // fixed layout rather than hardcoded, so this keeps working if a column is ever added/
    // removed ahead of it.
    const colLetter = (idx) => XLSX.utils.encode_col(idx);
    const colUnitId = colLetter(0), colLease = colLetter(1), colSupplier = colLetter(2);
    const colLastWd = colLetter(7), colLastInvoicePeriod = colLetter(8);
    const colTabPeriod = colLetter(HEADERS.length); // first column appended after HEADERS
    tabRows.forEach((r, idx) => {
      const zebra = (idx % 2 === 1) ? styles.zebra : null;
      const excelRow = idx + 3; // 1 = title, 2 = header, data starts at row 3
      // A live formula so the summary stays correct even if the boss edits a referenced cell
      // (e.g. corrects a typo'd Supplier) directly in Excel — matches "give edition to the
      // report". The cached fallback value below mirrors it exactly for non-recalculating viewers.
      const summaryFormula = `"Unit "&${colUnitId}${excelRow}&" — Supplier "&${colSupplier}${excelRow}&", Lease "&${colLease}${excelRow}&" — Last received: WD "&${colLastWd}${excelRow}&" ("&${colLastInvoicePeriod}${excelRow}&") — ${amountLabel} period: "&${colTabPeriod}${excelRow}`;
      const summaryFallback = `Unit ${r.unitId} — Supplier ${r.supplier}, Lease ${r.lease} — Last received: WD ${r.lastWdInvoiceNumber || '(none)'} (${r.lastInvoicePeriodText || 'n/a'}) — ${amountLabel} period: ${r[periodTextKey] || 'n/a'}`;
      aoa.push([
        cell(r.unitId, mergeStyles(styles.info, zebra)),
        cell(r.lease, mergeStyles(styles.info, zebra)),
        cell(r.supplier, mergeStyles(styles.info, zebra)),
        cell(r.company, mergeStyles(styles.info, zebra)),
        cell(r.costCenter, mergeStyles(styles.info, zebra)),
        cell(r.status, mergeStyles(styles.info, zebra)),
        cell(r.disabledDate, mergeStyles(styles.info, zebra)),
        cell(r.lastWdInvoiceNumber, mergeStyles(styles.info, zebra)),
        cell(r.lastInvoicePeriodText, mergeStyles(styles.info, zebra)),
        cell(r.lastInvoiceAmount, mergeStyles(styles.money, zebra)),
        cell(r.chargePerDay, mergeStyles(styles.money, zebra)),
        cell(r.accrualAmountUsed, mergeStyles(styles.money, zebra)),
        cell(r[periodTextKey], mergeStyles(styles.info, zebra)),
        cell(r[daysKey], mergeStyles(styles.info, zebra, { alignment: { horizontal: 'right' } })),
        cell(r[amountKey], mergeStyles(styles.money, zebra)),
        // Rounded UP to the next whole dollar (never nearest — 7650.58 becomes 7651, never 7650)
        // — a separate column, the exact amount above is never overwritten/replaced.
        cell(roundUpToDollar(r[amountKey]), mergeStyles(styles.money, zebra)),
        cell(r.comment, mergeStyles(styles.info, zebra, { alignment: { wrapText: true } })),
        formulaCellFn(summaryFormula, summaryFallback, mergeStyles(styles.info, zebra, { alignment: { wrapText: true } }))
      ]);
    });

    // Amount column now sits four from the end (Rounded Up, Comment, and Accounting Summary
    // trail after it) — label/value land there, not assuming the amount is the very last column.
    const amountColIdx = totalCols - 4;
    const roundedColIdx = amountColIdx + 1;

    // This tab's own total — sums exactly the rows actually listed above, nothing more. Kept as
    // the ONLY totals row on this tab (an earlier version also repeated a second "Overview —
    // whole open batch" block further down with all three headline figures, including the OTHER
    // tab's own metric — that's exactly the kind of cross-scope mixing the Accumulated/Current
    // Month split exists to avoid, and read as if the filter's own selection list reached the
    // totals). A solid top border spans the row (every cell, not just label/value) so it reads
    // unmistakably as a footer bar immediately below the data, never as another filterable row —
    // the filter range itself (below) still stops exactly at the last data row regardless.
    const footerBorder = { border: { top: { style: 'medium', color: { rgb: '0B74DE' } } } };
    aoa.push(blankRow());
    const totalRow = blankRow(footerBorder);
    totalRow[amountColIdx - 1] = cell(`Total ${amountLabel}:`, mergeStyles(styles.tabTotalLabel, footerBorder));
    totalRow[amountColIdx] = cell(tabTotal, mergeStyles(styles.tabTotalValue, footerBorder));
    // Sum of the ALREADY-rounded-up per-row figures (not the raw total rounded up) — lands
    // directly under the "(Round)" column, right next to the exact total for comparison.
    const tabTotalRounded = tabRows.reduce((s, r) => s + roundUpToDollar(r[amountKey]), 0);
    totalRow[roundedColIdx] = cell(tabTotalRounded, mergeStyles(styles.tabTotalValue, footerBorder));
    aoa.push(totalRow);

    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const range = XLSX.utils.encode_range({ s: { r: 1, c: 0 }, e: { r: 1 + tabRows.length, c: totalCols - 1 } });
    ws['!autofilter'] = { ref: range };
    ws['!freeze'] = { xSplit: 0, ySplit: 2, topLeftCell: 'A3', activePane: 'bottomLeft' };
    ws['!cols'] = [ {wch:14}, {wch:12}, {wch:14}, {wch:18}, {wch:14}, {wch:10}, {wch:14}, {wch:16}, {wch:22}, {wch:16}, {wch:12}, {wch:16}, {wch:22}, {wch:10}, {wch:16}, {wch:16}, {wch:30}, {wch:70} ];
    ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: totalCols - 1 } }];
    return ws;
  }

  const accumulatedRows = rows.filter(r => r.accumulated !== 0);
  const currentRows = rows.filter(r => r.currentMonth !== 0);

  // Accumulated's title shows the actual cutoff date it covers THROUGH — the last day of the
  // last CLOSED month (the day right before the currently-open month starts) — rather than the
  // open month's own name, since "Accumulated" by definition never includes the open month.
  // new Date(year, month - 1, 0) rolls back across a January open month into December of the
  // prior year automatically, same as every other month-math in this app.
  const lastClosedDate = new Date(year, month - 1, 0);
  const lastClosedDateText = isNaN(lastClosedDate) ? '' :
    `${String(lastClosedDate.getMonth() + 1).padStart(2, '0')}/${String(lastClosedDate.getDate()).padStart(2, '0')}/${lastClosedDate.getFullYear()}`;

  const wsAccumulated = buildTabSheet('Accumulated Amounts', lastClosedDateText, 'Accumulated', 'Accumulated Accrual', 'accumulated', 'accumulatedPeriodText', 'accumulatedDays', accumulatedRows, totalAccumulated);
  XLSX.utils.book_append_sheet(wb, wsAccumulated, 'Accumulated');
  const wsCurrent = buildTabSheet('Current Month Amounts', `${accrualMonthName(month)} ${year}`, 'Current Month', 'Current Month Accrual', 'currentMonth', 'currentMonthPeriodText', 'currentMonthDays', currentRows, totalCurrentMonth);
  XLSX.utils.book_append_sheet(wb, wsCurrent, 'Current Month');

  const fname = `Accruals_Deliverable_${accrualMonthName(month)}_${year}.xlsx`;
  try{ XLSX.writeFile(wb, fname); }catch(e){ alert('Failed to save Excel: ' + (e && e.message || e)); }
}

function closeAccrualsMonth(){
  const { month, year } = getAccrualsOpenMonthYear();
  // Not Accruable records share the same blank-accrualMonth/Year shape as open accruals but
  // must never be swept into a closed dollar-accrual document — excluded here explicitly.
  const openRecords = (state.accruals || []).filter(a => !a.accrualMonth && !a.accrualYear && !a.notAccruable);
  const monthLabel = `${accrualMonthName(month)} ${year}`;
  const confirmMsg = openRecords.length > 0
    ? `Close ${monthLabel}'s accrual batch? This will lock ${openRecords.length} period(s) as ${monthLabel} — no further edits after this. New accruals will start going to ${accrualMonthName(month === 12 ? 1 : month + 1)} ${month === 12 ? year + 1 : year}.`
    : `Close ${monthLabel} with no periods accrued, and move to ${accrualMonthName(month === 12 ? 1 : month + 1)} ${month === 12 ? year + 1 : year}?`;
  if(!confirm(confirmMsg)) return;

  const updateCalls = openRecords.map(rec => {
    rec.accrualMonth = String(month);
    rec.accrualYear = String(year);
    return DB.updateAccrual(rec).catch(e => console.error('Accrual close error:', e));
  });

  let nextMonth = month + 1, nextYear = year;
  if(nextMonth > 12){ nextMonth = 1; nextYear += 1; }
  state.meta.accrualsOpenMonth = nextMonth;
  state.meta.accrualsOpenYear = nextYear;
  // Also explicitly tracked (redundant with the saveState() call below, which pushes the same
  // meta): a re-fetch of getMeta() from the 60s auto-refresh racing this specific save would
  // silently revert the just-closed month's tracker back to the prior (still-open) month —
  // confusing since "Close Month Accruals" would then look like it never happened. Kept in the
  // SAME in-flight window as the record updates above, not a separate one.
  updateCalls.push(DB.saveAll(state).catch(e => console.error('Accrual close meta save error:', e)));
  _accrualsSyncInFlight = true;
  Promise.allSettled(updateCalls).finally(() => { _accrualsSyncInFlight = false; });
  try{ saveState(); }catch(e){}

  // The Undo label only ever makes sense for still-open records — anything it pointed to just
  // got closed above.
  _accrualsLastAccruedUnitId = null;
  _accrualsLastAccruedMissingRows = null;
  _accrualsLastAccruedIds = null;
  _accrualsLastAccruedMerge = null;

  // Follow the view to the newly-open (empty) month so it's obvious the close succeeded.
  _accrualsViewMonth = nextMonth; _accrualsViewYear = nextYear;

  // Missing Periods is capped at the end of whichever month is open (see
  // renderAccrualsMissingPeriods) — now that the tracker just advanced, a still-cached scan
  // would keep hiding next month's periods until something else happened to force a recompute.
  // Force one now so they become visible/accruable immediately, not just after the operator
  // happens to re-enter that sub-tab or trigger some unrelated re-render.
  renderAccrualsMissingPeriods(true);
  renderAccrualsAccruedList();
  updateAccrueUnitButton();
}

// Enables/disables "Accrue Period"/"Not Accruable" based on whether the currently-selected row
// in Table 1 still exists, and shows/hides the "Undo" label for the most recent accrue action.
function updateAccrueUnitButton(){
  // Both buttons now act on exactly the one selected row (see findSelectedMissingPeriodRow),
  // not every row belonging to the panel's unit — enabled state has to match that precondition.
  const hasSelectedRow = findSelectedMissingPeriodRow() !== -1;
  const enabled = hasSelectedRow && !_accrualsHasPendingChanges;
  const btn = qs('#accrualsAccrueUnitBtn');
  if(btn){
    btn.disabled = !enabled;
    btn.style.opacity = enabled ? '1' : '0.4';
    btn.style.cursor = enabled ? 'pointer' : 'not-allowed';
  }
  const notAccruableBtn = qs('#accrualsNotAccruableBtn');
  if(notAccruableBtn){
    notAccruableBtn.disabled = !enabled;
    notAccruableBtn.style.opacity = enabled ? '1' : '0.4';
    notAccruableBtn.style.cursor = enabled ? 'pointer' : 'not-allowed';
  }
  const undoLabel = qs('#accrualsAccrueUndoLabel');
  if(undoLabel){
    if(_accrualsLastAccruedUnitId){
      undoLabel.style.display = 'block';
      undoLabel.textContent = `Undo — restore ${_accrualsLastAccruedUnitId}'s period`;
    } else {
      undoLabel.style.display = 'none';
      undoLabel.textContent = '';
    }
  }
}

// Whenever a period sitting in "Periods Ready to Accrue" gets covered by a real invoice (or a
// manual-coverage mark) after it was added, the accrual no longer represents a genuine gap —
// leaving it as-is would double count that period. This ONLY ever touches OPEN records (no
// accrualMonth/accrualYear yet) — once a month is closed via "Close Month Accruals" its records
// are a locked historical statement and must never be silently altered just because coverage
// changed afterward, even if that coverage would have fully or partially resolved it.
//
// Reuses computeUnitMissingPeriods (the exact same day-by-day coverage check driving the
// Missing Periods table) restricted to each open record's own original date range, then
// reconciles:
//   - no longer missing at all      -> delete the accrual record entirely
//   - still exactly the same range  -> leave untouched
//   - shrunk to one sub-range       -> update this record's period/days in place
//   - split into 2+ sub-ranges (coverage carved out the middle) -> shrink this record to the
//     first surviving piece and create a new open record for each additional piece
function reconcileOpenAccrualsCoverage(){
  // Not Accruable records are excluded here too — they're a manual "not applicable" marker,
  // not a dollar estimate to reconcile away just because coverage happened to change.
  const openAccruals = (state.accruals || []).filter(a => !a.accrualMonth && !a.accrualYear && !a.notAccruable);
  if(openAccruals.length === 0) return;

  const toDeleteIds = [];
  const toUpdate = [];
  const toCreate = [];

  openAccruals.forEach(a => {
    const unit = (state.units || []).find(u => String(u.unitId || '').trim().toLowerCase() === String(a.unitId || '').trim().toLowerCase());
    if(!unit) return;
    const origStart = isoStrToDate(a.periodStart);
    const origEnd = isoStrToDate(a.periodEnd);
    if(isNaN(origStart) || isNaN(origEnd)) return;

    const stillMissing = computeUnitMissingPeriods(unit, origStart, origEnd, a.id);

    if(stillMissing.length === 0){
      toDeleteIds.push(a.id);
      return;
    }

    const first = stillMissing[0];
    const firstStartStr = dateToIsoStr(first.start), firstEndStr = dateToIsoStr(first.end);
    if(stillMissing.length === 1 && firstStartStr === a.periodStart && firstEndStr === a.periodEnd) return; // unchanged

    const firstDays = Math.round((first.end - first.start) / 86400000) + 1;
    toUpdate.push({ id: a.id, periodStart: firstStartStr, periodEnd: firstEndStr, days: firstDays });

    stillMissing.slice(1).forEach(seg => {
      const days = Math.round((seg.end - seg.start) / 86400000) + 1;
      toCreate.push({
        id: id(), unitId: a.unitId, lease: a.lease, supplier: a.supplier, costCenter: a.costCenter, status: a.status,
        periodStart: dateToIsoStr(seg.start), periodEnd: dateToIsoStr(seg.end), days,
        accrualMonth: '', accrualYear: '', createdAt: new Date().toISOString()
      });
    });
  });

  if(toDeleteIds.length === 0 && toUpdate.length === 0 && toCreate.length === 0) return;

  // Apply locally first so whichever render triggered this reflects it immediately, then
  // persist in the background — same _accrualsSyncInFlight-tracked pattern as every other
  // Accruals mutation, so the 60s auto-refresh can't land mid-reconcile and revert it.
  state.accruals = state.accruals.filter(a => toDeleteIds.indexOf(a.id) === -1);
  toUpdate.forEach(u => {
    const rec = state.accruals.find(a => a.id === u.id);
    if(rec){ rec.periodStart = u.periodStart; rec.periodEnd = u.periodEnd; rec.days = u.days; }
  });
  state.accruals = state.accruals.concat(toCreate);
  try{ saveState(); }catch(e){}

  const pending = [];
  if(toDeleteIds.length > 0) pending.push(DB.bulkDeleteAccruals(toDeleteIds).catch(e => console.error('Accrual reconcile delete error:', e)));
  toUpdate.forEach(u => {
    const rec = state.accruals.find(a => a.id === u.id);
    if(rec) pending.push(DB.updateAccrual(rec).catch(e => console.error('Accrual reconcile update error:', e)));
  });
  if(toCreate.length > 0) pending.push(DB.bulkSaveAccruals(toCreate).catch(e => console.error('Accrual reconcile create error:', e)));

  if(pending.length > 0){
    _accrualsSyncInFlight = true;
    Promise.allSettled(pending).finally(() => { _accrualsSyncInFlight = false; });
  }
}

// Estimates how much to accrue for one accrual record: pulls the unit's own charge + other
// charges from its MOST RECENT rental-invoice period ending strictly before this record's own
// periodStart (accruing May's gap looks at April's invoice, not May's), divides that by however
// many days THAT invoice period actually covered — periods aren't always a full calendar month,
// so the full invoice amount would overstate a partial one — then multiplies by however many
// days THIS accrual record itself covers. Tax is deliberately excluded; only rent (charge) plus
// named Other Charges make up the base being accrued.
//
// Not every unit's prior invoice has been re-registered with the newer per-unit detail
// breakdown yet — when a qualifying period is located but carries no usable charge, this
// returns needsUpdate:true and every dollar figure as 0 rather than guessing, so a $0 row in
// the table is a clear, actionable signal of exactly which invoice still needs updating.
// Nothing here is persisted onto the accrual record — it's recomputed fresh on every render, so
// fixing that invoice's detail and revisiting this tab immediately reflects the corrected amount.
//
// Built on top of computeUnitChargeHistory (every period ever invoiced for this unit) so both
// stay in agreement — the natural pick here is just that same history's closest-prior period.
// An operator can override that pick from the Charge History chart's "Use Block to Accrue"
// (see applyAccrualOverride/clearAccrualOverride) when the usual invoice looks unusually low or
// turns out to have an error — record.overrideSourceFrom/To, once set, take precedence over the
// natural pick; isOverridden reports whether that override actually changed anything (so the
// "!" indicator only ever shows when it's meaningfully different from what would've been picked
// automatically anyway).
function computeAccrualChargeEstimate(record){
  const result = {
    found: false, needsUpdate: true, totalAmount: 0, otherAmount: 0, daysInSourcePeriod: 0, chargePerDay: 0, toBeAccrued: 0,
    sourceWd: '', sourceDoc: '', sourceFrom: '', sourceTo: '', unitDetail: null, isOverridden: false,
    // The natural (never-overridden) closest-prior pick, exposed alongside the possibly-
    // overridden "used" fields above — the Accruals Deliverable shows both side by side
    // ("Last Invoice Amount/Period/WD#" = this; "Actual Cost Per Unit" = the used fields above),
    // since an override deliberately makes those two different on purpose.
    naturalFound: false, naturalTotalAmount: 0, naturalSourceWd: '', naturalSourceDoc: '', naturalSourceFrom: '', naturalSourceTo: ''
  };

  const history = computeUnitChargeHistory(record.unitId);

  let naturalPoint = null;
  history.forEach(p => {
    if(!(p.to < record.periodStart)) return;
    if(!naturalPoint || p.to > naturalPoint.to) naturalPoint = p;
  });

  if(naturalPoint){
    result.naturalFound = true;
    result.naturalTotalAmount = naturalPoint.totalAmount;
    result.naturalSourceWd = naturalPoint.sourceWd;
    result.naturalSourceDoc = naturalPoint.sourceDoc;
    result.naturalSourceFrom = naturalPoint.from;
    result.naturalSourceTo = naturalPoint.to;
  }

  let chosenPoint = naturalPoint;
  if(record.overrideSourceFrom && record.overrideSourceTo){
    const overridePoint = history.find(p => p.from === record.overrideSourceFrom && p.to === record.overrideSourceTo);
    if(overridePoint){
      chosenPoint = overridePoint;
      result.isOverridden = !naturalPoint || naturalPoint.from !== overridePoint.from || naturalPoint.to !== overridePoint.to;
    }
  }

  if(!chosenPoint) return result;

  result.found = true;
  result.sourceWd = chosenPoint.sourceWd;
  result.sourceDoc = chosenPoint.sourceDoc;
  result.sourceFrom = chosenPoint.from;
  result.sourceTo = chosenPoint.to;
  result.unitDetail = chosenPoint.unitDetail;
  result.needsUpdate = chosenPoint.needsUpdate;
  result.totalAmount = chosenPoint.totalAmount;
  result.otherAmount = chosenPoint.otherAmount;
  result.daysInSourcePeriod = chosenPoint.days;
  result.chargePerDay = chosenPoint.chargePerDay;
  result.toBeAccrued = result.chargePerDay * (Number(record.days) || 0);

  return result;
}

// Persists an operator's pick of a specific historical period (a block clicked in the Charge
// History chart) as the source for this record's accrual calculation, superseding the natural
// closest-prior pick — for when the usual invoice looks unusually low or turns out to have an
// error. Recomputes and re-renders "Periods Ready to Accrue" immediately so the new amount (and
// its "!" indicator, if this actually changed anything) show up without waiting on a refresh.
// Also auto-writes this month's comment to record which invoice is actually being used ("Invoice
// used to accrue "WD1234"") so accounting sees it directly on the deliverable's Comment column
// without the operator having to write it by hand — but only replaces a comment that was itself
// auto-generated (or none at all); a comment the operator wrote themselves is never overwritten.
function applyAccrualOverride(record, point){
  record.overrideSourceFrom = point.from;
  record.overrideSourceTo = point.to;
  const existingComment = getAccrualComment(record);
  if(!existingComment || existingComment.auto){
    setAccrualComment(record, `Invoice used to accrue "${point.sourceWd || '(unknown WD)'}"`, { auto: true });
  }
  _accrualsSyncInFlight = true;
  DB.updateAccrual(record).catch(e => console.error('Accrual override save error:', e)).finally(() => { _accrualsSyncInFlight = false; });
  try{ saveState(); }catch(e){}
  if(typeof renderAccrualsAccruedList === 'function') renderAccrualsAccruedList();
}

// Reverts a record back to the automatic closest-prior-period pick. Clears this month's comment
// too, but only if it's the auto-generated "Invoice used to accrue..." note from applyAccrualOverride
// above — a comment the operator wrote or edited themselves is left in place.
function clearAccrualOverride(record){
  record.overrideSourceFrom = '';
  record.overrideSourceTo = '';
  const existingComment = getAccrualComment(record);
  if(existingComment && existingComment.auto){
    setAccrualComment(record, '');
  }
  _accrualsSyncInFlight = true;
  DB.updateAccrual(record).catch(e => console.error('Accrual override clear error:', e)).finally(() => { _accrualsSyncInFlight = false; });
  try{ saveState(); }catch(e){}
  if(typeof renderAccrualsAccruedList === 'function') renderAccrualsAccruedList();
}

// Every rental period a unit has ever actually been invoiced for, chronologically — the same
// per-unit charge+other/days math as computeAccrualChargeEstimate, just walking every matching
// registry slice instead of stopping at the single most recent one. Powers the Charge History
// chart (Last Invoice Amount and Charge/Day over time) so a jump/anomaly in either is visible
// at a glance instead of having to click through each source invoice one at a time.
function computeUnitChargeHistory(unitId){
  const uidNorm = String(unitId || '').trim().toLowerCase();
  const invoices = state.invoices || [];
  const points = [];

  (state.registries || []).forEach(reg => {
    let cat = String(reg.category || '').toLowerCase();
    if(!cat){
      const inv = invoices.find(i => String(i.wdNumber||'').trim().toLowerCase() === String(reg.wdNumber||'').trim().toLowerCase());
      cat = inv ? String(inv.category||'').toLowerCase() : '';
    }
    if(cat !== 'rental') return;
    const slices = getRegistryCoveragePeriods(reg);
    slices.forEach(slice => {
      if(!slice.from || !slice.to) return;
      const inSlice = (slice.units||[]).some(u => String(u).trim().toLowerCase() === uidNorm);
      if(!inSlice) return;
      const unitDetail = (slice.unitDetails || []).find(d => String(d.unit||'').trim().toLowerCase() === uidNorm);
      // A period the unit is actually listed under is never skipped, even when it has no
      // detailed charge yet — dropping it would silently cut the timeline short or paper over
      // a gap that's really just an invoice that hasn't been re-registered with the new
      // detailed breakdown. Shown instead as an explicit $0 point (needsUpdate:true), the same
      // "this invoice needs updating" signal already used on Periods Ready to Accrue.
      const hasDetail = !!(unitDetail && unitDetail.charge !== undefined && unitDetail.charge !== null && String(unitDetail.charge).trim() !== '');

      const charge = hasDetail ? (parseCurrency(unitDetail.charge || '') || 0) : 0;
      const other = hasDetail ? (parseCurrency(unitDetail.other || '') || 0) : 0;
      const totalAmount = charge + other;
      const fromD = isoStrToDate(slice.from), toD = isoStrToDate(slice.to);
      const days = (!isNaN(fromD) && !isNaN(toD)) ? Math.round((toD - fromD) / 86400000) + 1 : 0;
      const chargePerDay = days > 0 ? totalAmount / days : 0;
      const otherPerDay = days > 0 ? other / days : 0;

      points.push({
        from: slice.from, to: slice.to, totalAmount, otherAmount: other, days, chargePerDay, otherPerDay,
        needsUpdate: !hasDetail, sourceWd: reg.wdNumber || '', sourceDoc: reg.docNumber || '',
        unitDetail: unitDetail || null,
        otherChargeDetails: (hasDetail && Array.isArray(unitDetail.otherChargeDetails)) ? unitDetail.otherChargeDetails : []
      });
    });
  });

  points.sort((a, b) => a.from < b.from ? -1 : (a.from > b.from ? 1 : 0));
  return points;
}

// Rounds a chart's Y-axis max up to a "nice" 1/2/5×10^n value, so gridlines land on clean
// numbers instead of whatever the exact data maximum happens to be.
function niceCeiling(val){
  if(!(val > 0)) return 10;
  const exp = Math.floor(Math.log10(val));
  const base = Math.pow(10, exp);
  const norm = val / base;
  let niceNorm;
  if(norm <= 1) niceNorm = 1;
  else if(norm <= 2) niceNorm = 2;
  else if(norm <= 5) niceNorm = 5;
  else niceNorm = 10;
  return niceNorm * base;
}

// Renders a bar chart (SVG) into containerEl: one bar per point (height proportional to its
// value, with a $ label above it and the point's own label below), plus a dot centered on each
// bar's top edge connected to its neighbors — the trend line the shape of the bars alone
// doesn't make obvious at a glance. When a point also carries a subValue (e.g. Other Charges,
// always a portion of the same total), a second, narrower block sharing the same baseline is
// nested inside the same bar, with its own dot+trend line in a second color — so that
// sub-amount's own trend across months is just as visible as the total's, not just implied by
// the outer bar's height. points: [{label, value, subValue?}], already in display order.
function renderHistoryBarChart(containerEl, points, opts){
  opts = opts || {};
  containerEl.innerHTML = '';
  if(!points || points.length === 0){
    const none = document.createElement('div');
    none.className = 'small-muted';
    none.textContent = opts.emptyMessage || 'No data available.';
    containerEl.appendChild(none);
    return;
  }

  const hasSub = points.some(p => p.subValue !== undefined && p.subValue !== null);

  const width = opts.width || 640;
  const height = opts.height || 220;
  const padTop = 34, padBottom = 30, padLeft = 60, padRight = 16;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;

  const maxVal = Math.max.apply(null, points.map(p => p.value).concat([0]));
  const niceMax = niceCeiling(maxVal);
  const colW = plotW / points.length;
  const barW = Math.min(colW * 0.5, 56);
  const subBarW = barW * 0.55;

  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.style.cssText = 'width:100%;height:auto;display:block;';

  const gridSteps = 4;
  for(let i = 0; i <= gridSteps; i++){
    const frac = i / gridSteps;
    const y = padTop + plotH * (1 - frac);
    const line = document.createElementNS(svgNS, 'line');
    line.setAttribute('x1', padLeft); line.setAttribute('x2', width - padRight);
    line.setAttribute('y1', y); line.setAttribute('y2', y);
    line.setAttribute('stroke', '#eef2f7'); line.setAttribute('stroke-width', '1');
    svg.appendChild(line);

    const gridLabel = document.createElementNS(svgNS, 'text');
    gridLabel.setAttribute('x', padLeft - 8); gridLabel.setAttribute('y', y + 3);
    gridLabel.setAttribute('text-anchor', 'end'); gridLabel.setAttribute('font-size', '10'); gridLabel.setAttribute('fill', '#9ca3af');
    gridLabel.textContent = formatCurrency(niceMax * frac);
    svg.appendChild(gridLabel);
  }

  const baselineY = padTop + plotH;
  const dotPoints = [];
  const subDotPoints = [];
  points.forEach((p, i) => {
    const cx = padLeft + colW * i + colW / 2;
    const barH = niceMax > 0 ? (p.value / niceMax) * plotH : 0;
    const barTopY = baselineY - Math.max(barH, 0);
    const barX = cx - barW / 2;

    if(i === opts.selectedIndex){
      const highlight = document.createElementNS(svgNS, 'rect');
      highlight.setAttribute('x', padLeft + colW * i); highlight.setAttribute('y', padTop);
      highlight.setAttribute('width', colW); highlight.setAttribute('height', plotH);
      highlight.setAttribute('fill', opts.selectedColor || 'rgba(11,116,222,0.08)');
      svg.appendChild(highlight);
    }

    const rect = document.createElementNS(svgNS, 'rect');
    rect.setAttribute('x', barX); rect.setAttribute('y', barTopY);
    rect.setAttribute('width', barW); rect.setAttribute('height', Math.max(barH, 0));
    rect.setAttribute('rx', 3);
    rect.setAttribute('fill', opts.barColor || '#93c5fd');
    svg.appendChild(rect);

    const amtLabel = document.createElementNS(svgNS, 'text');
    amtLabel.setAttribute('x', cx); amtLabel.setAttribute('y', Math.max(barTopY - 8, 12));
    amtLabel.setAttribute('text-anchor', 'middle'); amtLabel.setAttribute('font-size', '11'); amtLabel.setAttribute('font-weight', '700');
    amtLabel.setAttribute('fill', '#374151');
    amtLabel.textContent = formatCurrency(p.value);
    svg.appendChild(amtLabel);

    if(hasSub){
      // Same baseline (0) and column as the outer bar, just narrower and shorter — a block
      // nested inside the block, not a separate stacked segment, since Other Charges is
      // already included in (not additional to) the outer bar's own total.
      const subVal = p.subValue || 0;
      const subH = niceMax > 0 ? (subVal / niceMax) * plotH : 0;
      const subTopY = baselineY - Math.max(subH, 0);
      const subX = cx - subBarW / 2;

      const subRect = document.createElementNS(svgNS, 'rect');
      subRect.setAttribute('x', subX); subRect.setAttribute('y', subTopY);
      subRect.setAttribute('width', subBarW); subRect.setAttribute('height', Math.max(subH, 0));
      subRect.setAttribute('rx', 2);
      subRect.setAttribute('fill', opts.subBarColor || '#fbbf24');
      svg.appendChild(subRect);

      if(subVal > 0){
        const subLabel = document.createElementNS(svgNS, 'text');
        subLabel.setAttribute('x', cx); subLabel.setAttribute('y', Math.max(subTopY - 5, 24));
        subLabel.setAttribute('text-anchor', 'middle'); subLabel.setAttribute('font-size', '9'); subLabel.setAttribute('font-weight', '600');
        subLabel.setAttribute('fill', opts.subLineColor || '#b45309');
        subLabel.textContent = formatCurrency(subVal);
        svg.appendChild(subLabel);
      }

      subDotPoints.push({ x: cx, y: subTopY });
    }

    const xLabel = document.createElementNS(svgNS, 'text');
    xLabel.setAttribute('x', cx); xLabel.setAttribute('y', height - padBottom + 16);
    xLabel.setAttribute('text-anchor', 'middle'); xLabel.setAttribute('font-size', '10'); xLabel.setAttribute('fill', '#6b7280');
    xLabel.textContent = p.label;
    svg.appendChild(xLabel);

    // A full-height, invisible hit target spanning the whole column (not just the bar itself)
    // — added last so it sits on top of everything and clicking anywhere in the column selects
    // it, not just the (sometimes very short) visible bar.
    if(typeof opts.onBlockClick === 'function'){
      const hitRect = document.createElementNS(svgNS, 'rect');
      hitRect.setAttribute('x', padLeft + colW * i); hitRect.setAttribute('y', padTop);
      hitRect.setAttribute('width', colW); hitRect.setAttribute('height', plotH);
      hitRect.setAttribute('fill', 'transparent');
      hitRect.style.cursor = 'pointer';
      hitRect.addEventListener('click', () => opts.onBlockClick(p, i));
      svg.appendChild(hitRect);
    }

    dotPoints.push({ x: cx, y: barTopY });
  });

  // Both trend series are drawn after every bar (and after the per-column hit targets) so
  // neither ever ends up hidden behind one — but that puts them visually on top of the hit
  // targets too, so pointer-events:none on the line/dots lets a click land on whichever one of
  // them happens to visually sit there pass straight through to the hit target underneath.
  const addTrendSeries = (pts, color) => {
    if(pts.length > 1){
      const polyline = document.createElementNS(svgNS, 'polyline');
      polyline.setAttribute('points', pts.map(d => `${d.x},${d.y}`).join(' '));
      polyline.setAttribute('fill', 'none');
      polyline.setAttribute('stroke', color);
      polyline.setAttribute('stroke-width', '2');
      polyline.style.pointerEvents = 'none';
      svg.appendChild(polyline);
    }
    pts.forEach(d => {
      const circle = document.createElementNS(svgNS, 'circle');
      circle.setAttribute('cx', d.x); circle.setAttribute('cy', d.y); circle.setAttribute('r', 4);
      circle.setAttribute('fill', color);
      circle.setAttribute('stroke', '#fff'); circle.setAttribute('stroke-width', '1.5');
      circle.style.pointerEvents = 'none';
      svg.appendChild(circle);
    });
  };
  addTrendSeries(dotPoints, opts.lineColor || '#dc2626');
  if(hasSub) addTrendSeries(subDotPoints, opts.subLineColor || '#b45309');

  containerEl.appendChild(svg);
}

// Tracks Prev/Next navigation across whichever accrual records the modal was opened from
// (normally every row currently shown in "Periods Ready to Accrue"), and which historical
// block (if any) the operator has clicked on for the unit currently being viewed.
let _unitChargeHistoryRecordList = [];
let _unitChargeHistoryIndex = 0;
let _unitChargeHistorySelectedPoint = null;

// Opens the Charge History modal for one accrual record's unit. recordList is the full set of
// records to page through with Prev/Next (normally every row in "Periods Ready to Accrue") —
// omit it to keep whatever list is already loaded (e.g. when re-opening after an edit).
function openUnitChargeHistoryModal(record, recordList){
  if(!record) return;
  if(Array.isArray(recordList) && recordList.length > 0){
    _unitChargeHistoryRecordList = recordList;
  } else if(_unitChargeHistoryRecordList.length === 0){
    _unitChargeHistoryRecordList = [record];
  }
  _unitChargeHistoryIndex = _unitChargeHistoryRecordList.findIndex(r => r.id === record.id);
  if(_unitChargeHistoryIndex === -1) _unitChargeHistoryIndex = 0;
  _unitChargeHistorySelectedPoint = null;

  renderUnitChargeHistoryModal();
  const modal = qs('#unitChargeHistoryModal');
  if(modal) modal.style.display = 'flex';
}

function renderUnitChargeHistoryModal(){
  const record = _unitChargeHistoryRecordList[_unitChargeHistoryIndex];
  const modal = qs('#unitChargeHistoryModal');
  const amountChartEl = qs('#unitChargeHistoryAmountChart');
  const perDayChartEl = qs('#unitChargeHistoryPerDayChart');
  if(!record || !modal || !amountChartEl || !perDayChartEl) return;

  const unitId = record.unitId;
  const unit = (state.units || []).find(u => String(u.unitId || '').trim().toLowerCase() === String(unitId || '').trim().toLowerCase());

  const titleEl = qs('#unitChargeHistoryTitle');
  if(titleEl) titleEl.textContent = unitId + ' — Charge History';

  const navEl = qs('#unitChargeHistoryNav');
  if(navEl) navEl.textContent = `${_unitChargeHistoryIndex + 1} / ${_unitChargeHistoryRecordList.length}`;
  const prevBtn = qs('#unitChargeHistoryPrev');
  const nextBtn = qs('#unitChargeHistoryNext');
  if(prevBtn){
    prevBtn.style.opacity = _unitChargeHistoryIndex === 0 ? '0.3' : '1';
    prevBtn.onclick = () => {
      if(_unitChargeHistoryIndex > 0){
        _unitChargeHistoryIndex--;
        _unitChargeHistorySelectedPoint = null;
        renderUnitChargeHistoryModal();
      }
    };
  }
  if(nextBtn){
    nextBtn.style.opacity = _unitChargeHistoryIndex === _unitChargeHistoryRecordList.length - 1 ? '0.3' : '1';
    nextBtn.onclick = () => {
      if(_unitChargeHistoryIndex < _unitChargeHistoryRecordList.length - 1){
        _unitChargeHistoryIndex++;
        _unitChargeHistorySelectedPoint = null;
        renderUnitChargeHistoryModal();
      }
    };
  }

  // Same general unit info shown at the top of the coverage-history popup, so there's no need
  // to cross-reference the other modal just to confirm which lease/supplier/cost center this is.
  const infoEl = qs('#unitChargeHistoryInfo');
  if(infoEl){
    const fields = [
      { label: 'SUPPLIER', value: unit ? (unit.supplier || '—') : '—' },
      { label: 'LEASE', value: unit ? (unit.lease || '—') : '—' },
      { label: 'ARRANGEMENT', value: unit ? (unit.arrangement || '—') : '—' },
      { label: 'INVOICING', value: unit ? (unit.invoicing || '—') : '—' },
      { label: 'COST CENTER', value: unit ? (unit.costCenter || '—') : '—' },
      { label: 'COMPANY', value: unit ? (unit.company || '—') : '—' }
    ];
    infoEl.innerHTML = fields.map(f => `
      <div>
        <div style="font-size:10px;font-weight:700;color:#9ca3af;letter-spacing:0.6px;text-transform:uppercase;margin-bottom:2px;">${f.label}</div>
        <div style="font-size:12px;font-weight:600;color:#374151;">${escapeHtml(f.value)}</div>
      </div>
    `).join('');
  }

  const history = computeUnitChargeHistory(unitId);
  const estimate = computeAccrualChargeEstimate(record);
  // Only an open (not yet closed-month) record can have its accrual source overridden — a
  // closed month is a locked historical statement everywhere else in this workflow too.
  const isOpenRecord = !record.accrualMonth && !record.accrualYear;

  const labelFor = (p) => {
    const d = isoStrToDate(p.from);
    return isNaN(d) ? p.from : accrualMonthName(d.getMonth()+1).slice(0,3) + ' ' + String(d.getFullYear()).slice(2);
  };

  // Highlight whichever block the operator just clicked; absent a fresh click, highlight
  // whichever period is actually in use for this record right now (the override if one's set,
  // otherwise the natural pick) so it's obvious at a glance where today's number comes from.
  const selectedIndex = _unitChargeHistorySelectedPoint
    ? history.findIndex(p => p.from === _unitChargeHistorySelectedPoint.from && p.to === _unitChargeHistorySelectedPoint.to)
    : history.findIndex(p => p.from === estimate.sourceFrom && p.to === estimate.sourceTo);
  const selectedPoint = selectedIndex !== -1 ? history[selectedIndex] : null;

  // renderHistoryBarChart only knows about the mapped {label, value, subValue} chart points, not
  // the full history record — look the real one up by index (both arrays are the same length,
  // built from the same history.map(...) call, so the positions always correspond 1:1).
  const onBlockClick = (p, i) => {
    _unitChargeHistorySelectedPoint = history[i];
    renderUnitChargeHistoryModal();
  };

  renderHistoryBarChart(amountChartEl, history.map(p => ({ label: labelFor(p), value: p.totalAmount, subValue: p.otherAmount })),
    { barColor: '#93c5fd', lineColor: '#1d4ed8', subBarColor: '#fbbf24', subLineColor: '#b45309',
      emptyMessage: 'No invoice history found for this unit.', onBlockClick, selectedIndex });
  renderHistoryBarChart(perDayChartEl, history.map(p => ({ label: labelFor(p), value: p.chargePerDay, subValue: p.otherPerDay })),
    { barColor: '#fdba74', lineColor: '#c2410c', subBarColor: '#c4b5fd', subLineColor: '#6d28d9',
      emptyMessage: 'No invoice history found for this unit.', onBlockClick, selectedIndex });

  const legendEl = qs('#unitChargeHistoryLegend');
  if(legendEl){
    const swatch = (color, label) => `<span style="display:inline-flex;align-items:center;gap:4px;margin-right:14px;"><span style="width:10px;height:10px;border-radius:2px;background:${color};display:inline-block;"></span>${label}</span>`;
    legendEl.innerHTML = swatch('#93c5fd', 'Total (Charge + Other)') + swatch('#fbbf24', 'Other Charges');
  }
  const needsUpdateCount = history.filter(p => p.needsUpdate).length;
  const noteEl = qs('#unitChargeHistoryNote');
  if(noteEl){
    noteEl.textContent = needsUpdateCount > 0
      ? `${needsUpdateCount} period(s) shown as $0 — their source invoice hasn't been updated with the detailed per-unit breakdown yet.`
      : '';
    noteEl.style.display = needsUpdateCount > 0 ? 'block' : 'none';
  }

  // Invoice detail for whichever block is selected — the same information the coverage-history
  // popup shows for a day's invoice, so the operator can double-check it before committing to
  // "Use Block to Accrue".
  const detailEl = qs('#unitChargeHistoryDetail');
  if(detailEl){
    if(!selectedPoint){
      detailEl.innerHTML = "Click a block above to see that invoice's details before using it to accrue.";
    } else {
      const fmtMDY = (iso) => { if(!iso) return ''; const d = isoStrToDate(iso); return isNaN(d) ? iso : `${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}/${d.getFullYear()}`; };
      const row = (label, val) => `<div style="display:flex;justify-content:space-between;gap:16px;padding:2px 0;"><span style="color:#6b7280;">${label}</span><span style="font-weight:600;">${val}</span></div>`;
      let html = `<div style="background:#f9fafb;border:1px solid #e6e9ee;border-radius:8px;padding:10px 12px;">`;
      html += `<div style="font-size:12px;font-weight:700;color:#374151;margin-bottom:4px;">📄 WD ${escapeHtml(selectedPoint.sourceWd || '(none)')}${selectedPoint.sourceDoc ? ' / Doc ' + escapeHtml(selectedPoint.sourceDoc) : ''}</div>`;
      html += `<div style="font-size:11px;color:#6b7280;margin-bottom:6px;">📅 ${fmtMDY(selectedPoint.from)} – ${fmtMDY(selectedPoint.to)} (${selectedPoint.days} day(s))</div>`;
      if(selectedPoint.needsUpdate){
        html += `<div style="background:#fef9c3;color:#92400e;border:1px solid #fde68a;border-radius:6px;padding:8px 10px;font-size:12px;">This invoice hasn't been updated with the detailed per-unit breakdown yet — shown as $0 until it is.</div>`;
      } else {
        const ud = selectedPoint.unitDetail || {};
        html += row('Charge (rent)', formatCurrency(parseCurrency(ud.charge || '') || 0));
        html += row('Other Charges', formatCurrency(selectedPoint.otherAmount));
        if(selectedPoint.otherChargeDetails.length){
          html += `<div style="margin:2px 0 4px 12px;font-size:11px;color:#6b7280;">${selectedPoint.otherChargeDetails.map(d => `${escapeHtml(d.name || '(unnamed)')}: ${formatCurrency(parseCurrency(d.amount || '') || 0)}`).join('<br>')}</div>`;
        }
        html += `<div style="border-top:1px solid #e6e9ee;margin:6px 0;"></div>`;
        html += row('Total', formatCurrency(selectedPoint.totalAmount));
        html += row('Charge per day', formatCurrency(selectedPoint.chargePerDay));
      }
      html += `</div>`;
      detailEl.innerHTML = html;
    }
  }

  const useBlockBtn = qs('#unitChargeHistoryUseBlockBtn');
  const resetBtn = qs('#unitChargeHistoryResetBtn');
  const alreadyUsingSelected = !!(selectedPoint && estimate.sourceFrom === selectedPoint.from && estimate.sourceTo === selectedPoint.to);
  if(useBlockBtn){
    useBlockBtn.disabled = !selectedPoint || !isOpenRecord || alreadyUsingSelected;
    useBlockBtn.style.opacity = useBlockBtn.disabled ? '0.5' : '1';
    useBlockBtn.style.cursor = useBlockBtn.disabled ? 'not-allowed' : 'pointer';
    useBlockBtn.textContent = alreadyUsingSelected ? 'Already Using This Block' : 'Use Block to Accrue';
    useBlockBtn.title = isOpenRecord ? '' : "This month is already closed — an override can't change a locked accrual.";
    useBlockBtn.onclick = () => {
      if(!selectedPoint || !isOpenRecord) return;
      applyAccrualOverride(record, selectedPoint);
      renderUnitChargeHistoryModal();
    };
  }
  if(resetBtn){
    resetBtn.style.display = (record.overrideSourceFrom && isOpenRecord) ? 'inline-block' : 'none';
    resetBtn.onclick = () => {
      clearAccrualOverride(record);
      _unitChargeHistorySelectedPoint = null;
      renderUnitChargeHistoryModal();
    };
  }
}
const unitChargeHistoryCloseBtn = qs('#unitChargeHistoryCloseBtn');
if(unitChargeHistoryCloseBtn) unitChargeHistoryCloseBtn.addEventListener('click', () => { const m = qs('#unitChargeHistoryModal'); if(m) m.style.display = 'none'; });
const unitChargeHistoryBackdrop = qs('#unitChargeHistoryModal .modal-backdrop');
if(unitChargeHistoryBackdrop) unitChargeHistoryBackdrop.addEventListener('click', () => { const m = qs('#unitChargeHistoryModal'); if(m) m.style.display = 'none'; });

// Splits one accrual record's total into Accounting's two reporting buckets: everything
// through the end of the prior month ("Accumulated" — days already owed from before this
// reporting month even started) versus just the days that actually fall within the reporting
// month itself ("This Month"), plus their sum ("Total") so nobody has to add the two by hand.
// viewMonth/viewYear is whichever month is being looked at in "Periods Ready to Accrue" (the
// open month while it's still being built, or a closed month's own accrual month when looking
// back at history) — never the wall-clock "today", so a closed batch's split always matches
// what it represented when it was actually sent, not whatever month happens to be current now.
function splitAccrualAmountByViewMonth(record, chargePerDay, viewMonth, viewYear){
  const periodStart = isoStrToDate(record.periodStart);
  const periodEnd = isoStrToDate(record.periodEnd);
  const boundary = new Date(viewYear, viewMonth - 1, 1); // first day of the reporting month
  const dayCount = (a, b) => (a > b) ? 0 : Math.round((b - a) / 86400000) + 1;

  const accumulatedEnd = new Date(boundary);
  accumulatedEnd.setDate(accumulatedEnd.getDate() - 1); // last day of the prior month
  const accumulatedCap = periodEnd < accumulatedEnd ? periodEnd : accumulatedEnd;
  const accumulatedDays = dayCount(periodStart, accumulatedCap);

  const currentMonthStart = periodStart > boundary ? periodStart : boundary;
  const currentMonthDays = dayCount(currentMonthStart, periodEnd);

  const accumulatedAmount = chargePerDay * accumulatedDays;
  const currentMonthAmount = chargePerDay * currentMonthDays;
  return {
    accumulatedDays, accumulatedAmount,
    // The exact sub-range these accumulated days actually cover (periodStart through the last
    // day of the prior reporting month) — null when there's no accumulated portion at all
    // (accumulatedDays === 0), since the dates would be meaningless in that case. Lets a caller
    // display "what period is this dollar figure actually for" instead of the record's whole
    // (possibly much wider) periodStart/periodEnd, which would make an Accumulated-only amount
    // look like it includes the current reporting month too.
    accumulatedStart: accumulatedDays > 0 ? dateToIsoStr(periodStart) : null,
    accumulatedEnd: accumulatedDays > 0 ? dateToIsoStr(accumulatedCap) : null,
    currentMonthDays, currentMonthAmount,
    currentMonthStart: currentMonthDays > 0 ? dateToIsoStr(currentMonthStart) : null,
    currentMonthEnd: currentMonthDays > 0 ? dateToIsoStr(periodEnd) : null,
    totalAmount: accumulatedAmount + currentMonthAmount
  };
}

// Popup showing exactly what a "Last Invoice Amount" cell's total is built from — the source
// invoice's period/WD number, its Charge/Other Charges (with named breakdown) or an explicit
// "needs updating" notice, and the day-count math that turns it into a per-day rate.
function openAccrualChargeDetail(record, estimate, recordList){
  const modal = qs('#accrualChargeDetailModal');
  const body = qs('#accrualChargeDetailBody');
  if(!modal || !body) return;

  const fmtMDY = (iso) => { if(!iso) return ''; const d = isoStrToDate(iso); return isNaN(d) ? iso : `${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}/${d.getFullYear()}`; };
  const row = (label, val) => `<div style="display:flex;justify-content:space-between;gap:16px;padding:3px 0;"><span style="color:#6b7280;">${label}</span><span style="font-weight:600;">${val}</span></div>`;

  let html = `<div style="font-size:13px;color:#374151;margin-bottom:8px;"><strong>${record.unitId}</strong> — accruing ${fmtMDY(record.periodStart)} – ${fmtMDY(record.periodEnd)} (${record.days} day(s))</div>`;

  if(!estimate.found){
    html += `<div style="background:#fef9c3;color:#92400e;border:1px solid #fde68a;border-radius:6px;padding:10px;font-size:12px;">No rental invoice found for this unit ending before ${fmtMDY(record.periodStart)} — nothing to base an accrual amount on, so this row shows $0.</div>`;
  } else {
    html += `<div style="font-size:12px;color:#6b7280;margin-bottom:6px;">Source: WD ${estimate.sourceWd || '(none)'}${estimate.sourceDoc ? ' / Doc ' + estimate.sourceDoc : ''} — ${fmtMDY(estimate.sourceFrom)} – ${fmtMDY(estimate.sourceTo)}</div>`;
    if(estimate.needsUpdate){
      html += `<div style="background:#fef9c3;color:#92400e;border:1px solid #fde68a;border-radius:6px;padding:10px;font-size:12px;">This period was found, but it doesn't have a detailed per-unit charge yet — this invoice hasn't been updated with the new invoice registration. Showing $0 until it's updated.</div>`;
    } else {
      const ud = estimate.unitDetail || {};
      const otherDetails = Array.isArray(ud.otherChargeDetails) ? ud.otherChargeDetails : [];
      html += row('Charge (rent)', formatCurrency(parseCurrency(ud.charge||'')||0));
      html += row('Other Charges', formatCurrency(parseCurrency(ud.other||'')||0));
      if(otherDetails.length){
        html += `<div style="margin:2px 0 6px 12px;font-size:11px;color:#6b7280;">${otherDetails.map(d => `${d.name || '(unnamed)'}: ${formatCurrency(parseCurrency(d.amount||'')||0)}`).join('<br>')}</div>`;
      }
      html += `<div style="border-top:1px solid #e6e9ee;margin:6px 0;"></div>`;
      html += row('Total (source period)', formatCurrency(estimate.totalAmount));
      html += row('Days in source period', String(estimate.daysInSourcePeriod));
      html += row('Charge per day', formatCurrency(estimate.chargePerDay));
      html += row('Days being accrued', String(record.days));
      html += `<div style="border-top:1px solid #e6e9ee;margin:6px 0;"></div>`;
      html += row('To be accrued', formatCurrency(estimate.toBeAccrued));

      const split = splitAccrualAmountByViewMonth(record, estimate.chargePerDay, _accrualsViewMonth, _accrualsViewYear);
      html += `<div style="margin-top:8px;font-size:11px;font-weight:700;color:#6b7280;text-transform:uppercase;">Accounting/Payables split — ${accrualMonthName(_accrualsViewMonth)} ${_accrualsViewYear}</div>`;
      html += row(`Accumulated (thru ${accrualMonthName(_accrualsViewMonth === 1 ? 12 : _accrualsViewMonth - 1)})`, `${formatCurrency(split.accumulatedAmount)} (${split.accumulatedDays}d)`);
      html += row(`${accrualMonthName(_accrualsViewMonth)} ${_accrualsViewYear}`, `${formatCurrency(split.currentMonthAmount)} (${split.currentMonthDays}d)`);
      html += row('Total', formatCurrency(split.totalAmount));
    }
  }

  body.innerHTML = html;
  _accrualChargeDetailRecord = record;
  _accrualChargeDetailRecordList = Array.isArray(recordList) && recordList.length > 0 ? recordList : [record];
  modal.style.display = 'flex';
}
let _accrualChargeDetailRecord = null;
let _accrualChargeDetailRecordList = [];
const accrualChargeDetailCloseBtn = qs('#accrualChargeDetailCloseBtn');
if(accrualChargeDetailCloseBtn) accrualChargeDetailCloseBtn.addEventListener('click', () => { const m = qs('#accrualChargeDetailModal'); if(m) m.style.display = 'none'; });
const accrualChargeDetailHistoryBtn = qs('#accrualChargeDetailHistoryBtn');
if(accrualChargeDetailHistoryBtn) accrualChargeDetailHistoryBtn.addEventListener('click', () => {
  if(_accrualChargeDetailRecord) openUnitChargeHistoryModal(_accrualChargeDetailRecord, _accrualChargeDetailRecordList);
});
const accrualChargeDetailBackdrop = qs('#accrualChargeDetailModal .modal-backdrop');
if(accrualChargeDetailBackdrop) accrualChargeDetailBackdrop.addEventListener('click', () => { const m = qs('#accrualChargeDetailModal'); if(m) m.style.display = 'none'; });

// Click-to-sort state for "Periods Ready to Accrue" (not persisted).
let _accrualsAccruedSort = { column: 'unitId', ascending: true };

// "Periods Ready to Accrue" — a month/year-driven view like Unit Overview's. Selecting the
// currently-open month shows the live, still-editable (Undo-able) batch; selecting an earlier,
// already-closed month shows that batch read-only, exactly as it was sent.
function renderAccrualsAccruedList(){
  reconcileOpenAccrualsCoverage();
  const tableEl = qs('#accrualsAccruedTable');
  const summaryEl = qs('#accrualsAccruedSummary');
  const monthSelectEl = qs('#accrualsAccrueMonthSelect');
  const yearSelectEl = qs('#accrualsAccrueYearSelect');
  const closeBtn = qs('#accrualsCloseMonthBtn');
  if(!tableEl) return;

  const openMY = getAccrualsOpenMonthYear();
  if(_accrualsViewMonth === null || _accrualsViewYear === null){ _accrualsViewMonth = openMY.month; _accrualsViewYear = openMY.year; }
  const isViewingOpenMonth = _accrualsViewMonth === openMY.month && _accrualsViewYear === openMY.year;

  // Populate the month/year pickers once; keep them synced to the current view afterward.
  if(monthSelectEl && !monthSelectEl.dataset.wired){
    monthSelectEl.dataset.wired = 'true';
    for(let m = 1; m <= 12; m++){
      const opt = document.createElement('option'); opt.value = m; opt.textContent = accrualMonthName(m);
      monthSelectEl.appendChild(opt);
    }
    monthSelectEl.addEventListener('change', () => {
      _accrualsViewMonth = parseInt(monthSelectEl.value, 10);
      renderAccrualsAccruedList();
    });
  }
  if(yearSelectEl && !yearSelectEl.dataset.wired){
    yearSelectEl.dataset.wired = 'true';
    yearSelectEl.addEventListener('change', () => {
      _accrualsViewYear = parseInt(yearSelectEl.value, 10);
      renderAccrualsAccruedList();
    });
  }
  if(yearSelectEl){
    // Rebuilt whenever the needed range isn't already covered (cheap either way — a handful
    // of <option>s) rather than populated once and left fixed: closing enough months within
    // one continuous session can push accrualsOpenYear past the ±2 window that was there the
    // first time this rendered, which used to leave the dropdown showing blank/unselected
    // even though _accrualsViewYear (and the actual row filtering, which reads that variable
    // directly) was still correct.
    const existingYears = new Set(Array.from(yearSelectEl.options).map(o => Number(o.value)));
    const neededMin = Math.min(openMY.year, _accrualsViewYear) - 2;
    const neededMax = Math.max(openMY.year, _accrualsViewYear) + 2;
    let rangeOk = true;
    for(let y = neededMin; y <= neededMax; y++){ if(!existingYears.has(y)){ rangeOk = false; break; } }
    if(!rangeOk){
      yearSelectEl.innerHTML = '';
      for(let y = neededMin; y <= neededMax; y++){
        const opt = document.createElement('option'); opt.value = y; opt.textContent = String(y);
        yearSelectEl.appendChild(opt);
      }
    }
  }
  if(monthSelectEl) monthSelectEl.value = String(_accrualsViewMonth);
  if(yearSelectEl) yearSelectEl.value = String(_accrualsViewYear);
  if(closeBtn){
    closeBtn.style.display = isViewingOpenMonth ? 'inline-block' : 'none';
  }

  const rows = (state.accruals || []).filter(a => {
    if(a.notAccruable) return false; // shown in its own Not Accruable table instead
    if(isViewingOpenMonth) return !a.accrualMonth && !a.accrualYear;
    return Number(a.accrualMonth) === _accrualsViewMonth && Number(a.accrualYear) === _accrualsViewYear;
  });
  const fmtMDY = (iso) => { const d = isoStrToDate(iso); return isNaN(d) ? iso : `${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}/${d.getFullYear()}`; };

  if(summaryEl){
    const label = `${accrualMonthName(_accrualsViewMonth)} ${_accrualsViewYear}`;
    summaryEl.textContent = isViewingOpenMonth
      ? (rows.length === 0 ? `${label} (open) — no periods accrued yet.` : `${label} (open) — ${rows.length} period(s) accrued so far, not yet closed.`)
      : (rows.length === 0 ? `${label} — no accrual record found.` : `${label} — closed, ${rows.length} period(s).`);
  }

  tableEl.innerHTML = '';
  if(rows.length === 0) return;

  // Computed fresh every render (never persisted onto the accrual record) so fixing a source
  // invoice's detail and coming back to this tab immediately reflects the corrected amount.
  // The Accounting/Payables report needs the total split at the reporting month's own boundary
  // — everything accrued through the end of the PRIOR month ("Accumulated") versus just this
  // reporting month's own days ("This Month") — rather than one lump sum they'd have to split
  // by hand. Split against _accrualsViewYear/_accrualsViewMonth (whichever month this table is
  // currently showing), not wall-clock "today", so a closed month's split always reflects what
  // was actually being reported that month.
  const chargeEstimates = new Map();
  const monthSplits = new Map();
  rows.forEach(r => {
    const est = computeAccrualChargeEstimate(r);
    chargeEstimates.set(r.id, est);
    monthSplits.set(r.id, splitAccrualAmountByViewMonth(r, est.chargePerDay, _accrualsViewMonth, _accrualsViewYear));
  });

  const COLUMNS = [
    { key: 'unitId', label: 'UnitId', get: r => r.unitId },
    { key: 'lease', label: 'Lease', get: r => r.lease },
    { key: 'supplier', label: 'Supplier', get: r => r.supplier },
    { key: 'costCenter', label: 'Cost Center', get: r => r.costCenter },
    { key: 'status', label: 'Status', get: r => r.status },
    { key: 'disabledDate', label: 'Disabled Date', get: r => getUnitDisabledDateText(r.unitId) },
    { key: 'period', label: 'Missing Period', get: r => r.periodStart || '' },
    { key: 'days', label: 'Days', get: r => Number(r.days) || 0, numeric: true, alignRight: true },
    { key: 'lastInvoiceAmount', label: 'Last Invoice Amount', get: r => chargeEstimates.get(r.id).totalAmount, numeric: true, alignRight: true },
    { key: 'chargePerDay', label: 'Charge/Day', get: r => chargeEstimates.get(r.id).chargePerDay, numeric: true, alignRight: true },
    { key: 'accumulated', label: 'Accumulated', get: r => monthSplits.get(r.id).accumulatedAmount, numeric: true, alignRight: true },
    { key: 'currentMonth', label: 'This Month', get: r => monthSplits.get(r.id).currentMonthAmount, numeric: true, alignRight: true },
    { key: 'totalAccrued', label: 'Total', get: r => monthSplits.get(r.id).totalAmount, numeric: true, alignRight: true }
  ];
  const sortCol = COLUMNS.find(c => c.key === _accrualsAccruedSort.column) || COLUMNS[0];
  const ascending = _accrualsAccruedSort.ascending;
  rows.sort((a, b) => {
    const av = sortCol.get(a), bv = sortCol.get(b);
    let cmp;
    if(sortCol.numeric){
      cmp = av - bv;
    } else {
      const as = av.toString().toLowerCase(), bs = bv.toString().toLowerCase();
      cmp = as < bs ? -1 : (as > bs ? 1 : 0);
    }
    if(cmp === 0) cmp = (a.periodStart||'') < (b.periodStart||'') ? -1 : ((a.periodStart||'') > (b.periodStart||'') ? 1 : 0);
    return ascending ? cmp : -cmp;
  });

  const unitIdList = Array.from(new Set(rows.map(r => r.unitId)));

  const table = document.createElement('table');
  table.style.cssText = 'width:100%;border-collapse:collapse;font-size:11px;';

  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');

  // Leftmost, ahead of every other column — amount/detail columns are planned for the right
  // side of this row, so the remove control needs a stable position that won't keep shifting
  // right as those get added. Removing only ever makes sense for the still-open, uncommitted
  // batch — a closed month's records are locked, same as everywhere else in this workflow.
  if(isViewingOpenMonth){
    const thRemove = document.createElement('th');
    thRemove.style.cssText = 'padding:4px 6px;font-size:10px;background:#f9fafb;border-bottom:2px solid #eef2f7;position:sticky;top:0;';
    headerRow.appendChild(thRemove);
  }
  const thCounter = document.createElement('th');
  thCounter.textContent = '#';
  thCounter.style.cssText = 'text-align:left;padding:4px 6px;font-size:10px;font-weight:600;color:#374151;background:#f9fafb;border-bottom:2px solid #eef2f7;position:sticky;top:0;';
  headerRow.appendChild(thCounter);

  COLUMNS.forEach(col => {
    const th = document.createElement('th');
    th.textContent = col.label + (sortCol.key === col.key ? (ascending ? ' ▲' : ' ▼') : '');
    th.style.cssText = `text-align:${col.alignRight ? 'right' : 'left'};padding:4px 6px;font-size:10px;font-weight:600;color:#374151;background:#f9fafb;border-bottom:2px solid #eef2f7;position:sticky;top:0;cursor:pointer;user-select:none;`;
    th.title = 'Click to sort';
    th.addEventListener('click', () => {
      if(_accrualsAccruedSort.column === col.key) _accrualsAccruedSort.ascending = !_accrualsAccruedSort.ascending;
      else _accrualsAccruedSort = { column: col.key, ascending: true };
      renderAccrualsAccruedList();
    });
    headerRow.appendChild(th);
  });
  const thComment = document.createElement('th');
  thComment.textContent = 'Comment';
  thComment.style.cssText = 'text-align:center;padding:4px 6px;font-size:10px;font-weight:600;color:#374151;background:#f9fafb;border-bottom:2px solid #eef2f7;position:sticky;top:0;';
  headerRow.appendChild(thComment);
  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  rows.forEach((r, i) => {
    const tr = document.createElement('tr');
    tr.style.borderBottom = '1px solid #f0f0f0';
    tr.style.cursor = 'pointer';
    tr.addEventListener('mouseenter', () => { if(tr.dataset.selected !== 'true') tr.style.backgroundColor = '#f3f6fb'; });
    tr.addEventListener('mouseleave', () => { if(tr.dataset.selected !== 'true') tr.style.backgroundColor = ''; });
    tr.addEventListener('click', () => {
      Array.from(tbody.querySelectorAll('tr')).forEach(row => { row.dataset.selected = ''; row.style.backgroundColor = ''; });
      tr.dataset.selected = 'true';
      tr.style.backgroundColor = '#e6f0ff';
    });
    if(isViewingOpenMonth){
      const tdRemove = document.createElement('td');
      tdRemove.style.cssText = 'padding:4px 6px;text-align:center;';
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.textContent = '−';
      removeBtn.title = 'Remove — sends this period back to the missing-periods review list';
      removeBtn.style.cssText = 'width:18px;height:18px;line-height:14px;padding:0;border-radius:4px;border:1px solid #dc2626;background:transparent;color:#dc2626;font-weight:700;font-size:13px;cursor:pointer;';
      removeBtn.addEventListener('click', (e) => { e.stopPropagation(); removeAccrualRecord(r.id); });
      tdRemove.appendChild(removeBtn);
      tr.appendChild(tdRemove);
    }
    const tdCounter = document.createElement('td');
    tdCounter.textContent = String(i + 1);
    tdCounter.style.cssText = 'padding:4px 6px;color:#6b7280;';
    tr.appendChild(tdCounter);

    [r.unitId, r.lease, r.supplier, r.costCenter, r.status, getUnitDisabledDateText(r.unitId), `${fmtMDY(r.periodStart)} - ${fmtMDY(r.periodEnd)}`, String(r.days)].forEach((val, ci) => {
      const td = document.createElement('td');
      td.textContent = val;
      td.style.cssText = `padding:4px 6px;${ci === 7 ? 'text-align:right;' : ''}`;
      if(ci === 0){
        // Same coverage-history popup used everywhere else a UnitId is clickable — lets the
        // operator make a last visual check of this unit's calendar before sending the report.
        td.style.color = '#0b74de';
        td.style.cursor = 'pointer';
        td.title = 'View coverage history';
        td.addEventListener('click', (e) => {
          e.stopPropagation();
          const periodDate = isoStrToDate(r.periodStart);
          const y = isNaN(periodDate) ? new Date().getFullYear() : periodDate.getFullYear();
          const m = isNaN(periodDate) ? new Date().getMonth() : periodDate.getMonth();
          try{ openUnitWdNumbersModal(r.unitId, y, m, unitIdList); }catch(err){}
        });
      }
      tr.appendChild(td);
    });

    const estimate = chargeEstimates.get(r.id);
    const tdLastInvoice = document.createElement('td');
    tdLastInvoice.style.cssText = 'padding:4px 6px;text-align:right;cursor:pointer;';
    if(estimate.isOverridden){
      // Flags a row whose accrual source was manually picked (via the Charge History chart's
      // "Use Block to Accrue") rather than the automatic closest-prior-period — so it's obvious
      // at a glance which numbers reflect an operator's judgment call, not the default pick.
      const overrideMark = document.createElement('span');
      overrideMark.textContent = '! ';
      overrideMark.style.cssText = 'color:#dc2626;font-weight:800;';
      overrideMark.title = 'This amount was manually selected from a different period than the usual most-recent invoice — click for details';
      tdLastInvoice.appendChild(overrideMark);
    }
    tdLastInvoice.appendChild(document.createTextNode(formatCurrency(estimate.totalAmount)));
    if(estimate.needsUpdate){
      // Flags exactly which rows still need their source invoice re-registered with detailed
      // per-unit charges — a plain $0 alone wouldn't distinguish "needs updating" from a unit
      // that's genuinely never had a prior invoice.
      tdLastInvoice.style.color = '#b45309';
      tdLastInvoice.style.fontWeight = '600';
      tdLastInvoice.title = estimate.found ? 'Source invoice found but not yet updated with detailed charges — click for details' : 'No prior invoice found for this unit — click for details';
    } else {
      tdLastInvoice.style.color = '#0b74de';
      tdLastInvoice.title = estimate.isOverridden ? 'Manually selected amount — click for details' : 'Click to see what this amount includes';
    }
    tdLastInvoice.addEventListener('click', (e) => {
      e.stopPropagation();
      openAccrualChargeDetail(r, estimate, rows);
    });
    tr.appendChild(tdLastInvoice);

    const tdPerDay = document.createElement('td');
    tdPerDay.textContent = formatCurrency(estimate.chargePerDay);
    tdPerDay.style.cssText = 'padding:4px 6px;text-align:right;color:#0b74de;cursor:pointer;';
    tdPerDay.title = "View this unit's Charge/Day and Last Invoice Amount history";
    tdPerDay.addEventListener('click', (e) => {
      e.stopPropagation();
      openUnitChargeHistoryModal(r, rows);
    });
    tr.appendChild(tdPerDay);

    const split = monthSplits.get(r.id);
    const tdAccumulated = document.createElement('td');
    tdAccumulated.textContent = formatCurrency(split.accumulatedAmount);
    tdAccumulated.title = `${split.accumulatedDays} day(s) through the end of the prior month`;
    tdAccumulated.style.cssText = 'padding:4px 6px;text-align:right;';
    tr.appendChild(tdAccumulated);

    const tdCurrentMonth = document.createElement('td');
    tdCurrentMonth.textContent = formatCurrency(split.currentMonthAmount);
    tdCurrentMonth.title = `${split.currentMonthDays} day(s) within ${accrualMonthName(_accrualsViewMonth)} ${_accrualsViewYear}`;
    tdCurrentMonth.style.cssText = 'padding:4px 6px;text-align:right;';
    tr.appendChild(tdCurrentMonth);

    const tdTotal = document.createElement('td');
    tdTotal.textContent = formatCurrency(split.totalAmount);
    tdTotal.style.cssText = 'padding:4px 6px;text-align:right;font-weight:600;';
    tr.appendChild(tdTotal);

    // Comment icon — one slot per (record, current month); see getAccrualComment. Editable
    // regardless of open/closed, since a note isn't part of the frozen dollar figures.
    const tdComment = document.createElement('td');
    tdComment.style.cssText = 'padding:4px 6px;text-align:center;cursor:pointer;';
    const existingComment = getAccrualComment(r);
    const commentIcon = document.createElement('span');
    commentIcon.textContent = '💬';
    commentIcon.style.cssText = existingComment ? 'color:#0b74de;font-weight:700;' : 'color:#c0c5cc;';
    tdComment.title = existingComment ? existingComment.text : 'Add a comment for this month';
    tdComment.appendChild(commentIcon);
    tdComment.addEventListener('click', (e) => {
      e.stopPropagation();
      openAccrualCommentModal(r, () => renderAccrualsAccruedList());
    });
    tr.appendChild(tdComment);

    tbody.appendChild(tr);
  });
  table.appendChild(tbody);

  // Footer totals row -- lets the operator see the batch's grand totals (what's already
  // accumulated through last month, what this month alone adds, and the combined total that
  // will hit the books) without having to add up every row by hand.
  const totalAccumulated = rows.reduce((sum, r) => sum + monthSplits.get(r.id).accumulatedAmount, 0);
  const totalCurrentMonth = rows.reduce((sum, r) => sum + monthSplits.get(r.id).currentMonthAmount, 0);
  const totalAccrued = rows.reduce((sum, r) => sum + monthSplits.get(r.id).totalAmount, 0);

  const tfoot = document.createElement('tfoot');
  const footRow = document.createElement('tr');
  footRow.style.cssText = 'border-top:2px solid #d1d5db;background:#f9fafb;font-weight:700;';

  const tdFootLabel = document.createElement('td');
  tdFootLabel.textContent = 'Totals';
  // Spans everything up through Charge/Day -- i.e. every column except the three amount
  // columns being summed -- regardless of whether the leading Remove column is present. (The
  // trailing Comment column has no footer entry — this row is simply shorter than the header,
  // which is fine; it doesn't shift any of the cells that do exist.)
  tdFootLabel.colSpan = (isViewingOpenMonth ? 1 : 0) + 1 + 10;
  tdFootLabel.style.cssText = 'padding:6px;text-align:right;color:#374151;';
  footRow.appendChild(tdFootLabel);

  const tdFootAccumulated = document.createElement('td');
  tdFootAccumulated.textContent = formatCurrency(totalAccumulated);
  tdFootAccumulated.title = 'Total Accumulated';
  tdFootAccumulated.style.cssText = 'padding:6px;text-align:right;';
  footRow.appendChild(tdFootAccumulated);

  const tdFootCurrentMonth = document.createElement('td');
  tdFootCurrentMonth.textContent = formatCurrency(totalCurrentMonth);
  tdFootCurrentMonth.title = 'Charge for this month';
  tdFootCurrentMonth.style.cssText = 'padding:6px;text-align:right;';
  footRow.appendChild(tdFootCurrentMonth);

  const tdFootTotal = document.createElement('td');
  tdFootTotal.textContent = formatCurrency(totalAccrued);
  tdFootTotal.title = 'Total Amount Accruals';
  tdFootTotal.style.cssText = 'padding:6px;text-align:right;';
  footRow.appendChild(tdFootTotal);

  tfoot.appendChild(footRow);
  table.appendChild(tfoot);

  tableEl.appendChild(table);
}

// Removes a single accrual record from "Periods Ready to Accrue" (open batch only — see the
// isViewingOpenMonth gate above) and sends it back to the missing-periods review list, since
// it once again represents an open, un-accrued period. Unlike the single most-recent "Undo"
// label, this works on ANY row in the open batch, not just the last one accrued — so any
// stale reference that label was tracking is cleared here rather than left dangling.
function removeAccrualRecord(recordId){
  const idx = (state.accruals || []).findIndex(a => a.id === recordId);
  if(idx === -1) return;
  const record = state.accruals[idx];
  state.accruals = state.accruals.filter(a => a.id !== recordId);
  _accrualsSyncInFlight = true;
  DB.deleteAccrual(recordId).catch(e => console.error('Accrual remove error:', e)).finally(() => { _accrualsSyncInFlight = false; });
  try{ saveState(); }catch(e){}

  if(_accrualsLastAccruedIds && _accrualsLastAccruedIds.indexOf(recordId) !== -1){
    _accrualsLastAccruedUnitId = null;
    _accrualsLastAccruedMissingRows = null;
    _accrualsLastAccruedIds = null;
    _accrualsLastAccruedMerge = null;
  }

  const unit = (state.units || []).find(u => String(u.unitId || '').trim().toLowerCase() === String(record.unitId || '').trim().toLowerCase());
  if(unit && typeof refreshAccrualsRowsForUnit === 'function') refreshAccrualsRowsForUnit(unit);

  renderAccrualsAccruedList();
  if(typeof updateAccrueUnitButton === 'function') updateAccrueUnitButton();
}

// Click-to-sort state for "Not Accruable" (not persisted).
let _accrualsNotAccruableSort = { column: 'unitId', ascending: true };

// Weekly/Quarterly leases' missing periods, manually parked here via the coverage panel's
// "Not Accruable" button instead of being accrued (see markCurrentPeriodNotAccruable) — a flat
// list, not month/year-driven like "Periods Ready to Accrue", since these are never "closed"
// as a dollar-accrual document. Remove sends a period straight back to Missing Periods.
function renderAccrualsNotAccruableList(){
  const tableEl = qs('#accrualsNotAccruableTable');
  const summaryEl = qs('#accrualsNotAccruableSummary');
  if(!tableEl) return;

  const rows = (state.accruals || []).filter(a => a.notAccruable);
  const fmtMDY = (iso) => { const d = isoStrToDate(iso); return isNaN(d) ? iso : `${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}/${d.getFullYear()}`; };

  if(summaryEl){
    summaryEl.textContent = rows.length === 0
      ? 'No periods marked not accruable.'
      : `${rows.length} period(s) marked not accruable.`;
  }

  tableEl.innerHTML = '';
  if(rows.length === 0) return;

  const COLUMNS = [
    { key: 'unitId', label: 'UnitId', get: r => r.unitId },
    { key: 'lease', label: 'Lease', get: r => r.lease },
    { key: 'supplier', label: 'Supplier', get: r => r.supplier },
    { key: 'costCenter', label: 'Cost Center', get: r => r.costCenter },
    { key: 'status', label: 'Status', get: r => r.status },
    { key: 'disabledDate', label: 'Disabled Date', get: r => getUnitDisabledDateText(r.unitId) },
    { key: 'period', label: 'Period', get: r => r.periodStart || '' },
    { key: 'days', label: 'Days', get: r => Number(r.days) || 0, numeric: true, alignRight: true }
  ];
  const sortCol = COLUMNS.find(c => c.key === _accrualsNotAccruableSort.column) || COLUMNS[0];
  const ascending = _accrualsNotAccruableSort.ascending;
  rows.sort((a, b) => {
    const av = sortCol.get(a), bv = sortCol.get(b);
    let cmp;
    if(sortCol.numeric){
      cmp = av - bv;
    } else {
      const as = av.toString().toLowerCase(), bs = bv.toString().toLowerCase();
      cmp = as < bs ? -1 : (as > bs ? 1 : 0);
    }
    if(cmp === 0) cmp = (a.periodStart||'') < (b.periodStart||'') ? -1 : ((a.periodStart||'') > (b.periodStart||'') ? 1 : 0);
    return ascending ? cmp : -cmp;
  });

  const unitIdList = Array.from(new Set(rows.map(r => r.unitId)));

  const table = document.createElement('table');
  table.style.cssText = 'width:100%;border-collapse:collapse;font-size:11px;';

  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');

  const thRemove = document.createElement('th');
  thRemove.style.cssText = 'padding:4px 6px;font-size:10px;background:#f9fafb;border-bottom:2px solid #eef2f7;position:sticky;top:0;';
  headerRow.appendChild(thRemove);

  const thCounter = document.createElement('th');
  thCounter.textContent = '#';
  thCounter.style.cssText = 'text-align:left;padding:4px 6px;font-size:10px;font-weight:600;color:#374151;background:#f9fafb;border-bottom:2px solid #eef2f7;position:sticky;top:0;';
  headerRow.appendChild(thCounter);

  COLUMNS.forEach(col => {
    const th = document.createElement('th');
    th.textContent = col.label + (sortCol.key === col.key ? (ascending ? ' ▲' : ' ▼') : '');
    th.style.cssText = `text-align:${col.alignRight ? 'right' : 'left'};padding:4px 6px;font-size:10px;font-weight:600;color:#374151;background:#f9fafb;border-bottom:2px solid #eef2f7;position:sticky;top:0;cursor:pointer;user-select:none;`;
    th.title = 'Click to sort';
    th.addEventListener('click', () => {
      if(_accrualsNotAccruableSort.column === col.key) _accrualsNotAccruableSort.ascending = !_accrualsNotAccruableSort.ascending;
      else _accrualsNotAccruableSort = { column: col.key, ascending: true };
      renderAccrualsNotAccruableList();
    });
    headerRow.appendChild(th);
  });
  const thComment = document.createElement('th');
  thComment.textContent = 'Comment';
  thComment.style.cssText = 'text-align:center;padding:4px 6px;font-size:10px;font-weight:600;color:#374151;background:#f9fafb;border-bottom:2px solid #eef2f7;position:sticky;top:0;';
  headerRow.appendChild(thComment);
  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  rows.forEach((r, i) => {
    const tr = document.createElement('tr');
    tr.style.borderBottom = '1px solid #f0f0f0';
    tr.style.cursor = 'pointer';
    tr.addEventListener('mouseenter', () => { if(tr.dataset.selected !== 'true') tr.style.backgroundColor = '#f3f6fb'; });
    tr.addEventListener('mouseleave', () => { if(tr.dataset.selected !== 'true') tr.style.backgroundColor = ''; });
    tr.addEventListener('click', () => {
      Array.from(tbody.querySelectorAll('tr')).forEach(row => { row.dataset.selected = ''; row.style.backgroundColor = ''; });
      tr.dataset.selected = 'true';
      tr.style.backgroundColor = '#e6f0ff';
    });

    const tdRemove = document.createElement('td');
    tdRemove.style.cssText = 'padding:4px 6px;text-align:center;';
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.textContent = '−';
    removeBtn.title = 'Remove — sends this period back to the missing-periods review list';
    removeBtn.style.cssText = 'width:18px;height:18px;line-height:14px;padding:0;border-radius:4px;border:1px solid #dc2626;background:transparent;color:#dc2626;font-weight:700;font-size:13px;cursor:pointer;';
    removeBtn.addEventListener('click', (e) => { e.stopPropagation(); removeNotAccruableRecord(r.id); });
    tdRemove.appendChild(removeBtn);
    tr.appendChild(tdRemove);

    const tdCounter = document.createElement('td');
    tdCounter.textContent = String(i + 1);
    tdCounter.style.cssText = 'padding:4px 6px;color:#6b7280;';
    tr.appendChild(tdCounter);

    [r.unitId, r.lease, r.supplier, r.costCenter, r.status, getUnitDisabledDateText(r.unitId), `${fmtMDY(r.periodStart)} - ${fmtMDY(r.periodEnd)}`, String(r.days)].forEach((val, ci) => {
      const td = document.createElement('td');
      td.textContent = val;
      td.style.cssText = `padding:4px 6px;${ci === 7 ? 'text-align:right;' : ''}`;
      if(ci === 0){
        // Same coverage-history popup as everywhere else a UnitId is clickable.
        td.style.color = '#0b74de';
        td.style.cursor = 'pointer';
        td.title = 'View coverage history';
        td.addEventListener('click', (e) => {
          e.stopPropagation();
          const periodDate = isoStrToDate(r.periodStart);
          const y = isNaN(periodDate) ? new Date().getFullYear() : periodDate.getFullYear();
          const m = isNaN(periodDate) ? new Date().getMonth() : periodDate.getMonth();
          try{ openUnitWdNumbersModal(r.unitId, y, m, unitIdList); }catch(err){}
        });
      }
      tr.appendChild(td);
    });

    // Comment icon — one slot per (record, current month); see getAccrualComment. A Not
    // Accruable row never closes, so this is the ONLY per-cycle note mechanism it has.
    const tdComment = document.createElement('td');
    tdComment.style.cssText = 'padding:4px 6px;text-align:center;cursor:pointer;';
    const existingComment = getAccrualComment(r);
    const commentIcon = document.createElement('span');
    commentIcon.textContent = '💬';
    commentIcon.style.cssText = existingComment ? 'color:#0b74de;font-weight:700;' : 'color:#c0c5cc;';
    tdComment.title = existingComment ? existingComment.text : 'Add a comment for this month';
    tdComment.appendChild(commentIcon);
    tdComment.addEventListener('click', (e) => {
      e.stopPropagation();
      openAccrualCommentModal(r, () => renderAccrualsNotAccruableList());
    });
    tr.appendChild(tdComment);

    tbody.appendChild(tr);
  });
  table.appendChild(tbody);

  tableEl.appendChild(table);
}

// Removes a single record from the Not Accruable table and sends it back to the missing-periods
// review list — mirrors removeAccrualRecord's shape exactly, just against this table instead.
function removeNotAccruableRecord(recordId){
  const idx = (state.accruals || []).findIndex(a => a.id === recordId);
  if(idx === -1) return;
  const record = state.accruals[idx];
  state.accruals = state.accruals.filter(a => a.id !== recordId);
  _accrualsSyncInFlight = true;
  DB.deleteAccrual(recordId).catch(e => console.error('Not Accruable remove error:', e)).finally(() => { _accrualsSyncInFlight = false; });
  try{ saveState(); }catch(e){}

  const unit = (state.units || []).find(u => String(u.unitId || '').trim().toLowerCase() === String(record.unitId || '').trim().toLowerCase());
  if(unit && typeof refreshAccrualsRowsForUnit === 'function') refreshAccrualsRowsForUnit(unit);

  renderAccrualsNotAccruableList();
}

const accrualsAccrueUnitBtnEl = qs('#accrualsAccrueUnitBtn');
if(accrualsAccrueUnitBtnEl) accrualsAccrueUnitBtnEl.addEventListener('click', accrueCurrentUnit);
const accrualsNotAccruableBtnEl = qs('#accrualsNotAccruableBtn');
if(accrualsNotAccruableBtnEl) accrualsNotAccruableBtnEl.addEventListener('click', markCurrentPeriodNotAccruable);
const accrualsCloseMonthBtnEl = qs('#accrualsCloseMonthBtn');
if(accrualsCloseMonthBtnEl) accrualsCloseMonthBtnEl.addEventListener('click', closeAccrualsMonth);
const accrualsDownloadDeliverableBtnEl = qs('#accrualsDownloadDeliverableBtn');
if(accrualsDownloadDeliverableBtnEl) accrualsDownloadDeliverableBtnEl.addEventListener('click', downloadAccrualsDeliverable);
const accrualsAccrueUndoLabelEl = qs('#accrualsAccrueUndoLabel');
if(accrualsAccrueUndoLabelEl) accrualsAccrueUndoLabelEl.addEventListener('click', undoAccrueUnit);

// Updates the panel's "X / Y" counter and Prev/Next arrow enabled state to match whichever
// row is currently selected in _accrualsRowRefs.
function updateAccrualsPanelNav(){
  const navEl = qs('#accrualsPanelNav');
  const prevBtn = qs('#accrualsPanelPrev');
  const nextBtn = qs('#accrualsPanelNext');
  const refs = _accrualsActiveSubTab === 'manual' ? _accrualsManualRowRefs : _accrualsRowRefs;
  const selectedKey = _accrualsActiveSubTab === 'manual' ? _accrualsManualSelectedRowKey : _accrualsSelectedRowKey;
  const idx = refs.findIndex(x => x.rowKey === selectedKey);
  if(navEl) navEl.textContent = (idx === -1 || refs.length === 0) ? '' : `${idx + 1} / ${refs.length}`;
  if(prevBtn) prevBtn.style.opacity = (idx <= 0) ? '0.3' : '1';
  if(nextBtn) nextBtn.style.opacity = (idx === -1 || idx >= refs.length - 1) ? '0.3' : '1';
}

// Steps the panel to the previous/next row in whichever sub-tab's list is currently shown on
// the left, reusing that row's own click handler (highlight + panel render) and scrolling it
// into view within the table's own scroll container if it isn't already visible.
function accrualsPanelNavigate(direction){
  if(accrualsPanelBlockedByPending()) return;
  const refs = _accrualsActiveSubTab === 'manual' ? _accrualsManualRowRefs : _accrualsRowRefs;
  const selectedKey = _accrualsActiveSubTab === 'manual' ? _accrualsManualSelectedRowKey : _accrualsSelectedRowKey;
  if(!refs.length) return;
  let idx = refs.findIndex(x => x.rowKey === selectedKey);
  if(idx === -1){ idx = 0; } else { idx += direction; }
  if(idx < 0 || idx >= refs.length) return;
  const target = refs[idx];
  target.tr.click();
  try{
    const listContainer = qs(_accrualsActiveSubTab === 'manual' ? '#accrualsManualPeriodsTable' : '#accrualsMissingPeriodsTable');
    scrollIntoContainerView(target.tr, listContainer, 'nearest');
  }catch(e){}
}

const accrualsPanelPrevBtn = qs('#accrualsPanelPrev');
if(accrualsPanelPrevBtn) accrualsPanelPrevBtn.addEventListener('click', () => accrualsPanelNavigate(-1));
const accrualsPanelNextBtn = qs('#accrualsPanelNext');
if(accrualsPanelNextBtn) accrualsPanelNextBtn.addEventListener('click', () => accrualsPanelNavigate(1));

// ========== Invoice Tracking tab ==========
// An entry can only ever be created for a WD Invoice Number that's already posted in the
// system (a registry) — internal procedure now requires every invoice, disputed or not, to
// be posted first. So everything about the invoice itself (supplier, lease, units, dates,
// amount, per-unit detail) is looked up from that registry and locked here rather than typed;
// the only things the operator actually picks are which units are in dispute (checkboxes on
// the breakdown table below) and the narrative fields (Amount in Dispute, statuses,
// description/request).
function populateInvoiceTrackingDropdowns(){
  const supplierSel = qs('#itSupplier');
  if(supplierSel){
    const cur = supplierSel.value;
    supplierSel.innerHTML = '<option value="">Look up a WD Invoice Num above</option>';
    (state.meta.devSuppliers || []).forEach(s => {
      const opt = document.createElement('option'); opt.value = s; opt.textContent = s; supplierSel.appendChild(opt);
    });
    if(cur) supplierSel.value = cur;
  }
}

// The registry currently matched by the WD Invoice Num lookup — the single source of truth
// for every locked field and for the breakdown table's rows. Null until a match is found.
let _itMatchedRegistry = null;

function getInvoiceTrackingCheckedUnits(){
  const wrap = qs('#itUnitAmountBreakdown'); if(!wrap) return [];
  return Array.from(wrap.querySelectorAll('.unit-breakdown-row')).filter(row => {
    const cb = row.querySelector('.itb-dispute-checkbox');
    return cb && cb.checked;
  }).map(row => row.dataset.unitId);
}

// Cost Center for the saved record is derived from whichever units end up checked as disputed.
function computeCostCenterSummaryForUnits(unitIds){
  const ccSet = new Set();
  (unitIds || []).forEach(uid => {
    const u = (state.units || []).find(x => (x.unitId || x.id || '').toString().trim().toLowerCase() === uid.toString().trim().toLowerCase());
    if(u && u.costCenter) ccSet.add(u.costCenter);
  });
  return Array.from(ccSet).join(', ');
}

function getInvoiceTrackingCostCenterSummary(){
  return computeCostCenterSummaryForUnits(getInvoiceTrackingCheckedUnits());
}

// Single source of truth for "how much of one unit's charge is actually in dispute" — shared by
// the live checkbox-driven auto-sum (updateInvoiceTrackingDisputeAmountFromChecked, below), the
// Refresh Data recompute (refreshInvoiceTrackingRecordFromSource), and the row tooltip estimate
// (renderInvoiceTrackingUnitBreakdown) — factored out specifically so none of the three can ever
// drift out of sync with each other.
//
// The Charge (rent) portion is DAY-PRORATED, PER PERIOD: `chargePeriods` carries each period this
// unit was actually invoiced in on this registry (a quarterly invoice bills a unit separately
// per month, so there can be several) — each one is prorated and taxed against its OWN dates
// separately, then summed, rather than picking just one period's charge (which used to silently
// zero out a dispute whenever the unit's actually-relevant month wasn't the first one found: the
// day-math would run against the WRONG month's dates, landing on $0 with no error). A dispute is
// specifically about days the unit was DISABLED but still invoiced for, so each period's charge
// scales down to its own disabled-day overlap — a period the unit was disabled for ENTIRELY
// naturally resolves to its full charge; one it was never disabled in at all resolves to 0. Tax
// is never itself pro-rated directly — it's expressed as the % it represents of that SAME
// period's own charge (taxRate = tax / charge), applied to that period's own disputed portion.
//
// Other Charges (Freight, Gasoline, etc.) are handled completely differently: NEVER prorated by
// day at all, and only counted when the operator has explicitly checked that specific line's own
// checkbox (`sub.disputed`, or `otherSelected` for a legacy lump with no named breakdown) — a
// flat charge like Freight is typically owed in FULL the moment the unit operated for any part of
// the period, or fully disputable if it wasn't there for any of it, which is the operator's own
// judgment call per charge, not something day-math can decide. A checked charge counts at its
// FULL amount plus its own tax (each subcharge can carry a different tax rate than the others or
// any charge period, so each is added at its own rate, never blended).
function computeUnitDisputeShare(unitId, chargePeriods, otherVal, otherChargeDetails, otherSelected){
  const periods = Array.isArray(chargePeriods) ? chargePeriods : [];
  const other = parseCurrency(otherVal || '') || 0;
  const details = Array.isArray(otherChargeDetails) ? otherChargeDetails : [];

  let total = 0;

  const unitRec = periods.length ? (state.units || []).find(u => (u.unitId || u.id || '').toString().trim().toLowerCase() === (unitId || '').toString().trim().toLowerCase()) : null;
  if(unitRec){
    periods.forEach(cp => {
      const charge = parseCurrency(cp.charge || '') || 0;
      if(!charge) return;
      const tax = parseCurrency(cp.tax || '') || 0;
      const { totalDays, disabledDays } = computeDisabledDaysInPeriod(unitRec, cp.periodFrom, cp.periodTo);
      if(totalDays <= 0) return;
      const disputedCharge = charge * (disabledDays / totalDays);
      const chargeTaxRate = tax / charge;
      total += disputedCharge + (disputedCharge * chargeTaxRate);
    });
  }

  if(details.length > 0){
    details.forEach(sub => {
      if(!sub.disputed) return;
      const subAmt = parseCurrency(sub.amount || '') || 0;
      const subTax = parseCurrency(sub.tax || '') || 0;
      total += subAmt + subTax;
    });
  } else if(other && otherSelected){
    total += other;
  }

  return total;
}

// Checking/unchecking a unit's dispute box, or any of its individual Other Charge checkboxes,
// re-sums a starting estimate into Amount in Dispute — still freely editable by hand afterward
// (checking further boxes will re-sum again, overwriting a manual edit). Reads each subcharge's
// live checked state off row._subcharges (set at render time — see renderInvoiceTrackingUnitBreakdown),
// not the original registry snapshot, since that's exactly what the operator has been toggling.
function updateInvoiceTrackingDisputeAmountFromChecked(){
  const wrap = qs('#itUnitAmountBreakdown');
  let sum = 0;
  if(wrap){
    wrap.querySelectorAll('.unit-breakdown-row').forEach(row => {
      const cb = row.querySelector('.itb-dispute-checkbox');
      if(!cb || !cb.checked) return;
      const subEntries = Array.isArray(row._subcharges) ? row._subcharges : [];
      const otherChargeDetails = subEntries.filter(s => !s.isLegacyOther)
        .map(s => ({ name: s.name, amount: s.amount, tax: s.tax, disputed: !!(s.checkbox && s.checkbox.checked) }));
      const legacyEntry = subEntries.find(s => s.isLegacyOther);
      const otherSelected = !!(legacyEntry && legacyEntry.checkbox && legacyEntry.checkbox.checked);
      sum += computeUnitDisputeShare(row.dataset.unitId, row._chargePeriods, row.dataset.other, otherChargeDetails, otherSelected);
    });
  }
  const disputeField = qs('#itAmountInDispute');
  if(disputeField) disputeField.value = sum ? sum.toFixed(2) : '';
  updateInvoiceTrackingAmountDue();
}

// Amount Due = Invoice Amount − Amount in Dispute.
function updateInvoiceTrackingAmountDue(){
  const dueField = qs('#itAmountDue'); if(!dueField) return;
  const invoiceAmount = parseCurrency((qs('#itInvoiceAmount') || {}).value || '') || 0;
  const amountInDispute = parseCurrency((qs('#itAmountInDispute') || {}).value || '') || 0;
  const due = invoiceAmount - amountInDispute;
  dueField.value = due ? due.toFixed(2) : '';
}
const itAmountInDisputeEl = qs('#itAmountInDispute');
if(itAmountInDisputeEl) itAmountInDisputeEl.addEventListener('input', updateInvoiceTrackingAmountDue);

// Renders one read-only row per unit on the matched registry — Company/UnitId/Lease/Cost
// Center (the same shared column set as Invoice Registration) plus that unit's actual, locked
// Tax/Other Charges/Amount/Total Charge — with a leading checkbox to mark it disputed. Every
// unit here is freely selectable regardless of any other dispute entry — the WD Invoice Number
// itself is what's checked for duplicates (see lookupInvoiceTrackingWd), since a new invoice
// against a unit that's already been disputed before is exactly the kind of thing that must
// still get tracked. A row is only ever locked out for being Disabled.
function renderInvoiceTrackingUnitBreakdown(){
  const wrap = qs('#itUnitAmountBreakdown'); if(!wrap) return;
  const registry = _itMatchedRegistry;

  if(!registry){
    wrap.style.display = 'none';
    wrap.innerHTML = '';
    return;
  }

  // Every unit on the registry (Period 1 + every quarterly sub-period), each already tagged with
  // the exact period slice its own detail entry came from (d.__slice) — see
  // getRegistryUnitDetailsWithSlice for why this has to be built in one pass rather than two
  // independent lookups (one for what to display, one for which dates to prorate against).
  const details = getRegistryUnitDetailsWithSlice(registry);
  wrap.innerHTML = '';
  if(details.length === 0){
    wrap.style.display = 'none';
    return;
  }

  const AMOUNT_COLS = [['tax', 'Tax', 110], ['other', 'Other Charges', 120], ['charge', 'Amount', 110], ['rowTotal', 'Total Charge', 110]];

  const header = document.createElement('div');
  header.className = 'unit-breakdown-header';
  header.style.cssText = 'display:flex;gap:8px;font-weight:600;font-size:12px;color:#374151;padding:4px 0;border-bottom:2px solid #e6e9ee;background:#fff;';
  const checkboxHeaderCell = document.createElement('div');
  checkboxHeaderCell.textContent = 'Dispute?';
  checkboxHeaderCell.style.cssText = 'flex:0 0 60px;';
  header.appendChild(checkboxHeaderCell);
  UNIT_BREAKDOWN_COLUMNS.forEach(col => {
    const d = document.createElement('div');
    d.textContent = col.label;
    d.style.cssText = `flex:0 0 ${getColWidth(wrap, col.key, col.width)}px;`;
    header.appendChild(d);
  });
  AMOUNT_COLS.forEach(([key, label, w]) => {
    const d = document.createElement('div');
    d.textContent = label;
    d.style.cssText = `flex:0 0 ${getColWidth(wrap, key, w)}px;`;
    header.appendChild(d);
  });

  const rowsContainer = document.createElement('div');
  rowsContainer.className = 'unit-breakdown-rows';
  wrap.appendChild(rowsContainer);
  rowsContainer.appendChild(header);

  const allUnitIds = details.map(d => d.unit);

  details.forEach((d, rowIdx) => {
    const uid = d.unit;
    const unitRec = (state.units || []).find(u => (u.unitId || u.id || '').toString().trim() === uid.toString().trim());
    const row = document.createElement('div');
    row.className = 'unit-breakdown-row ' + (rowIdx % 2 === 0 ? 'unit-breakdown-row-even' : 'unit-breakdown-row-odd');
    row.dataset.unitId = uid;
    row.style.cssText = 'display:flex;gap:8px;align-items:center;padding:4px 0;border-bottom:1px solid #f0f0f0;';
    row.dataset.tax = d.tax || '';
    row.dataset.other = d.other || '';
    row.dataset.charge = d.charge || '';
    row.dataset.otherChargeDetails = JSON.stringify(d.otherChargeDetails || []);
    // Every period this unit is actually invoiced for on this registry (a quarterly invoice can
    // bill the same unit separately per month) — see getRegistryUnitDetailsWithSlice. The dispute
    // sum prorates and taxes EACH one against its own dates, then sums the results, rather than
    // picking just one (which used to silently zero out a dispute whenever the unit's actually-
    // relevant month wasn't the first one found).
    row._chargePeriods = Array.isArray(d.chargePeriods) ? d.chargePeriods : [];
    const slice = d.__slice || { from: '', to: '' };
    row.dataset.periodFrom = slice.from || '';
    row.dataset.periodTo = slice.to || '';

    // Flagged when the unit has a disabled period that never returned, or returned ON OR AFTER
    // this invoice's own From Date — i.e. it was still out of service for at least part of what
    // this invoice bills for, regardless of whether it's disabled RIGHT NOW. Catches the case a
    // simple "is this unit currently Disabled?" check misses: a unit that WAS disabled during
    // the invoice's period but has since been returned to service.
    const disputeFlag = unitRec ? computeUnitReturnDisputeFlag(unitRec, slice.from) : { flagged: false };
    if(disputeFlag.flagged){
      row.style.background = '#fee2e2';
      const returnText = disputeFlag.stillDisabled
        ? `still Disabled (not yet returned) since ${formatDate(disputeFlag.disabledFrom) || disputeFlag.disabledFrom}`
        : `Disabled ${formatDate(disputeFlag.disabledFrom) || disputeFlag.disabledFrom} → Returned ${formatDate(disputeFlag.returnedDate) || disputeFlag.returnedDate}`;
      const { totalDays, disabledDays } = computeDisabledDaysInPeriod(unitRec, slice.from, slice.to);
      if(totalDays > 0){
        // Charge-only estimate (summed across ALL of this unit's periods on this registry, each
        // prorated against its own dates) — Other Charges are never auto-included now (see the
        // per-charge checkboxes below), so they're deliberately left out of this starting-point
        // number too.
        const estAmount = computeUnitDisputeShare(uid, row._chargePeriods, '', [], false);
        row.title = `${returnText} — invoice period ${formatDate(slice.from) || slice.from} – ${formatDate(slice.to) || slice.to} — disabled ${disabledDays} of ${totalDays} day(s) in it → charge-only dispute estimate: ${formatCurrency(estAmount.toFixed(2))} (tax included proportionally; review each Other Charge below individually)`;
      } else if(!slice.from || !slice.to){
        // Safety net: this unit's own invoice period couldn't be resolved at all (both
        // getRegistryCoveragePeriods' own fallbacks AND the registry's overall periodStart/
        // periodEnd came back empty) — the Charge portion specifically has no days to prorate
        // against and will silently contribute $0. Flag it visibly rather than leaving that a
        // mystery. Other Charges are unaffected by this — those checkboxes still add their full
        // amount regardless, since they were never day-based to begin with.
        row.title = `${returnText} — ⚠ could not determine this unit's invoice period (missing From/To date on the source registry) — the Charge amount will NOT be added to Amount in Dispute; enter it by hand instead (Other Charges below are unaffected and still work normally)`;
      } else {
        row.title = returnText;
      }
    }

    const cbCell = document.createElement('div'); cbCell.style.cssText = 'flex:0 0 60px;display:flex;align-items:center;';
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.className = 'itb-dispute-checkbox'; cb.style.cursor = 'pointer';
    cb.addEventListener('change', () => {
      row.classList.toggle('selected', cb.checked);
      updateInvoiceTrackingDisputeAmountFromChecked();
    });
    cbCell.appendChild(cb);
    row.appendChild(cbCell);

    const mkCell = (text, w) => { const c = document.createElement('div'); c.textContent = text; c.style.cssText = `flex:0 0 ${w}px;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;`; return c; };
    UNIT_BREAKDOWN_COLUMNS.forEach(col => {
      const cell = mkCell(col.get(unitRec, uid), getColWidth(wrap, col.key, col.width));
      if(col.key === 'unitId' && uid){
        if(disputeFlag.flagged){
          cell.textContent = uid + (disputeFlag.stillDisabled ? ' (Disabled)' : ' (Returned Late)');
          cell.style.color = '#b91c1c';
          cell.style.fontWeight = '600';
        } else {
          cell.style.color = '#0b74de';
        }
        cell.style.cursor = 'pointer';
        cell.title = 'View coverage history';
        cell.addEventListener('click', (e) => {
          e.stopPropagation();
          try{ openUnitWdNumbersModal(uid, new Date().getFullYear(), new Date().getMonth(), allUnitIds); }catch(err){}
        });
      }
      row.appendChild(cell);
    });

    const taxVal = parseCurrency(d.tax || '') || 0;
    const otherVal = parseCurrency(d.other || '') || 0;
    const chargeVal = parseCurrency(d.charge || '') || 0;
    const totalVal = taxVal + otherVal + chargeVal;
    [['tax', taxVal, 110], ['other', otherVal, 120], ['charge', chargeVal, 110], ['rowTotal', totalVal, 110]].forEach(([key, val, w]) => {
      const c = document.createElement('div');
      c.textContent = val ? formatCurrency(val.toFixed(2)) : '';
      c.style.cssText = `flex:0 0 ${getColWidth(wrap, key, w)}px;font-size:12px;color:#374151;` + (key === 'rowTotal' ? 'font-weight:600;' : '');
      row.appendChild(c);
    });

    // Shown for ANY flagged unit (not just currently-disabled ones) so the operator can compare
    // the actual disabled/return dates against the invoice's own From/To Date without having to
    // open a separate coverage view.
    if(disputeFlag.flagged){
      const disabledDateCell = document.createElement('div');
      disabledDateCell.textContent = disputeFlag.stillDisabled
        ? `Disabled: ${formatDate(disputeFlag.disabledFrom) || disputeFlag.disabledFrom} (not yet returned)`
        : `Disabled: ${formatDate(disputeFlag.disabledFrom) || disputeFlag.disabledFrom} — Returned: ${formatDate(disputeFlag.returnedDate) || disputeFlag.returnedDate}`;
      disabledDateCell.style.cssText = 'flex:1 1 220px;font-size:11px;color:#b91c1c;font-weight:600;white-space:nowrap;';
      row.appendChild(disabledDateCell);
    }

    rowsContainer.appendChild(row);

    // Each named "Other" subcharge (Freight, Gasoline, etc.) gets its OWN checkbox — unlike the
    // main Charge (rent), which naturally prorates by how many days the unit was disabled, a
    // charge like Freight is typically a flat, one-time cost: owed in FULL the moment the unit
    // operated for ANY part of the invoice's period, or fully disputable if it wasn't there for
    // any of it. That's the operator's own judgment call per charge, not something day-math can
    // decide — so checking one includes its FULL amount + its own tax (never prorated); leaving
    // it unchecked contributes nothing. Kept as plain JS references on the row (row._subcharges),
    // not just DOM attributes, so the submit handler and the live sum can read exactly which
    // boxes are checked without re-querying by unit id. Defaults to unchecked (a deliberate
    // choice every time) unless a saved dispute record already decided it — see
    // startEditingInvoiceTrackingRecord, which restores that after this first render.
    row._subcharges = [];
    const subcharges = Array.isArray(d.otherChargeDetails) ? d.otherChargeDetails : [];
    const mkSubchargeCheckbox = (title) => {
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.className = 'itb-subcharge-checkbox'; cb.style.cssText = 'cursor:pointer;flex:0 0 auto;';
      cb.title = title;
      cb.addEventListener('change', () => { updateInvoiceTrackingDisputeAmountFromChecked(); });
      return cb;
    };
    subcharges.forEach(sub => {
      const subAmt = parseCurrency(sub.amount || '') || 0;
      const subTax = parseCurrency(sub.tax || '') || 0;
      if(!sub.name && !subAmt && !subTax) return;
      const subRow = document.createElement('div');
      subRow.className = rowIdx % 2 === 0 ? 'unit-breakdown-row-even' : 'unit-breakdown-row-odd';
      subRow.style.cssText = 'display:flex;gap:6px;align-items:center;padding:2px 0 2px 20px;font-size:11px;color:#6b7280;';
      const subCb = mkSubchargeCheckbox('Include this charge in the dispute — full amount, not prorated by day (a flat charge like Freight is either owed in full or fully disputable, not something to split by days)');
      const descNote = sub.description ? ` <span style="font-style:italic;">— ${escapeHtml(sub.description)}</span>` : '';
      const label = document.createElement('span');
      label.style.cssText = 'flex:1 1 auto;';
      label.innerHTML = `<span style="color:#9ca3af;">↳</span> ${escapeHtml(sub.name || '(unnamed)')}${descNote}`;
      const amountSpan = document.createElement('span');
      amountSpan.textContent = formatCurrency((subAmt + subTax).toFixed(2));
      subRow.appendChild(subCb); subRow.appendChild(label); subRow.appendChild(amountSpan);
      rowsContainer.appendChild(subRow);
      row._subcharges.push({ checkbox: subCb, name: sub.name || '', amount: sub.amount || '', tax: sub.tax || '' });
    });
    // Legacy "Other Charges" with no named breakdown at all — still a single manual, full-amount
    // decision, same reasoning as above, just one combined line instead of several.
    if(subcharges.length === 0 && parseCurrency(d.other || '')){
      const subRow = document.createElement('div');
      subRow.className = rowIdx % 2 === 0 ? 'unit-breakdown-row-even' : 'unit-breakdown-row-odd';
      subRow.style.cssText = 'display:flex;gap:6px;align-items:center;padding:2px 0 2px 20px;font-size:11px;color:#6b7280;';
      const subCb = mkSubchargeCheckbox('Include Other Charges in the dispute — full amount, not prorated by day');
      const label = document.createElement('span');
      label.style.cssText = 'flex:1 1 auto;';
      label.innerHTML = `<span style="color:#9ca3af;">↳</span> Other Charges`;
      const amountSpan = document.createElement('span');
      amountSpan.textContent = formatCurrency((parseCurrency(d.other || '') || 0).toFixed(2));
      subRow.appendChild(subCb); subRow.appendChild(label); subRow.appendChild(amountSpan);
      rowsContainer.appendChild(subRow);
      row._subcharges.push({ checkbox: subCb, isLegacyOther: true });
    }
  });

  wrap.style.display = 'block';
}

// Returns the OTHER (non-currently-editing) invoice tracking entry already using this exact
// WD Invoice Number, if any. One WD invoice can only ever have a single dispute-tracking
// entry — a new invoice against a unit that's already been disputed before must still get
// tracked, so the duplicate check lives on the invoice number itself, not on which units are
// checked. Adding more disputed units to an already-tracked invoice means editing that same
// entry, not creating a second one alongside it.
function findExistingInvoiceTrackingForWd(wdVal, excludeId){
  const wd = (wdVal || '').toString().trim().toLowerCase();
  if(!wd) return null;
  return (state.invoiceTracking || []).find(t =>
    (!excludeId || t.id !== excludeId) &&
    (t.wdInvoiceNum || '').toString().trim().toLowerCase() === wd
  ) || null;
}

// Looks the typed WD number up against the invoice registries: an invoice must already be
// posted before it can be tracked as a dispute, so a non-match clears and locks everything
// below rather than letting the operator fill it in by hand. Also blocks on a WD number
// that's already tracked as a dispute elsewhere (see findExistingInvoiceTrackingForWd) — that
// invoice's existing entry should be edited instead of creating a duplicate.
function lookupInvoiceTrackingWd(){
  const wdInput = qs('#itWdInvoiceNum');
  const wdDateField = qs('#itWdInvoiceDate');
  const fromField = qs('#itFromDate');
  const toField = qs('#itToDate');
  const docField = qs('#itSupplierInvoiceDoc');
  const amountField = qs('#itInvoiceAmount');
  const supplierSel = qs('#itSupplier');
  const leaseField = qs('#itLeaseSummary');
  const noteEl = qs('#itWdLookupNote');
  if(!wdInput) return;

  const clearAll = () => {
    if(fromField) fromField.value = '';
    if(toField) toField.value = '';
    if(docField) docField.value = '';
    if(amountField) amountField.value = '';
    if(supplierSel) supplierSel.value = '';
    if(leaseField) leaseField.value = '';
    _itMatchedRegistry = null;
    renderInvoiceTrackingUnitBreakdown();
    updateInvoiceTrackingAmountDue();
  };

  const wdVal = wdInput.value.trim();
  if(!wdVal){
    clearAll();
    if(wdDateField) wdDateField.value = '';
    if(noteEl) noteEl.textContent = '';
    return;
  }

  const reg = (state.registries || []).find(r => (r.wdNumber || '').toString().trim().toLowerCase() === wdVal.toLowerCase());
  if(!reg){
    clearAll();
    if(wdDateField) wdDateField.value = 'Not Submitted';
    if(noteEl){
      noteEl.textContent = 'No posted invoice found for this WD Invoice Num — it must already be registered (Invoices tab) before it can be tracked here.';
      noteEl.style.color = '#dc2626';
      noteEl.style.fontWeight = '600';
    }
    return;
  }

  const editingId = (qs('#invoiceTrackingForm') || {}).dataset ? qs('#invoiceTrackingForm').dataset.editingId : null;
  const dupTracking = findExistingInvoiceTrackingForWd(wdVal, editingId);
  if(dupTracking){
    clearAll();
    if(wdDateField) wdDateField.value = '';
    if(noteEl){
      noteEl.textContent = 'This WD Invoice Number is already tracked as a dispute — edit that existing entry to add more disputed units instead of creating a new one.';
      noteEl.style.color = '#dc2626';
      noteEl.style.fontWeight = '600';
    }
    return;
  }

  _itMatchedRegistry = reg;
  if(noteEl){ noteEl.textContent = ''; }
  if(wdDateField) wdDateField.value = reg.invoiceDate || '';
  if(fromField) fromField.value = reg.periodStart || '';
  if(toField) toField.value = reg.periodEnd || '';
  if(docField) docField.value = reg.docNumber || '';
  if(amountField) amountField.value = reg.totalAmount || '';

  const registryLeases = Array.isArray(reg.leases) && reg.leases.length ? reg.leases : ((reg.lease || '').toString().split(',').map(s => s.trim()).filter(Boolean));
  if(leaseField) leaseField.value = registryLeases.join(', ');
  if(supplierSel){
    const firstLeaseRec = registryLeases.length ? (state.leases || []).find(l => (l.leaseNumber || l.id || '').toString() === registryLeases[0]) : null;
    supplierSel.value = (firstLeaseRec && firstLeaseRec.supplier) || '';
  }

  renderInvoiceTrackingUnitBreakdown();
  updateInvoiceTrackingDisputeAmountFromChecked();
}
const itWdInvoiceNumEl = qs('#itWdInvoiceNum');
if(itWdInvoiceNumEl){
  itWdInvoiceNumEl.addEventListener('input', lookupInvoiceTrackingWd);
  // Enter is commonly used here to re-trigger the lookup when data looks stale/missing rather
  // than to submit the form — block the native submit and just refresh the lookup instead.
  itWdInvoiceNumEl.addEventListener('keydown', (e) => {
    if(e.key === 'Enter'){
      e.preventDefault();
      lookupInvoiceTrackingWd();
    }
  });
}


// --- Tracked Invoices table: per-column header filters ---
// Raw (unjoined) values for a row's column, used for filter matching against the DISTINCT
// underlying values -- the two array-valued columns (Lease, Units in Dispute) have their own
// entries checked individually, not the ", "-joined display string col.get() builds for the cell.
function getInvoiceTrackingRawValues(row, col){
  if(col.key === 'lease') return Array.isArray(row.lease) ? row.lease : (row.lease ? [row.lease] : []);
  if(col.key === 'unitsInDispute') return Array.isArray(row.unitsInDispute) ? row.unitsInDispute : [];
  const v = row[col.key];
  return [v == null ? '' : v];
}

function getInvoiceTrackingDistinctValues(col){
  const set = new Set();
  (state.invoiceTracking || []).forEach(r => {
    getInvoiceTrackingRawValues(r, col).forEach(v => {
      const s = (v || '').toString().trim();
      if(s) set.add(s);
    });
  });
  return Array.from(set).sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
}

function invoiceTrackingRowPassesFilters(row){
  return INVOICE_TRACKING_COLUMNS.every(col => {
    const f = _invoiceTrackingFilters[col.key];
    if(!f) return true;
    if(f.type === 'multi'){
      const raw = getInvoiceTrackingRawValues(row, col).map(v => (v || '').toString().trim());
      return raw.some(v => f.values.has(v));
    }
    if(f.type === 'range'){
      const val = parseCurrency(col.get ? col.get(row) : (row[col.key] || '')) || 0;
      if(f.min !== '' && val < parseFloat(f.min)) return false;
      if(f.max !== '' && val > parseFloat(f.max)) return false;
      return true;
    }
    if(f.type === 'daterange'){
      const val = (col.get ? col.get(row) : (row[col.key] || '')).toString();
      if(!val) return false;
      if(f.min && val < f.min) return false;
      if(f.max && val > f.max) return false;
      return true;
    }
    if(f.type === 'text'){
      const val = (col.get ? col.get(row) : (row[col.key] || '')).toString().toLowerCase();
      return val.indexOf(f.value.toLowerCase()) !== -1;
    }
    return true;
  });
}

function closeInvoiceTrackingFilterPopover(){
  const pop = qs('#itFilterPopover');
  if(pop) pop.remove();
  _invoiceTrackingOpenFilterCol = null;
}

function repositionInvoiceTrackingFilterPopover(anchorTh){
  const pop = qs('#itFilterPopover');
  if(!pop || !anchorTh) return;
  const rect = anchorTh.getBoundingClientRect();
  pop.style.top = (rect.bottom + 4) + 'px';
  let left = rect.left;
  const maxLeft = window.innerWidth - 280;
  if(left > maxLeft) left = Math.max(8, maxLeft);
  pop.style.left = left + 'px';
}

// Setting a filter re-renders the WHOLE table (header + rows), but the popover itself lives in
// document.body (not inside a <th>), so it survives that rebuild untouched -- only its position
// is refreshed afterward (see the reposition call at the end of renderInvoiceTrackingTable), so
// an open popover's search box / focus / scroll position is never disturbed by the operator's own
// selections.
function setInvoiceTrackingFilter(colKey, filterOrNull){
  if(filterOrNull) _invoiceTrackingFilters[colKey] = filterOrNull;
  else delete _invoiceTrackingFilters[colKey];
  renderInvoiceTrackingTable();
}

function openInvoiceTrackingFilterPopover(col, anchorTh){
  const wasOpenForSameCol = _invoiceTrackingOpenFilterCol === col.key;
  closeInvoiceTrackingFilterPopover();
  if(wasOpenForSameCol) return;
  _invoiceTrackingOpenFilterCol = col.key;

  const pop = document.createElement('div');
  pop.id = 'itFilterPopover';
  pop.style.cssText = 'position:fixed;z-index:200;width:240px;max-height:320px;overflow:auto;background:#fff;border:1px solid #e6e9ee;border-radius:8px;box-shadow:0 8px 24px rgba(2,6,23,0.15);padding:10px;font-size:13px;';
  pop.addEventListener('click', e => e.stopPropagation());
  pop.addEventListener('mousedown', e => e.stopPropagation());

  const title = document.createElement('div');
  title.textContent = 'Filter: ' + col.label;
  title.style.cssText = 'font-weight:700;margin-bottom:8px;color:#111827;';
  pop.appendChild(title);

  const existing = _invoiceTrackingFilters[col.key];

  if(col.filterType === 'multi'){
    const search = document.createElement('input');
    search.type = 'text';
    search.placeholder = 'Search values…';
    search.style.cssText = 'width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid #e6e9ee;border-radius:6px;margin-bottom:8px;font-size:12px;';
    pop.appendChild(search);

    const linksRow = document.createElement('div');
    linksRow.style.cssText = 'display:flex;gap:10px;margin-bottom:6px;';
    const selectAllLink = document.createElement('a');
    selectAllLink.href = '#'; selectAllLink.textContent = 'Select all';
    selectAllLink.style.cssText = 'font-size:12px;color:#0b74de;cursor:pointer;text-decoration:none;';
    const clearLink = document.createElement('a');
    clearLink.href = '#'; clearLink.textContent = 'Clear';
    clearLink.style.cssText = 'font-size:12px;color:#0b74de;cursor:pointer;text-decoration:none;';
    linksRow.appendChild(selectAllLink); linksRow.appendChild(clearLink);
    pop.appendChild(linksRow);

    const list = document.createElement('div');
    list.style.cssText = 'display:flex;flex-direction:column;gap:2px;';
    pop.appendChild(list);

    const values = getInvoiceTrackingDistinctValues(col);
    const selected = new Set(existing ? existing.values : []);

    const commit = () => {
      setInvoiceTrackingFilter(col.key, selected.size ? { type: 'multi', values: selected } : null);
    };

    const renderList = (filterText) => {
      list.innerHTML = '';
      const ft = (filterText || '').toLowerCase();
      const filteredValues = ft ? values.filter(v => v.toLowerCase().indexOf(ft) !== -1) : values;
      if(filteredValues.length === 0){
        const none = document.createElement('div');
        none.textContent = 'No values';
        none.style.cssText = 'color:#9ca3af;padding:4px 2px;';
        list.appendChild(none);
        return;
      }
      filteredValues.forEach(v => {
        const optRow = document.createElement('label');
        optRow.style.cssText = 'display:flex;align-items:center;gap:6px;padding:3px 2px;cursor:pointer;border-radius:4px;';
        optRow.addEventListener('mouseenter', () => optRow.style.background = '#f3f6fb');
        optRow.addEventListener('mouseleave', () => optRow.style.background = '');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = selected.has(v);
        cb.addEventListener('change', () => {
          if(cb.checked) selected.add(v); else selected.delete(v);
          commit();
        });
        const span = document.createElement('span');
        span.textContent = v;
        span.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
        optRow.appendChild(cb); optRow.appendChild(span);
        list.appendChild(optRow);
      });
    };
    renderList('');
    search.addEventListener('input', () => renderList(search.value));
    selectAllLink.addEventListener('click', e => {
      e.preventDefault();
      const ft = (search.value || '').toLowerCase();
      (ft ? values.filter(v => v.toLowerCase().indexOf(ft) !== -1) : values).forEach(v => selected.add(v));
      commit(); renderList(search.value);
    });
    clearLink.addEventListener('click', e => {
      e.preventDefault();
      selected.clear();
      commit(); renderList(search.value);
    });
  } else if(col.filterType === 'range' || col.filterType === 'daterange'){
    const isDate = col.filterType === 'daterange';
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-direction:column;gap:8px;';
    const mkField = (labelText, initial) => {
      const l = document.createElement('label');
      l.style.cssText = 'display:flex;flex-direction:column;gap:3px;font-size:11px;color:#374151;font-weight:600;';
      l.textContent = labelText;
      const inp = document.createElement('input');
      inp.type = isDate ? 'date' : 'number';
      if(!isDate) inp.step = '0.01';
      inp.value = initial || '';
      inp.style.cssText = 'padding:6px 8px;border:1px solid #e6e9ee;border-radius:6px;font-size:12px;';
      l.appendChild(inp);
      return { l, inp };
    };
    const minField = mkField(isDate ? 'From' : 'Min', existing ? existing.min : '');
    const maxField = mkField(isDate ? 'To' : 'Max', existing ? existing.max : '');
    wrap.appendChild(minField.l); wrap.appendChild(maxField.l);
    pop.appendChild(wrap);

    const commit = () => {
      const min = minField.inp.value, max = maxField.inp.value;
      setInvoiceTrackingFilter(col.key, (min || max) ? { type: col.filterType, min, max } : null);
    };
    minField.inp.addEventListener('change', commit);
    maxField.inp.addEventListener('change', commit);

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button'; clearBtn.textContent = 'Clear';
    clearBtn.style.cssText = 'margin-top:8px;padding:5px 10px;border:1px solid #d1d5db;background:#fff;border-radius:6px;font-size:12px;cursor:pointer;';
    clearBtn.addEventListener('click', () => setInvoiceTrackingFilter(col.key, null));
    pop.appendChild(clearBtn);
  } else if(col.filterType === 'text'){
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.placeholder = 'Contains…';
    inp.value = existing ? existing.value : '';
    inp.style.cssText = 'width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid #e6e9ee;border-radius:6px;font-size:12px;';
    pop.appendChild(inp);
    inp.addEventListener('input', () => {
      setInvoiceTrackingFilter(col.key, inp.value ? { type: 'text', value: inp.value } : null);
    });
  }

  document.body.appendChild(pop);
  repositionInvoiceTrackingFilterPopover(anchorTh);
}

if(!window.__itFilterOutsideClickWired){
  window.__itFilterOutsideClickWired = true;
  document.addEventListener('mousedown', (e) => {
    const pop = qs('#itFilterPopover');
    if(!pop) return;
    if(pop.contains(e.target)) return;
    if(e.target.closest && e.target.closest('.it-filter-btn')) return;
    closeInvoiceTrackingFilterPopover();
  });
}

function renderInvoiceTrackingTable(){
  const headerRow = qs('#invoiceTrackingHeaderRow');
  const filterRow = qs('#invoiceTrackingFilterRow');
  const tbody = qs('#invoiceTrackingTableBody');
  if(!headerRow || !filterRow || !tbody) return;

  const thStyle = 'text-align:left;padding:6px 8px;font-size:12px;font-weight:600;color:#374151;background:#f9fafb;border-bottom:1px solid #eef2f7;white-space:nowrap;';
  const filterCellStyle = 'text-align:left;padding:4px 6px;background:#fff;border-bottom:2px solid #eef2f7;';

  // Sticking the whole <thead> (both the label row and the filter-controls row below it) keeps
  // both visible while scrolling through the capped ~20-row window -- see updateInvoiceTrackingScrollHeight().
  const theadEl = headerRow.parentElement;
  if(theadEl) theadEl.style.cssText = 'position:sticky;top:0;z-index:5;';

  headerRow.innerHTML = '';
  const thCounter = document.createElement('th');
  thCounter.textContent = '#';
  thCounter.style.cssText = thStyle;
  headerRow.appendChild(thCounter);

  INVOICE_TRACKING_COLUMNS.forEach(col => {
    const th = document.createElement('th');
    th.textContent = col.label + (_invoiceTrackingSort.column === col.key ? (_invoiceTrackingSort.ascending ? ' ▲' : ' ▼') : '');
    th.style.cssText = thStyle + 'cursor:pointer;user-select:none;';
    th.title = 'Click to sort';
    th.addEventListener('click', () => {
      if(_invoiceTrackingSort.column === col.key) _invoiceTrackingSort.ascending = !_invoiceTrackingSort.ascending;
      else _invoiceTrackingSort = { column: col.key, ascending: true };
      renderInvoiceTrackingTable();
    });
    headerRow.appendChild(th);
  });
  const thActions = document.createElement('th');
  thActions.style.cssText = thStyle;
  headerRow.appendChild(thActions);

  // Always-visible filter controls, one per column, directly under its label -- this is the
  // actual filtering UI (a hidden per-header icon proved too easy to miss).
  filterRow.innerHTML = '';
  const filterCounterCell = document.createElement('th');
  filterCounterCell.style.cssText = filterCellStyle;
  filterRow.appendChild(filterCounterCell);

  INVOICE_TRACKING_COLUMNS.forEach(col => {
    const cell = document.createElement('th');
    cell.style.cssText = filterCellStyle;
    cell.dataset.colKey = col.key;

    if(col.filterType === 'multi'){
      const f = _invoiceTrackingFilters[col.key];
      const count = f ? f.values.size : 0;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'it-filter-btn';
      btn.textContent = count ? `${count} selected ▾` : 'All ▾';
      btn.title = 'Filter ' + col.label;
      btn.style.cssText = 'width:100%;max-width:140px;text-align:left;padding:4px 6px;border-radius:5px;font-size:11px;font-weight:600;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' + (count ? 'background:#e6f0fd;border:1px solid #0b74de;color:#0b74de;' : 'background:#fff;border:1px solid #d1d5db;color:#6b7280;');
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openInvoiceTrackingFilterPopover(col, btn);
      });
      cell.appendChild(btn);
    } else if(col.filterType === 'range' || col.filterType === 'daterange'){
      const isDate = col.filterType === 'daterange';
      const f = _invoiceTrackingFilters[col.key];
      const wrap = document.createElement('div');
      wrap.style.cssText = 'display:flex;gap:3px;';
      const mkInput = (placeholder, initial) => {
        const inp = document.createElement('input');
        inp.type = isDate ? 'date' : 'number';
        if(!isDate) inp.step = '0.01';
        inp.placeholder = placeholder;
        inp.value = initial || '';
        inp.style.cssText = 'width:' + (isDate ? '112px' : '58px') + ';box-sizing:border-box;padding:3px 4px;border:1px solid #d1d5db;border-radius:4px;font-size:11px;';
        return inp;
      };
      const minInp = mkInput(isDate ? 'From' : 'Min', f ? f.min : '');
      const maxInp = mkInput(isDate ? 'To' : 'Max', f ? f.max : '');
      const commit = () => {
        const min = minInp.value, max = maxInp.value;
        setInvoiceTrackingFilter(col.key, (min || max) ? { type: col.filterType, min, max } : null);
      };
      minInp.addEventListener('change', commit);
      maxInp.addEventListener('change', commit);
      wrap.appendChild(minInp); wrap.appendChild(maxInp);
      cell.appendChild(wrap);
    } else if(col.filterType === 'text'){
      const f = _invoiceTrackingFilters[col.key];
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.placeholder = 'Contains…';
      inp.value = f ? f.value : '';
      inp.style.cssText = 'width:100%;max-width:150px;box-sizing:border-box;padding:4px 6px;border:1px solid #d1d5db;border-radius:5px;font-size:11px;';
      // Live-as-you-type, but only re-renders the ROWS (not this filter row / its own input),
      // so typing never rebuilds -- and loses focus on -- the very input the operator is using.
      inp.addEventListener('input', () => {
        if(inp.value) _invoiceTrackingFilters[col.key] = { type: 'text', value: inp.value };
        else delete _invoiceTrackingFilters[col.key];
        renderInvoiceTrackingRows();
      });
      cell.appendChild(inp);
    }

    filterRow.appendChild(cell);
  });
  const filterActionsCell = document.createElement('th');
  filterActionsCell.style.cssText = filterCellStyle;
  filterRow.appendChild(filterActionsCell);

  renderInvoiceTrackingRows();
}

function renderInvoiceTrackingRows(){
  const tbody = qs('#invoiceTrackingTableBody');
  const headerRow = qs('#invoiceTrackingHeaderRow');
  if(!tbody) return;

  const totalCount = (state.invoiceTracking || []).length;
  const rows = (state.invoiceTracking || []).filter(invoiceTrackingRowPassesFilters);
  const sortCol = INVOICE_TRACKING_COLUMNS.find(c => c.key === _invoiceTrackingSort.column) || INVOICE_TRACKING_COLUMNS[0];
  const ascending = _invoiceTrackingSort.ascending;
  rows.sort((a, b) => {
    const av = (sortCol.get ? sortCol.get(a) : (a[sortCol.key] || '')).toString();
    const bv = (sortCol.get ? sortCol.get(b) : (b[sortCol.key] || '')).toString();
    let cmp;
    if(sortCol.numeric) cmp = (parseCurrency(av) || 0) - (parseCurrency(bv) || 0);
    else cmp = av.toLowerCase() < bv.toLowerCase() ? -1 : (av.toLowerCase() > bv.toLowerCase() ? 1 : 0);
    return ascending ? cmp : -cmp;
  });

  const hasActiveFilters = Object.keys(_invoiceTrackingFilters).length > 0;
  const summaryEl = qs('#itFilterSummary');
  const clearFiltersBtn = qs('#itClearFiltersBtn');
  if(summaryEl) summaryEl.textContent = hasActiveFilters ? `Showing ${rows.length} of ${totalCount}` : '';
  if(clearFiltersBtn) clearFiltersBtn.style.display = hasActiveFilters ? 'inline-block' : 'none';
  if(_invoiceTrackingOpenFilterCol && headerRow){
    const filterRow = qs('#invoiceTrackingFilterRow');
    const anchorCell = filterRow && filterRow.querySelector(`th[data-col-key="${_invoiceTrackingOpenFilterCol}"]`);
    const anchorEl = (anchorCell && anchorCell.querySelector('button,input')) || anchorCell;
    repositionInvoiceTrackingFilterPopover(anchorEl);
  }

  tbody.innerHTML = '';
  if(rows.length === 0){
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = INVOICE_TRACKING_COLUMNS.length + 2;
    td.className = 'small-muted';
    td.style.padding = '12px';
    td.textContent = hasActiveFilters ? 'No tracked invoices match the selected filters.' : 'No tracked invoices yet.';
    tr.appendChild(td);
    tbody.appendChild(tr);
    updateInvoiceTrackingScrollHeight();
    return;
  }

  const fmtShortDate = (s) => {
    if(!s) return '';
    const p = String(s).split('-');
    if(p.length < 3) return s;
    const d = new Date(parseInt(p[0]), parseInt(p[1]) - 1, parseInt(p[2]));
    return isNaN(d) ? s : d.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
  };
  // Description/Request can be several sentences long — a full-length cell would blow out
  // row height and column width across the whole table. Show a short preview for now; a
  // popup with the full text is planned as a follow-up.
  const PREVIEW_LEN = 40;
  const previewText = (s) => (s && s.length > PREVIEW_LEN) ? s.slice(0, PREVIEW_LEN).trim() + '…' : (s || '');

  rows.forEach((r, i) => {
    const tr = document.createElement('tr');
    tr.style.borderBottom = '1px solid #f0f0f0';
    tr.style.cursor = 'pointer';
    tr.style.transition = 'background-color 0.2s ease';

    tr.addEventListener('mouseenter', () => {
      if(tr.style.backgroundColor !== 'rgb(224, 242, 254)') tr.style.backgroundColor = '#f3f6fb';
    });
    tr.addEventListener('mouseleave', () => {
      if(tr.style.backgroundColor !== 'rgb(224, 242, 254)') tr.style.backgroundColor = '';
    });
    tr.addEventListener('click', () => {
      tbody.querySelectorAll('tr').forEach(row => { row.style.backgroundColor = ''; });
      tr.style.backgroundColor = '#e0f2fe';
    });

    const tdCounter = document.createElement('td'); tdCounter.textContent = i + 1; tdCounter.style.cssText = 'padding:6px 8px;color:#6b7280;';
    tr.appendChild(tdCounter);

    INVOICE_TRACKING_COLUMNS.forEach(col => {
      const td = document.createElement('td');
      td.style.cssText = 'padding:6px 8px;white-space:nowrap;';
      let val = col.get ? col.get(r) : (r[col.key] || '');
      if(col.key === 'invoiceAmount' || col.key === 'amountInDispute'){
        val = val ? formatCurrency(val) : '';
      } else if(col.key === 'amountDue'){
        val = formatCurrency(val || 0);
      } else if(col.key === 'fromDate' || col.key === 'toDate'){
        val = fmtShortDate(val);
      } else if(col.key === 'descriptionOfIssue' || col.key === 'request'){
        if(val) td.title = val;
        val = previewText(val);
      }
      td.textContent = val;
      tr.appendChild(td);
    });

    const tdActions = document.createElement('td');
    tdActions.style.cssText = 'padding:6px 8px;';
    const viewBtn = document.createElement('button');
    viewBtn.type = 'button';
    viewBtn.className = 'small-link';
    viewBtn.textContent = '🔍';
    viewBtn.title = 'View full detail';
    viewBtn.style.fontSize = '15px';
    viewBtn.addEventListener('click', () => {
      try{ openInvoiceTrackingDetailModal(r, rows); }catch(e){ console.error('Invoice Tracking detail open error:', e); }
    });
    tdActions.appendChild(viewBtn);
    tr.appendChild(tdActions);

    tbody.appendChild(tr);
  });

  updateInvoiceTrackingScrollHeight();
}

// Caps the Tracked Invoices table to ~20 visible data rows by setting the scroll wrapper's
// max-height to (sticky header + filter row + 20 * one data row's real rendered height) --
// with 20 or fewer rows the table is naturally shorter than that cap so no scrollbar/clipping
// ever appears; past 20 the wrapper scrolls (scrollbar hidden via the invisible-scroll CSS class,
// but wheel/trackpad/drag scrolling still works normally).
function updateInvoiceTrackingScrollHeight(){
  const wrap = qs('#itTableScrollWrap');
  const headerRow = qs('#invoiceTrackingHeaderRow');
  const filterRow = qs('#invoiceTrackingFilterRow');
  const tbody = qs('#invoiceTrackingTableBody');
  if(!wrap || !headerRow) return;
  const headerH = headerRow.getBoundingClientRect().height || 30;
  const filterH = filterRow ? (filterRow.getBoundingClientRect().height || 30) : 0;
  const firstRow = tbody && tbody.querySelector('tr');
  const rowH = firstRow ? (firstRow.getBoundingClientRect().height || 31) : 31;
  wrap.style.maxHeight = Math.round(headerH + filterH + rowH * INVOICE_TRACKING_VISIBLE_ROWS) + 'px';
}

// Downloads the Tracked Invoices table to Excel — same rows, same columns, in the same order
// and with the same value formatting as the on-screen table (INVOICE_TRACKING_COLUMNS), with one
// exception: Description of Issue/Request are NOT truncated here — the on-screen "…" preview is
// only a screen-space compromise (see PREVIEW_LEN above), not the actual information, and a
// downloadable report should carry the real thing. One Comments column is appended at the end,
// gathering this record's manually-entered binnacle comments — the free-text "Add comment"
// entries plus Completed-status completion notes — as "Comment 1: …\nComment 2: …\n…" in a
// single cell, oldest first (the order they were actually written in). Auto-generated change-log
// entries (Description/Request/Status edits, "Entry edited: …", "Data refreshed from source…")
// are deliberately excluded — those are a change history, not a comment; matches the same
// manual-vs-auto distinction the binnacle's own "hide auto" checkbox already uses.
function downloadInvoiceTrackingReport(){
  if(!(window.XLSX && typeof XLSX === 'object')){ alert('Excel export library not found. Please reload the page.'); return; }

  const rows = (state.invoiceTracking || []).slice();
  if(rows.length === 0){ alert('No tracked invoices to export yet.'); return; }

  // Same short-date formatting the on-screen table applies to From Date/To Date only — WD
  // Invoice Date and every other field are shown exactly as stored, same as the table.
  const fmtShortDate = (s) => {
    if(!s) return '';
    const p = String(s).split('-');
    if(p.length < 3) return s;
    const d = new Date(parseInt(p[0]), parseInt(p[1]) - 1, parseInt(p[2]));
    return isNaN(d) ? s : d.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
  };

  const manualCommentsText = (record) => {
    const log = Array.isArray(record.log) ? record.log : [];
    const manual = log.filter(entry => !(entry.type && entry.type.indexOf('auto') === 0));
    return manual.map((entry, idx) => `Comment ${idx + 1}: ${(entry.text || '').toString().trim()}`).join('\n');
  };

  const wb = XLSX.utils.book_new();
  wb.Props = {
    Title: 'Invoice Dispute Tracking Report',
    Subject: 'AGI Vehicle Lease Management — Invoice Dispute Tracking',
    Author: 'AGI Vehicle Lease Management', Company: 'AGI', CreatedDate: new Date()
  };

  // Same visual vocabulary as the Accruals Deliverable's styles above, kept local to this
  // function since the two exports don't otherwise share any data/state.
  const baseFont = { name: 'Calibri', sz: 11 };
  const styles = {
    header: {
      font: Object.assign({}, baseFont, { bold: true, color: { rgb: 'FFFFFF' } }),
      fill: { fgColor: { rgb: '0B74DE' } },
      alignment: { horizontal: 'center', vertical: 'center' },
      border: { left:{style:'thin',color:{rgb:'0B74DE'}}, right:{style:'thin',color:{rgb:'0B74DE'}}, top:{style:'thin',color:{rgb:'0B74DE'}}, bottom: { style: 'medium', color: { rgb: '0B74DE' } } }
    },
    title: { font: Object.assign({}, baseFont, { bold: true, sz: 16, color: { rgb: '0B74DE' } }), alignment: { horizontal: 'left', vertical: 'center' } },
    info: { alignment: { vertical: 'center', wrapText: true }, font: baseFont },
    zebra: { fill: { fgColor: { rgb: 'F8FAFC' } } },
    money: { alignment: { horizontal: 'right', vertical: 'center' }, font: baseFont, numFmt: '$#,##0.00' }
  };
  // Deep-merges object-valued style properties but directly overwrites primitive ones (numFmt is
  // a plain string) — same fix as downloadAccrualsDeliverable's mergeStyles, needed for the same
  // reason (a naive Object.assign(...) on a string corrupts numFmt and crashes the real writer).
  function mergeStyles(...objs){
    const out = {};
    objs.forEach(o => {
      if(!o) return;
      Object.keys(o).forEach(k => {
        const v = o[k];
        out[k] = (v && typeof v === 'object' && !Array.isArray(v)) ? Object.assign({}, out[k], v) : v;
      });
    });
    return out;
  }
  // aoa_to_sheet doesn't infer a cell's type (.t) from .v for the {v,s} object form — always
  // stamp it explicitly, same as downloadAccrualsDeliverable's cell().
  function cell(v, s){ return { v, t: (typeof v === 'number') ? 'n' : 's', s }; }

  const headers = INVOICE_TRACKING_COLUMNS.map(c => c.label).concat(['Comments']);
  const totalCols = headers.length;
  const titleText = `Invoice Dispute Tracking Report — ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`;

  const aoa = [
    [cell(titleText, styles.title)].concat(Array.from({ length: totalCols - 1 }, () => cell('', styles.title))),
    headers.map(h => cell(h, styles.header))
  ];

  rows.forEach((r, idx) => {
    const zebra = (idx % 2 === 1) ? styles.zebra : null;
    const rowCells = INVOICE_TRACKING_COLUMNS.map(col => {
      let val = col.get ? col.get(r) : (r[col.key] || '');
      if(col.key === 'invoiceAmount' || col.key === 'amountInDispute' || col.key === 'amountDue'){
        return cell(parseCurrency(val) || 0, mergeStyles(styles.money, zebra));
      }
      if(col.key === 'fromDate' || col.key === 'toDate') val = fmtShortDate(val);
      return cell(val || '', mergeStyles(styles.info, zebra));
    });
    rowCells.push(cell(manualCommentsText(r), mergeStyles(styles.info, zebra)));
    aoa.push(rowCells);
  });

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const range = XLSX.utils.encode_range({ s: { r: 1, c: 0 }, e: { r: 1 + rows.length, c: totalCols - 1 } });
  ws['!autofilter'] = { ref: range };
  ws['!freeze'] = { xSplit: 0, ySplit: 2, topLeftCell: 'A3', activePane: 'bottomLeft' };
  ws['!cols'] = INVOICE_TRACKING_COLUMNS.map(col => ({ wch: (col.key === 'descriptionOfIssue' || col.key === 'request') ? 30 : 16 })).concat([{ wch: 60 }]);
  ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: totalCols - 1 } }];

  XLSX.utils.book_append_sheet(wb, ws, 'Invoice Tracking');

  const fname = `Invoice_Dispute_Tracking_Report_${new Date().toISOString().slice(0, 10)}.xlsx`;
  try{ XLSX.writeFile(wb, fname); }catch(e){ alert('Failed to save Excel: ' + (e && e.message || e)); }
}
const itDownloadReportBtnEl = qs('#itDownloadReportBtn');
if(itDownloadReportBtnEl) itDownloadReportBtnEl.addEventListener('click', downloadInvoiceTrackingReport);
const itClearFiltersBtnEl = qs('#itClearFiltersBtn');
if(itClearFiltersBtnEl) itClearFiltersBtnEl.addEventListener('click', () => {
  _invoiceTrackingFilters = {};
  closeInvoiceTrackingFilterPopover();
  renderInvoiceTrackingTable();
});
const itRefreshAllBtnEl = qs('#itRefreshAllBtn');
if(itRefreshAllBtnEl) itRefreshAllBtnEl.addEventListener('click', refreshAllInvoiceTrackingRecords);

const invoiceTrackingForm = qs('#invoiceTrackingForm');
if(invoiceTrackingForm){
  invoiceTrackingForm.addEventListener('submit', (e) => {
    e.preventDefault();

    // Defense-in-depth: the lookup already blocks a WD number that's already tracked elsewhere
    // (see findExistingInvoiceTrackingForWd), but re-check here too in case the field changed
    // without a fresh lookup running.
    const submitEditingId = invoiceTrackingForm.dataset.editingId || null;
    const wdVal = ((qs('#itWdInvoiceNum') || {}).value || '').trim();
    const dupTracking = findExistingInvoiceTrackingForWd(wdVal, submitEditingId);
    if(dupTracking){
      alert('This WD Invoice Number is already tracked as a dispute. Edit that existing entry to add more disputed units instead of creating a new one.');
      return;
    }

    // The invoice must already be posted (matched via WD Invoice Num lookup) and at least
    // one of its units must be checked as disputed — there's nothing left to type by hand.
    if(!_itMatchedRegistry){
      alert('This WD Invoice Number must already be posted in the system (Invoices tab) before it can be tracked as a dispute.');
      return;
    }
    const checkedUnits = getInvoiceTrackingCheckedUnits();
    if(checkedUnits.length === 0){
      alert('Check at least one unit above to mark it as disputed.');
      return;
    }

    const registryLeases = Array.isArray(_itMatchedRegistry.leases) && _itMatchedRegistry.leases.length
      ? _itMatchedRegistry.leases
      : ((_itMatchedRegistry.lease || '').toString().split(',').map(s => s.trim()).filter(Boolean));

    const toMoney = (elId) => { const n = parseCurrency(qs('#'+elId) ? qs('#'+elId).value : ''); return n === null ? '' : n.toFixed(2); };
    const wrap = qs('#itUnitAmountBreakdown');
    const rowForUnit = (uid) => wrap ? Array.from(wrap.querySelectorAll('.unit-breakdown-row')).find(r => r.dataset.unitId === uid) : null;

    const editingId = invoiceTrackingForm.dataset.editingId || null;
    const existingRecord = editingId ? (state.invoiceTracking || []).find(r => r.id === editingId) : null;

    const fields = {
      supplier: (qs('#itSupplier') || {}).value || '',
      lease: registryLeases,
      unitsInDispute: checkedUnits,
      supplierInvoiceDoc: (qs('#itSupplierInvoiceDoc') || {}).value || '',
      invoiceAmount: toMoney('itInvoiceAmount'),
      amountInDispute: toMoney('itAmountInDispute'),
      amountDue: toMoney('itAmountDue'),
      wdInvoiceNum: ((qs('#itWdInvoiceNum') || {}).value || '').trim(),
      wdInvoiceDate: (qs('#itWdInvoiceDate') || {}).value || '',
      invoiceStatus: (qs('#itInvoiceStatus') || {}).value || '',
      paymentStatus: (qs('#itPaymentStatus') || {}).value || '',
      fromDate: (qs('#itFromDate') || {}).value || '',
      toDate: (qs('#itToDate') || {}).value || '',
      costCenter: getInvoiceTrackingCostCenterSummary(),
      descriptionOfIssue: ((qs('#itDescriptionOfIssue') || {}).value || '').trim(),
      request: ((qs('#itRequest') || {}).value || '').trim(),
      status: ((qs('#itStatus') || {}).value || '').trim(),
      unitAmountDetails: checkedUnits.map(uid => {
        const row = rowForUnit(uid);
        // Each subcharge's `disputed` flag (and the legacy lump's `otherSelected`) is captured
        // from the actual checkbox state right now — see renderInvoiceTrackingUnitBreakdown's
        // row._subcharges — not re-parsed from the original registry snapshot, which never had
        // that flag at all. Persisting it here is what lets startEditingInvoiceTrackingRecord
        // restore exactly which charges were chosen the next time this entry is edited, and what
        // lets refreshInvoiceTrackingRecordFromSource carry the same choices across a refresh.
        const subEntries = row && Array.isArray(row._subcharges) ? row._subcharges : [];
        const otherChargeDetails = subEntries.filter(s => !s.isLegacyOther)
          .map(s => ({ name: s.name, amount: s.amount, tax: s.tax, disputed: !!(s.checkbox && s.checkbox.checked) }));
        const legacyEntry = subEntries.find(s => s.isLegacyOther);
        const otherSelected = !!(legacyEntry && legacyEntry.checkbox && legacyEntry.checkbox.checked);
        return {
          unit: uid,
          tax: row ? row.dataset.tax : '',
          other: row ? row.dataset.other : '',
          otherChargeDetails,
          otherSelected,
          charge: row ? row.dataset.charge : '',
          // Each period this unit is actually invoiced for on this registry — needed so a later
          // Refresh Data can re-prorate against the SAME set of periods, not just a single
          // summed charge/tax that would lose which specific months it came from.
          chargePeriods: row && Array.isArray(row._chargePeriods) ? row._chargePeriods : []
        };
      })
    };

    state.invoiceTracking = state.invoiceTracking || [];
    if(existingRecord){
      // Editing: keep the same id and its existing binnacle log, just update the fields —
      // and log a summary of what changed so the binnacle reflects edits made here too.
      const changes = describeInvoiceTrackingFieldChanges(existingRecord, fields);
      Object.assign(existingRecord, fields);
      if(changes.length > 0){
        addInvoiceTrackingLogEntry(existingRecord, 'Entry edited:\n' + changes.join('\n'), 'auto-edit');
      }
      DB.updateInvoiceTracking(existingRecord).catch(e => console.error('Invoice Tracking update error:', e));
    } else {
      const record = Object.assign({ id: id() }, fields);
      state.invoiceTracking.push(record);
      DB.saveInvoiceTracking(record).catch(e => console.error('Invoice Tracking save error:', e));
    }

    renderInvoiceTrackingTable();
    if(typeof renderRegistries === 'function') renderRegistries();

    resetInvoiceTrackingFormToAddMode();
  });
}

// Clears the Add/Edit form back to its default "Add Entry" state — used both after a
// successful save and when an in-progress edit is cancelled via the Cancel button.
function resetInvoiceTrackingFormToAddMode(){
  const form = qs('#invoiceTrackingForm'); if(!form) return;
  form.reset();
  delete form.dataset.editingId;
  const submitBtn = form.querySelector('button[type="submit"]'); if(submitBtn) submitBtn.textContent = 'Add Entry';
  const cancelBtn = qs('#itCancelEditBtn'); if(cancelBtn) cancelBtn.style.display = 'none';
  _itMatchedRegistry = null;
  renderInvoiceTrackingUnitBreakdown();
  const wdDateField = qs('#itWdInvoiceDate'); if(wdDateField) wdDateField.value = '';
  const leaseField = qs('#itLeaseSummary'); if(leaseField) leaseField.value = '';
  const noteEl = qs('#itWdLookupNote'); if(noteEl) noteEl.textContent = '';
}

const itCancelEditBtn = qs('#itCancelEditBtn');
if(itCancelEditBtn){
  itCancelEditBtn.addEventListener('click', () => {
    resetInvoiceTrackingFormToAddMode();
  });
}

// Always-visible "Clear" button — wipes whatever's currently entered in the Add/Edit form,
// whether or not an edit is in progress (Cancel above only shows during an edit).
const itClearBtn = qs('#itClearBtn');
if(itClearBtn){
  itClearBtn.addEventListener('click', () => {
    resetInvoiceTrackingFormToAddMode();
  });
}

// ========== Invoice Tracking detail popup (view / binnacle / edit / delete) ==========
let _itDetailList = [];
let _itDetailIndex = 0;
// Description/Request/Status edits are staged here and only committed (persisted + logged)
// when Save is clicked — Cancel discards them and reverts the fields to the record's values.
let _itDetailDirty = false;
let _itDetailPendingCompletionNote = null;

function markItDetailDirty(){
  _itDetailDirty = true;
  updateItDetailSaveCancelUI();
}

function updateItDetailSaveCancelUI(){
  const saveBtn = qs('#itDetailSaveBtn');
  const cancelBtn = qs('#itDetailCancelBtn');
  [saveBtn, cancelBtn].forEach(btn => {
    if(!btn) return;
    btn.disabled = !_itDetailDirty;
    btn.style.opacity = _itDetailDirty ? '1' : '0.5';
    btn.style.cursor = _itDetailDirty ? 'pointer' : 'not-allowed';
  });
}

function confirmDiscardIfDirty(){
  if(!_itDetailDirty) return true;
  return confirm('You have unsaved changes to this entry. Discard them?');
}

function getCurrentUserDisplayName(){
  const session = currentSession();
  if(!session) return 'Unknown User';
  if(session.user === 'Master') return 'Master';
  const u = (state.users || []).find(x => x.username === session.user);
  if(u){
    const name = ((u.firstName || '') + ' ' + (u.lastName || '')).trim();
    return name || u.username || 'Unknown User';
  }
  return session.user || 'Unknown User';
}

function getCurrentUserRole(){
  const session = currentSession();
  if(!session) return null;
  if(session.user === 'Master') return 'Master';
  const u = (state.users || []).find(x => x.username === session.user);
  return u ? (u.role || null) : null;
}

// Binnacle edit/delete is restricted to these two account levels only.
function isFullAccessRole(){
  const role = getCurrentUserRole();
  return role === 'Master' || role === 'Developer';
}

// Escapes text for safe HTML insertion, then turns any http(s) URL into a link that opens in a
// new tab — so a pasted link in a binnacle entry stays clickable rather than just sitting as
// plain, unusable text.
function linkifyText(text){
  const escaped = escapeHtml(text || '');
  return escaped.replace(/(https?:\/\/[^\s<]+)/g, (m) => {
    const trailing = m.match(/[.,;:!?)\]]+$/);
    const core = trailing ? m.slice(0, -trailing[0].length) : m;
    const suffix = trailing ? trailing[0] : '';
    return `<a href="${core}" target="_blank" rel="noopener noreferrer">${core}</a>${suffix}`;
  });
}

// Compares an existing record's operator-facing fields against the values about to be saved
// from the Edit form, so an edit made there can be auto-logged to the binnacle the same way
// the detail popup already logs its own Description/Request/Status edits.
const INVOICE_TRACKING_CHANGE_LABELS = {
  wdInvoiceNum: 'WD Invoice Num',
  unitsInDispute: 'Units in Dispute',
  amountInDispute: 'Amount in Dispute',
  amountDue: 'Amount Due',
  invoiceStatus: 'Invoice Status',
  paymentStatus: 'Payment Status',
  descriptionOfIssue: 'Description of Issue',
  request: 'Request',
  status: 'Status'
};
function describeInvoiceTrackingFieldChanges(oldRecord, newFields){
  const changes = [];
  Object.keys(INVOICE_TRACKING_CHANGE_LABELS).forEach(key => {
    const oldVal = Array.isArray(oldRecord[key]) ? oldRecord[key].join(', ') : (oldRecord[key] || '');
    const newVal = Array.isArray(newFields[key]) ? newFields[key].join(', ') : (newFields[key] || '');
    if(oldVal !== newVal){
      changes.push(INVOICE_TRACKING_CHANGE_LABELS[key] + ': "' + (oldVal || '(empty)') + '" → "' + (newVal || '(empty)') + '"');
    }
  });
  return changes;
}

function addInvoiceTrackingLogEntry(record, text, type){
  record.log = Array.isArray(record.log) ? record.log : [];
  record.log.push({ text, user: getCurrentUserDisplayName(), timestamp: new Date().toISOString(), type: type || 'manual' });
}

function saveInvoiceTrackingRecord(record){
  DB.updateInvoiceTracking(record).catch(e => console.error('Invoice Tracking update error:', e));
  renderInvoiceTrackingTable();
  if(typeof renderRegistries === 'function') renderRegistries();
}

// `list` is whatever's currently rendered in the table (already reflecting sort/search) so
// Prev/Next only ever moves within that same visible set — once filters exist, this keeps
// working unchanged since it just walks whatever list was passed in.
function openInvoiceTrackingDetailModal(record, list){
  _itDetailList = Array.isArray(list) ? list.slice() : (state.invoiceTracking || []).slice();
  _itDetailIndex = _itDetailList.indexOf(record);
  if(_itDetailIndex === -1) _itDetailIndex = 0;
  renderInvoiceTrackingDetailModal(_itDetailList[_itDetailIndex] || record);
  const modal = qs('#invoiceTrackingDetailModal');
  if(modal) modal.style.display = 'flex';
}

function closeInvoiceTrackingDetailModal(){
  if(!confirmDiscardIfDirty()) return false;
  const modal = qs('#invoiceTrackingDetailModal');
  if(modal) modal.style.display = 'none';
  const menuPanel = qs('#itDetailMenuPanel');
  if(menuPanel) menuPanel.style.display = 'none';
  _itDetailDirty = false;
  _itDetailPendingCompletionNote = null;
  return true;
}

// Renders a record's binnacle into any container (the small inline list, or the bigger
// full-window list) — `hideAuto` filters out auto-* entries so operators can clean the view
// down to manual/completion entries without those being permanently removed.
function renderInvoiceTrackingLogListInto(record, listEl, hideAuto){
  if(!listEl) return;
  const canManage = isFullAccessRole();
  let indexed = (Array.isArray(record.log) ? record.log : []).map((entry, idx) => ({ entry, idx }));
  if(hideAuto) indexed = indexed.filter(({ entry }) => !(entry.type && entry.type.indexOf('auto') === 0));
  indexed = indexed.reverse();
  if(indexed.length === 0){
    listEl.innerHTML = '<div class="small-muted">No entries yet.</div>';
    return;
  }
  listEl.innerHTML = indexed.map(({ entry, idx }) => {
    const when = entry.timestamp ? new Date(entry.timestamp).toLocaleString() : '';
    const badge = entry.type === 'completion'
      ? '<span style="font-size:10px;font-weight:700;background:#dcfce7;color:#15803d;padding:2px 8px;border-radius:10px;margin-left:6px;">COMPLETION</span>'
      : (entry.type && entry.type.indexOf('auto') === 0 ? '<span style="font-size:10px;font-weight:700;background:#e0e7ff;color:#4338ca;padding:2px 8px;border-radius:10px;margin-left:6px;">AUTO</span>' : '');
    const editedNote = entry.editedAt ? ' <span style="font-style:italic;">(edited)</span>' : '';
    const actionsHtml = canManage ? `
        <div style="display:flex;gap:6px;margin-top:6px;">
          <button type="button" class="it-log-edit-btn" data-log-idx="${idx}" style="font-size:11px;padding:2px 8px;">Edit</button>
          <button type="button" class="it-log-delete-btn" data-log-idx="${idx}" style="font-size:11px;padding:2px 8px;color:#dc2626;">Delete</button>
        </div>` : '';
    return `
      <div style="background:#f9fafb;border:1px solid #eef0f3;border-radius:6px;padding:8px 10px;margin-bottom:6px;">
        <div style="font-size:11px;color:#6b7280;margin-bottom:4px;">${escapeHtml(entry.user || '')} · ${escapeHtml(when)}${editedNote}${badge}</div>
        <div style="font-size:13px;white-space:pre-wrap;word-break:break-word;">${linkifyText(entry.text || '')}</div>
        ${actionsHtml}
      </div>
    `;
  }).join('');

  if(!canManage) return;
  listEl.querySelectorAll('.it-log-edit-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.logIdx, 10);
      const rec = _itDetailList[_itDetailIndex]; if(!rec || !Array.isArray(rec.log)) return;
      const entry = rec.log[idx]; if(!entry) return;
      const newText = window.prompt('Edit binnacle entry:', entry.text || '');
      if(newText === null) return;
      const trimmed = newText.trim();
      if(!trimmed || trimmed === entry.text) return;
      entry.text = trimmed;
      entry.editedBy = getCurrentUserDisplayName();
      entry.editedAt = new Date().toISOString();
      saveInvoiceTrackingRecord(rec);
      renderInvoiceTrackingLogList(rec);
    });
  });
  listEl.querySelectorAll('.it-log-delete-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.logIdx, 10);
      const rec = _itDetailList[_itDetailIndex]; if(!rec || !Array.isArray(rec.log)) return;
      if(!confirm('Delete this binnacle entry? This cannot be undone.')) return;
      rec.log.splice(idx, 1);
      saveInvoiceTrackingRecord(rec);
      renderInvoiceTrackingLogList(rec);
    });
  });
}

// Keeps the small inline binnacle in sync, plus the bigger full-window list if it's currently
// open (respecting whatever "Hide auto entries" state that window is in).
function renderInvoiceTrackingLogList(record){
  renderInvoiceTrackingLogListInto(record, qs('#itDetailLogList'), false);
  const fullModal = qs('#itBinnacleFullModal');
  if(fullModal && fullModal.style.display !== 'none'){
    const hideAutoCb = qs('#itBinnacleHideAutoCheckbox');
    renderInvoiceTrackingLogListInto(record, qs('#itBinnacleFullList'), hideAutoCb ? hideAutoCb.checked : false);
  }
}

function openBinnacleFullModal(record){
  const modal = qs('#itBinnacleFullModal'); if(!modal) return;
  const wdLabel = qs('#itBinnacleFullWd'); if(wdLabel) wdLabel.textContent = record.wdInvoiceNum || '';
  const hideAutoCb = qs('#itBinnacleHideAutoCheckbox');
  renderInvoiceTrackingLogListInto(record, qs('#itBinnacleFullList'), hideAutoCb ? hideAutoCb.checked : false);
  modal.style.display = 'flex';
}

function closeBinnacleFullModal(){
  const modal = qs('#itBinnacleFullModal'); if(modal) modal.style.display = 'none';
}

const itBinnacleExpandBtn = qs('#itBinnacleExpandBtn');
if(itBinnacleExpandBtn){
  itBinnacleExpandBtn.addEventListener('click', () => {
    const record = _itDetailList[_itDetailIndex]; if(!record) return;
    openBinnacleFullModal(record);
  });
}

const itBinnacleFullCloseBtn = qs('#itBinnacleFullCloseBtn');
if(itBinnacleFullCloseBtn) itBinnacleFullCloseBtn.addEventListener('click', closeBinnacleFullModal);

const itBinnacleFullModalEl = qs('#itBinnacleFullModal');
if(itBinnacleFullModalEl){
  const itBinnacleFullBackdrop = itBinnacleFullModalEl.querySelector('.modal-backdrop');
  if(itBinnacleFullBackdrop) itBinnacleFullBackdrop.addEventListener('click', closeBinnacleFullModal);
}

const itBinnacleHideAutoCheckbox = qs('#itBinnacleHideAutoCheckbox');
if(itBinnacleHideAutoCheckbox){
  itBinnacleHideAutoCheckbox.addEventListener('change', () => {
    const record = _itDetailList[_itDetailIndex]; if(!record) return;
    renderInvoiceTrackingLogListInto(record, qs('#itBinnacleFullList'), itBinnacleHideAutoCheckbox.checked);
  });
}

// Every unit actually on the matched registry/invoice — not just the disputed subset — for the
// Dispute Detail popup's "see everything this invoice covers" view (quarterly-aware, mirrors the
// same Period-1 + later-sub-period merge renderInvoiceTrackingUnitBreakdown already does). A
// disputed unit shows its SAVED snapshot (record.unitAmountDetails, exactly what actually drove
// Amount in Dispute) rather than live registry data, so what's displayed always matches what was
// actually disputed even if the source invoice was corrected since; every other unit on the
// invoice (never disputed) shows live registry data instead, since no snapshot exists for it.
// A disputed unit no longer present on the live registry (e.g. removed from the invoice since)
// still shows up, from its saved snapshot alone — it's still part of this record.
function getInvoiceTrackingFullUnitList(record){
  const disputedSet = new Set((record.unitsInDispute || []).map(u => (u || '').toString().trim().toLowerCase()));
  const savedByUnit = new Map((Array.isArray(record.unitAmountDetails) ? record.unitAmountDetails : []).map(d => [(d.unit || '').toString().trim().toLowerCase(), d]));

  const reg = (state.registries || []).find(r => (r.wdNumber || '').toString().trim().toLowerCase() === (record.wdInvoiceNum || '').toString().trim().toLowerCase());
  if(!reg){
    // No live registry to expand from (e.g. deleted since) -- fall back to just the disputed
    // snapshot, same as this view showed before this feature existed.
    return (Array.isArray(record.unitAmountDetails) ? record.unitAmountDetails : []).map(d => Object.assign({}, d, { isDisputed: true }));
  }

  const liveDetails = getRegistryUnitDetailsWithSlice(reg);

  const merged = liveDetails.map(d => {
    const key = (d.unit || '').toString().trim().toLowerCase();
    const isDisputed = disputedSet.has(key);
    const source = (isDisputed && savedByUnit.has(key)) ? savedByUnit.get(key) : d;
    return Object.assign({}, source, { unit: d.unit, isDisputed });
  });

  const seenAfterLive = new Set(liveDetails.map(d => (d.unit || '').toString().trim().toLowerCase()));
  (Array.isArray(record.unitAmountDetails) ? record.unitAmountDetails : []).forEach(d => {
    const key = (d.unit || '').toString().trim().toLowerCase();
    if(!key || seenAfterLive.has(key)) return;
    merged.push(Object.assign({}, d, { isDisputed: true }));
  });

  return merged;
}

function renderInvoiceTrackingDetailModal(record){
  if(!record) return;

  const navLabel = qs('#itDetailNavLabel');
  if(navLabel) navLabel.textContent = `${_itDetailIndex + 1} / ${_itDetailList.length}`;
  const prevBtn = qs('#itDetailPrevBtn');
  const nextBtn = qs('#itDetailNextBtn');
  if(prevBtn) prevBtn.style.opacity = _itDetailIndex === 0 ? '0.3' : '1';
  if(nextBtn) nextBtn.style.opacity = _itDetailIndex === _itDetailList.length - 1 ? '0.3' : '1';

  const infoGrid = qs('#itDetailInfoGrid');
  if(infoGrid){
    const fields = [
      ['Supplier', record.supplier || '—'],
      ['Lease(s)', Array.isArray(record.lease) ? record.lease.join(', ') : (record.lease || '—')],
      ['WD Invoice Num', record.wdInvoiceNum || '—'],
      ['WD Invoice Date', formatDate(record.wdInvoiceDate) || '—'],
      ['Supplier Invoice Doc', record.supplierInvoiceDoc || '—'],
      ['Invoice Amount', record.invoiceAmount ? formatCurrency(record.invoiceAmount) : '—'],
      ['Amount in Dispute', record.amountInDispute ? formatCurrency(record.amountInDispute) : '—'],
      ['Amount Due', formatCurrency(record.amountDue || 0)],
      ['Invoice Status', record.invoiceStatus || '—'],
      ['Payment Status', record.paymentStatus || '—'],
      ['From Date', formatDate(record.fromDate) || '—'],
      ['To Date', formatDate(record.toDate) || '—'],
      ['Cost Center', record.costCenter || '—']
    ];
    infoGrid.innerHTML = fields.map(([label, val]) => `
      <div style="flex:1 1 160px;min-width:140px;">
        <div style="font-size:10px;font-weight:700;color:#6b7280;letter-spacing:0.5px;text-transform:uppercase;">${escapeHtml(label)}</div>
        <div style="font-size:13px;font-weight:600;color:#111827;">${escapeHtml(val)}</div>
      </div>
    `).join('');
  }

  const unitTableEl = qs('#itDetailUnitTable');
  if(unitTableEl){
    const details = getInvoiceTrackingFullUnitList(record);
    if(details.length === 0){
      unitTableEl.innerHTML = '<div class="small-muted">No unit detail recorded.</div>';
    } else {
      // Shows EVERY unit actually on this invoice, not just the disputed ones, so the operator
      // can see the full picture of what the invoice covers. Only a DISPUTED row (d.isDisputed)
      // gets the plain yellow outline — just marking "this is the unit chosen from the invoice",
      // nothing more; there's no unified/structured dispute reason field to compare it against,
      // so the outline never tries to signal a reason. The RED background is separate and
      // unrelated, and applies to ANY row (disputed or not): it flags whether the unit was
      // actually Disabled at/after the invoice's own From Date (the Disabled/Returned dates below
      // the UnitId make the same case) — including units that maybe SHOULD have been disputed
      // but weren't selected.
      const rowsHtml = details.map(d => {
        const total = (parseCurrency(d.tax || '') || 0) + (parseCurrency(d.other || '') || 0) + (parseCurrency(d.charge || '') || 0);
        const unitRec = (state.units || []).find(u => (u.unitId || u.id || '').toString().trim().toLowerCase() === (d.unit || '').toString().trim().toLowerCase());
        const disputeFlag = unitRec ? computeUnitReturnDisputeFlag(unitRec, record.fromDate) : { flagged: false };
        const outlineColor = '#eab308';
        const bgStyle = disputeFlag.flagged ? 'background:#fee2e2;' : '';
        const returnText = disputeFlag.flagged
          ? (disputeFlag.stillDisabled
              ? `Disabled: ${formatDate(disputeFlag.disabledFrom) || disputeFlag.disabledFrom} (not yet returned)`
              : `Disabled: ${formatDate(disputeFlag.disabledFrom) || disputeFlag.disabledFrom} — Returned: ${formatDate(disputeFlag.returnedDate) || disputeFlag.returnedDate}`)
          : '';
        const returnNote = returnText ? `<div style="font-size:10px;font-weight:600;color:#b91c1c;white-space:nowrap;">${escapeHtml(returnText)}</div>` : '';
        const tdBorder = (edge) => d.isDisputed
          ? (`border-top:2px solid ${outlineColor};border-bottom:2px solid ${outlineColor};` + (edge === 'first' ? `border-left:2px solid ${outlineColor};` : (edge === 'last' ? `border-right:2px solid ${outlineColor};` : '')))
          : '';
        const subcharges = Array.isArray(d.otherChargeDetails) ? d.otherChargeDetails.filter(s => s && (s.name || parseCurrency(s.amount||'') || parseCurrency(s.tax||''))) : [];
        const subchargesHtml = subcharges.length ? `<tr><td colspan="5" style="padding:0 8px 4px 24px;${tdBorder('last')}">` +
          subcharges.map(s => {
            const subTotal = (parseCurrency(s.amount || '') || 0) + (parseCurrency(s.tax || '') || 0);
            const descNote = s.description ? ` <span style="font-style:italic;">— ${escapeHtml(s.description)}</span>` : '';
            return `<div style="font-size:11px;color:#6b7280;">↳ ${escapeHtml(s.name || '(unnamed)')}: ${formatCurrency(subTotal.toFixed(2))}${descNote}</div>`;
          }).join('') + `</td></tr>` : '';
        return `<tr style="${bgStyle}">
          <td style="padding:4px 8px;${tdBorder('first')}">${escapeHtml(d.unit || '')}${returnNote}</td>
          <td style="padding:4px 8px;${tdBorder()}">${d.tax ? formatCurrency(d.tax) : ''}</td>
          <td style="padding:4px 8px;${tdBorder()}">${d.other ? formatCurrency(d.other) : ''}</td>
          <td style="padding:4px 8px;${tdBorder()}">${d.charge ? formatCurrency(d.charge) : ''}</td>
          <td style="padding:4px 8px;font-weight:600;${tdBorder('last')}">${total ? formatCurrency(total.toFixed(2)) : ''}</td>
        </tr>${subchargesHtml}`;
      }).join('');
      unitTableEl.innerHTML = `
        <div style="font-size:11px;font-weight:700;color:#6b7280;text-transform:uppercase;margin-bottom:4px;">All Units on This Invoice</div>
        <div style="font-size:10px;color:#6b7280;margin-bottom:4px;">
          <span style="display:inline-block;width:10px;height:10px;border:2px solid #eab308;margin-right:4px;vertical-align:middle;"></span>Unit selected for this dispute
          &nbsp;&nbsp;<span style="display:inline-block;width:10px;height:10px;background:#fee2e2;margin-right:4px;vertical-align:middle;"></span>Unit was Disabled at/after the invoice's From Date
        </div>
        <table style="width:100%;border-collapse:collapse;font-size:12px;">
          <thead><tr style="border-bottom:2px solid #e6e9ee;">
            <th style="text-align:left;padding:4px 8px;">UnitId</th>
            <th style="text-align:left;padding:4px 8px;">Tax</th>
            <th style="text-align:left;padding:4px 8px;">Other Charges</th>
            <th style="text-align:left;padding:4px 8px;">Amount</th>
            <th style="text-align:left;padding:4px 8px;">Total Charge</th>
          </tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      `;
    }
  }

  const descField = qs('#itDetailDescriptionOfIssue'); if(descField) descField.value = record.descriptionOfIssue || '';
  const reqField = qs('#itDetailRequest'); if(reqField) reqField.value = record.request || '';
  const statusField = qs('#itDetailStatus');
  if(statusField){
    statusField.value = record.status || '';
    statusField.dataset.lastValue = record.status || '';
  }

  _itDetailDirty = false;
  _itDetailPendingCompletionNote = null;
  updateItDetailSaveCancelUI();

  renderInvoiceTrackingLogList(record);
}

const itDetailDescriptionOfIssueEl = qs('#itDetailDescriptionOfIssue');
if(itDetailDescriptionOfIssueEl){
  itDetailDescriptionOfIssueEl.addEventListener('input', () => {
    const record = _itDetailList[_itDetailIndex]; if(!record) return;
    if(itDetailDescriptionOfIssueEl.value === (record.descriptionOfIssue || '')) return;
    markItDetailDirty();
  });
}

const itDetailRequestEl = qs('#itDetailRequest');
if(itDetailRequestEl){
  itDetailRequestEl.addEventListener('input', () => {
    const record = _itDetailList[_itDetailIndex]; if(!record) return;
    if(itDetailRequestEl.value === (record.request || '')) return;
    markItDetailDirty();
  });
}

const itDetailStatusEl = qs('#itDetailStatus');
if(itDetailStatusEl){
  itDetailStatusEl.addEventListener('change', () => {
    const record = _itDetailList[_itDetailIndex]; if(!record) return;
    const newVal = itDetailStatusEl.value;
    const displayedBefore = itDetailStatusEl.dataset.lastValue || record.status || '';
    if(newVal === displayedBefore) return;
    if(newVal === 'Completed' && record.status !== 'Completed'){
      // Marking a dispute Completed is only allowed alongside a note explaining why —
      // cancelling or leaving it blank reverts the dropdown instead of staging the change.
      const note = window.prompt('Add a completion note (required to mark this entry as Completed):');
      if(!note || !note.trim()){
        itDetailStatusEl.value = displayedBefore;
        return;
      }
      _itDetailPendingCompletionNote = note.trim();
    } else if(newVal !== 'Completed'){
      _itDetailPendingCompletionNote = null;
    }
    itDetailStatusEl.dataset.lastValue = newVal;
    markItDetailDirty();
  });
}

const itDetailSaveBtn = qs('#itDetailSaveBtn');
if(itDetailSaveBtn){
  itDetailSaveBtn.addEventListener('click', () => {
    const record = _itDetailList[_itDetailIndex]; if(!record) return;
    if(itDetailDescriptionOfIssueEl){
      const newVal = itDetailDescriptionOfIssueEl.value.trim();
      const oldVal = record.descriptionOfIssue || '';
      if(newVal !== oldVal){
        record.descriptionOfIssue = newVal;
        addInvoiceTrackingLogEntry(record, 'Description of Issue updated' + (oldVal ? ' (was: "' + oldVal + '")' : '') + ' → "' + (newVal || '(cleared)') + '"', 'auto-description');
      }
    }
    if(itDetailRequestEl){
      const newVal = itDetailRequestEl.value.trim();
      const oldVal = record.request || '';
      if(newVal !== oldVal){
        record.request = newVal;
        addInvoiceTrackingLogEntry(record, 'Request updated' + (oldVal ? ' (was: "' + oldVal + '")' : '') + ' → "' + (newVal || '(cleared)') + '"', 'auto-request');
      }
    }
    if(itDetailStatusEl){
      const newVal = itDetailStatusEl.value;
      if(newVal !== (record.status || '')){
        record.status = newVal;
        if(newVal === 'Completed' && _itDetailPendingCompletionNote){
          addInvoiceTrackingLogEntry(record, _itDetailPendingCompletionNote, 'completion');
        }
      }
    }
    _itDetailPendingCompletionNote = null;
    saveInvoiceTrackingRecord(record);
    renderInvoiceTrackingDetailModal(record);
  });
}

const itDetailCancelBtn = qs('#itDetailCancelBtn');
if(itDetailCancelBtn){
  itDetailCancelBtn.addEventListener('click', () => {
    const record = _itDetailList[_itDetailIndex]; if(!record) return;
    _itDetailPendingCompletionNote = null;
    renderInvoiceTrackingDetailModal(record);
  });
}

const itDetailLogAddBtn = qs('#itDetailLogAddBtn');
if(itDetailLogAddBtn){
  itDetailLogAddBtn.addEventListener('click', () => {
    const record = _itDetailList[_itDetailIndex]; if(!record) return;
    const input = qs('#itDetailLogInput'); if(!input) return;
    const text = input.value.trim();
    if(!text) return;
    addInvoiceTrackingLogEntry(record, text, 'manual');
    input.value = '';
    saveInvoiceTrackingRecord(record);
    renderInvoiceTrackingLogList(record);
  });
}

const itDetailPrevBtn = qs('#itDetailPrevBtn');
if(itDetailPrevBtn){
  itDetailPrevBtn.addEventListener('click', () => {
    if(_itDetailIndex > 0 && confirmDiscardIfDirty()){ _itDetailIndex--; renderInvoiceTrackingDetailModal(_itDetailList[_itDetailIndex]); }
  });
}
const itDetailNextBtn = qs('#itDetailNextBtn');
if(itDetailNextBtn){
  itDetailNextBtn.addEventListener('click', () => {
    if(_itDetailIndex < _itDetailList.length - 1 && confirmDiscardIfDirty()){ _itDetailIndex++; renderInvoiceTrackingDetailModal(_itDetailList[_itDetailIndex]); }
  });
}

const itDetailCloseBtn = qs('#itDetailCloseBtn');
if(itDetailCloseBtn) itDetailCloseBtn.addEventListener('click', closeInvoiceTrackingDetailModal);

const itDetailModalEl = qs('#invoiceTrackingDetailModal');
if(itDetailModalEl){
  const itDetailBackdrop = itDetailModalEl.querySelector('.modal-backdrop');
  if(itDetailBackdrop) itDetailBackdrop.addEventListener('click', closeInvoiceTrackingDetailModal);
}

const itDetailMenuBtn = qs('#itDetailMenuBtn');
const itDetailMenuPanel = qs('#itDetailMenuPanel');
if(itDetailMenuBtn && itDetailMenuPanel){
  itDetailMenuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    itDetailMenuPanel.style.display = itDetailMenuPanel.style.display === 'none' ? 'block' : 'none';
  });
  document.addEventListener('click', (e) => {
    if(e.target.closest('#itDetailMenuPanel') || e.target.closest('#itDetailMenuBtn')) return;
    itDetailMenuPanel.style.display = 'none';
  });
}

const itDetailDeleteBtn = qs('#itDetailDeleteBtn');
if(itDetailDeleteBtn){
  itDetailDeleteBtn.addEventListener('click', async () => {
    const record = _itDetailList[_itDetailIndex]; if(!record) return;
    if(itDetailMenuPanel) itDetailMenuPanel.style.display = 'none';
    if(!confirm('Delete this tracked invoice entry?')) return;
    try{ if(record.id) await DB.deleteInvoiceTracking(record.id); }catch(e){ console.error('Invoice Tracking delete error:', e); }
    state.invoiceTracking = (state.invoiceTracking || []).filter(x => x !== record);
    closeInvoiceTrackingDetailModal();
    renderInvoiceTrackingTable();
    if(typeof renderRegistries === 'function') renderRegistries();
  });
}

// Populates the Add/Edit form above from an existing record (via the same WD lookup that
// drives normal entry) so the operator can adjust which units are disputed, the narrative
// fields, or the amounts, then save back onto this same record instead of creating a new one.
function startEditingInvoiceTrackingRecord(record){
  const form = qs('#invoiceTrackingForm'); if(!form) return;
  const wdInput = qs('#itWdInvoiceNum'); if(!wdInput) return;

  // editingId MUST be set before the WD lookup runs below (dispatchEvent runs its 'input'
  // listener synchronously) -- lookupInvoiceTrackingWd() reads it to exclude this record's own
  // existing entry from the "already tracked" duplicate check. Set after the dispatch, this
  // record's own WD number always looked like a duplicate of itself, blocking every edit with
  // "already tracked as a dispute" and wiping the form back to empty.
  form.dataset.editingId = record.id;

  wdInput.value = record.wdInvoiceNum || '';
  wdInput.dispatchEvent(new Event('input'));

  const wrap = qs('#itUnitAmountBreakdown');
  if(wrap){
    const disputedSet = new Set((record.unitsInDispute || []).map(u => u.toString().trim().toLowerCase()));
    const savedByUnit = new Map((Array.isArray(record.unitAmountDetails) ? record.unitAmountDetails : []).map(d => [(d.unit || '').toString().trim().toLowerCase(), d]));
    wrap.querySelectorAll('.unit-breakdown-row').forEach(row => {
      const uidKey = (row.dataset.unitId || '').toString().trim().toLowerCase();
      const cb = row.querySelector('.itb-dispute-checkbox');
      if(cb) cb.checked = disputedSet.has(uidKey);
      // Restore exactly which Other Charges were previously chosen for this unit — the freshly
      // re-rendered breakdown above only ever defaults every subcharge checkbox to unchecked
      // (see renderInvoiceTrackingUnitBreakdown), since it has no idea a saved dispute record
      // exists at all until now. Matched by subcharge NAME (the live registry's amounts may have
      // since changed, but the name is the stable identifier).
      const saved = savedByUnit.get(uidKey);
      if(saved && Array.isArray(row._subcharges)){
        const savedSubByName = new Map((Array.isArray(saved.otherChargeDetails) ? saved.otherChargeDetails : []).map(s => [(s.name || '').toString().trim().toLowerCase(), s]));
        row._subcharges.forEach(entry => {
          if(!entry.checkbox) return;
          if(entry.isLegacyOther){ entry.checkbox.checked = !!saved.otherSelected; return; }
          const savedSub = savedSubByName.get((entry.name || '').toString().trim().toLowerCase());
          entry.checkbox.checked = !!(savedSub && savedSub.disputed);
        });
      }
    });
  }
  const disputeField = qs('#itAmountInDispute'); if(disputeField) disputeField.value = record.amountInDispute || '';
  updateInvoiceTrackingAmountDue();
  const invStatus = qs('#itInvoiceStatus'); if(invStatus) invStatus.value = record.invoiceStatus || '';
  const payStatus = qs('#itPaymentStatus'); if(payStatus) payStatus.value = record.paymentStatus || '';
  const descField = qs('#itDescriptionOfIssue'); if(descField) descField.value = record.descriptionOfIssue || '';
  const reqField = qs('#itRequest'); if(reqField) reqField.value = record.request || '';
  const statusField = qs('#itStatus'); if(statusField) statusField.value = record.status || '';

  const submitBtn = form.querySelector('button[type="submit"]'); if(submitBtn) submitBtn.textContent = 'Save Changes';
  const cancelBtn = qs('#itCancelEditBtn'); if(cancelBtn) cancelBtn.style.display = '';
  try{ form.scrollIntoView({ behavior: 'smooth', block: 'start' }); }catch(e){}
}

const itDetailEditBtn = qs('#itDetailEditBtn');
if(itDetailEditBtn){
  itDetailEditBtn.addEventListener('click', () => {
    const record = _itDetailList[_itDetailIndex]; if(!record) return;
    if(itDetailMenuPanel) itDetailMenuPanel.style.display = 'none';
    if(!closeInvoiceTrackingDetailModal()) return;
    startEditingInvoiceTrackingRecord(record);
  });
}

// Re-pulls Supplier, dates, amounts, and per-unit Tax/Other/Amount detail from the matching
// registry/unit records — for when that source data changes after the dispute entry was
// created (e.g. a unit's Cost Center was corrected, or an invoice amount was fixed).
// Description of Issue, Request, Status, and the binnacle are untouched.
// Recomputes ONE record's derived fields from its live source registry/unit data -- no alert, no
// log entry, no save, no render. This is the shared core behind both the single-record "Refresh
// Data" button (refreshInvoiceTrackingRecordFromSource, below, which adds its own UI feedback)
// and the table-wide "Refresh All" button (refreshAllInvoiceTrackingRecords, further below, which
// reports one combined summary instead of alerting once per record). Returns false (record left
// untouched) when no matching posted registry exists for this record's WD Invoice Num.
function recomputeInvoiceTrackingRecordFromSource(record){
  const reg = (state.registries || []).find(r => (r.wdNumber || '').toString().trim().toLowerCase() === (record.wdInvoiceNum || '').toString().trim().toLowerCase());
  if(!reg) return false;

  const registryLeases = Array.isArray(reg.leases) && reg.leases.length
    ? reg.leases
    : ((reg.lease || '').toString().split(',').map(s => s.trim()).filter(Boolean));
  const firstLeaseRec = registryLeases.length ? (state.leases || []).find(l => (l.leaseNumber || l.id || '').toString() === registryLeases[0]) : null;

  record.wdInvoiceDate = reg.invoiceDate || record.wdInvoiceDate;
  record.fromDate = reg.periodStart || record.fromDate;
  record.toDate = reg.periodEnd || record.toDate;
  record.supplierInvoiceDoc = reg.docNumber || record.supplierInvoiceDoc;
  record.invoiceAmount = reg.totalAmount || record.invoiceAmount;
  record.lease = registryLeases;
  record.supplier = (firstLeaseRec && firstLeaseRec.supplier) || record.supplier;
  record.costCenter = computeCostCenterSummaryForUnits(record.unitsInDispute);

  // Capture the previously-saved per-charge dispute selections BEFORE they're overwritten below
  // (keyed by unit, then by subcharge name) — a Refresh Data re-syncs the live amounts, but must
  // never silently reset every manually-made "include this charge" decision back to unchecked.
  const priorByUnit = new Map((Array.isArray(record.unitAmountDetails) ? record.unitAmountDetails : []).map(d => [(d.unit || '').toString().trim().toLowerCase(), d]));

  // Every unit on the registry, aggregated across ALL of its periods (Period 1 + every quarterly
  // sub-period a unit is separately invoiced in) — see getRegistryUnitDetailsWithSlice. Looked up
  // by unit (not re-scanned per unit) since it's used twice below — once for the saved snapshot
  // (which must NOT carry the internal __slice field into what gets persisted), once for the
  // pro-ration. chargePeriods is always re-pulled LIVE here (that's the whole point of a
  // refresh) — only the operator's own charge/subcharge SELECTIONS are carried over from before.
  const sourceByUnit = new Map(getRegistryUnitDetailsWithSlice(reg).map(d => [(d.unit || '').toString().trim().toLowerCase(), d]));
  record.unitAmountDetails = (record.unitsInDispute || []).map(uid => {
    const key = uid.toString().trim().toLowerCase();
    const d = sourceByUnit.get(key);
    const prior = priorByUnit.get(key);
    const priorSubByName = new Map((prior && Array.isArray(prior.otherChargeDetails) ? prior.otherChargeDetails : []).map(s => [(s.name || '').toString().trim().toLowerCase(), s]));
    const otherChargeDetails = (d && Array.isArray(d.otherChargeDetails) ? d.otherChargeDetails : []).map(sub => {
      const priorSub = priorSubByName.get((sub.name || '').toString().trim().toLowerCase());
      return Object.assign({}, sub, { disputed: !!(priorSub && priorSub.disputed) });
    });
    return {
      unit: uid, tax: d ? d.tax : '', other: d ? d.other : '', otherChargeDetails,
      otherSelected: !!(prior && prior.otherSelected), charge: d ? d.charge : '',
      chargePeriods: d && Array.isArray(d.chargePeriods) ? d.chargePeriods : []
    };
  });

  // Amount in Dispute is re-derived the SAME way the checkbox auto-sum computes it
  // (computeUnitDisputeShare) — each unit's own Charge summed across ALL of its periods above
  // (each prorated against its own dates — see getRegistryUnitDetailsWithSlice), tax included
  // proportionally per period; each Other Charge counted at its full amount, only for whichever
  // ones were previously selected (carried over just above). Refreshing must never silently
  // drift from that same formula.
  const unitAmountDetailsByUnit = new Map(record.unitAmountDetails.map(d => [(d.unit || '').toString().trim().toLowerCase(), d]));
  const recomputedDispute = (record.unitsInDispute || []).reduce((sum, uid) => {
    const key = (uid || '').toString().trim().toLowerCase();
    if(!sourceByUnit.has(key)) return sum;
    const saved = unitAmountDetailsByUnit.get(key);
    return sum + computeUnitDisputeShare(uid, saved.chargePeriods, saved.other, saved.otherChargeDetails, saved.otherSelected);
  }, 0);
  record.amountInDispute = recomputedDispute ? recomputedDispute.toFixed(2) : '';
  const invoiceAmountNum = parseCurrency(record.invoiceAmount || '') || 0;
  const amountInDisputeNum = parseCurrency(record.amountInDispute || '') || 0;
  const dueNum = invoiceAmountNum - amountInDisputeNum;
  record.amountDue = dueNum ? dueNum.toFixed(2) : '';
  return true;
}

function refreshInvoiceTrackingRecordFromSource(record){
  const ok = recomputeInvoiceTrackingRecordFromSource(record);
  if(!ok){
    alert('No posted registry found for WD Invoice Num "' + (record.wdInvoiceNum || '') + '" — cannot refresh.');
    return;
  }
  addInvoiceTrackingLogEntry(record, 'Data refreshed from source registry/unit records (supplier, dates, amounts, unit cost center detail, and Amount in Dispute/Amount Due re-synced).', 'auto-refresh');
  saveInvoiceTrackingRecord(record);
  renderInvoiceTrackingDetailModal(record);
}

// Refreshes EVERY tracked invoice entry in one pass -- same recompute as the single-record
// Refresh Data button, but persistence and UI updates are batched (one table re-render, one
// registries re-render, one summary alert) instead of firing once per record.
function refreshAllInvoiceTrackingRecords(){
  const records = state.invoiceTracking || [];
  if(records.length === 0){ alert('No tracked invoices to refresh yet.'); return; }
  const noun = records.length === 1 ? 'entry' : 'entries';
  if(!confirm(`Refresh all ${records.length} tracked invoice ${noun} from their source registries? This re-syncs amounts and other derived fields for each entry.`)) return;

  const refreshedLabels = [];
  const skippedLabels = [];
  records.forEach(record => {
    const ok = recomputeInvoiceTrackingRecordFromSource(record);
    const label = record.wdInvoiceNum || record.id || '(unnamed entry)';
    if(ok){
      addInvoiceTrackingLogEntry(record, 'Data refreshed from source registry/unit records (supplier, dates, amounts, unit cost center detail, and Amount in Dispute/Amount Due re-synced) via Refresh All.', 'auto-refresh');
      DB.updateInvoiceTracking(record).catch(e => console.error('Invoice Tracking bulk update error:', e));
      refreshedLabels.push(label);
    } else {
      skippedLabels.push(label);
    }
  });

  renderInvoiceTrackingTable();
  if(typeof renderRegistries === 'function') renderRegistries();
  // If the Detail modal happens to be open on one of the just-refreshed records, reflect the new
  // numbers there too instead of leaving it showing stale pre-refresh data.
  const detailModal = qs('#invoiceTrackingDetailModal');
  if(detailModal && detailModal.style.display !== 'none' && _itDetailList && _itDetailList.length){
    const current = _itDetailList[_itDetailIndex];
    if(current) renderInvoiceTrackingDetailModal(current);
  }

  let msg = `Refreshed ${refreshedLabels.length} of ${records.length} entries.`;
  if(skippedLabels.length) msg += ` ${skippedLabels.length} skipped (no matching source registry found): ${skippedLabels.join(', ')}.`;
  alert(msg);
}

const itDetailRefreshBtn = qs('#itDetailRefreshBtn');
if(itDetailRefreshBtn){
  itDetailRefreshBtn.addEventListener('click', () => {
    const record = _itDetailList[_itDetailIndex]; if(!record) return;
    if(itDetailMenuPanel) itDetailMenuPanel.style.display = 'none';
    if(!confirmDiscardIfDirty()) return;
    refreshInvoiceTrackingRecordFromSource(record);
  });
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