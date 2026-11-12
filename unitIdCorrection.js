// unitIdCorrection.js — Developer-only "Unit ID Correction" tool (Import Invoice tab).
//
// The assets team identifies units by serial number while invoices were registered under our
// own Unit IDs; most match, some don't. This tool:
//   1. lists every registered invoice (SINV registry) that bills a given Unit ID,
//   2. opens any of them with the same detail the Invoices tab shows, and lets it be replaced
//      from its TCR PDF through the exact same flow as "TCR Americas — Update Invoice"
//      (window.TcrInvoiceUpdater from pdfImport.js — replaces, never merges),
//   3. renames the unit to a new Unit ID on every listed invoice at once.
//
// A rename rewrites only the unit id on each invoice (units list, every period's per-unit row);
// amounts, leases and everything else stay as they are. Each invoice is one whole-row overwrite
// by id, and memory only changes for the invoices Google Sheets confirmed.
(function(){
  const P = 'unitFix';
  const normKey = s => (s || '').toString().trim().toLowerCase();
  const moneyNum = v => parseCurrency(v === undefined || v === null ? '' : v) || 0;
  const el = name => qs('#' + P + name);
  const setText = (name, msg) => { const e = el(name); if(e) e.textContent = msg || ''; };

  // { unitId, registries: [], selectedId } — unitId is the Unit ID as searched/renamed.
  let _search = null;

  function isDevSession(){
    const role = typeof getCurrentUserRole === 'function' ? getCurrentUserRole() : null;
    return role === 'Developer' || role === 'Master';
  }

  function userName(){
    const session = typeof currentSession === 'function' ? currentSession() : null;
    if(!session) return 'Unknown User';
    if(session.user === 'Master') return 'Master';
    const u = (state.users || []).find(x => x.username === session.user);
    if(!u) return session.user || 'Unknown User';
    return ((u.firstName || '') + ' ' + (u.lastName || '')).trim() || u.username || 'Unknown User';
  }

  // Every unit id a registry carries anywhere: its units list, Period 1 and every later period.
  function registryUnitKeys(r){
    const keys = new Set();
    (Array.isArray(r.units) ? r.units : []).forEach(u => keys.add(normKey(u)));
    (Array.isArray(r.unitDetails) ? r.unitDetails : []).forEach(d => keys.add(normKey(d && d.unit)));
    (Array.isArray(r.periods) ? r.periods : []).forEach(p => (Array.isArray(p.unitDetails) ? p.unitDetails : []).forEach(d => keys.add(normKey(d && d.unit))));
    keys.delete('');
    return keys;
  }

  function findRegistriesForUnit(unitId){
    const k = normKey(unitId);
    return (state.registries || [])
      .filter(r => registryUnitKeys(r).has(k))
      .sort((a, b) => (a.periodStart || '').localeCompare(b.periodStart || '') || (Number(a.seq) || 0) - (Number(b.seq) || 0));
  }

  // ---- List ----

  function renderList(){
    const list = el('List'); if(!list || !_search) return;
    list.innerHTML = '';
    const head = document.createElement('div');
    head.style.cssText = 'display:flex;gap:8px;font-weight:600;font-size:12px;color:#374151;padding:4px 8px;border-bottom:2px solid #e6e9ee;';
    [['WD Invoice', 150], ['Doc', 120], ['Period', 200], ['Category', 110], ['Units', 50], ['Total', 110]].forEach(([label, w]) => {
      const d = document.createElement('div'); d.textContent = label; d.style.flex = `0 0 ${w}px`;
      if(label === 'Units' || label === 'Total') d.style.textAlign = 'right';
      head.appendChild(d);
    });
    list.appendChild(head);
    _search.registries.forEach((r, i) => {
      const row = document.createElement('div');
      const selected = _search.selectedId && r.id === _search.selectedId;
      row.style.cssText = 'display:flex;gap:8px;align-items:center;font-size:12px;padding:6px 8px;border-bottom:1px solid #eef0f3;cursor:pointer;' +
        (selected ? 'background:#dbeafe;' : (i % 2 ? 'background:#f8fafc;' : 'background:#fff;'));
      row.title = 'Open this invoice';
      const cells = [
        [r.wdNumber || '(no WD)', 150], [r.docNumber || '', 120],
        [formatDate(r.periodStart) + ' — ' + formatDate(r.periodEnd), 200], [r.category || '', 110],
        [String(registryUnitKeys(r).size), 50], [formatCurrency(moneyNum(r.totalAmount).toFixed(2)), 110]
      ];
      cells.forEach(([text, w], ci) => {
        const c = document.createElement('div'); c.textContent = text;
        c.style.cssText = `flex:0 0 ${w}px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;` + (ci === 0 ? 'color:#0b74de;font-weight:600;' : '') + (ci >= 4 ? 'text-align:right;' : '');
        row.appendChild(c);
      });
      row.addEventListener('click', () => {
        if(_search.selectedId === r.id && el('Detail').style.display !== 'none') closeDetail();
        else openDetail(r);
      });
      list.appendChild(row);
    });
  }

  function search(unitId, statusMsg){
    const q = (unitId === undefined ? ((el('Search') || {}).value || '') : unitId).trim();
    closeDetail();
    _search = null;
    const results = el('Results'); if(results) results.style.display = 'none';
    setText('RenameStatus', '');
    if(!q){ setText('SearchStatus', 'Enter a Unit ID.'); return; }
    const regs = findRegistriesForUnit(q);
    if(regs.length === 0){ setText('SearchStatus', statusMsg || `No registered invoice includes unit "${q}".`); return; }
    // Use the unit's spelling as registered (search is case-insensitive) for labels/comments.
    const stored = [].concat(regs[0].units || [], (regs[0].unitDetails || []).map(d => d && d.unit)).find(u => normKey(u) === normKey(q));
    _search = { unitId: stored ? String(stored).trim() : q, registries: regs, selectedId: null };
    const unitExists = (state.units || []).some(u => normKey(u.unitId || u.id) === normKey(q));
    setText('SearchStatus', statusMsg || `${regs.length} invoice(s) include ${q}.` + (unitExists ? '' : ' (This Unit ID isn\'t in Unit Control.)'));
    const applyBtn = el('ApplyBtn'); if(applyBtn) applyBtn.textContent = `Apply to all ${regs.length} listed invoice(s)`;
    if(results) results.style.display = 'block';
    renderList();
  }

  // ---- Detail (same information the Invoices tab shows when a registry is expanded) ----

  function registryLeaseInfo(r){
    const leaseList = Array.isArray(r.leases) && r.leases.length ? r.leases : (r.lease || '').toString().split(',').map(s => s.trim()).filter(Boolean);
    const recs = leaseList.map(l => (state.leases || []).find(x => normKey(x.leaseNumber || x.id) === normKey(l))).filter(Boolean);
    const distinct = get => {
      const vals = Array.from(new Set(recs.map(get).map(v => (v || '').toString()).filter(Boolean)));
      return vals.length === 0 ? '' : (vals.length === 1 ? vals[0] : '(multiple)');
    };
    return {
      leases: leaseList.join(', '),
      supplier: distinct(l => l.supplier), company: distinct(l => l.company),
      arrangement: distinct(l => l.arrangement), invoicing: distinct(l => l.invoicing)
    };
  }

  function renderDetailInfo(r){
    const wrap = el('DetailInfo'); if(!wrap) return;
    wrap.innerHTML = '';
    const heading = document.createElement('h4'); heading.style.margin = '0 0 8px';
    heading.textContent = `${r.seq ? r.seq + '. ' : ''}${r.wdNumber || '(no WD)'}`;
    wrap.appendChild(heading);
    const lease = registryLeaseInfo(r);
    const info = document.createElement('div');
    info.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:4px 16px;font-size:13px;margin-bottom:10px;';
    [
      ['WD Invoice Number', r.wdNumber || ''], ['Doc Number', r.docNumber || ''],
      ['Lease', lease.leases], ['Category', r.category || ''],
      ['Supplier', lease.supplier], ['AGI Company', lease.company],
      ['Arrangement', lease.arrangement], ['Invoicing', lease.invoicing],
      ['Period', formatDate(r.periodStart) + ' — ' + formatDate(r.periodEnd)], ['Supplier Inv. Date', formatDate(r.invoiceDate) || '—'],
      ['Submitted', formatDate(r.submittedDate) || '—'], ['Total Amount', formatCurrency(moneyNum(r.totalAmount).toFixed(2))]
    ].forEach(([label, val]) => {
      const row = document.createElement('div');
      row.innerHTML = `<strong>${escapeHtml(label)}:</strong> ${escapeHtml(val || '')}`;
      info.appendChild(row);
    });
    wrap.appendChild(info);

    // Missing information worth fixing from the PDF.
    const missing = [];
    if(!r.docNumber) missing.push('Doc Number');
    if(!r.invoiceDate) missing.push('Supplier Inv. Date');
    if(!lease.leases) missing.push('Lease');
    const periods = getRegistryCoveragePeriods(r);
    const noAmounts = new Set();
    periods.forEach(s => (s.unitDetails || []).forEach(d => {
      if(!(moneyNum(d.charge) || moneyNum(d.tax) || moneyNum(d.other))) noAmounts.add(d.unit);
    }));
    if(noAmounts.size) missing.push('amounts for ' + Array.from(noAmounts).join(', '));
    if(periods.some(s => (s.unitDetails || []).some(d => moneyNum(d.charge) && !moneyNum(d.tax)))) missing.push('tax on some units');
    if(missing.length){
      const note = document.createElement('div');
      note.style.cssText = 'background:#fef9c3;color:#92400e;border:1px solid #fde68a;border-radius:6px;padding:8px 10px;font-size:12px;margin-bottom:10px;';
      note.textContent = '⚠ Missing: ' + missing.join('; ') + '.';
      wrap.appendChild(note);
    }

    const isQuarterly = !!(r.period1From || r.period1To || (Array.isArray(r.periods) && r.periods.length > 0));
    const tables = [{ label: isQuarterly ? 'Period 1' : 'Units', from: r.period1From || r.periodStart || '', to: r.period1To || r.periodEnd || '', unitDetails: getRegistryUnitDetails(r) }];
    (Array.isArray(r.periods) ? r.periods : []).forEach((p, i) => tables.push({ label: 'Period ' + (i + 2), from: p.fromDate || '', to: p.toDate || '', unitDetails: Array.isArray(p.unitDetails) ? p.unitDetails : [] }));
    tables.forEach(t => {
      const label = document.createElement('div');
      label.style.cssText = 'font-size:12px;font-weight:700;color:#374151;margin:8px 0 2px;';
      label.textContent = t.label + (isQuarterly && t.from && t.to ? ' (' + formatDate(t.from) + ' — ' + formatDate(t.to) + ')' : '');
      wrap.appendChild(label);
      const tableEl = document.createElement('div'); tableEl.className = 'registry-unit-detail-table'; tableEl.style.overflowX = 'auto';
      wrap.appendChild(tableEl);
      if(!renderRegistryUnitDetailTable(tableEl, t.unitDetails)) tableEl.innerHTML = '<div class="small-muted">(no units)</div>';
    });

    const comments = Array.isArray(r.comments) ? r.comments : [];
    if(comments.length){
      const cl = document.createElement('div'); cl.innerHTML = '<strong>Comments:</strong>'; cl.style.margin = '10px 0 4px'; cl.style.fontSize = '13px';
      wrap.appendChild(cl);
      comments.forEach(c => {
        const box = document.createElement('div');
        box.style.cssText = 'border:1px solid #e6e6e6;border-radius:6px;padding:6px 8px;margin-bottom:4px;background:#f9fafb;font-size:12px;';
        box.innerHTML = `<div style="font-size:11px;color:#6b7280;">${escapeHtml(c.user || 'Unknown User')} · ${escapeHtml(c.timestamp ? new Date(c.timestamp).toLocaleString() : '')}</div>${escapeHtml(c.text || '')}`;
        wrap.appendChild(box);
      });
    }
  }

  function openDetail(r){
    if(!_search) return;
    _search.selectedId = r.id;
    renderList();
    renderDetailInfo(r);
    // Same PDF-replace flow as TCR Update Invoice; on save, refresh this tool in place.
    window.TcrInvoiceUpdater.begin(P, r, (reg, newTotal) => {
      const unitId = _search ? _search.unitId : '';
      search(unitId, `✓ ${reg.wdNumber} updated from its PDF — new total ${formatCurrency(newTotal.toFixed(2))}.`);
      const again = _search && _search.registries.find(x => x === reg);
      if(again) openDetail(again);
    });
    const detail = el('Detail'); if(detail){ detail.style.display = 'block'; detail.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
  }

  function closeDetail(){
    if(window.TcrInvoiceUpdater) window.TcrInvoiceUpdater.end(P);
    const detail = el('Detail'); if(detail) detail.style.display = 'none';
    const info = el('DetailInfo'); if(info) info.innerHTML = '';
    if(_search){ _search.selectedId = null; renderList(); }
  }

  // ---- Rename ----

  // Whole, whitelisted registry record with `oldKey` renamed to `newId` everywhere it appears —
  // same column set the TCR updater writes, so stray keys picked up while loading never get
  // written back and every other column of the row is left untouched by the backend.
  function renamedRecord(reg, oldKey, newId, oldLabel){
    const rename = d => (normKey(d && d.unit) === oldKey ? Object.assign({}, d, { unit: newId }) : d);
    const units = (Array.isArray(reg.units) ? reg.units : []).map(u => (normKey(u) === oldKey ? newId : u));
    const record = {
      id: reg.id,
      seq: reg.seq,
      wdNumber: reg.wdNumber || '',
      docNumber: reg.docNumber || '',
      category: reg.category || '',
      totalAmount: reg.totalAmount || '',
      unitCount: reg.unitCount !== undefined && reg.unitCount !== '' ? reg.unitCount : units.length,
      units,
      invoiceDate: reg.invoiceDate || '',
      periodStart: reg.periodStart || '',
      periodEnd: reg.periodEnd || '',
      submittedDate: reg.submittedDate || '',
      createdAt: reg.createdAt || '',
      comments: (Array.isArray(reg.comments) ? reg.comments.slice() : []).concat([{
        text: `Unit ID changed ${oldLabel} → ${newId} (Unit ID Correction).`,
        user: userName(),
        timestamp: new Date().toISOString()
      }]),
      leases: Array.isArray(reg.leases) ? reg.leases.slice() : [],
      lease: reg.lease || '',
      unitDetails: (Array.isArray(reg.unitDetails) ? reg.unitDetails : []).map(rename),
      periods: (Array.isArray(reg.periods) ? reg.periods : []).map(p => Object.assign({}, p, { unitDetails: (Array.isArray(p.unitDetails) ? p.unitDetails : []).map(rename) }))
    };
    if(reg.period1From || reg.period1To){ record.period1From = reg.period1From || ''; record.period1To = reg.period1To || ''; }
    // Continuation columns this row already has (see db.js REGISTRY_SPLIT_FIELDS).
    Object.keys(reg).forEach(k => { if(/^(unitDetails|periods)__\d+$/.test(k)) record[k] = ''; });
    return record;
  }

  const isNetworkError = e => /Failed to fetch|NetworkError|Load failed|network/i.test((e && e.message) || '');
  async function withRetry(fn){
    try{ return await fn(); }
    catch(e){
      if(!isNetworkError(e)) throw e;
      await new Promise(r => setTimeout(r, 2000));
      return await fn();
    }
  }

  async function applyRename(){
    if(!_search || !isDevSession()) return;
    const oldId = _search.unitId;
    const oldKey = normKey(oldId);
    const newId = ((el('NewId') || {}).value || '').trim();
    if(!newId){ setText('RenameStatus', 'Enter the new Unit ID.'); return; }
    if(newId === oldId){ setText('RenameStatus', 'The new Unit ID is the same as the current one.'); return; }
    const newKey = normKey(newId);
    const regs = _search.registries.slice();

    // An invoice already billing the new id would end up listing the same unit twice.
    if(newKey !== oldKey){
      const clash = regs.filter(r => registryUnitKeys(r).has(newKey));
      if(clash.length){
        setText('RenameStatus', '');
        alert(`${newId} is already on ${clash.length} of these invoices: ${clash.map(r => r.wdNumber || '(no WD)').join(', ')}.\n\nRenaming ${oldId} there would list the unit twice. Fix those invoices first (e.g. replace them from their PDF). Nothing was changed.`);
        return;
      }
    }
    const noId = regs.filter(r => !r.id);
    if(noId.length){
      alert(`${noId.map(r => r.wdNumber || '(no WD)').join(', ')} ha${noId.length > 1 ? 've' : 's'} no saved identifier in Google Sheets, so ${noId.length > 1 ? 'they' : 'it'} can't be updated safely. Add an identifier to ${noId.length > 1 ? 'those rows' : 'that row'} in the "invoices" sheet, then reload. Nothing was changed.`);
      return;
    }

    const newUnitExists = (state.units || []).some(u => normKey(u.unitId || u.id) === newKey);
    const wdSet = new Set(regs.map(r => normKey(r.wdNumber)).filter(Boolean));
    const tracking = (state.invoiceTracking || []).filter(t => wdSet.has(normKey(t.wdInvoiceNum)) &&
      ((t.unitsInDispute || []).some(u => normKey(u) === oldKey) || (t.unitAmountDetails || []).some(d => normKey(d.unit) === oldKey)));
    const msg = `Change unit ${oldId} → ${newId} on these ${regs.length} invoice(s)?\n\n` +
      regs.map(r => '  • ' + (r.wdNumber || '(no WD)')).join('\n') +
      (tracking.length ? `\n\n${tracking.length} Invoice Tracking entr${tracking.length > 1 ? 'ies' : 'y'} for these invoices will be updated too.` : '') +
      (newUnitExists ? '' : `\n\n⚠ ${newId} doesn't exist in Unit Control — the invoices will reference a unit the system doesn't know yet.`) +
      '\n\nOnly the Unit ID changes; amounts and leases stay as they are.';
    if(!confirm(msg)) return;

    const applyBtn = el('ApplyBtn');
    const searchBtn = el('SearchBtn');
    if(applyBtn) applyBtn.disabled = true;
    if(searchBtn) searchBtn.disabled = true;
    closeDetail();

    const done = [], failed = [];
    for(let i = 0; i < regs.length; i++){
      const reg = regs[i];
      setText('RenameStatus', `Saving ${i + 1} of ${regs.length} (${reg.wdNumber || '(no WD)'})…`);
      const record = renamedRecord(reg, oldKey, newId, oldId);
      try{
        await withRetry(() => DB.updateRegistry(record));
      }catch(e){
        console.error('Unit ID Correction save error:', reg.wdNumber, e);
        failed.push({ reg, error: (e && e.message) || String(e) });
        continue;
      }
      // Confirmed — mirror in memory (keep the object's identity; other views reference it).
      Object.assign(reg, record);
      const wd = normKey(reg.wdNumber), doc = normKey(reg.docNumber);
      (state.invoices || []).forEach(inv => {
        if(normKey(inv.wdNumber) === wd && normKey(inv.docNumber) === doc && normKey(inv.unit) === oldKey) inv.unit = newId;
      });
      done.push(reg);
    }

    // Invoice Tracking entries (keyed by WD) of the invoices that were renamed.
    const doneWds = new Set(done.map(r => normKey(r.wdNumber)).filter(Boolean));
    const trackingFailed = [];
    for(const t of tracking){
      if(!doneWds.has(normKey(t.wdInvoiceNum))) continue;
      const updated = Object.assign({}, t, {
        unitsInDispute: (t.unitsInDispute || []).map(u => (normKey(u) === oldKey ? newId : u)),
        unitAmountDetails: (t.unitAmountDetails || []).map(d => (normKey(d.unit) === oldKey ? Object.assign({}, d, { unit: newId }) : d))
      });
      try{
        await withRetry(() => DB.updateInvoiceTracking(updated));
        Object.assign(t, updated);
      }catch(e){
        console.error('Unit ID Correction tracking save error:', t.wdInvoiceNum, e);
        trackingFailed.push(t.wdInvoiceNum || '(no WD)');
      }
    }

    if(applyBtn) applyBtn.disabled = false;
    if(searchBtn) searchBtn.disabled = false;
    if(done.length){
      saveState();
      renderRegistries();
      renderInvoices();
      renderUnitOverview();
      renderLeaseOverview();
      renderOverview();
      if(typeof renderInvoiceTrackingTable === 'function') renderInvoiceTrackingTable();
    }

    if(failed.length){
      // Still listed under the old id, so Apply can simply be pressed again for the rest.
      search(oldId, `${done.length} of ${regs.length} renamed to ${newId}. Not saved: ${failed.map(f => f.reg.wdNumber || '(no WD)').join(', ')} — press Apply again to retry.`);
      alert('Failed to save to Google Sheets:\n' + failed.map(f => `${f.reg.wdNumber || '(no WD)'}: ${f.error}`).join('\n'));
    } else {
      const searchInput = el('Search'); if(searchInput) searchInput.value = newId;
      const newIdInput = el('NewId'); if(newIdInput) newIdInput.value = '';
      search(newId, `✓ ${oldId} renamed to ${newId} on ${done.length} invoice(s).`);
    }
    if(trackingFailed.length){
      alert(`The invoices were renamed, but these Invoice Tracking entries couldn't be saved and still list ${oldId}: ${trackingFailed.join(', ')}.`);
    }
  }

  // ---- Wiring ----

  const searchInput = el('Search');
  if(searchInput) searchInput.addEventListener('keydown', e => { if(e.key === 'Enter'){ e.preventDefault(); search(); } });
  const searchBtn = el('SearchBtn'); if(searchBtn) searchBtn.addEventListener('click', () => search());
  const newIdInput = el('NewId');
  if(newIdInput) newIdInput.addEventListener('keydown', e => { if(e.key === 'Enter'){ e.preventDefault(); applyRename(); } });
  const applyBtn = el('ApplyBtn'); if(applyBtn) applyBtn.addEventListener('click', applyRename);
  if(window.TcrInvoiceUpdater) window.TcrInvoiceUpdater.wire(P, closeDetail);
})();
