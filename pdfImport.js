// --- Import Invoice (PDF) tab ---------------------------------------------------------
// Parses TCR Americas' quarterly usage-detail invoice PDF (always the same fixed layout:
// per-unit rows of barcode/fleet code/model/dates/Labour|Parts|Usage amounts, repeated once
// per billed month) and turns it into the same per-unit-per-period structure the Invoice
// Registration form's quarterly period tables already expect. Usage is the unit's actual
// rent, so it becomes the main Charge amount; Labour and Parts are billed alongside it but
// aren't rent, so they're placed as named Other Charges instead (matching how the rest of
// the app already distinguishes rent from other charges). The preview tables below are the
// exact same interactive component the real registration form uses, so the operator can
// re-categorize or edit any amount before it's sent. Nothing here writes to state or DB
// directly — "Send to Registration" only fills in the real #invoiceForm fields/tables, so
// the existing validation, uniqueness checks and save logic are exactly what runs.

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
  // model, service type, start date, end date, est/act/avg use, amount — immediately followed
  // by a second row ending in "Labour"/"Parts"/"Usage" that says which of the three this line
  // is. Section-header rows ("BELTLOADER/GASOLINE"), the repeated page header row, and the
  // Document Overview page's summary rows never match the first shape, so they're skipped
  // without needing special-casing. A line whose next row isn't recognized falls back to
  // Usage (rent) rather than silently dropping the amount, and is counted as uncategorized
  // so the review screen can flag it.
  function parseDetailRows(rows){
    const unitMonthCat = {};
    const monthRanges = {};
    let rowCount = 0;
    let uncategorizedCount = 0;
    for(let i = 0; i < rows.length; i++){
      const tokens = rows[i].split(' ');
      if(tokens.length !== 10) continue;
      if(!/^\d{5,8}$/.test(tokens[0])) continue;
      if(!/^\d{2}\/\d{2}\/\d{4}$/.test(tokens[4]) || !/^\d{2}\/\d{2}\/\d{4}$/.test(tokens[5])) continue;
      const amtStr = tokens[9].replace(/,/g,'');
      if(!/^\d+(\.\d{2})?$/.test(amtStr)) continue;
      const mk = monthKeyFromMDY(tokens[4]);
      if(!mk) continue;
      const unit = tokens[0];
      const amt = parseFloat(amtStr);

      let category = null;
      const nextTokens = rows[i+1] ? rows[i+1].split(' ') : null;
      if(nextTokens && nextTokens.length >= 3){
        const last = nextTokens[nextTokens.length-1];
        if(['Labour','Parts','Usage'].indexOf(last) !== -1) category = last;
      }
      if(!category){ category = 'Usage'; uncategorizedCount++; }

      unitMonthCat[unit] = unitMonthCat[unit] || {};
      unitMonthCat[unit][mk.key] = unitMonthCat[unit][mk.key] || { Labour:0, Parts:0, Usage:0 };
      unitMonthCat[unit][mk.key][category] += amt;
      monthRanges[mk.key] = { from: mk.from, to: mk.to };
      rowCount++;
    }
    return { unitMonthCat, monthRanges, rowCount, uncategorizedCount };
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

  // Maps a parsed bucket ("Labour"/"Parts") to whichever Other Charge Type name is already
  // configured on the Developer tab, so the preview's dropdown lands on a real option instead
  // of an ad-hoc "(not in list)" one whenever a matching type already exists.
  function mapOtherChargeName(bucket){
    const list = (state.meta && state.meta.devOtherCharges) || [];
    const needles = bucket === 'Labour' ? ['labour','labor'] : ['part'];
    const found = list.find(v => needles.some(n => v.toLowerCase().indexOf(n) !== -1));
    return found || (bucket === 'Labour' ? 'Labour' : 'Equipment Parts');
  }

  // Turns the raw parse into one entry per distinct billed month, each carrying a seed object
  // shaped exactly like renderUnitBreakdownTable's own seed param (charge/tax/other/
  // otherChargeDetails) — Usage becomes the unit's Charge (its rent), Labour/Parts become
  // named Other Charge rows. Only units that actually have an amount for that month are
  // included (so ragged data across units/months is naturally supported); barcodes that don't
  // match an existing UnitId are excluded per the app's convention and reported separately.
  function buildPeriods(unitMonthCat){
    const monthKeys = new Set();
    Object.values(unitMonthCat).forEach(byMonth => Object.keys(byMonth).forEach(k => monthKeys.add(k)));
    const sortedKeys = Array.from(monthKeys).sort();

    const existingUnitIds = new Set((state.units||[]).map(u => (u.unitId||u.id||'').toString().trim().toLowerCase()));
    const matchedUnits = new Set();
    const unmatchedUnits = new Set();
    Object.keys(unitMonthCat).forEach(uid => {
      if(existingUnitIds.has(uid.toString().trim().toLowerCase())) matchedUnits.add(uid); else unmatchedUnits.add(uid);
    });

    const labourName = mapOtherChargeName('Labour');
    const partsName = mapOtherChargeName('Parts');

    const periods = sortedKeys.map(key => {
      const [yyyy, mm] = key.split('-');
      const lastDay = new Date(Number(yyyy), Number(mm), 0).getDate();
      const unitData = {};
      matchedUnits.forEach(uid => {
        const cat = unitMonthCat[uid][key]; if(!cat) return;
        const otherChargeDetails = [];
        if(cat.Labour) otherChargeDetails.push({ name: labourName, amount: cat.Labour.toFixed(2), tax: '', description: '' });
        if(cat.Parts) otherChargeDetails.push({ name: partsName, amount: cat.Parts.toFixed(2), tax: '', description: '' });
        const otherSum = cat.Labour + cat.Parts;
        unitData[uid] = {
          charge: cat.Usage ? cat.Usage.toFixed(2) : '',
          tax: '',
          other: otherSum ? otherSum.toFixed(2) : '',
          otherChargeDetails
        };
      });
      return { key, fromDate: `${yyyy}-${mm}-01`, toDate: `${yyyy}-${mm}-${String(lastDay).padStart(2,'0')}`, unitData };
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
  let _reviewData = null; // { header, periods, matchedUnitIds, unmatchedUnitIds, overallFrom, overallTo, uncategorizedCount }

  function monthLabel(key){
    const [yyyy, mm] = key.split('-');
    const d = new Date(Number(yyyy), Number(mm)-1, 1);
    return d.toLocaleDateString(undefined, { month:'short', year:'numeric' });
  }

  function seedRowTotal(row){
    return (parseCurrency(row.charge||'')||0) + (parseCurrency(row.tax||'')||0) + (parseCurrency(row.other||'')||0);
  }
  function periodTotalFromUnitData(unitData){
    return Object.values(unitData).reduce((s,row) => s + seedRowTotal(row), 0);
  }
  // Reads whatever is currently in a period's live preview table (post any manual edits/
  // re-categorization) rather than the frozen originally-parsed values.
  function currentPeriodSeed(idx){
    return getUnitBreakdownRowsData('pdfImportPreview_' + idx);
  }

  function renderReview(){
    const wrap = qs('#pdfImportReview');
    const headerWrap = qs('#pdfImportHeaderInfo');
    const warnWrap = qs('#pdfImportWarnings');
    const tableWrap = qs('#pdfImportTableWrap');
    if(!wrap || !headerWrap || !warnWrap || !tableWrap || !_reviewData) return;

    const { header, periods, matchedUnitIds, unmatchedUnitIds, overallFrom, overallTo, uncategorizedCount } = _reviewData;

    const leaseRec = (state.leases||[]).find(l => (l.leaseNumber||'').toString().trim().toLowerCase() === (header.leaseNumber||'').toString().trim().toLowerCase());
    const isQuarterlyLease = !!(leaseRec && (leaseRec.arrangement||'').toString().trim().toLowerCase() === 'quarterly');

    headerWrap.innerHTML = '';
    [
      ['Doc Number', header.docNumber || '(not found)'],
      ['Lease', header.leaseNumber ? (header.leaseNumber + (leaseRec ? '' : ' — not found in system')) : '(not found)'],
      ['Overall Period', (overallFrom && overallTo) ? (formatDate(overallFrom) + ' — ' + formatDate(overallTo)) : '(none)'],
      ['Invoice Date', header.invoiceDateIso ? formatDate(header.invoiceDateIso) : '(not found)'],
      ['WD Invoice Number', 'not in this PDF — enter manually on the registration form']
    ].forEach(([label, val]) => {
      const row = document.createElement('div');
      row.innerHTML = `<strong>${label}:</strong> ${val}`;
      headerWrap.appendChild(row);
    });

    warnWrap.innerHTML = '';
    const warnings = [];
    if(!leaseRec) warnings.push(`Lease "${header.leaseNumber || '(none found)'}" doesn't match any lease in the system — you'll need to select it manually before sending.`);
    if(periods.length > 1 && leaseRec && !isQuarterlyLease) warnings.push(`This invoice spans ${periods.length} separate months, but Lease ${header.leaseNumber} isn't marked Quarterly — periods will be merged into one period unless you fix the lease's Arrangement first.`);
    if(unmatchedUnitIds.length > 0) warnings.push(`${unmatchedUnitIds.length} unit(s) in the PDF don't match any UnitId in the system and will be skipped: ${unmatchedUnitIds.join(', ')}`);
    if(uncategorizedCount > 0) warnings.push(`${uncategorizedCount} line item(s) couldn't be identified as Labour/Parts/Usage and were counted as the main Charge (rent) by default — double-check the amounts below.`);
    const parsedSum = periods.reduce((s,p) => s + periodTotalFromUnitData(p.unitData), 0);
    if(header.subtotalAmount !== null && Math.round(parsedSum*100) !== Math.round(header.subtotalAmount*100)){
      warnings.push(`Parsed total (${formatCurrency(parsedSum.toFixed(2))}) doesn't match the PDF's own "Subtotal Amount" (${formatCurrency(header.subtotalAmount.toFixed(2))}) — some rows may not have been read correctly. Note: this excludes the invoice's Tax (${header.tax !== null ? formatCurrency(header.tax.toFixed(2)) : 'n/a'}), which isn't broken out per unit and isn't allocated automatically.`);
    }
    warnings.forEach(msg => {
      const d = document.createElement('div');
      d.style.cssText = 'background:#fef9c3;color:#92400e;border:1px solid #fde68a;border-radius:6px;padding:8px 10px;font-size:12px;margin-bottom:6px;';
      d.textContent = '⚠ ' + msg;
      warnWrap.appendChild(d);
    });

    tableWrap.innerHTML = '';
    if(matchedUnitIds.length === 0){
      const none = document.createElement('div'); none.className = 'small-muted'; none.textContent = 'No units from this PDF matched an existing UnitId.';
      tableWrap.appendChild(none);
      wrap.style.display = 'block';
      return;
    }

    // One card per billed month, each showing the exact same interactive Tax/Other Charges
    // (named, editable category)/Amount/Total table the real registration form uses — so
    // re-categorizing Labour/Parts here works exactly like it does there.
    periods.forEach((period, idx) => {
      const card = document.createElement('div');
      card.style.cssText = 'border:1px solid #e6e9ee;border-radius:8px;padding:10px;margin-bottom:14px;background:#fafbfc;';
      const title = document.createElement('strong');
      title.textContent = monthLabel(period.key) + ' (' + formatDate(period.fromDate) + ' — ' + formatDate(period.toDate) + ')';
      card.appendChild(title);
      const wrapId = 'pdfImportPreview_' + idx;
      const wrapDiv = document.createElement('div');
      wrapDiv.id = wrapId;
      wrapDiv.className = 'invoice-unit-breakdown';
      wrapDiv.style.marginTop = '8px';
      card.appendChild(wrapDiv);
      tableWrap.appendChild(card);
      renderUnitBreakdownTable(wrapId, matchedUnitIds, null, period.unitData, { showEmptyRow: true });
      // There's no "declared Amount" to compare against in this preview (that only exists once
      // it's on the real registration form), so the shared component's red/green matching
      // color would otherwise always show red here on every edit — pin it to a neutral color.
      const totalEl = wrapDiv.querySelector('.unit-breakdown-total-text');
      if(totalEl){
        totalEl.style.color = '#374151';
        new MutationObserver(() => { totalEl.style.color = '#374151'; }).observe(totalEl, { childList: true, characterData: true, subtree: true });
      }
    });

    wrap.style.display = 'block';
  }

  function sendToRegistration(){
    if(!_reviewData) return;
    const { header, periods, matchedUnitIds } = _reviewData;
    if(matchedUnitIds.length === 0){ alert('No matched units to send.'); return; }

    // Pull whatever is currently in each period's live preview table — including any manual
    // edits or category reassignment — rather than the frozen originally-parsed values.
    const periodSeeds = periods.map((p, idx) => currentPeriodSeed(idx));

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
    if(typeof updateInvoiceAddPeriodAvailability === 'function') updateInvoiceAddPeriodAvailability();

    const isQuarterlyLease = !!(leaseRec && (leaseRec.arrangement||'').toString().trim().toLowerCase() === 'quarterly');
    const usePeriods = periods.length > 1 && isQuarterlyLease && typeof invoiceHasQuarterlyLeaseSelected === 'function' && invoiceHasQuarterlyLeaseSelected();

    let totalAmount = 0;
    const sumSeed = (seed) => Object.values(seed).reduce((s,row) => s + seedRowTotal(row), 0);

    if(usePeriods){
      if(typeof renderInvoiceUnitBreakdown === 'function') renderInvoiceUnitBreakdown(periodSeeds[0]);
      const p0 = periods[0];
      if(typeof _invoicePeriod1 !== 'undefined'){
        _invoicePeriod1.fromDate = p0.fromDate; _invoicePeriod1.toDate = p0.toDate;
        if(_invoicePeriod1.fromInputEl) _invoicePeriod1.fromInputEl.value = p0.fromDate;
        if(_invoicePeriod1.toInputEl) _invoicePeriod1.toInputEl.value = p0.toDate;
      }
      totalAmount += sumSeed(periodSeeds[0]);

      for(let i = 1; i < periods.length; i++){
        const addBtn = qs('#invoiceAddPeriodBtn'); if(addBtn) addBtn.click();
        const periodObj = _invoicePeriods[_invoicePeriods.length - 1];
        if(!periodObj) continue;
        const src = periods[i];
        periodObj.fromDate = src.fromDate; periodObj.toDate = src.toDate;
        if(periodObj.fromInputEl) periodObj.fromInputEl.value = src.fromDate;
        if(periodObj.toInputEl) periodObj.toInputEl.value = src.toDate;
        if(typeof renderInvoicePeriodTable === 'function') renderInvoicePeriodTable(periodObj, periodSeeds[i]);
        totalAmount += sumSeed(periodSeeds[i]);
      }
      if(typeof validateInvoicePeriodRanges === 'function') validateInvoicePeriodRanges();
    } else {
      // Merge every period's seed into one (sum charge/tax/other per unit, concatenate named
      // other-charge rows) for the single plain breakdown table.
      const merged = {};
      periodSeeds.forEach(seed => {
        Object.keys(seed).forEach(uid => {
          const row = seed[uid];
          if(!merged[uid]) merged[uid] = { charge: 0, tax: 0, other: 0, otherChargeDetails: [] };
          merged[uid].charge += parseCurrency(row.charge||'') || 0;
          merged[uid].tax += parseCurrency(row.tax||'') || 0;
          merged[uid].other += parseCurrency(row.other||'') || 0;
          merged[uid].otherChargeDetails = merged[uid].otherChargeDetails.concat(row.otherChargeDetails || []);
        });
      });
      Object.keys(merged).forEach(uid => {
        merged[uid].charge = merged[uid].charge ? merged[uid].charge.toFixed(2) : '';
        merged[uid].tax = merged[uid].tax ? merged[uid].tax.toFixed(2) : '';
        merged[uid].other = merged[uid].other ? merged[uid].other.toFixed(2) : '';
      });
      if(typeof renderInvoiceUnitBreakdown === 'function') renderInvoiceUnitBreakdown(merged);
      totalAmount = sumSeed(merged);
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
      const { unitMonthCat, rowCount, uncategorizedCount } = parseDetailRows(rows);
      if(rowCount === 0){
        if(statusEl) statusEl.textContent = 'No recognizable line items found — this may not be a TCR quarterly usage-detail invoice.';
        return;
      }
      const built = buildPeriods(unitMonthCat);
      _reviewData = { header, periods: built.periods, matchedUnitIds: built.matchedUnitIds, unmatchedUnitIds: built.unmatchedUnitIds, overallFrom: built.overallFrom, overallTo: built.overallTo, uncategorizedCount };
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
