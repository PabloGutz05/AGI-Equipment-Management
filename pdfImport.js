// --- Import Invoice (PDF) tab ---------------------------------------------------------
// Parses TCR Americas' quarterly usage-detail invoice PDF (always the same fixed layout:
// per-unit rows of barcode/fleet code/model/dates/Labour|Parts|Usage amounts, repeated once
// per billed month) and turns it into the same per-unit-per-period structure the Invoice
// Registration form's quarterly period tables already expect. Nothing here writes to state
// or DB directly — "Send to Registration" only fills in the real #invoiceForm fields/tables,
// so the existing validation, uniqueness checks and save logic are exactly what runs.

(function(){
  const PDFJS_VERSION = '6.2.108';
  const PDFJS_URL = `https://unpkg.com/pdfjs-dist@${PDFJS_VERSION}/build/pdf.min.mjs`;
  const PDFJS_WORKER_URL = `https://unpkg.com/pdfjs-dist@${PDFJS_VERSION}/build/pdf.worker.min.mjs`;

  let pdfjsLibPromise = null;
  function loadPdfJs(){
    if(!pdfjsLibPromise){
      pdfjsLibPromise = import(/* webpackIgnore: true */ PDFJS_URL).then(lib => {
        lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
        return lib;
      });
    }
    return pdfjsLibPromise;
  }

  // Reconstructs visual text rows from pdf.js's flat, position-only text items: group items
  // whose baseline (y) is within a couple points of each other, then join left-to-right.
  async function extractRows(pdf){
    const rows = [];
    for(let p = 1; p <= pdf.numPages; p++){
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      const items = content.items
        .map(it => ({ str: it.str, x: it.transform[4], y: it.transform[5] }))
        .filter(it => it.str && it.str.trim() !== '');
      const buckets = [];
      items.forEach(it => {
        let bucket = buckets.find(b => Math.abs(b.y - it.y) <= 2);
        if(!bucket){ bucket = { y: it.y, items: [] }; buckets.push(bucket); }
        bucket.items.push(it);
      });
      buckets.sort((a,b) => b.y - a.y); // PDF y grows upward; top of page first
      buckets.forEach(b => {
        const text = b.items.slice().sort((a,c) => a.x - c.x).map(i => i.str).join(' ').replace(/\s+/g,' ').trim();
        if(text) rows.push(text);
      });
    }
    return rows;
  }

  function monthKeyFromMDY(mdy){
    const m = mdy.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if(!m) return null;
    const mm = m[1], yyyy = m[3];
    const lastDay = new Date(Number(yyyy), Number(mm), 0).getDate();
    return { key: yyyy + '-' + mm, from: `${yyyy}-${mm}-01`, to: `${yyyy}-${mm}-${String(lastDay).padStart(2,'0')}` };
  }

  // Every detail line item is exactly 10 whitespace-separated tokens: barcode, fleet code,
  // model, service type, start date, end date, est/act/avg use, amount. Section-header rows
  // ("BELTLOADER/GASOLINE"), the repeated page header row, and the Document Overview page's
  // summary rows never match this shape, so they're skipped without needing special-casing.
  function parseDetailRows(rows){
    const unitMonthAmounts = {};
    const monthRanges = {};
    let rowCount = 0;
    rows.forEach(text => {
      const tokens = text.split(' ');
      if(tokens.length !== 10) return;
      if(!/^\d{5,8}$/.test(tokens[0])) return;
      if(!/^\d{2}\/\d{2}\/\d{4}$/.test(tokens[4]) || !/^\d{2}\/\d{2}\/\d{4}$/.test(tokens[5])) return;
      const amtStr = tokens[9].replace(/,/g,'');
      if(!/^\d+(\.\d{2})?$/.test(amtStr)) return;
      const mk = monthKeyFromMDY(tokens[4]);
      if(!mk) return;
      const unit = tokens[0];
      const amt = parseFloat(amtStr);
      unitMonthAmounts[unit] = unitMonthAmounts[unit] || {};
      unitMonthAmounts[unit][mk.key] = (unitMonthAmounts[unit][mk.key] || 0) + amt;
      monthRanges[mk.key] = { from: mk.from, to: mk.to };
      rowCount++;
    });
    return { unitMonthAmounts, monthRanges, rowCount };
  }

  function parseHeaderInfo(rows){
    const info = { docNumber:'', leaseNumber:'', invoiceDateIso:'', subtotalAmount:null, tax:null, totalAmount:null };
    rows.forEach(text => {
      let m;
      if(!info.docNumber && (m = text.match(/^Invoice:\s*(\S+)/))) info.docNumber = m[1];
      if(!info.leaseNumber && (m = text.match(/Reference Number\s+(.+)$/i))) info.leaseNumber = m[1].replace(/^FSRA\s*/i,'').trim();
      if(!info.invoiceDateIso && (m = text.match(/\bDate:\s*([A-Za-z]+ \d{1,2},\s*\d{4})/))){
        const d = new Date(m[1]);
        if(!isNaN(d.getTime())) info.invoiceDateIso = d.toISOString().slice(0,10);
      }
      if(info.subtotalAmount === null && (m = text.match(/Subtotal Amount\s+([\d,]+\.\d{2})/i))) info.subtotalAmount = parseFloat(m[1].replace(/,/g,''));
      if(info.tax === null && (m = text.match(/^Tax\s+([\d,]+\.\d{2})/))) info.tax = parseFloat(m[1].replace(/,/g,''));
      if(info.totalAmount === null && (m = text.match(/Total Amount\s+([\d,]+\.\d{2})/i))) info.totalAmount = parseFloat(m[1].replace(/,/g,''));
    });
    return info;
  }

  // Turns the raw parse into the shape the review UI/send-to-registration step consume:
  // one entry per distinct billed month, each carrying only the units that actually have an
  // amount for that month (so ragged data across units/months is naturally supported), plus
  // which barcodes didn't match an existing UnitId (flagged, excluded per the app's convention).
  function buildPeriods(unitMonthAmounts){
    const monthKeys = new Set();
    Object.values(unitMonthAmounts).forEach(byMonth => Object.keys(byMonth).forEach(k => monthKeys.add(k)));
    const sortedKeys = Array.from(monthKeys).sort();

    const existingUnitIds = new Set((state.units||[]).map(u => (u.unitId||u.id||'').toString().trim().toLowerCase()));
    const matchedUnits = new Set();
    const unmatchedUnits = new Set();
    Object.keys(unitMonthAmounts).forEach(uid => {
      if(existingUnitIds.has(uid.toString().trim().toLowerCase())) matchedUnits.add(uid); else unmatchedUnits.add(uid);
    });

    const periods = sortedKeys.map(key => {
      const [yyyy, mm] = key.split('-');
      const lastDay = new Date(Number(yyyy), Number(mm), 0).getDate();
      const unitAmounts = {};
      matchedUnits.forEach(uid => {
        const amt = unitMonthAmounts[uid][key];
        if(amt !== undefined) unitAmounts[uid] = amt;
      });
      return { key, fromDate: `${yyyy}-${mm}-01`, toDate: `${yyyy}-${mm}-${String(lastDay).padStart(2,'0')}`, unitAmounts };
    });

    return {
      periods,
      matchedUnitIds: Array.from(matchedUnits).sort(),
      unmatchedUnitIds: Array.from(unmatchedUnits).sort(),
      overallFrom: periods.length ? periods[0].fromDate : '',
      overallTo: periods.length ? periods[periods.length-1].toDate : ''
    };
  }

  // ---- Review UI state ----
  let _reviewData = null; // { header, periods, matchedUnitIds, unmatchedUnitIds, overallFrom, overallTo }

  function monthLabel(key){
    const [yyyy, mm] = key.split('-');
    const d = new Date(Number(yyyy), Number(mm)-1, 1);
    return d.toLocaleDateString(undefined, { month:'short', year:'numeric' });
  }

  function currentPeriodTotal(period){
    let sum = 0;
    Object.keys(period.unitAmounts).forEach(uid => { sum += period.unitAmounts[uid] || 0; });
    return sum;
  }

  function renderReview(){
    const wrap = qs('#pdfImportReview');
    const headerWrap = qs('#pdfImportHeaderInfo');
    const warnWrap = qs('#pdfImportWarnings');
    const tableWrap = qs('#pdfImportTableWrap');
    if(!wrap || !headerWrap || !warnWrap || !tableWrap || !_reviewData) return;

    const { header, periods, matchedUnitIds, unmatchedUnitIds, overallFrom, overallTo } = _reviewData;

    const leaseRec = (state.leases||[]).find(l => (l.leaseNumber||'').toString().trim().toLowerCase() === (header.leaseNumber||'').toString().trim().toLowerCase());
    const isQuarterlyLease = !!(leaseRec && (leaseRec.arrangement||'').toString().trim().toLowerCase() === 'quarterly');

    headerWrap.innerHTML = '';
    const infoLines = [
      ['Doc Number', header.docNumber || '(not found)'],
      ['Lease', header.leaseNumber ? (header.leaseNumber + (leaseRec ? '' : ' — not found in system')) : '(not found)'],
      ['Overall Period', (overallFrom && overallTo) ? (formatDate(overallFrom) + ' — ' + formatDate(overallTo)) : '(none)'],
      ['Invoice Date', header.invoiceDateIso ? formatDate(header.invoiceDateIso) : '(not found)'],
      ['WD Invoice Number', 'not in this PDF — enter manually on the registration form']
    ];
    infoLines.forEach(([label, val]) => {
      const row = document.createElement('div');
      row.innerHTML = `<strong>${label}:</strong> ${val}`;
      headerWrap.appendChild(row);
    });

    warnWrap.innerHTML = '';
    const warnings = [];
    if(!leaseRec) warnings.push(`Lease "${header.leaseNumber || '(none found)'}" doesn't match any lease in the system — you'll need to select it manually before sending.`);
    if(periods.length > 1 && leaseRec && !isQuarterlyLease) warnings.push(`This invoice spans ${periods.length} separate months, but Lease ${header.leaseNumber} isn't marked Quarterly — periods will be merged into a single Amount unless you fix the lease's Arrangement first.`);
    if(unmatchedUnitIds.length > 0) warnings.push(`${unmatchedUnitIds.length} unit(s) in the PDF don't match any UnitId in the system and will be skipped: ${unmatchedUnitIds.join(', ')}`);
    const parsedSum = periods.reduce((s,p) => s + currentPeriodTotal(p), 0);
    if(header.subtotalAmount !== null && Math.round(parsedSum*100) !== Math.round(header.subtotalAmount*100)){
      warnings.push(`Parsed total (${formatCurrency(parsedSum.toFixed(2))}) doesn't match the PDF's own "Subtotal Amount" (${formatCurrency(header.subtotalAmount.toFixed(2))}) — some rows may not have been read correctly. Note: this total excludes the invoice's Tax (${header.tax !== null ? formatCurrency(header.tax.toFixed(2)) : 'n/a'}), which isn't broken out per unit and isn't allocated automatically.`);
    }
    warnings.forEach(msg => {
      const d = document.createElement('div');
      d.style.cssText = 'background:#fef9c3;color:#92400e;border:1px solid #fde68a;border-radius:6px;padding:8px 10px;font-size:12px;margin-bottom:6px;';
      d.textContent = '⚠ ' + msg;
      warnWrap.appendChild(d);
    });

    tableWrap.innerHTML = '';
    if(matchedUnitIds.length === 0){
      const none = document.createElement('div'); none.className = 'small-muted'; none.textContent = 'No units from this PDF matched an existing UnitId.'; tableWrap.appendChild(none);
      wrap.style.display = 'block';
      return;
    }

    const table = document.createElement('table');
    table.style.cssText = 'border-collapse:collapse;width:100%;font-size:12px;';
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    ['Unit'].concat(periods.map(p => monthLabel(p.key)), ['Total']).forEach(label => {
      const th = document.createElement('th');
      th.textContent = label;
      th.style.cssText = 'text-align:left;padding:6px 8px;border-bottom:2px solid #e6e9ee;background:#f9fafb;';
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    matchedUnitIds.forEach(uid => {
      const tr = document.createElement('tr');
      const tdUnit = document.createElement('td'); tdUnit.textContent = uid; tdUnit.style.cssText = 'padding:5px 8px;border-bottom:1px solid #f0f0f0;font-weight:600;';
      tr.appendChild(tdUnit);
      periods.forEach(period => {
        const td = document.createElement('td'); td.style.cssText = 'padding:5px 8px;border-bottom:1px solid #f0f0f0;';
        const input = document.createElement('input');
        input.type = 'text'; input.inputMode = 'decimal';
        input.style.cssText = 'width:90px;padding:3px 6px;border:1px solid #e6e9ee;border-radius:4px;';
        const amt = period.unitAmounts[uid];
        input.value = amt !== undefined ? amt.toFixed(2) : '';
        input.addEventListener('input', () => {
          const n = parseCurrency(input.value);
          if(n === null) delete period.unitAmounts[uid]; else period.unitAmounts[uid] = n;
          updateRowTotal(tr);
          updatePeriodFooterTotals();
        });
        td.appendChild(input);
        tr.appendChild(td);
      });
      const tdTotal = document.createElement('td'); tdTotal.className = 'pdf-import-row-total'; tdTotal.style.cssText = 'padding:5px 8px;border-bottom:1px solid #f0f0f0;font-weight:600;';
      tr.appendChild(tdTotal);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);

    const tfoot = document.createElement('tfoot');
    const footRow = document.createElement('tr');
    const tdLabel = document.createElement('td'); tdLabel.textContent = 'Period Total'; tdLabel.style.cssText = 'padding:6px 8px;font-weight:700;';
    footRow.appendChild(tdLabel);
    periods.forEach(() => { const td = document.createElement('td'); td.className = 'pdf-import-period-total'; td.style.cssText = 'padding:6px 8px;font-weight:700;'; footRow.appendChild(td); });
    const tdGrand = document.createElement('td'); tdGrand.className = 'pdf-import-grand-total'; tdGrand.style.cssText = 'padding:6px 8px;font-weight:700;'; footRow.appendChild(tdGrand);
    tfoot.appendChild(footRow);
    table.appendChild(tfoot);

    function updateRowTotal(tr){
      const uid = tr.querySelector('td').textContent;
      let sum = 0;
      periods.forEach(p => { sum += p.unitAmounts[uid] || 0; });
      tr.querySelector('.pdf-import-row-total').textContent = formatCurrency(sum.toFixed(2));
    }
    function updatePeriodFooterTotals(){
      const periodTotalCells = table.querySelectorAll('.pdf-import-period-total');
      let grand = 0;
      periods.forEach((p, i) => {
        const t = currentPeriodTotal(p);
        grand += t;
        if(periodTotalCells[i]) periodTotalCells[i].textContent = formatCurrency(t.toFixed(2));
      });
      const grandEl = table.querySelector('.pdf-import-grand-total');
      if(grandEl) grandEl.textContent = formatCurrency(grand.toFixed(2));
    }

    tbody.querySelectorAll('tr').forEach(updateRowTotal);
    updatePeriodFooterTotals();

    tableWrap.appendChild(table);
    wrap.style.display = 'block';
  }

  function fillBreakdownAmounts(wrapId, unitAmounts){
    const wrap = qs('#' + wrapId); if(!wrap) return;
    wrap.querySelectorAll('.unit-breakdown-row').forEach(row => {
      const uid = row.dataset.unitId;
      const amt = unitAmounts[uid];
      if(amt === undefined) return;
      const chargeInput = row.querySelector('.ub-charge');
      if(chargeInput){ chargeInput.value = amt.toFixed(2); chargeInput.dispatchEvent(new Event('input')); }
    });
  }

  function sendToRegistration(){
    if(!_reviewData) return;
    const { header, periods, matchedUnitIds } = _reviewData;
    if(matchedUnitIds.length === 0){ alert('No matched units to send.'); return; }

    const invoicesTabBtn = document.querySelector('.tab[data-tab="invoices"]');
    if(invoicesTabBtn) invoicesTabBtn.click();

    const form = qs('#invoiceForm');
    if(!form) return;
    form.reset();
    delete form.dataset.editing; delete form.dataset.editingGroupIds;
    if(typeof resetInvoiceQuarterlyPeriods === 'function') resetInvoiceQuarterlyPeriods();

    const docInput = qs('#invoiceDoc'); if(docInput) docInput.value = header.docNumber || '';
    const pStart = qs('#invoicePeriodStart'); if(pStart) pStart.value = _reviewData.overallFrom || '';
    const pEnd = qs('#invoicePeriodEnd'); if(pEnd) pEnd.value = _reviewData.overallTo || '';
    const invDate = qs('#invoiceSupplierInvoiceDate'); if(invDate && header.invoiceDateIso) invDate.value = header.invoiceDateIso;

    const catSel = qs('#invoiceCategory');
    if(catSel){
      const opt = Array.from(catSel.options).find(o => o.value.toLowerCase() === 'rental');
      if(opt) catSel.value = opt.value;
    }

    const leaseRec = (state.leases||[]).find(l => (l.leaseNumber||'').toString().trim().toLowerCase() === (header.leaseNumber||'').toString().trim().toLowerCase());
    let leaseChecked = false;
    if(leaseRec){
      const leasePanel = qs('#invoiceLeasePanel');
      const row = leasePanel ? Array.from(leasePanel.querySelectorAll('.lease-checkbox-row')).find(r => r.getAttribute('data-lease-id') === (leaseRec.leaseNumber||leaseRec.id||'').toString().trim().toLowerCase()) : null;
      if(row){
        const cb = row.querySelector('input[type="checkbox"]');
        if(cb){ cb.checked = true; leaseChecked = true; if(typeof onInvoiceLeaseSelectionChange === 'function') onInvoiceLeaseSelectionChange(); }
      }
    }

    if(typeof syncInvoiceUnitOptions === 'function'){
      syncInvoiceUnitOptions(leaseChecked ? [leaseRec.leaseNumber || leaseRec.id] : [], matchedUnitIds);
    }
    if(typeof renderInvoiceUnitBreakdown === 'function') renderInvoiceUnitBreakdown();
    if(typeof updateInvoiceAddPeriodAvailability === 'function') updateInvoiceAddPeriodAvailability();
    if(typeof updateInvoiceQuarterlyPeriod1Mode === 'function') updateInvoiceQuarterlyPeriod1Mode();

    const isQuarterlyLease = !!(leaseRec && (leaseRec.arrangement||'').toString().trim().toLowerCase() === 'quarterly');
    const usePeriods = periods.length > 1 && isQuarterlyLease && typeof invoiceHasQuarterlyLeaseSelected === 'function' && invoiceHasQuarterlyLeaseSelected();

    let totalAmount = 0;

    if(usePeriods){
      const p0 = periods[0];
      if(typeof _invoicePeriod1 !== 'undefined'){
        _invoicePeriod1.fromDate = p0.fromDate; _invoicePeriod1.toDate = p0.toDate;
        if(_invoicePeriod1.fromInputEl) _invoicePeriod1.fromInputEl.value = p0.fromDate;
        if(_invoicePeriod1.toInputEl) _invoicePeriod1.toInputEl.value = p0.toDate;
      }
      fillBreakdownAmounts('invoiceUnitBreakdown', p0.unitAmounts);
      totalAmount += currentPeriodTotal(p0);

      for(let i = 1; i < periods.length; i++){
        const addBtn = qs('#invoiceAddPeriodBtn'); if(addBtn) addBtn.click();
        const periodObj = _invoicePeriods[_invoicePeriods.length - 1];
        if(!periodObj) continue;
        const src = periods[i];
        periodObj.fromDate = src.fromDate; periodObj.toDate = src.toDate;
        if(periodObj.fromInputEl) periodObj.fromInputEl.value = src.fromDate;
        if(periodObj.toInputEl) periodObj.toInputEl.value = src.toDate;
        fillBreakdownAmounts(periodObj.wrapId, src.unitAmounts);
        totalAmount += currentPeriodTotal(src);
      }
      if(typeof validateInvoicePeriodRanges === 'function') validateInvoicePeriodRanges();
    } else {
      const merged = {};
      periods.forEach(p => { Object.keys(p.unitAmounts).forEach(uid => { merged[uid] = (merged[uid]||0) + p.unitAmounts[uid]; }); });
      fillBreakdownAmounts('invoiceUnitBreakdown', merged);
      totalAmount = Object.values(merged).reduce((s,v) => s+v, 0);
    }

    const amountInput = qs('#invoiceAmount');
    if(amountInput){ amountInput.value = totalAmount.toFixed(2); amountInput.dispatchEvent(new Event('input')); }
    if(typeof updateUnitBreakdownTotal === 'function') updateUnitBreakdownTotal('invoiceUnitBreakdown');
    if(typeof updateQuarterlyPeriodsAggregateTotal === 'function') updateQuarterlyPeriodsAggregateTotal();

    const wdInput = qs('#invoiceWD'); if(wdInput) wdInput.focus();
  }

  async function handleFile(file){
    const statusEl = qs('#pdfImportStatus');
    const reviewWrap = qs('#pdfImportReview');
    if(reviewWrap) reviewWrap.style.display = 'none';
    _reviewData = null;
    if(statusEl) statusEl.textContent = 'Loading PDF reader…';
    try{
      const lib = await loadPdfJs();
      if(statusEl) statusEl.textContent = 'Reading PDF…';
      const buf = await file.arrayBuffer();
      const pdf = await lib.getDocument({ data: buf }).promise;
      const rows = await extractRows(pdf);
      const header = parseHeaderInfo(rows);
      const { unitMonthAmounts, rowCount } = parseDetailRows(rows);
      if(rowCount === 0){
        if(statusEl) statusEl.textContent = 'No recognizable line items found — this may not be a TCR quarterly usage-detail invoice.';
        return;
      }
      const built = buildPeriods(unitMonthAmounts);
      _reviewData = { header, periods: built.periods, matchedUnitIds: built.matchedUnitIds, unmatchedUnitIds: built.unmatchedUnitIds, overallFrom: built.overallFrom, overallTo: built.overallTo };
      if(statusEl) statusEl.textContent = `Parsed ${rowCount} line item(s) across ${built.periods.length} period(s) for ${built.matchedUnitIds.length} matched unit(s).`;
      renderReview();
    }catch(err){
      if(statusEl) statusEl.textContent = 'Failed to parse PDF: ' + (err && err.message ? err.message : String(err));
    }
  }

  const fileInput = qs('#pdfImportFile');
  if(fileInput){
    fileInput.addEventListener('change', () => {
      const file = fileInput.files && fileInput.files[0];
      if(file) handleFile(file);
    });
  }
  const sendBtn = qs('#pdfImportSendBtn');
  if(sendBtn) sendBtn.addEventListener('click', sendToRegistration);
})();
