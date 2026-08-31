// --- Import Invoice (PDF) tab ---------------------------------------------------------
// Parses two known supplier invoice layouts and turns each into the same per-unit
// Tax/Other Charges/Amount structure the Invoice Registration form already expects:
//   - TCR Americas' quarterly usage-detail invoice (always the same fixed layout: per-unit
//     rows of barcode/fleet code/model/dates/Labour|Parts|Usage amounts, repeated once per
//     billed month, all under ONE lease). Usage is the unit's actual rent, so it becomes the
//     main Charge amount; Labour and Parts are billed alongside it but aren't rent, so
//     they're placed as named Other Charges instead.
//   - Toyota Industries Commercial Finance's account invoice summary (one "ACCOUNT
//     INFORMATION / SUMMARY OF CHARGES" block per contract/unit, each contract billed under
//     its OWN lease — a single PDF can span many leases at once). Each block's Contract
//     Number is this system's Lease Number, its Description line is the UnitId, and its
//     charge row(s) split straight into Charge + Tax. Toyota invoices only ever cover a
//     single month and never print the period's start date — only the Invoice Date, which
//     doubles as that period's end/"to" date; the operator fills in the start date by hand.
// Which parser runs is auto-detected from the PDF's own text (detectInvoiceType) — the
// operator never has to pick a format. The preview tables below are the exact same
// interactive component the real registration form uses, so the operator can re-categorize
// or edit any amount before it's sent. Nothing here writes to state or DB directly — "Send
// to Registration" only fills in the real #invoiceForm fields/tables, so the existing
// validation, uniqueness checks and save logic are exactly what runs.

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

  function escapeRegExp(s){ return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  // Picks which of the two known parsers to run, straight from the PDF's own text — the
  // operator never has to declare the format up front.
  function detectInvoiceType(rows){
    const joined = rows.join(' ');
    if(/Toyota Industries Commercial Finance/i.test(joined) || /Toyotacf\.com/i.test(joined)) return 'toyota';
    if(rows.some(r => /Document Detail/i.test(r))) return 'tcr';
    return 'unknown';
  }

  function monthKeyFromMDY(mdy){
    const m = mdy.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if(!m) return null;
    const mm = m[1], yyyy = m[3];
    const lastDay = new Date(Number(yyyy), Number(mm), 0).getDate();
    return { key: yyyy + '-' + mm, from: `${yyyy}-${mm}-01`, to: `${yyyy}-${mm}-${String(lastDay).padStart(2,'0')}` };
  }

  function looseAmount(tokens){
    const t = tokens[tokens.length-1] || '';
    return /^[\d,]+\.\d{2}$/.test(t) ? parseFloat(t.replace(/,/g,'')) : null;
  }
  function looseMonthKey(tokens){
    const found = tokens.find(t => /^\d{2}\/\d{2}\/\d{4}$/.test(t));
    return found ? monthKeyFromMDY(found) : null;
  }

  // The description/category line for a data row ("...BOS Labour") is usually the very next
  // row, but when the data row falls last on a PDF page, the repeated table header/column
  // titles reprint at the top of the next page *before* that continuation line reaches us.
  // Scan forward past any such noise (bounded, so a genuinely uncategorized row doesn't
  // wrongly borrow some later unit's category) until we find a row ending in Labour/Parts/
  // Usage, or hit the next unit's own data row first — whichever comes first.
  function findCategoryAhead(rows, i, maxLookahead){
    const limit = Math.min(rows.length, i + 1 + (maxLookahead || 20));
    for(let j = i + 1; j < limit; j++){
      const t = rows[j].split(' ');
      if(/^\d{5,8}$/.test(t[0])) return null; // reached the next data row — no category found for row i
      const last = t[t.length - 1];
      if(t.length >= 2 && ['Labour','Parts','Usage'].indexOf(last) !== -1) return last;
    }
    return null;
  }

  // Every detail line item is a barcode followed by a variable number of descriptive tokens
  // (fleet code/model/description word count differ by invoice and GSE type), then a start
  // date and end date back-to-back, then an amount as the row's very last token — sometimes
  // immediately followed by a second row ending in "Labour"/"Parts"/"Usage" that says which of
  // the three this line is (some invoice variants never break usage out that way at all — see
  // hasAnyCategoryLine below). Section-header rows ("BELTLOADER/GASOLINE"), the repeated page
  // header row, and the Document Overview page's summary rows never start with a
  // barcode-shaped token, so they're skipped without needing special-casing. Anything that DOES
  // start with a barcode-shaped token but doesn't fully match the expected shape (bad dates/
  // amount) — or whose category can't be identified from the row below it, on an invoice that
  // otherwise does use the Labour/Parts/Usage split — is never silently dropped: it's recorded
  // as an "issue" for the operator to review/complete at the top of the screen instead. An
  // unidentified category still defaults into Usage (rent) so nothing is silently missing from
  // the totals while it's still flagged.
  function parseDetailRows(rows){
    const unitMonthCat = {};
    const monthRanges = {};
    const issues = [];
    let issueSeq = 0;
    let totalCandidates = 0;

    // Real detail lines only ever appear under the "Document Detail(s)" section banner —
    // everything before it (bill-to address, bank/wire/routing numbers, FEIN, customer/billing
    // document numbers, street addresses) can contain barcode-shaped numbers purely by
    // coincidence. Starting the scan after that banner rules those false positives out without
    // changing anything about how an actual detail line is recognized or categorized once we're
    // past it. Matches both "Document Details ADV" and the plain "Document Detail" banner some
    // invoices use. Falls back to scanning everything if the banner isn't found, rather than
    // silently parsing nothing.
    const bannerIdx = rows.findIndex(r => /Document Detail/i.test(r));
    const scanStart = bannerIdx === -1 ? 0 : bannerIdx + 1;

    // Some invoice variants never print a Labour/Parts/Usage line at all — they're pure GSE
    // rental with nothing else billed alongside it. Checked once up front so a totally
    // uncategorized row on one of those invoices doesn't get flagged as an "issue" for every
    // single line item: there's nothing genuinely ambiguous to review when the split simply
    // doesn't exist anywhere in the document.
    const hasAnyCategoryLine = rows.some(r => {
      const t = r.split(' ');
      const last = t[t.length - 1];
      return t.length >= 2 && ['Labour','Parts','Usage'].indexOf(last) !== -1;
    });

    for(let i = scanStart; i < rows.length; i++){
      const tokens = rows[i].split(' ');
      if(!/^\d{5,8}$/.test(tokens[0])) continue;
      totalCandidates++;
      const barcode = tokens[0];

      // Locate the start/end date pair wherever it falls (position varies with how many
      // description words precede it) rather than assuming a fixed token index.
      let dateIdx = -1;
      for(let k = 1; k < tokens.length - 1; k++){
        if(/^\d{2}\/\d{2}\/\d{4}$/.test(tokens[k]) && /^\d{2}\/\d{2}\/\d{4}$/.test(tokens[k+1])){ dateIdx = k; break; }
      }
      const lastToken = tokens[tokens.length - 1];
      const validShape = dateIdx !== -1 && (dateIdx + 1) < (tokens.length - 1) && /^[\d,]+\.\d{2}$/.test(lastToken);

      if(!validShape){
        const mk = looseMonthKey(tokens);
        issues.push({
          id: 'iss' + (++issueSeq), unit: barcode, monthKey: mk ? mk.key : '', category: '', amount: looseAmount(tokens),
          rawText: rows[i], reason: 'Row shape not recognized (missing/garbled date or amount) — fill in the missing fields.'
        });
        continue;
      }

      const mk = monthKeyFromMDY(tokens[dateIdx]);
      const amt = parseFloat(lastToken.replace(/,/g,''));
      monthRanges[mk.key] = { from: mk.from, to: mk.to };

      const category = findCategoryAhead(rows, i);

      if(!category){
        if(hasAnyCategoryLine){
          issues.push({
            id: 'iss' + (++issueSeq), unit: barcode, monthKey: mk.key, category: 'Usage', amount: amt,
            rawText: rows[i], reason: 'Could not identify Labour/Parts/Usage from the line below it — defaulted to Usage (rent).'
          });
          continue;
        }
        // No line anywhere in this document ever breaks out Labour/Parts/Usage, so this is a
        // pure-rental invoice — default straight to Usage without flagging it for review.
        unitMonthCat[barcode] = unitMonthCat[barcode] || {};
        unitMonthCat[barcode][mk.key] = unitMonthCat[barcode][mk.key] || { Labour:0, Parts:0, Usage:0 };
        unitMonthCat[barcode][mk.key].Usage += amt;
        continue;
      }

      unitMonthCat[barcode] = unitMonthCat[barcode] || {};
      unitMonthCat[barcode][mk.key] = unitMonthCat[barcode][mk.key] || { Labour:0, Parts:0, Usage:0 };
      unitMonthCat[barcode][mk.key][category] += amt;
    }
    return { unitMonthCat, monthRanges, totalCandidates, issues };
  }

  function parseHeaderInfo(rows){
    const info = { docNumber:'', leaseNumber:'', invoiceDateIso:'', subtotalAmount:null, tax:null, totalAmount:null };
    rows.forEach(text => {
      let m;
      if(!info.docNumber && (m = text.match(/^Invoice:\s*(\S+)/))) info.docNumber = m[1];
      // The field label varies by invoice variant ("Reference Number FSRA123456" vs. this
      // format's plain "Reference ATS MCO - CO20220520 and CO20220729" — a customer label
      // followed by one or more lease codes). Pull out just the first lease-code-shaped token
      // (an existing lease number in this system, e.g. "CO20220520" or a bare "20190311") when
      // one is present, so the customer-label prefix and any additional lease codes after
      // "and" don't end up baked into the match; falls back to the whole (FSRA-stripped)
      // string when nothing code-shaped is found, preserving the original format's behavior.
      if(!info.leaseNumber && (m = text.match(/Reference(?:\s+Number)?\s+(.+)$/i))){
        const raw = m[1].replace(/^FSRA\s*/i,'').trim();
        const codeMatch = raw.match(/\b(?:CO)?\d{8}\b/i);
        info.leaseNumber = codeMatch ? codeMatch[0] : raw;
      }
      if(!info.invoiceDateIso && (m = text.match(/\bDate:\s*([A-Za-z]+ \d{1,2},\s*\d{4})/))){
        const d = new Date(m[1]);
        if(!isNaN(d.getTime())) info.invoiceDateIso = d.toISOString().slice(0,10);
      }
      // Same field, numeric MM/DD/YYYY layout (this invoice variant never uses a month-name
      // date anywhere) — checked as a separate fallback rather than folded into the regex
      // above so the month-name path (and whichever format relies on it) is untouched.
      if(!info.invoiceDateIso && (m = text.match(/\bDate:\s*(\d{2})\/(\d{2})\/(\d{4})\b/))){
        info.invoiceDateIso = `${m[3]}-${m[1]}-${m[2]}`;
      }
      if(info.subtotalAmount === null && (m = text.match(/Subtotal Amount\s+([\d,]+\.\d{2})/i))) info.subtotalAmount = parseFloat(m[1].replace(/,/g,''));
      if(info.tax === null && (m = text.match(/^Tax\s+([\d,]+\.\d{2})/))) info.tax = parseFloat(m[1].replace(/,/g,''));
      // Anchored to the start of the row (like the Tax match below) — "Total Amount" is
      // otherwise also a literal substring of "Subtotal Amount" ("Sub" + "total Amount"), so an
      // unanchored match picks up the Subtotal row's own number first and never reaches the
      // real Total Amount row at all.
      if(info.totalAmount === null && (m = text.match(/^Total Amount\s+([\d,]+\.\d{2})/i))) info.totalAmount = parseFloat(m[1].replace(/,/g,''));
    });
    return info;
  }

  // ---- Toyota Industries Commercial Finance: account invoice summary ----

  function parseToyotaHeaderInfo(rows){
    const info = { docNumber:'', invoiceDateIso:'', subtotalAmount:null, tax:null, totalAmount:null };
    rows.forEach(text => {
      let m;
      if(!info.docNumber && (m = text.match(/^Invoice Number\s+(\S+)/))) info.docNumber = m[1];
      if(!info.invoiceDateIso && (m = text.match(/^Invoice Date\s+(\d{2})\/(\d{2})\/(\d{4})/))) info.invoiceDateIso = `${m[3]}-${m[1]}-${m[2]}`;
      // The recap block on the final page ("Total Amount Due:") is the WHOLE invoice's grand
      // total split into Amount/Tax/Total — distinct from each per-contract "Total Amount Due
      // <contract#> ..." row (no colon, four trailing numbers) parsed separately below. Used
      // purely as a cross-check against the sum of everything actually parsed.
      if(info.totalAmount === null && (m = text.match(/^Total Amount Due:\s+\$?([\d,]+\.\d{2})\s+\$?([\d,]+\.\d{2})\s+\$?([\d,]+\.\d{2})$/))){
        info.subtotalAmount = parseFloat(m[1].replace(/,/g,''));
        info.tax = parseFloat(m[2].replace(/,/g,''));
        info.totalAmount = parseFloat(m[3].replace(/,/g,''));
      }
    });
    return info;
  }

  // Every contract/unit on a Toyota statement gets its own "ACCOUNT INFORMATION / SUMMARY OF
  // CHARGES" block: a Contract Number (== this system's Lease Number), a Description line
  // naming the unit (its UnitId), then one or more named charge rows (Base Payment, and
  // occasionally Late Charges/Property Tax/Other Charges) each shaped
  // "<label> $amount $tax $total", closed out by that same contract's own "Total Amount Due
  // <contract#> ..." recap row. Charge/Tax are summed across every charge row found in the
  // block — this invoice never breaks a unit's charges into named sub-types the way TCR's
  // Labour/Parts do, so everything simply rolls into the unit's plain Charge + Tax. A block
  // missing either its unit id or a readable charge amount is recorded as an issue for the
  // operator to complete, exactly like TCR's unrecognized rows.
  function parseToyotaBlocks(rows){
    const units = [];
    const issues = [];
    let issueSeq = 0;

    for(let i = 0; i < rows.length; i++){
      let contractNumber = null;
      let m = rows[i].match(/^Contract Number\s+(\S+)/);
      if(m) contractNumber = m[1];
      else if(/^Contract Number$/i.test(rows[i].trim()) && rows[i+1]) contractNumber = rows[i+1].trim();
      if(!contractNumber) continue;

      // This block's end: its own "Total Amount Due <contract#>" recap row, or — if that's
      // missing/garbled — the next "Contract Number" line, whichever comes first.
      let endIdx = rows.length;
      const totalDueRe = new RegExp('^Total Amount Due\\s+' + escapeRegExp(contractNumber) + '\\b');
      for(let j = i + 1; j < rows.length; j++){
        if(totalDueRe.test(rows[j]) || /^Contract Number\b/i.test(rows[j])){ endIdx = j; break; }
      }

      // Unit id: the first non-empty line after "Description", bounded to this block.
      let unitId = null;
      for(let j = i + 1; j < endIdx; j++){
        if(/^Description\b/i.test(rows[j].trim())){
          for(let k = j + 1; k < endIdx; k++){
            const t = rows[k].trim();
            if(!t) continue;
            unitId = t;
            break;
          }
          break;
        }
      }

      // Charge row(s): "<label...> $amount $tax $total" — sum Amount/Tax across every one
      // found. Explicitly skips this contract's own "Total Amount Due" recap row (it has FOUR
      // trailing numbers, not three, but a lazy label match could otherwise still absorb the
      // extra one and misparse it as a charge line if the endIdx boundary above ever missed it).
      let charge = 0, tax = 0, chargeRowsFound = 0;
      for(let j = i + 1; j < endIdx; j++){
        if(/^Total Amount Due\b/i.test(rows[j])) continue;
        const cm = rows[j].match(/^(.+?)\s+\$?([\d,]+\.\d{2})\s+\$?([\d,]+\.\d{2})\s+\$?([\d,]+\.\d{2})$/);
        if(!cm) continue;
        charge += parseFloat(cm[2].replace(/,/g,''));
        tax += parseFloat(cm[3].replace(/,/g,''));
        chargeRowsFound++;
      }

      if(!unitId || chargeRowsFound === 0){
        issues.push({
          id: 'iss' + (++issueSeq), contractNumber, unitId: unitId || '',
          charge: chargeRowsFound ? charge : null, tax: chargeRowsFound ? tax : null,
          rawText: rows[i], reason: !unitId ? 'Could not find the unit id (Description line) for this contract.' : 'Could not find a charge amount for this contract.'
        });
        continue;
      }

      units.push({ contractNumber, unitId, charge, tax });
    }

    return { units, issues };
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
  // _reviewData.type ('tcr' | 'toyota') decides which shape the rest of this object has and
  // which recompute/render/send function runs. In both shapes, the "base" field(s) hold only
  // confidently-parsed data and are never mutated directly; issues holds the operator-editable
  // rows shown at the top of the screen; everything else is always derived fresh from those two
  // via recompute() — this is what makes editing an issue row update the tables below live.
  //   tcr:    { header, baseUnitMonthCat, monthRanges, issues, periods, matchedUnitIds,
  //             unmatchedUnitIds, overallFrom, overallTo }
  //   toyota: { header, baseUnits, issues, rows, matchedUnitIds, unmatchedUnitIds,
  //             matchedLeaseNumbers, unmatchedLeaseContracts, leaseMismatches, unitData }
  let _reviewData = null;

  // Folds baseUnitMonthCat + every issue that currently has a complete unit/period/category/
  // amount into one combined map, then rebuilds periods/matchedUnitIds/etc. from it — this is
  // what makes editing a row in the issues table show up in the tables below.
  function recomputeTcr(){
    const combined = {};
    Object.keys(_reviewData.baseUnitMonthCat).forEach(uid => {
      combined[uid] = {};
      Object.keys(_reviewData.baseUnitMonthCat[uid]).forEach(mk => {
        combined[uid][mk] = Object.assign({}, _reviewData.baseUnitMonthCat[uid][mk]);
      });
    });
    _reviewData.issues.forEach(issue => {
      if(!issue.unit || !issue.monthKey || !issue.category) return;
      const amt = Number(issue.amount);
      if(!isFinite(amt)) return;
      combined[issue.unit] = combined[issue.unit] || {};
      combined[issue.unit][issue.monthKey] = combined[issue.unit][issue.monthKey] || { Labour:0, Parts:0, Usage:0 };
      combined[issue.unit][issue.monthKey][issue.category] += amt;
    });
    const built = buildPeriods(combined);
    _reviewData.periods = built.periods;
    _reviewData.matchedUnitIds = built.matchedUnitIds;
    _reviewData.unmatchedUnitIds = built.unmatchedUnitIds;
    _reviewData.overallFrom = built.overallFrom;
    _reviewData.overallTo = built.overallTo;
  }

  // Toyota equivalent of recomputeTcr(): folds baseUnits + every issue that now has a
  // complete contract/unit/charge into one combined row list, then rebuilds
  // matchedUnitIds/matchedLeaseNumbers/unitData/etc. from it.
  function recomputeToyota(){
    const combined = _reviewData.baseUnits.slice();
    _reviewData.issues.forEach(issue => {
      if(!issue.contractNumber || !issue.unitId) return;
      const c = Number(issue.charge);
      if(!isFinite(c)) return;
      const t = Number(issue.tax);
      combined.push({ contractNumber: issue.contractNumber, unitId: issue.unitId, charge: c, tax: isFinite(t) ? t : 0 });
    });

    const existingUnitIds = new Set((state.units||[]).map(u => (u.unitId||u.id||'').toString().trim().toLowerCase()));
    const matchedUnitIds = [];
    const unmatchedUnitIds = [];
    const matchedLeaseNumbers = [];
    const unmatchedLeaseContracts = [];
    const leaseMismatches = [];
    const unitData = {};

    combined.forEach(row => {
      const uidKey = row.unitId.toString().trim().toLowerCase();
      const unitMatched = existingUnitIds.has(uidKey);
      if(unitMatched){
        if(matchedUnitIds.indexOf(row.unitId) === -1) matchedUnitIds.push(row.unitId);
        const existing = unitData[row.unitId];
        // Same unit listed more than once in one PDF (shouldn't normally happen on this
        // invoice format) — sum rather than silently overwrite so nothing disappears.
        if(existing){
          const newCharge = (parseCurrency(existing.charge)||0) + row.charge;
          const newTax = (parseCurrency(existing.tax)||0) + row.tax;
          existing.charge = newCharge ? newCharge.toFixed(2) : '';
          existing.tax = newTax ? newTax.toFixed(2) : '';
        } else {
          unitData[row.unitId] = { charge: row.charge ? row.charge.toFixed(2) : '', tax: row.tax ? row.tax.toFixed(2) : '', other: '', otherChargeDetails: [] };
        }
      } else if(unmatchedUnitIds.indexOf(row.unitId) === -1){
        unmatchedUnitIds.push(row.unitId);
      }

      const leaseRec = (state.leases||[]).find(l => (l.leaseNumber||l.id||'').toString().trim().toLowerCase() === row.contractNumber.toString().trim().toLowerCase());
      if(leaseRec){
        const leaseKey = (leaseRec.leaseNumber||leaseRec.id||'').toString();
        if(matchedLeaseNumbers.indexOf(leaseKey) === -1) matchedLeaseNumbers.push(leaseKey);
        const unitRec = (state.units||[]).find(u => (u.unitId||u.id||'').toString().trim().toLowerCase() === uidKey);
        if(unitRec && (unitRec.lease||'').toString().trim().toLowerCase() !== leaseKey.toLowerCase()){
          leaseMismatches.push(`Unit ${row.unitId} is registered under lease "${unitRec.lease || '(none)'}" but this invoice lists it under contract "${row.contractNumber}" — it won't be pre-checked or included in the total below until you fix the lease or select it manually.`);
        }
      } else if(unmatchedLeaseContracts.indexOf(row.contractNumber) === -1){
        unmatchedLeaseContracts.push(row.contractNumber);
      }
    });

    _reviewData.rows = combined;
    _reviewData.matchedUnitIds = matchedUnitIds;
    _reviewData.unmatchedUnitIds = unmatchedUnitIds;
    _reviewData.matchedLeaseNumbers = matchedLeaseNumbers;
    _reviewData.unmatchedLeaseContracts = unmatchedLeaseContracts;
    _reviewData.leaseMismatches = leaseMismatches;
    _reviewData.unitData = unitData;
  }

  function recompute(){
    if(_reviewData.type === 'toyota') recomputeToyota();
    else recomputeTcr();
  }

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

  // Every row this app already knows as an Other Charge Type, for the issues table's Category
  // picker, plus the two fixed buckets every line item actually belongs to before that split.
  function issueCategoryOptionsHtml(current){
    return ['', 'Usage', 'Labour', 'Parts'].map(v => {
      const label = v === '' ? '(select)' : (v === 'Usage' ? 'Usage (rent)' : v);
      return `<option value="${v}"${v === current ? ' selected' : ''}>${label}</option>`;
    }).join('');
  }

  function renderIssuesTableTcr(){
    const issuesWrap = qs('#pdfImportIssuesWrap');
    if(!issuesWrap) return;
    issuesWrap.innerHTML = '';
    const issues = _reviewData.issues;
    if(!issues || issues.length === 0) return;

    const monthKeys = Object.keys(_reviewData.monthRanges).sort();
    const title = document.createElement('div');
    title.innerHTML = `<strong>⚠ ${issues.length} line item(s) need review</strong> — edit Unit/Period/Category/Amount below; changes apply to the tables further down immediately. The matching row is highlighted red until you dismiss it here.`;
    title.style.cssText = 'background:#fee2e2;color:#991b1b;border:1px solid #fecaca;border-radius:6px;padding:8px 10px;font-size:12px;margin-bottom:8px;';
    issuesWrap.appendChild(title);

    const table = document.createElement('table');
    table.style.cssText = 'border-collapse:collapse;width:100%;font-size:12px;';
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    ['Unit','Period','Category','Amount','Reason','Raw text','']
      .forEach(label => { const th = document.createElement('th'); th.textContent = label; th.style.cssText = 'text-align:left;padding:6px 8px;border-bottom:2px solid #fecaca;background:#fef2f2;'; headRow.appendChild(th); });
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    issues.forEach(issue => {
      const tr = document.createElement('tr'); tr.style.cssText = 'background:#fff5f5;';

      const mk = (cell, el) => { const td = document.createElement('td'); td.style.cssText = 'padding:4px 8px;border-bottom:1px solid #fee2e2;'; td.appendChild(el); tr.appendChild(td); return td; };

      const unitInput = document.createElement('input'); unitInput.type = 'text'; unitInput.value = issue.unit || '';
      unitInput.style.cssText = 'width:100px;padding:3px 6px;border:1px solid #e6e9ee;border-radius:4px;';
      unitInput.addEventListener('input', () => { issue.unit = unitInput.value.trim(); recompute(); renderReview(); });
      mk('unit', unitInput);

      const periodSelect = document.createElement('select');
      periodSelect.style.cssText = 'padding:3px 6px;border:1px solid #e6e9ee;border-radius:4px;';
      periodSelect.innerHTML = '<option value="">(select)</option>' + monthKeys.map(k => `<option value="${k}"${k===issue.monthKey?' selected':''}>${monthLabel(k)}</option>`).join('');
      periodSelect.addEventListener('change', () => { issue.monthKey = periodSelect.value; recompute(); renderReview(); });
      mk('period', periodSelect);

      const catSelect = document.createElement('select');
      catSelect.style.cssText = 'padding:3px 6px;border:1px solid #e6e9ee;border-radius:4px;';
      catSelect.innerHTML = issueCategoryOptionsHtml(issue.category);
      catSelect.addEventListener('change', () => { issue.category = catSelect.value; recompute(); renderReview(); });
      mk('category', catSelect);

      const amountInput = document.createElement('input'); amountInput.type = 'text'; amountInput.inputMode = 'decimal';
      amountInput.value = (issue.amount === null || issue.amount === undefined) ? '' : issue.amount.toFixed(2);
      amountInput.style.cssText = 'width:90px;padding:3px 6px;border:1px solid #e6e9ee;border-radius:4px;';
      amountInput.addEventListener('input', () => { const n = parseCurrency(amountInput.value); issue.amount = n; recompute(); renderReview(); });
      mk('amount', amountInput);

      const reasonEl = document.createElement('div'); reasonEl.textContent = issue.reason; reasonEl.style.cssText = 'max-width:220px;color:#7f1d1d;';
      mk('reason', reasonEl);

      const rawEl = document.createElement('div'); rawEl.textContent = issue.rawText; rawEl.title = issue.rawText;
      rawEl.style.cssText = 'max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#9ca3af;';
      mk('raw', rawEl);

      const dismissBtn = document.createElement('button'); dismissBtn.type = 'button'; dismissBtn.textContent = 'Dismiss';
      dismissBtn.title = 'Accept the current values as final and stop flagging this row';
      dismissBtn.style.cssText = 'font-size:11px;padding:3px 8px;border:1px solid #d1d5db;border-radius:4px;background:#f9fafb;cursor:pointer;';
      dismissBtn.addEventListener('click', () => {
        if(issue.unit && issue.monthKey && issue.category && isFinite(Number(issue.amount))){
          _reviewData.baseUnitMonthCat[issue.unit] = _reviewData.baseUnitMonthCat[issue.unit] || {};
          _reviewData.baseUnitMonthCat[issue.unit][issue.monthKey] = _reviewData.baseUnitMonthCat[issue.unit][issue.monthKey] || { Labour:0, Parts:0, Usage:0 };
          _reviewData.baseUnitMonthCat[issue.unit][issue.monthKey][issue.category] += Number(issue.amount);
        }
        _reviewData.issues = _reviewData.issues.filter(i => i.id !== issue.id);
        recompute();
        renderReview();
      });
      mk('actions', dismissBtn);

      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    issuesWrap.appendChild(table);
  }

  function renderReviewTcr(){
    const wrap = qs('#pdfImportReview');
    const headerWrap = qs('#pdfImportHeaderInfo');
    const warnWrap = qs('#pdfImportWarnings');
    const tableWrap = qs('#pdfImportTableWrap');
    if(!wrap || !headerWrap || !warnWrap || !tableWrap || !_reviewData) return;

    const { header, periods, matchedUnitIds, unmatchedUnitIds, overallFrom, overallTo, issues } = _reviewData;

    renderIssuesTableTcr();

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
      // Highlight whichever unit rows have an open issue for this exact period, so it's obvious
      // which numbers below came from a guess/incomplete row until it's fixed or dismissed above.
      issues.filter(iss => iss.monthKey === period.key && iss.unit).forEach(iss => {
        const row = wrapDiv.querySelector(`.unit-breakdown-row[data-unit-id="${CSS.escape(iss.unit)}"]`);
        if(row){ row.style.backgroundColor = '#fee2e2'; row.title = iss.reason; }
      });
    });

    wrap.style.display = 'block';
  }

  // Toyota equivalent of renderIssuesTableTcr(): one editable row per contract that couldn't
  // be confidently parsed (no unit id found and/or no readable charge amount).
  function renderIssuesTableToyota(){
    const issuesWrap = qs('#pdfImportIssuesWrap');
    if(!issuesWrap) return;
    issuesWrap.innerHTML = '';
    const issues = _reviewData.issues;
    if(!issues || issues.length === 0) return;

    const title = document.createElement('div');
    title.innerHTML = `<strong>⚠ ${issues.length} contract(s) need review</strong> — edit Contract/Unit/Charge/Tax below; changes apply to the table further down immediately.`;
    title.style.cssText = 'background:#fee2e2;color:#991b1b;border:1px solid #fecaca;border-radius:6px;padding:8px 10px;font-size:12px;margin-bottom:8px;';
    issuesWrap.appendChild(title);

    const table = document.createElement('table');
    table.style.cssText = 'border-collapse:collapse;width:100%;font-size:12px;';
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    ['Contract Number','Unit','Charge','Tax','Reason','Raw text','']
      .forEach(label => { const th = document.createElement('th'); th.textContent = label; th.style.cssText = 'text-align:left;padding:6px 8px;border-bottom:2px solid #fecaca;background:#fef2f2;'; headRow.appendChild(th); });
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    issues.forEach(issue => {
      const tr = document.createElement('tr'); tr.style.cssText = 'background:#fff5f5;';
      const mk = (el) => { const td = document.createElement('td'); td.style.cssText = 'padding:4px 8px;border-bottom:1px solid #fee2e2;'; td.appendChild(el); tr.appendChild(td); };

      const contractInput = document.createElement('input'); contractInput.type = 'text'; contractInput.value = issue.contractNumber || '';
      contractInput.style.cssText = 'width:130px;padding:3px 6px;border:1px solid #e6e9ee;border-radius:4px;';
      contractInput.addEventListener('input', () => { issue.contractNumber = contractInput.value.trim(); recompute(); renderReview(); });
      mk(contractInput);

      const unitInput = document.createElement('input'); unitInput.type = 'text'; unitInput.value = issue.unitId || '';
      unitInput.style.cssText = 'width:100px;padding:3px 6px;border:1px solid #e6e9ee;border-radius:4px;';
      unitInput.addEventListener('input', () => { issue.unitId = unitInput.value.trim(); recompute(); renderReview(); });
      mk(unitInput);

      const chargeInput = document.createElement('input'); chargeInput.type = 'text'; chargeInput.inputMode = 'decimal';
      chargeInput.value = (issue.charge === null || issue.charge === undefined) ? '' : issue.charge.toFixed(2);
      chargeInput.style.cssText = 'width:90px;padding:3px 6px;border:1px solid #e6e9ee;border-radius:4px;';
      chargeInput.addEventListener('input', () => { issue.charge = parseCurrency(chargeInput.value); recompute(); renderReview(); });
      mk(chargeInput);

      const taxInput = document.createElement('input'); taxInput.type = 'text'; taxInput.inputMode = 'decimal';
      taxInput.value = (issue.tax === null || issue.tax === undefined) ? '' : issue.tax.toFixed(2);
      taxInput.style.cssText = 'width:90px;padding:3px 6px;border:1px solid #e6e9ee;border-radius:4px;';
      taxInput.addEventListener('input', () => { issue.tax = parseCurrency(taxInput.value); recompute(); renderReview(); });
      mk(taxInput);

      const reasonEl = document.createElement('div'); reasonEl.textContent = issue.reason; reasonEl.style.cssText = 'max-width:220px;color:#7f1d1d;';
      mk(reasonEl);

      const rawEl = document.createElement('div'); rawEl.textContent = issue.rawText; rawEl.title = issue.rawText;
      rawEl.style.cssText = 'max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#9ca3af;';
      mk(rawEl);

      const dismissBtn = document.createElement('button'); dismissBtn.type = 'button'; dismissBtn.textContent = 'Dismiss';
      dismissBtn.title = 'Accept the current values as final and stop flagging this row';
      dismissBtn.style.cssText = 'font-size:11px;padding:3px 8px;border:1px solid #d1d5db;border-radius:4px;background:#f9fafb;cursor:pointer;';
      dismissBtn.addEventListener('click', () => {
        if(issue.contractNumber && issue.unitId && isFinite(Number(issue.charge))){
          _reviewData.baseUnits.push({ contractNumber: issue.contractNumber, unitId: issue.unitId, charge: Number(issue.charge), tax: isFinite(Number(issue.tax)) ? Number(issue.tax) : 0 });
        }
        _reviewData.issues = _reviewData.issues.filter(i => i.id !== issue.id);
        recompute();
        renderReview();
      });
      mk(dismissBtn);

      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    issuesWrap.appendChild(table);
  }

  function renderReviewToyota(){
    const wrap = qs('#pdfImportReview');
    const headerWrap = qs('#pdfImportHeaderInfo');
    const warnWrap = qs('#pdfImportWarnings');
    const tableWrap = qs('#pdfImportTableWrap');
    if(!wrap || !headerWrap || !warnWrap || !tableWrap || !_reviewData) return;

    const { header, matchedUnitIds, unmatchedUnitIds, unmatchedLeaseContracts, leaseMismatches, unitData, rows } = _reviewData;

    renderIssuesTableToyota();

    headerWrap.innerHTML = '';
    [
      ['Doc Number', header.docNumber || '(not found)'],
      ['Invoice Date', header.invoiceDateIso ? formatDate(header.invoiceDateIso) : '(not found)'],
      ['Period Start', 'not in this PDF — enter manually on the registration form'],
      ['Period End', header.invoiceDateIso ? (formatDate(header.invoiceDateIso) + ' (from Invoice Date)') : '(not found)'],
      ['WD Invoice Number', 'not in this PDF — enter manually on the registration form'],
      ['Contracts found', String(rows.length) + ' (' + matchedUnitIds.length + ' matched unit(s))']
    ].forEach(([label, val]) => {
      const row = document.createElement('div');
      row.innerHTML = `<strong>${label}:</strong> ${val}`;
      headerWrap.appendChild(row);
    });

    warnWrap.innerHTML = '';
    const warnings = [];
    if(unmatchedLeaseContracts.length > 0) warnings.push(`${unmatchedLeaseContracts.length} contract number(s) don't match any lease in the system: ${unmatchedLeaseContracts.join(', ')}`);
    if(unmatchedUnitIds.length > 0) warnings.push(`${unmatchedUnitIds.length} unit(s) in the PDF don't match any UnitId in the system and will be skipped: ${unmatchedUnitIds.join(', ')}`);
    leaseMismatches.forEach(msg => warnings.push(msg));
    const parsedSum = rows.reduce((s,r) => s + r.charge + r.tax, 0);
    if(header.subtotalAmount !== null && header.tax !== null){
      const pdfSum = header.subtotalAmount + header.tax;
      if(Math.round(parsedSum*100) !== Math.round(pdfSum*100)){
        warnings.push(`Parsed total (${formatCurrency(parsedSum.toFixed(2))}) doesn't match the PDF's own grand total (${formatCurrency(pdfSum.toFixed(2))}) — some rows may not have been read correctly, or some contracts/units aren't in the system yet.`);
      }
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

    // Always a single flat breakdown table -- this invoice format only ever covers one month.
    const card = document.createElement('div');
    card.style.cssText = 'border:1px solid #e6e9ee;border-radius:8px;padding:10px;margin-bottom:14px;background:#fafbfc;';
    const title = document.createElement('strong');
    title.textContent = 'Charges' + (header.invoiceDateIso ? ' (period start — fill in manually — through ' + formatDate(header.invoiceDateIso) + ')' : '');
    card.appendChild(title);
    const wrapId = 'pdfImportPreview_0';
    const wrapDiv = document.createElement('div');
    wrapDiv.id = wrapId;
    wrapDiv.className = 'invoice-unit-breakdown';
    wrapDiv.style.marginTop = '8px';
    card.appendChild(wrapDiv);
    tableWrap.appendChild(card);
    renderUnitBreakdownTable(wrapId, matchedUnitIds, null, unitData, { showEmptyRow: true });
    // There's no "declared Amount" to compare against in this preview (that only exists once
    // it's on the real registration form), so the shared component's red/green matching color
    // would otherwise always show red here on every edit — pin it to a neutral color.
    const totalEl = wrapDiv.querySelector('.unit-breakdown-total-text');
    if(totalEl){
      totalEl.style.color = '#374151';
      new MutationObserver(() => { totalEl.style.color = '#374151'; }).observe(totalEl, { childList: true, characterData: true, subtree: true });
    }

    wrap.style.display = 'block';
  }

  function sendToRegistrationTcr(){
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

      // Build periods 2+ directly (rather than simulating a click on #invoiceAddPeriodBtn) so
      // the seed is applied on the table's very first render — clicking the button renders an
      // empty table first, and the shared component treats those just-created blank cells as
      // real prior data that then wins over a seed applied a moment later, leaving $0 amounts.
      for(let i = 1; i < periods.length; i++){
        if(typeof _invoicePeriodSeq !== 'undefined') _invoicePeriodSeq++;
        const src = periods[i];
        const periodObj = { id: 'p' + _invoicePeriodSeq, wrapId: 'invoicePeriodBreakdown_' + _invoicePeriodSeq, fromDate: src.fromDate, toDate: src.toDate, units: matchedUnitIds.slice() };
        if(typeof _invoicePeriods !== 'undefined') _invoicePeriods.push(periodObj);
        if(typeof renderInvoicePeriodBlock === 'function') renderInvoicePeriodBlock(periodObj, periodSeeds[i]);
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

  // Toyota equivalent of sendToRegistrationTcr(): always a single flat breakdown table (this
  // invoice format is never quarterly), but across potentially MANY leases at once — every
  // contract number that matched a real lease gets checked, exactly like editing an existing
  // multi-lease invoice group does elsewhere in this app. Period Start is left blank (this
  // invoice never prints it) so the operator notices and fills it in; Period End defaults to
  // the invoice date, which is this format's stand-in "through" date.
  function sendToRegistrationToyota(){
    if(!_reviewData) return;
    const { header, matchedUnitIds, matchedLeaseNumbers } = _reviewData;
    if(matchedUnitIds.length === 0){ alert('No matched units to send.'); return; }

    // Pull whatever is currently in the live preview table — including any manual edits —
    // rather than the frozen originally-parsed values.
    const seed = getUnitBreakdownRowsData('pdfImportPreview_0');

    const invoicesTabBtn = document.querySelector('.tab[data-tab="invoices"]');
    if(invoicesTabBtn) invoicesTabBtn.click();

    const form = qs('#invoiceForm');
    if(!form) return;
    form.reset();
    delete form.dataset.editing; delete form.dataset.editingGroupIds;
    if(typeof resetInvoiceQuarterlyPeriods === 'function') resetInvoiceQuarterlyPeriods();

    const docInput = qs('#invoiceDoc'); if(docInput) docInput.value = header.docNumber || '';
    const pStart = qs('#invoicePeriodStart'); if(pStart) pStart.value = ''; // not printed on this invoice -- operator fills in
    const pEnd = qs('#invoicePeriodEnd'); if(pEnd) pEnd.value = header.invoiceDateIso || '';
    const invDate = qs('#invoiceSupplierInvoiceDate'); if(invDate && header.invoiceDateIso) invDate.value = header.invoiceDateIso;

    const catSel = qs('#invoiceCategory');
    if(catSel){
      const opt = Array.from(catSel.options).find(o => o.value.toLowerCase() === 'rental');
      if(opt) catSel.value = opt.value;
    }

    if(typeof syncInvoiceLeaseOptions === 'function') syncInvoiceLeaseOptions(matchedLeaseNumbers);
    if(typeof renderInvoiceLeaseDetailTable === 'function') renderInvoiceLeaseDetailTable();
    if(typeof syncInvoiceUnitOptions === 'function') syncInvoiceUnitOptions(matchedLeaseNumbers, matchedUnitIds);
    if(typeof updateInvoiceAddPeriodAvailability === 'function') updateInvoiceAddPeriodAvailability();

    if(typeof renderInvoiceUnitBreakdown === 'function') renderInvoiceUnitBreakdown(seed);
    // The real breakdown table (and so the actual invoice) only ever gets a row for whichever
    // units actually ended up checked in the unit picker — the unit picker itself only ever
    // offers units whose OWN registered lease is one of the leases just checked above, so a
    // unit flagged by leaseMismatches above (registered under a different lease than this
    // invoice lists it under) never makes it in. Summing every matched unit's seed here
    // regardless would silently overstate the Declared Amount past what the breakdown table
    // actually adds up to, so the total is scoped to only what's really selected instead.
    const actualUnitIds = typeof getSelectedInvoiceUnits === 'function' ? getSelectedInvoiceUnits() : matchedUnitIds;
    const totalAmount = actualUnitIds.reduce((s,uid) => s + (seed[uid] ? seedRowTotal(seed[uid]) : 0), 0);

    const amountInput = qs('#invoiceAmount');
    if(amountInput){ amountInput.value = totalAmount.toFixed(2); amountInput.dispatchEvent(new Event('input')); }
    if(typeof updateUnitBreakdownTotal === 'function') updateUnitBreakdownTotal('invoiceUnitBreakdown');
    if(typeof updateQuarterlyPeriodsAggregateTotal === 'function') updateQuarterlyPeriodsAggregateTotal();

    const wdInput = qs('#invoiceWD'); if(wdInput) wdInput.focus();
  }

  function renderReview(){
    if(!_reviewData) return;
    if(_reviewData.type === 'toyota') renderReviewToyota();
    else renderReviewTcr();
  }

  function sendToRegistration(){
    if(!_reviewData) return;
    if(_reviewData.type === 'toyota') sendToRegistrationToyota();
    else sendToRegistrationTcr();
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
      const invoiceType = detectInvoiceType(rows);

      if(invoiceType === 'toyota'){
        const header = parseToyotaHeaderInfo(rows);
        const { units, issues } = parseToyotaBlocks(rows);
        if(units.length === 0 && issues.length === 0){
          if(statusEl) statusEl.textContent = 'No recognizable contract/charge blocks found — this may not be a Toyota Industries Commercial Finance invoice.';
          return;
        }
        _reviewData = { type:'toyota', header, baseUnits: units, issues, rows: [], matchedUnitIds: [], unmatchedUnitIds: [], matchedLeaseNumbers: [], unmatchedLeaseContracts: [], leaseMismatches: [], unitData: {} };
        recompute();
        if(statusEl) statusEl.textContent = `Parsed ${_reviewData.rows.length} contract(s) for ${_reviewData.matchedUnitIds.length} matched unit(s)` + (issues.length ? ` — ${issues.length} need review.` : '.');
        renderReview();
        return;
      }

      const header = parseHeaderInfo(rows);
      const { unitMonthCat, monthRanges, totalCandidates, issues } = parseDetailRows(rows);
      if(totalCandidates === 0){
        if(statusEl) statusEl.textContent = 'No recognizable line items found — this may not be a TCR quarterly usage-detail invoice.';
        return;
      }
      _reviewData = { type:'tcr', header, baseUnitMonthCat: unitMonthCat, monthRanges, issues, periods: [], matchedUnitIds: [], unmatchedUnitIds: [], overallFrom: '', overallTo: '' };
      recompute();
      if(statusEl) statusEl.textContent = `Parsed ${totalCandidates} line item(s) across ${_reviewData.periods.length} period(s) for ${_reviewData.matchedUnitIds.length} matched unit(s)` + (issues.length ? ` — ${issues.length} need review.` : '.');
      renderReview();
    }catch(err){
      if(statusEl) statusEl.textContent = 'Failed to parse PDF: ' + (err && err.message ? err.message : String(err));
    }
  }

  function clearImport(){
    _reviewData = null;
    const fileInput = qs('#pdfImportFile'); if(fileInput) fileInput.value = '';
    const statusEl = qs('#pdfImportStatus'); if(statusEl) statusEl.textContent = '';
    const reviewWrap = qs('#pdfImportReview'); if(reviewWrap) reviewWrap.style.display = 'none';
    const issuesWrap = qs('#pdfImportIssuesWrap'); if(issuesWrap) issuesWrap.innerHTML = '';
    const headerWrap = qs('#pdfImportHeaderInfo'); if(headerWrap) headerWrap.innerHTML = '';
    const warnWrap = qs('#pdfImportWarnings'); if(warnWrap) warnWrap.innerHTML = '';
    const tableWrap = qs('#pdfImportTableWrap'); if(tableWrap) tableWrap.innerHTML = '';
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
  const clearBtn = qs('#pdfImportClearBtn');
  if(clearBtn) clearBtn.addEventListener('click', clearImport);
})();
