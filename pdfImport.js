// --- Import Invoice (PDF) tab ---------------------------------------------------------
// Parses two known supplier invoice layouts and turns each into the same per-unit
// Tax/Other Charges/Amount structure the Invoice Registration form already expects:
//   - TCR Americas' quarterly usage-detail invoice (always the same fixed layout: per-unit
//     rows of barcode/fleet code/model/dates/Labour|Parts|Usage amounts, repeated once per
//     billed month, all under ONE lease). Usage is the unit's actual rent, so it becomes the
//     main Charge amount; Labour and Parts are billed alongside it but aren't rent, so
//     they're placed as named Other Charges instead. The invoice-level Tax is split equally
//     between the units (see buildPeriods).
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
    if(/Fortbrand Services/i.test(joined) || /fortbrand\.com/i.test(joined)) return 'fortbrand';
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
  // sign is -1 for a credit memo (its line amounts are printed unsigned but are credits), 1
  // otherwise; every parsed amount — confident rows and issue rows alike — carries it.
  function parseDetailRows(rows, sign){
    sign = sign === -1 ? -1 : 1;
    const signed = n => (n === null || n === undefined) ? n : sign * Math.abs(n);
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
          id: 'iss' + (++issueSeq), unit: barcode, monthKey: mk ? mk.key : '', category: '', amount: signed(looseAmount(tokens)),
          rawText: rows[i], reason: 'Row shape not recognized (missing/garbled date or amount) — fill in the missing fields.'
        });
        continue;
      }

      const mk = monthKeyFromMDY(tokens[dateIdx]);
      const amt = signed(parseFloat(lastToken.replace(/,/g,'')));
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
    const info = { docNumber:'', leaseNumber:'', invoiceDateIso:'', subtotalAmount:null, tax:null, totalAmount:null, isCredit:false };
    rows.forEach(text => {
      let m;
      // Regular invoices print "Invoice: 2631812345"; TCR credit memos use the same layout but
      // label the number "Credit Memo: 2631900020" (and still print every amount unsigned).
      if(!info.docNumber && (m = text.match(/^(Invoice|Credit Memo):\s*(\S+)/i))){
        info.docNumber = m[2];
        info.isCredit = /credit/i.test(m[1]);
      }
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
      // Tax is printed either as one "Tax 1,234.56" row or split per jurisdiction ("Tax Jur Code
      // Level 1 6.00 % 2,269.98", "Tax Jur Code Level 2 1.50 % 567.90") — sum every Tax row's
      // trailing amount (never the rate before the "%"), but only up to the Total Amount row so
      // nothing past the summary block can be picked up.
      if(info.totalAmount === null && (m = text.match(/^Tax\b.*?([\d,]+\.\d{2})$/))) info.tax = Math.round(((info.tax || 0) + parseFloat(m[1].replace(/,/g,''))) * 100) / 100;
      // Anchored to the start of the row (like the Tax match below) — "Total Amount" is
      // otherwise also a literal substring of "Subtotal Amount" ("Sub" + "total Amount"), so an
      // unanchored match picks up the Subtotal row's own number first and never reaches the
      // real Total Amount row at all.
      if(info.totalAmount === null && (m = text.match(/^Total Amount\s+([\d,]+\.\d{2})/i))) info.totalAmount = parseFloat(m[1].replace(/,/g,''));
    });
    // A credit memo's amounts are credits back to us — store them negative, the same sign the
    // registration form requires for the Credit category.
    if(info.isCredit){
      ['subtotalAmount','tax','totalAmount'].forEach(k => { if(info[k] !== null) info[k] = -Math.abs(info[k]); });
    }
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
  // The invoice's Tax is only printed as one invoice-level total, so it's split equally
  // between every unit on the invoice (matched or not — an unmatched unit's share is skipped
  // along with it, same as its charges), then each unit's share is split equally across the
  // months it was billed. Done in whole cents with the leftover pennies going to the first
  // entries, so the shares always add back up to the PDF's Tax exactly.
  function buildPeriods(unitMonthCat, invoiceTax){
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

    const splitCents = (cents, n) => {
      const base = Math.floor(cents / n), rem = cents - base * n;
      return Array.from({ length: n }, (_, i) => base + (i < rem ? 1 : 0));
    };
    const taxByUnitMonth = {};
    const taxedUnits = Object.keys(unitMonthCat).filter(uid => Object.keys(unitMonthCat[uid]).length > 0).sort();
    // Split the tax's magnitude and re-apply its sign, so a credit memo's negative tax is
    // allocated the same way (splitCents' floor-based math only works on positive cents).
    const taxRaw = Math.round((Number(invoiceTax) || 0) * 100);
    const taxSign = taxRaw < 0 ? -1 : 1;
    const taxCents = Math.abs(taxRaw);
    if(taxCents > 0 && taxedUnits.length > 0){
      const unitShares = splitCents(taxCents, taxedUnits.length);
      taxedUnits.forEach((uid, i) => {
        const months = Object.keys(unitMonthCat[uid]).sort();
        const monthShares = splitCents(unitShares[i], months.length);
        taxByUnitMonth[uid] = {};
        months.forEach((mk, j) => { taxByUnitMonth[uid][mk] = taxSign * monthShares[j] / 100; });
      });
    }

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
        const tax = (taxByUnitMonth[uid] && taxByUnitMonth[uid][key]) || 0;
        unitData[uid] = {
          charge: cat.Usage ? cat.Usage.toFixed(2) : '',
          tax: tax ? tax.toFixed(2) : '',
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

  // ---- Fortbrand Services: lease GSE invoice ("RPM Posted Invoice RI…") ----
  // Header: "Invoice Number: RI18747", "Invoice Date: 10/1/2025", "Contract No. 20088-06".
  // Each billed line is "<description> MM/DD/YY-MM/DD/YY <periods> <qty> <unit price> <total>";
  // a unit line is followed (before the next line) by "Unit No. 5151 (SN: 8294)". Lines with no
  // Unit No. (e.g. "TRANSPORTATION (EQUIPMENT)") are invoice-level extra charges. Totals sit in
  // the summary block: "Subtotal: 5,432.98", "Total Sales Tax: 488.97", "Total USD: 5,921.95".
  function fortbrandDate(s){
    const m = (s || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
    if(!m) return '';
    const y = m[3].length === 2 ? '20' + m[3] : m[3];
    return y + '-' + m[1].padStart(2,'0') + '-' + m[2].padStart(2,'0');
  }
  const FORTBRAND_LINE_RE = /^(.+?)\s+(\d{1,2}\/\d{1,2}\/\d{2,4})\s*-\s*(\d{1,2}\/\d{1,2}\/\d{2,4})\s+(-?[\d.,]+)\s+(-?[\d.,]+)\s+(-?[\d,]+\.\d{2})\s+(-?[\d,]+\.\d{2})$/;

  function parseFortbrandRows(rows){
    const num = s => parseFloat(String(s).replace(/,/g,''));
    const header = { docNumber:'', leaseNumber:'', invoiceDateIso:'', subtotalAmount:null, tax:null, totalAmount:null, isCredit:false };
    rows.forEach(t => {
      let m;
      if(!header.docNumber && (m = t.match(/Invoice Number:\s*(\S+)/i))) header.docNumber = m[1];
      if(!header.invoiceDateIso && (m = t.match(/Invoice Date:\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i))) header.invoiceDateIso = fortbrandDate(m[1]);
      if(!header.leaseNumber && (m = t.match(/Contract No\.?\s*(\S+)/i))) header.leaseNumber = m[1];
      if(header.subtotalAmount === null && (m = t.match(/Subtotal:\s*(-?[\d,]+\.\d{2})/i))) header.subtotalAmount = num(m[1]);
      if(header.tax === null && (m = t.match(/Total Sales Tax:\s*(-?[\d,]+\.\d{2})/i))) header.tax = num(m[1]);
      if(header.totalAmount === null && (m = t.match(/Total USD:\s*(-?[\d,]+\.\d{2})/i))) header.totalAmount = num(m[1]);
    });
    const lines = [];
    for(let i = 0; i < rows.length; i++){
      const m = rows[i].match(FORTBRAND_LINE_RE);
      if(!m) continue;
      // The Unit No. row comes after the line (possibly after a repeated page header when the
      // line is last on a page) and before the next line's "Month(s)" header.
      let unitNo = '', sn = '';
      for(let j = i + 1; j < Math.min(rows.length, i + 15); j++){
        if(FORTBRAND_LINE_RE.test(rows[j]) || /^Month\(s\)/i.test(rows[j]) || /US DOLLARS/i.test(rows[j])) break;
        const um = rows[j].match(/Unit No\.?\s*([^\s(]+)(?:\s*\(SN:\s*([^)]*?)\s*\))?/i);
        if(um){ unitNo = um[1]; sn = (um[2] || '').trim(); break; }
      }
      lines.push({ description: m[1].trim(), from: fortbrandDate(m[2]), to: fortbrandDate(m[3]), amount: num(m[7]), unitNo, sn });
    }
    return { header, lines };
  }

  // Turns the parsed lines into the same shape buildPeriods returns (one period per distinct
  // billed date range). A line's unit is the Unit Control unit whose UnitId equals its Unit No.
  // or, failing that, its serial number (SN). The invoice-level extra charges and the Sales Tax
  // are split equally (whole cents, leftover pennies to the first lines) between every unit
  // line, matched or not; an unmatched line's share is skipped along with it.
  function buildFortbrand(parsed){
    const unitLines = parsed.lines.filter(l => l.unitNo || l.sn);
    const extras = parsed.lines.filter(l => !(l.unitNo || l.sn));
    const unitByKey = {};
    (state.units || []).forEach(u => { const id = (u.unitId || u.id || '').toString().trim(); if(id) unitByKey[id.toLowerCase()] = id; });
    const resolve = l => unitByKey[(l.unitNo || '').toLowerCase()] || unitByKey[(l.sn || '').toLowerCase()] || null;

    const splitCents = (total, n) => {
      const cents = Math.round(Math.abs(total) * 100), sign = total < 0 ? -1 : 1;
      const base = Math.floor(cents / n), rem = cents - base * n;
      return Array.from({ length: n }, (_, i) => sign * (base + (i < rem ? 1 : 0)) / 100);
    };
    const n = unitLines.length;
    const taxShares = n ? splitCents(Number(parsed.header.tax) || 0, n) : [];
    const extraShares = extras.map(x => n ? splitCents(x.amount, n) : []);
    const extraNames = extras.map(x => {
      const list = (state.meta && state.meta.devOtherCharges) || [];
      const needles = /transport|freight|deliver/i.test(x.description) ? ['transport','freight','deliver'] : [x.description.toLowerCase()];
      const found = list.find(v => needles.some(k => v.toLowerCase().indexOf(k) !== -1));
      return found || x.description.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
    });

    const byPeriod = {};
    const matched = [], unmatched = [];
    unitLines.forEach((l, i) => {
      const uid = resolve(l);
      if(!uid){ const label = l.unitNo + (l.sn ? ' (SN ' + l.sn + ')' : ''); if(unmatched.indexOf(label) === -1) unmatched.push(label); return; }
      if(matched.indexOf(uid) === -1) matched.push(uid);
      const key = l.from + '|' + l.to;
      const p = byPeriod[key] = byPeriod[key] || { fromDate: l.from, toDate: l.to, unitData: {} };
      const row = p.unitData[uid] = p.unitData[uid] || { charge: 0, tax: 0, other: 0, otherChargeDetails: [] };
      row.charge += l.amount;
      row.tax += taxShares[i] || 0;
      extras.forEach((x, k) => {
        const amt = extraShares[k][i] || 0; if(!amt) return;
        row.other += amt;
        row.otherChargeDetails.push({ name: extraNames[k], amount: amt.toFixed(2), tax: '', description: x.description });
      });
    });
    const periods = Object.keys(byPeriod).sort().map(key => {
      const p = byPeriod[key];
      Object.keys(p.unitData).forEach(uid => {
        const r = p.unitData[uid];
        ['charge','tax','other'].forEach(f => { r[f] = r[f] ? r[f].toFixed(2) : ''; });
      });
      return p;
    });
    return {
      periods,
      matchedUnitIds: matched,
      unmatchedUnitIds: unmatched,
      overallFrom: periods.length ? periods.map(p => p.fromDate).sort()[0] : '',
      overallTo: periods.length ? periods.map(p => p.toDate).sort().slice(-1)[0] : '',
      unitLineCount: n,
      extras
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
    const built = buildPeriods(combined, _reviewData.header.tax);
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
      ['Doc Number', (header.docNumber || '(not found)') + (header.isCredit ? ' — Credit Memo: amounts are negative and the Credit category is selected' : '')],
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
    if(header.isCredit && !((state.meta && state.meta.devRentals) || []).some(r => (r || '').toString().trim().toLowerCase() === 'credit')){
      warnings.push('This is a Credit Memo, but there\'s no "Credit" invoice category set up — add it so the negative amounts can be registered.');
    }
    if(periods.length > 1 && leaseRec && !isQuarterlyLease) warnings.push(`This invoice spans ${periods.length} separate months, but Lease ${header.leaseNumber} isn't marked Quarterly — periods will be merged into one period unless you fix the lease's Arrangement first.`);
    if(unmatchedUnitIds.length > 0) warnings.push(`${unmatchedUnitIds.length} unit(s) in the PDF don't match any UnitId in the system and will be skipped: ${unmatchedUnitIds.join(', ')}`);
    const parsedSum = periods.reduce((s,p) => s + periodTotalFromUnitData(p.unitData), 0);
    // Tax is allocated across the units above, so the parse should add up to the full
    // Subtotal + Tax; fall back to the PDF's Total Amount row if Subtotal wasn't readable.
    const pdfTotal = header.subtotalAmount !== null ? header.subtotalAmount + (header.tax || 0) : header.totalAmount;
    const taxMaybeMissing = header.tax === null && !(header.subtotalAmount !== null && header.totalAmount !== null && Math.round(header.subtotalAmount*100) === Math.round(header.totalAmount*100));
    if(taxMaybeMissing) warnings.push(`The invoice's Tax row couldn't be read — no tax was allocated to the units. Enter each unit's Tax manually if this invoice has one.`);
    if(pdfTotal !== null && Math.round(parsedSum*100) !== Math.round(pdfTotal*100)){
      warnings.push(`Parsed total (${formatCurrency(parsedSum.toFixed(2))}) doesn't match the PDF's own total (${formatCurrency(pdfTotal.toFixed(2))}, Subtotal + Tax) — some rows may not have been read correctly, or some units aren't in the system yet.`);
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
    if(typeof exitInvoiceReplaceMode === "function") exitInvoiceReplaceMode();
    if(typeof resetInvoiceQuarterlyPeriods === 'function') resetInvoiceQuarterlyPeriods();

    const docInput = qs('#invoiceDoc'); if(docInput) docInput.value = header.docNumber || '';
    const pStart = qs('#invoicePeriodStart'); if(pStart) pStart.value = _reviewData.overallFrom || '';
    const pEnd = qs('#invoicePeriodEnd'); if(pEnd) pEnd.value = _reviewData.overallTo || '';
    const invDate = qs('#invoiceSupplierInvoiceDate'); if(invDate && header.invoiceDateIso) invDate.value = header.invoiceDateIso;

    // A credit memo's amounts are negative, which the form only accepts under Credit.
    const catSel = qs('#invoiceCategory');
    if(catSel){
      const want = header.isCredit ? 'credit' : 'rental';
      const opt = Array.from(catSel.options).find(o => o.value.trim().toLowerCase() === want);
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
    if(typeof exitInvoiceReplaceMode === "function") exitInvoiceReplaceMode();
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

      if(invoiceType === 'fortbrand'){
        if(statusEl) statusEl.textContent = 'This is a Fortbrand invoice. Fortbrand PDFs are read by Edit Invoice (Unit ID Correction) for now — nothing was imported here.';
        return;
      }
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
      const { unitMonthCat, monthRanges, totalCandidates, issues } = parseDetailRows(rows, header.isCredit ? -1 : 1);
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
    setDropFileName('');
    const statusEl = qs('#pdfImportStatus'); if(statusEl) statusEl.textContent = '';
    const reviewWrap = qs('#pdfImportReview'); if(reviewWrap) reviewWrap.style.display = 'none';
    const issuesWrap = qs('#pdfImportIssuesWrap'); if(issuesWrap) issuesWrap.innerHTML = '';
    const headerWrap = qs('#pdfImportHeaderInfo'); if(headerWrap) headerWrap.innerHTML = '';
    const warnWrap = qs('#pdfImportWarnings'); if(warnWrap) warnWrap.innerHTML = '';
    const tableWrap = qs('#pdfImportTableWrap'); if(tableWrap) tableWrap.innerHTML = '';
  }

  function setDropFileName(name){
    const el = qs('#pdfImportDropFileName'); if(el) el.textContent = name || '';
  }

  // Drop zone + its hidden file input: dropping a PDF runs the exact same path as picking it in
  // the input; clicking/Enter/Space on the zone just opens that input's picker.
  function wirePdfDropZone(zoneSel, inputSel, statusSel, onFile){
    const input = qs(inputSel);
    const zone = qs(zoneSel);
    if(input){
      input.addEventListener('change', () => {
        const file = input.files && input.files[0];
        if(file) onFile(file);
      });
    }
    if(!zone) return;
    const setHover = (on) => {
      zone.style.background = on ? '#e0f2fe' : '#f8fafc';
      zone.style.borderColor = on ? '#0284c7' : '#cbd5e1';
    };
    zone.addEventListener('click', () => { if(input) input.click(); });
    zone.addEventListener('keydown', (e) => {
      if(e.key === 'Enter' || e.key === ' '){ e.preventDefault(); if(input) input.click(); }
    });
    ['dragenter','dragover'].forEach(evt => zone.addEventListener(evt, (e) => { e.preventDefault(); setHover(true); }));
    zone.addEventListener('dragleave', (e) => { if(!zone.contains(e.relatedTarget)) setHover(false); });
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      setHover(false);
      const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if(!file) return;
      const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
      if(!isPdf){
        const statusEl = qs(statusSel); if(statusEl) statusEl.textContent = `"${file.name}" isn't a PDF — drop an invoice PDF.`;
        return;
      }
      if(input) input.value = '';
      onFile(file);
    });
  }

  wirePdfDropZone('#pdfImportDropZone', '#pdfImportFile', '#pdfImportStatus', file => { setDropFileName(file.name); handleFile(file); });

  // ---- TCR Americas: Update Invoice ----
  // Finds an already-registered invoice (registry) by its WD/SINV number, re-reads a TCR PDF
  // with the exact same parser as the import above (so Tax is allocated per unit the same way),
  // and rebuilds that registry's periods, per-unit amounts, units/leases and total the way the
  // import would have registered it (see tcrUpdateBuild). WD/Doc/category/dates submitted stay
  // as they are; a PDF for a different Doc number blocks the save.
  // The same flow also backs the Unit ID Correction tool (unitIdCorrection.js), so each tool
  // keeps its own context, keyed by the prefix of its element ids (#<p>DropZone, #<p>Status…):
  //   { p, registry, slices, quarterly, newSlices, newTotal, blockers, usePeriods,
  //     overallFrom, overallTo, category, onSaved(registry, newTotal) }
  const _tcrCtx = {};
  const tcrEl = (p, name) => qs('#' + p + name);

  const normKey = s => (s || '').toString().trim().toLowerCase();
  const moneyNum = v => parseCurrency(v === undefined || v === null ? '' : v) || 0;
  const money2 = n => n ? n.toFixed(2) : '';
  const detailTotal = d => moneyNum(d.charge) + moneyNum(d.tax) + moneyNum(d.other);

  function tcrUpdateSetStatus(sel, msg){ const el = qs(sel); if(el) el.textContent = msg || ''; }

  function tcrUpdateFindRegistries(query){
    const q = normKey(query); if(!q) return [];
    const bare = q.replace(/^sinv-?/, '');
    return (state.registries || []).filter(r => {
      const wd = normKey(r.wdNumber);
      return wd && (wd === q || wd.replace(/^sinv-?/, '') === bare);
    });
  }

  // Read-only per-unit table for one period. When `oldDetails` is given, every value that
  // differs from it is bolded with the previous value struck through underneath.
  function tcrUpdateDetailTable(details, oldDetails){
    const oldByUnit = {};
    (oldDetails || []).forEach(d => { oldByUnit[normKey(d.unit)] = d; });
    const table = document.createElement('table');
    table.style.cssText = 'border-collapse:collapse;width:100%;font-size:12px;';
    const headRow = document.createElement('tr');
    ['Unit','Amount','Tax','Other Charges','Total'].forEach((label, i) => {
      const th = document.createElement('th'); th.textContent = label;
      th.style.cssText = 'padding:6px 8px;border-bottom:2px solid #e6e9ee;background:#f3f4f6;text-align:' + (i === 0 ? 'left' : 'right') + ';';
      headRow.appendChild(th);
    });
    const thead = document.createElement('thead'); thead.appendChild(headRow); table.appendChild(thead);
    const tbody = document.createElement('tbody');
    let sum = 0;
    details.forEach(d => {
      const tr = document.createElement('tr');
      const old = oldDetails ? oldByUnit[normKey(d.unit)] : null;
      const unitTd = document.createElement('td'); unitTd.textContent = d.unit || '';
      unitTd.style.cssText = 'padding:4px 8px;border-bottom:1px solid #eef0f3;';
      if(d.__added){
        tr.style.background = '#eff6ff';
        const tag = document.createElement('span');
        tag.textContent = ' added' + (d.lease ? ' · ' + d.lease : '');
        tag.style.cssText = 'font-size:11px;color:#1d4ed8;font-weight:600;';
        unitTd.appendChild(tag);
      }
      tr.appendChild(unitTd);
      const values = [moneyNum(d.charge), moneyNum(d.tax), moneyNum(d.other), detailTotal(d)];
      const oldValues = old ? [moneyNum(old.charge), moneyNum(old.tax), moneyNum(old.other), detailTotal(old)] : null;
      values.forEach((v, i) => {
        const td = document.createElement('td');
        td.style.cssText = 'padding:4px 8px;border-bottom:1px solid #eef0f3;text-align:right;';
        td.textContent = formatCurrency(v.toFixed(2));
        if(oldValues && !d.__added && Math.round(oldValues[i]*100) !== Math.round(v*100)){
          td.style.fontWeight = '600';
          td.style.background = '#ecfdf5';
          const prev = document.createElement('div');
          prev.textContent = formatCurrency(oldValues[i].toFixed(2));
          prev.style.cssText = 'font-weight:400;color:#9ca3af;text-decoration:line-through;font-size:11px;';
          td.appendChild(prev);
        }
        tr.appendChild(td);
      });
      sum += detailTotal(d);
      tbody.appendChild(tr);
    });
    const totalRow = document.createElement('tr');
    const label = document.createElement('td'); label.textContent = 'Total'; label.colSpan = 4;
    label.style.cssText = 'padding:6px 8px;font-weight:600;text-align:right;';
    const val = document.createElement('td'); val.textContent = formatCurrency(sum.toFixed(2));
    val.style.cssText = 'padding:6px 8px;font-weight:600;text-align:right;';
    totalRow.appendChild(label); totalRow.appendChild(val); tbody.appendChild(totalRow);
    table.appendChild(tbody);
    return table;
  }

  function tcrUpdatePeriodCards(container, slices, oldSlices){
    slices.forEach((s, i) => {
      const card = document.createElement('div');
      card.style.cssText = 'border:1px solid #e6e9ee;border-radius:8px;padding:10px;margin-bottom:10px;background:#fafbfc;overflow-x:auto;';
      const title = document.createElement('strong');
      title.textContent = (slices.length > 1 ? 'Period ' + (i + 1) + ' ' : 'Period ') + '(' + formatDate(s.from) + ' — ' + formatDate(s.to) + ')';
      card.appendChild(title);
      const tableWrap = document.createElement('div'); tableWrap.style.marginTop = '8px';
      // Changes are only highlighted against an old period covering exactly the same dates —
      // when the periods were rebuilt there's nothing like-for-like to compare a value to.
      const oldMatch = oldSlices ? oldSlices.find(o => o.from === s.from && o.to === s.to) : null;
      tableWrap.appendChild(tcrUpdateDetailTable(s.unitDetails || [], oldMatch ? (oldMatch.unitDetails || []) : null));
      card.appendChild(tableWrap);
      container.appendChild(card);
    });
  }

  function tcrUpdateRenderCurrent(u){
    const wrap = qs('#tcrUpdateCurrent'); if(!wrap || !u) return;
    const reg = u.registry;
    wrap.innerHTML = '';
    const heading = document.createElement('h4'); heading.textContent = 'Current invoice'; heading.style.margin = '0 0 8px';
    wrap.appendChild(heading);
    const info = document.createElement('div');
    info.style.cssText = 'display:flex;flex-direction:column;gap:4px;font-size:13px;margin-bottom:10px;';
    [
      ['WD Invoice Number', reg.wdNumber || ''],
      ['Doc Number', reg.docNumber || ''],
      ['Lease', reg.lease || ''],
      ['Category', reg.category || ''],
      ['Period', formatDate(reg.periodStart) + ' — ' + formatDate(reg.periodEnd)],
      ['Invoice Date', formatDate(reg.invoiceDate) || '—'],
      ['Units', String((reg.units || []).length)],
      ['Total Amount', formatCurrency(moneyNum(reg.totalAmount).toFixed(2))]
    ].forEach(([label, val]) => {
      const row = document.createElement('div');
      row.innerHTML = `<strong>${escapeHtml(label)}:</strong> ${escapeHtml(val)}`;
      info.appendChild(row);
    });
    wrap.appendChild(info);
    tcrUpdatePeriodCards(wrap, u.slices, null);
  }

  // Clears the PDF preview of the tool with element-id prefix `p` (and its context's pending
  // rebuild, if one is open).
  function tcrUpdateClearPreview(p){
    const u = _tcrCtx[p];
    if(u){ u.newSlices = null; u.newTotal = 0; u.blockers = []; }
    const preview = tcrEl(p, 'Preview'); if(preview) preview.style.display = 'none';
    const warn = tcrEl(p, 'Warnings'); if(warn) warn.innerHTML = '';
    const nw = tcrEl(p, 'New'); if(nw) nw.innerHTML = '';
    const fileInput = tcrEl(p, 'File'); if(fileInput) fileInput.value = '';
    tcrUpdateSetStatus('#' + p + 'DropFileName', '');
    tcrUpdateSetStatus('#' + p + 'Status', '');
    const saveBtn = tcrEl(p, 'SaveBtn'); if(saveBtn){ saveBtn.disabled = true; saveBtn.textContent = 'Save Changes'; }
  }

  // Opens a PDF-update context for `registry` on the tool with element-id prefix `p`,
  // replacing any context that tool already had open.
  function tcrUpdateBegin(p, registry, onSaved){
    const slices = getRegistryCoveragePeriods(registry).map(s => ({ from: s.from, to: s.to, unitDetails: (s.unitDetails || []).slice() }));
    const quarterly = !!(registry.period1From || registry.period1To || (Array.isArray(registry.periods) && registry.periods.length > 0));
    _tcrCtx[p] = null;
    tcrUpdateClearPreview(p);
    const u = { p, registry, slices, quarterly, newSlices: null, newTotal: 0, blockers: [], onSaved };
    _tcrCtx[p] = u;
    return u;
  }

  function tcrUpdateEnd(p){
    _tcrCtx[p] = null;
    tcrUpdateClearPreview(p);
  }

  function tcrUpdateSelect(registry){
    const u = tcrUpdateBegin('tcrUpdate', registry, (reg, newTotal) => {
      const savedWd = reg.wdNumber;
      tcrUpdateReset();
      tcrUpdateSetStatus('#tcrUpdateSearchStatus', `✓ ${savedWd} updated — new total ${formatCurrency(newTotal.toFixed(2))}.`);
    });
    const matches = qs('#tcrUpdateMatches'); if(matches) matches.innerHTML = '';
    tcrUpdateRenderCurrent(u);
    const wrap = qs('#tcrUpdateInvoice'); if(wrap) wrap.style.display = 'block';
  }

  function tcrUpdateReset(){
    tcrUpdateEnd('tcrUpdate');
    const wrap = qs('#tcrUpdateInvoice'); if(wrap) wrap.style.display = 'none';
    const cur = qs('#tcrUpdateCurrent'); if(cur) cur.innerHTML = '';
    const matches = qs('#tcrUpdateMatches'); if(matches) matches.innerHTML = '';
    const search = qs('#tcrUpdateSearch'); if(search) search.value = '';
    tcrUpdateSetStatus('#tcrUpdateSearchStatus', '');
  }

  function tcrUpdateSearch(){
    const query = (qs('#tcrUpdateSearch') || {}).value || '';
    tcrUpdateEnd('tcrUpdate');
    const wrap = qs('#tcrUpdateInvoice'); if(wrap) wrap.style.display = 'none';
    const matchesWrap = qs('#tcrUpdateMatches'); if(matchesWrap) matchesWrap.innerHTML = '';
    if(!query.trim()){ tcrUpdateSetStatus('#tcrUpdateSearchStatus', 'Enter a WD Invoice Number.'); return; }
    const found = tcrUpdateFindRegistries(query);
    if(found.length === 0){ tcrUpdateSetStatus('#tcrUpdateSearchStatus', `No registered invoice found for "${query.trim()}".`); return; }
    if(found.length === 1){ tcrUpdateSetStatus('#tcrUpdateSearchStatus', ''); tcrUpdateSelect(found[0]); return; }
    // Same WD on more than one registry (different Doc numbers) — let the operator pick.
    tcrUpdateSetStatus('#tcrUpdateSearchStatus', `${found.length} invoices share this WD number — pick one:`);
    found.forEach(r => {
      const btn = document.createElement('button'); btn.type = 'button';
      btn.textContent = `${r.wdNumber} · Doc ${r.docNumber || '(none)'} · ${formatDate(r.periodStart)} — ${formatDate(r.periodEnd)} · ${formatCurrency(moneyNum(r.totalAmount).toFixed(2))}`;
      btn.style.cssText = 'display:block;margin-bottom:6px;font-size:12px;';
      btn.addEventListener('click', () => { tcrUpdateSetStatus('#tcrUpdateSearchStatus', ''); tcrUpdateSelect(r); });
      if(matchesWrap) matchesWrap.appendChild(btn);
    });
  }

  // Rebuilds the selected registry's periods/units from the parsed PDF exactly the way the
  // import's "Send to Registration" would lay them out (see sendToRegistrationTcr): one period
  // per billed month when the invoice is on a Quarterly lease (or was already registered with
  // periods), otherwise every month merged into one breakdown spanning the PDF's whole range.
  // Every period lists every unit — the ones already on the invoice plus any the PDF bills —
  // with each unit's lease details carried over from its existing row, blanks filled from its
  // own unit record. Also collects anything that should block the save or just be pointed out.
  function tcrUpdateBuild(u, header, built, parseIssues){
    const { registry, slices } = u;
    const blockers = [];
    const warnings = [];

    if(header.docNumber && registry.docNumber && normKey(header.docNumber) !== normKey(registry.docNumber)){
      blockers.push(`This PDF is invoice ${header.docNumber}, but ${registry.wdNumber} was registered with Doc Number ${registry.docNumber}. Drop the matching PDF.`);
    }
    if(!header.docNumber) warnings.push('The PDF\'s invoice (Doc) number couldn\'t be read — make sure it\'s the right invoice before saving.');
    // A credit memo's amounts are negative, which is only valid under the Credit category (same
    // rule as the registration form) — so a credit memo always saves as Credit.
    let category = registry.category || '';
    if(header.isCredit){
      warnings.push('This PDF is a Credit Memo — every amount below is saved as negative.');
      if(normKey(category) !== 'credit'){
        const configured = ((state.meta && state.meta.devRentals) || []).find(r => normKey(r) === 'credit');
        category = configured || 'Credit';
        warnings.push(`Category changes from "${registry.category || '(none)'}" to "${category}".`);
      }
    }
    if(built.periods.length === 0) blockers.push('None of the units billed in the PDF exist in the system, so there\'s nothing to update.');
    if(parseIssues.length) warnings.push(`${parseIssues.length} line item(s) in the PDF couldn't be read confidently and aren't included. Use the Import Invoice processor to see them.`);
    if(built.unmatchedUnitIds.length) warnings.push(`${built.unmatchedUnitIds.length} unit(s) in the PDF don't exist in the system and are skipped: ${built.unmatchedUnitIds.join(', ')}`);

    const regLeases = (Array.isArray(registry.leases) && registry.leases.length ? registry.leases : (registry.lease || '').split(',')).map(normKey).filter(Boolean);

    // Every unit on the updated invoice, in order: what it already lists, then what the PDF adds.
    const unitOrder = [];
    const pushUnit = uid => { if(uid && !unitOrder.some(x => normKey(x) === normKey(uid))) unitOrder.push(uid); };
    // pdfUnitsOnly (the edit form's drop zone): the PDF replaces the unit list outright.
    const pdfUnitsOnly = !!(u.opts && u.opts.pdfUnitsOnly);
    if(!pdfUnitsOnly){
      (registry.units || []).forEach(pushUnit);
      slices.forEach(s => s.unitDetails.forEach(d => pushUnit(d.unit)));
    }
    built.matchedUnitIds.forEach(pushUnit);
    if(pdfUnitsOnly){
      const dropped = [];
      (registry.units || []).concat(...slices.map(s => s.unitDetails.map(d => d.unit))).forEach(x => {
        if(x && !unitOrder.some(y => normKey(y) === normKey(x)) && !dropped.some(y => normKey(y) === normKey(x))) dropped.push(x);
      });
      if(dropped.length) warnings.push(`Not billed in the PDF, so removed from the invoice: ${dropped.join(', ')}`);
    }

    const oldByUnit = {};
    slices.forEach(s => s.unitDetails.forEach(d => { const k = normKey(d.unit); if(!oldByUnit[k]) oldByUnit[k] = d; }));

    // Per-unit lease details (no amounts), resolved exactly like the registration form does —
    // from the unit's own record and that record's lease. The invoice's old row only fills in
    // for a unit that no longer exists in the system.
    const existingLeases = new Set(regLeases);
    const addedUnits = [], addedLeases = new Set(), noLeaseUnits = [];
    const baseByUnit = {};
    unitOrder.forEach(uid => {
      const k = normKey(uid);
      const old = oldByUnit[k];
      const unitRec = (state.units || []).find(u => normKey(u.unitId || u.id) === k);
      const base = { unit: uid };
      if(unitRec){
        Object.assign(base, resolveInvoiceUnitLeaseInfo(uid, []), { costCenter: unitRec.costCenter || '' });
      } else if(old){
        ['lease','company','supplier','arrangement','invoicing','costCenter'].forEach(f => { base[f] = old[f] || ''; });
      }
      if(!base.lease) noLeaseUnits.push(uid);
      if(!old && !(registry.units || []).some(x => normKey(x) === k)){ base.__added = true; addedUnits.push(uid); }
      if(base.lease && !existingLeases.has(normKey(base.lease))) addedLeases.add(base.lease);
      baseByUnit[k] = base;
    });

    // Same period rule as sendToRegistrationTcr.
    const leaseRecFor = l => (state.leases || []).find(x => normKey(x.leaseNumber || x.id) === normKey(l));
    const allLeases = regLeases.concat(Array.from(addedLeases), header.leaseNumber ? [header.leaseNumber] : []);
    const isQuarterlyLease = allLeases.some(l => { const rec = leaseRecFor(l); return !!rec && normKey(rec.arrangement) === 'quarterly'; });
    const usePeriods = built.periods.length > 1 && (isQuarterlyLease || u.quarterly);
    if(built.periods.length > 1 && !usePeriods){
      warnings.push(`The PDF bills ${built.periods.length} separate months, but none of this invoice's leases is marked Quarterly — they're merged into one period, the same as the import does.`);
    }

    const rowFor = (data, uid) => { const key = Object.keys(data).find(k => normKey(k) === normKey(uid)); return key ? data[key] : null; };
    const makeDetails = data => unitOrder.map(uid => {
      const row = rowFor(data, uid);
      return Object.assign({}, baseByUnit[normKey(uid)], {
        charge: row ? money2(moneyNum(row.charge)) : '',
        tax: row ? money2(moneyNum(row.tax)) : '',
        other: row ? money2(moneyNum(row.other)) : '',
        otherChargeDetails: row ? (row.otherChargeDetails || []) : []
      });
    });

    let newSlices;
    if(usePeriods){
      newSlices = built.periods.map(p => ({ from: p.fromDate, to: p.toDate, unitDetails: makeDetails(p.unitData) }));
    } else {
      const merged = {};
      built.periods.forEach(p => {
        Object.keys(p.unitData).forEach(uid => {
          const row = p.unitData[uid];
          if(!merged[uid]) merged[uid] = { charge: 0, tax: 0, other: 0, otherChargeDetails: [] };
          merged[uid].charge += moneyNum(row.charge);
          merged[uid].tax += moneyNum(row.tax);
          merged[uid].other += moneyNum(row.other);
          merged[uid].otherChargeDetails = merged[uid].otherChargeDetails.concat(row.otherChargeDetails || []);
        });
      });
      newSlices = [{ from: built.overallFrom, to: built.overallTo, unitDetails: makeDetails(merged) }];
    }

    const overallFrom = built.overallFrom || registry.periodStart || '';
    const overallTo = built.overallTo || registry.periodEnd || '';
    if(overallFrom !== (registry.periodStart || '') || overallTo !== (registry.periodEnd || '')){
      warnings.push(`The invoice period changes from ${formatDate(registry.periodStart) || '(none)'} — ${formatDate(registry.periodEnd) || '(none)'} to ${formatDate(overallFrom)} — ${formatDate(overallTo)}, per the PDF.`);
    }
    const oldLayout = slices.map(s => s.from + '|' + s.to).join(',');
    const newLayout = newSlices.map(s => s.from + '|' + s.to).join(',');
    if(oldLayout !== newLayout){
      warnings.push(usePeriods
        ? `Periods are rebuilt as ${newSlices.length} monthly periods (was ${slices.length}).`
        : `Periods are rebuilt as one period (was ${slices.length}).`);
    }

    const billedUnits = new Set();
    newSlices.forEach(s => s.unitDetails.forEach(d => { if(detailTotal(d)) billedUnits.add(normKey(d.unit)); }));
    const unbilled = unitOrder.filter(uid => !billedUnits.has(normKey(uid)));
    if(addedUnits.length) warnings.push(`${addedUnits.length} unit(s) billed in the PDF aren't on this invoice and will be added: ${addedUnits.join(', ')}`);
    if(addedLeases.size) warnings.push(`Lease(s) added to this invoice from its units' records: ${Array.from(addedLeases).join(', ')}`);
    if(noLeaseUnits.length) warnings.push(`No lease in the unit record for ${noLeaseUnits.join(', ')} — saved without one.`);
    if(unbilled.length) warnings.push(`No amounts in the PDF for ${unbilled.join(', ')} — they stay on the invoice with blank amounts.`);

    const newTotal = newSlices.reduce((s, sl) => s + sl.unitDetails.reduce((a, d) => a + detailTotal(d), 0), 0);
    const pdfTotal = header.subtotalAmount !== null ? header.subtotalAmount + (header.tax || 0) : header.totalAmount;
    if(pdfTotal !== null && Math.round(newTotal*100) !== Math.round(pdfTotal*100)){
      warnings.push(`Updated total (${formatCurrency(newTotal.toFixed(2))}) doesn't match the PDF's own total (${formatCurrency(pdfTotal.toFixed(2))}, Subtotal + Tax).`);
    }
    if(header.tax === null) warnings.push('The PDF\'s Tax row couldn\'t be read — no tax was allocated.');

    return { newSlices, newTotal, blockers, warnings, usePeriods, overallFrom, overallTo, category };
  }

  function tcrUpdateRenderPreview(u, result){
    const warnWrap = tcrEl(u.p, 'Warnings');
    const newWrap = tcrEl(u.p, 'New');
    if(!warnWrap || !newWrap) return;
    warnWrap.innerHTML = ''; newWrap.innerHTML = '';
    result.blockers.forEach(msg => {
      const d = document.createElement('div');
      d.style.cssText = 'background:#fee2e2;color:#991b1b;border:1px solid #fecaca;border-radius:6px;padding:8px 10px;font-size:12px;margin-bottom:6px;';
      d.textContent = '⛔ ' + msg;
      warnWrap.appendChild(d);
    });
    result.warnings.forEach(msg => {
      const d = document.createElement('div');
      d.style.cssText = 'background:#fef9c3;color:#92400e;border:1px solid #fde68a;border-radius:6px;padding:8px 10px;font-size:12px;margin-bottom:6px;';
      d.textContent = '⚠ ' + msg;
      warnWrap.appendChild(d);
    });
    const heading = document.createElement('h4'); heading.style.margin = '0 0 8px';
    const oldTotal = moneyNum(u.registry.totalAmount);
    heading.textContent = `Updated data — total ${formatCurrency(result.newTotal.toFixed(2))} (was ${formatCurrency(oldTotal.toFixed(2))})`;
    newWrap.appendChild(heading);
    tcrUpdatePeriodCards(newWrap, result.newSlices, u.slices);
    const preview = tcrEl(u.p, 'Preview'); if(preview) preview.style.display = 'block';
  }

  async function tcrUpdateHandleFile(u, file){
    if(!u || _tcrCtx[u.p] !== u) return;
    const p = u.p;
    const status = msg => tcrUpdateSetStatus('#' + p + 'Status', msg);
    tcrUpdateClearPreview(p);
    tcrUpdateSetStatus('#' + p + 'DropFileName', file.name);
    status('Reading PDF…');
    try{
      const lib = await loadPdfJs();
      const pdf = await lib.getDocument({ data: await file.arrayBuffer() }).promise;
      const rows = await extractRows(pdf);
      if(detectInvoiceType(rows) !== 'tcr'){ status('This isn\'t a TCR Americas invoice PDF.'); return; }
      const header = parseHeaderInfo(rows);
      const { unitMonthCat, totalCandidates, issues } = parseDetailRows(rows, header.isCredit ? -1 : 1);
      if(totalCandidates === 0){ status('No recognizable line items found — this may not be a TCR quarterly usage-detail invoice.'); return; }
      const built = buildPeriods(unitMonthCat, header.tax);
      if(_tcrCtx[p] !== u) return; // cancelled (or another invoice picked) while reading
      const result = tcrUpdateBuild(u, header, built, issues);
      Object.assign(u, { newSlices: result.newSlices, newTotal: result.newTotal, blockers: result.blockers, usePeriods: result.usePeriods, overallFrom: result.overallFrom, overallTo: result.overallTo, category: result.category });
      tcrUpdateRenderPreview(u, result);
      status(result.blockers.length ? 'Can\'t save — see the issues below.' : 'Review the updated amounts below, then Save Changes.');
      const saveBtn = tcrEl(p, 'SaveBtn'); if(saveBtn) saveBtn.disabled = result.blockers.length > 0;
    }catch(err){
      status('Failed to parse PDF: ' + (err && err.message ? err.message : String(err)));
    }
  }

  function tcrUpdateUserName(){
    const session = typeof currentSession === 'function' ? currentSession() : null;
    if(!session) return 'Unknown User';
    if(session.user === 'Master') return 'Master';
    const u = (state.users || []).find(x => x.username === session.user);
    if(!u) return session.user || 'Unknown User';
    return ((u.firstName || '') + ' ' + (u.lastName || '')).trim() || u.username || 'Unknown User';
  }

  // Google Sheets rejects any single cell over 50,000 characters. unitDetails/periods are split
  // across cells by db.js; the other JSON columns are checked before sending so an oversized
  // invoice fails with a clear message instead of a half-understood error from the backend.
  const SHEETS_CELL_LIMIT = 50000;

  // Writes the rebuilt invoice as a complete, fresh registry record rather than merging the
  // changes into the loaded one: the invoice's identifying info (id/seq/WD/Doc/category/invoice
  // and submitted dates/created/comments) is carried over from the looked-up record, and every
  // unit/lease/period/amount field is rewritten from the PDF exactly as a new registration would
  // save it (see the invoiceForm submit handler). Only these known columns are sent, so stray
  // keys picked up while loading (raw sheet headers etc.) never get written back, and the
  // backend's updateRow leaves every other column of the row untouched. The write is one
  // whole-row overwrite by id, so retrying it can't duplicate or partially apply anything —
  // and nothing in memory changes until Google Sheets confirms it.
  // The progress window (app.js beginBlockingProgress) always closes, even on an unexpected error.
  async function tcrUpdateSave(u){
    try{ return await _tcrUpdateSave(u); }
    catch(e){ console.error('TCR invoice update error:', e); endBlockingProgress(); alert('Unexpected error while saving: ' + ((e && e.message) || e)); }
    finally{ endBlockingProgress(); }
  }

  async function _tcrUpdateSave(u){
    if(!u || _tcrCtx[u.p] !== u || !u.newSlices || u.blockers.length) return;
    const reg = u.registry;
    if(!reg.id){
      alert(`Registry ${reg.seq || ''} (WD ${reg.wdNumber || '(no WD)'}) has no saved identifier in Google Sheets, so it can't be updated safely. Add an identifier to that row in the "invoices" sheet, then reload.`);
      return;
    }

    // Same per-unit field set (and order) the registration form saves.
    const toDetail = d => ({
      unit: d.unit, lease: d.lease || '', company: d.company || '', supplier: d.supplier || '',
      arrangement: d.arrangement || '', invoicing: d.invoicing || '', costCenter: d.costCenter || '',
      tax: d.tax || '', other: d.other || '', otherChargeDetails: d.otherChargeDetails || [], charge: d.charge || ''
    });
    const newSlices = u.newSlices.map(s => ({ from: s.from, to: s.to, unitDetails: s.unitDetails.map(toDetail) }));

    const units = [], leases = [];
    newSlices.forEach(s => s.unitDetails.forEach(d => {
      if(d.unit && !units.some(x => normKey(x) === normKey(d.unit))) units.push(d.unit);
      if(d.lease && !leases.some(x => normKey(x) === normKey(d.lease))) leases.push(d.lease);
    }));
    const addedUnits = units.filter(x => !(reg.units || []).some(y => normKey(y) === normKey(x)));
    const oldTotal = moneyNum(reg.totalAmount);
    // A credit memo switches the invoice to Credit (see tcrUpdateBuild); otherwise unchanged.
    const category = u.category !== undefined ? u.category : (reg.category || '');
    const categoryChanged = category !== (reg.category || '');

    const record = {
      id: reg.id,
      seq: reg.seq,
      wdNumber: reg.wdNumber || '',
      docNumber: reg.docNumber || '',
      category,
      totalAmount: u.newTotal.toFixed(2),
      unitCount: units.length,
      units,
      invoiceDate: reg.invoiceDate || '',
      periodStart: u.overallFrom || '',
      periodEnd: u.overallTo || '',
      submittedDate: reg.submittedDate || '',
      createdAt: reg.createdAt || '',
      comments: (Array.isArray(reg.comments) ? reg.comments.slice() : []).concat([{
        text: `Amounts updated from the TCR invoice PDF (TCR Americas — Update Invoice). Total ${formatCurrency(oldTotal.toFixed(2))} → ${formatCurrency(u.newTotal.toFixed(2))}.` + (categoryChanged ? ` Category ${reg.category || '(none)'} → ${category} (Credit Memo).` : '') + (addedUnits.length ? ` Units added: ${addedUnits.join(', ')}.` : ''),
        user: tcrUpdateUserName(),
        timestamp: new Date().toISOString()
      }]),
      leases,
      lease: leases.join(', '),
      // Period 1 lives on unitDetails (+ period1From/To when quarterly), every later period in
      // periods[] — the same layout the registration form saves.
      unitDetails: newSlices[0].unitDetails,
      periods: u.usePeriods ? newSlices.slice(1).map(s => ({ fromDate: s.from, toDate: s.to, unitDetails: s.unitDetails })) : []
    };
    // Only touch the period-1 columns when this invoice uses them now or used them before (to
    // clear stale values) — otherwise a plain invoice would add empty columns to the sheet.
    if(u.usePeriods || reg.period1From || reg.period1To){
      record.period1From = u.usePeriods ? newSlices[0].from : '';
      record.period1To = u.usePeriods ? newSlices[0].to : '';
    }
    // Carry over which continuation columns this row already has (see db.js's
    // REGISTRY_SPLIT_FIELDS) so any the rewritten data no longer needs get blanked.
    Object.keys(reg).forEach(k => { if(/^(unitDetails|periods)__\d+$/.test(k)) record[k] = ''; });

    // unitDetails/periods are split across cells by db.js when needed; these aren't.
    const oversized = ['units','leases','comments']
      .filter(k => JSON.stringify(record[k]).length > SHEETS_CELL_LIMIT);
    if(oversized.length){
      alert(`This invoice is too large to store: the ${oversized.join(', ')} data would exceed Google Sheets' 50,000-character limit for a single cell. Nothing was saved.`);
      return;
    }

    const saveBtn = tcrEl(u.p, 'SaveBtn');
    const cancelBtn = tcrEl(u.p, 'CancelBtn');
    if(saveBtn){ saveBtn.disabled = true; saveBtn.textContent = 'Saving...'; }
    if(cancelBtn) cancelBtn.disabled = true;
    const restoreButtons = () => {
      if(saveBtn){ saveBtn.disabled = false; saveBtn.textContent = 'Save Changes'; }
      if(cancelBtn) cancelBtn.disabled = false;
    };
    beginBlockingProgress(`Updating ${reg.wdNumber || '(no WD)'} from its PDF`, 'Step 1 of 2 — Writing the rebuilt invoice to Google Sheets…');
    setBlockingProgress(15);

    // A network-level failure ("Failed to fetch") leaves it unknown whether the request reached
    // Google at all; since this is a whole-row overwrite by id, re-sending the same record is
    // safe either way, so retry those once before reporting.
    const isNetworkError = e => /Failed to fetch|NetworkError|Load failed|network/i.test((e && e.message) || '');
    let lastErr = null;
    for(let attempt = 1; attempt <= 2; attempt++){
      try{
        await DB.updateRegistry(record);
        lastErr = null;
        break;
      }catch(e){
        lastErr = e;
        console.error(`TCR invoice update save error (attempt ${attempt}):`, e);
        if(attempt === 1 && isNetworkError(e)){
          tcrUpdateSetStatus('#' + u.p + 'Status', 'Connection to Google Sheets dropped — retrying…');
          setBlockingProgress(30, 'Step 1 of 2 — Connection to Google Sheets dropped, retrying…');
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }
        break;
      }
    }
    if(lastErr){
      restoreButtons();
      endBlockingProgress();
      tcrUpdateSetStatus('#' + u.p + 'Status', 'Not saved — see the message.');
      alert('Failed to save to Google Sheets: ' + lastErr.message + '\n\nNothing was changed in the app. It\'s safe to press Save Changes again — the invoice is rewritten as a whole, so a repeated save can\'t duplicate anything.');
      return;
    }
    restoreButtons();
    setBlockingProgress(80, 'Step 2 of 2 — Updating the app with the saved invoice…');

    // Confirmed saved — now mirror it in memory. The registry object keeps its identity (other
    // views hold references to it); every rewritten field is replaced outright.
    Object.assign(reg, record);
    if(!record.period1From && !record.period1To){ delete reg.period1From; delete reg.period1To; }

    // In-session invoice records mirror Period 1 (see the registration submit handler): rebuild
    // this invoice's set from scratch, keeping each surviving unit's existing record id.
    const wd = normKey(reg.wdNumber), doc = normKey(reg.docNumber);
    const isThisInvoice = i => normKey(i.wdNumber) === wd && normKey(i.docNumber) === doc;
    const oldInvoices = (state.invoices || []).filter(isThisInvoice);
    const fresh = record.unitDetails.map(d => {
      const prev = oldInvoices.find(i => normKey(i.unit) === normKey(d.unit));
      return {
        id: prev ? prev.id : id(), unit: d.unit, comment: prev ? (prev.comment || '') : '',
        wdNumber: record.wdNumber, docNumber: record.docNumber, category: record.category,
        invoiceDate: record.invoiceDate, periodStart: record.periodStart, periodEnd: record.periodEnd,
        submittedDate: record.submittedDate,
        lease: d.lease, company: d.company, supplier: d.supplier, arrangement: d.arrangement, invoicing: d.invoicing,
        amount: d.charge, taxAmount: d.tax, otherCharges: d.other, otherChargeDetails: d.otherChargeDetails
      };
    });
    state.invoices = (state.invoices || []).filter(i => !isThisInvoice(i)).concat(fresh);

    saveState();
    renderRegistries(reg.id);
    renderInvoices();
    renderUnitOverview();
    renderLeaseOverview();
    renderOverview();

    _tcrCtx[u.p] = null;
    tcrUpdateClearPreview(u.p);
    setBlockingProgress(100, 'Done.');
    endBlockingProgress();
    if(typeof u.onSaved === 'function') u.onSaved(reg, u.newTotal);
  }

  // Wires a tool's PDF drop zone and Save/Cancel buttons (#<p>DropZone, #<p>File, #<p>Status,
  // #<p>SaveBtn, #<p>CancelBtn) to whatever context that tool currently has open.
  function tcrUpdateWire(p, onCancel){
    wirePdfDropZone('#' + p + 'DropZone', '#' + p + 'File', '#' + p + 'Status', file => tcrUpdateHandleFile(_tcrCtx[p], file));
    const saveBtn = tcrEl(p, 'SaveBtn');
    if(saveBtn) saveBtn.addEventListener('click', () => tcrUpdateSave(_tcrCtx[p]));
    const cancelBtn = tcrEl(p, 'CancelBtn');
    if(cancelBtn && onCancel) cancelBtn.addEventListener('click', onCancel);
  }

  // Lets unitIdCorrection.js run this same PDF update against an invoice it picked.
  window.TcrInvoiceUpdater = { begin: tcrUpdateBegin, end: tcrUpdateEnd, wire: tcrUpdateWire };

  const tcrUpdateSearchInput = qs('#tcrUpdateSearch');
  if(tcrUpdateSearchInput) tcrUpdateSearchInput.addEventListener('keydown', e => { if(e.key === 'Enter'){ e.preventDefault(); tcrUpdateSearch(); } });
  const tcrUpdateSearchBtn = qs('#tcrUpdateSearchBtn');
  if(tcrUpdateSearchBtn) tcrUpdateSearchBtn.addEventListener('click', tcrUpdateSearch);
  tcrUpdateWire('tcrUpdate', tcrUpdateReset);

  // ---- Edit Invoice (replace mode) — refill the form from a supplier PDF ----
  // Reads a TCR Americas or Fortbrand PDF and reloads the Invoice Registration form (still in
  // replace mode for the same registry) with the PDF's doc number, invoice date, period(s),
  // units and amounts. Nothing is written until Save Changes; a PDF from any other supplier,
  // or one whose Doc number doesn't match the invoice, leaves the form untouched.
  const REPLACE_SUPPLIERS = 'TCR Americas, Fortbrand';
  function replaceStatus(msg, kind){
    const el = qs('#invoiceReplaceStatus'); if(!el) return;
    el.textContent = msg || '';
    el.style.color = kind === 'error' ? '#991b1b' : kind === 'ok' ? '#166534' : '#1e3a8a';
    el.style.fontWeight = kind ? '600' : '';
  }
  let _replaceReadSeq = 0;
  async function fillReplaceFormFromPdf(file){
    const form = qs('#invoiceForm');
    const regId = form && form.dataset.replacingRegistry;
    const reg = regId && (state.registries || []).find(r => r.id === regId);
    if(!reg){ replaceStatus('No invoice is being edited.', 'error'); return; }
    const seq = ++_replaceReadSeq;
    const fn = qs('#invoiceReplaceDropFileName'); if(fn) fn.textContent = file.name;
    const fileInput = qs('#invoiceReplaceFile'); if(fileInput) fileInput.value = '';
    const unchanged = ' Nothing in the form was changed.';
    replaceStatus('Reading PDF…');
    try{
      const lib = await loadPdfJs();
      const pdf = await lib.getDocument({ data: await file.arrayBuffer() }).promise;
      const rows = await extractRows(pdf);
      if(seq !== _replaceReadSeq || form.dataset.replacingRegistry !== regId) return; // superseded or edit closed
      const type = detectInvoiceType(rows);
      let header, built, issues = [], supplier;
      if(type === 'tcr'){
        supplier = 'TCR Americas';
        header = parseHeaderInfo(rows);
        const r = parseDetailRows(rows, header.isCredit ? -1 : 1);
        if(r.totalCandidates === 0){ replaceStatus('This looks like a TCR Americas PDF, but no line items could be read.' + unchanged, 'error'); return; }
        built = buildPeriods(r.unitMonthCat, header.tax);
        issues = r.issues;
      } else if(type === 'fortbrand'){
        supplier = 'Fortbrand';
        const parsed = parseFortbrandRows(rows);
        header = parsed.header;
        built = buildFortbrand(parsed);
        if(!built.unitLineCount){ replaceStatus('This looks like a Fortbrand PDF, but no unit lines could be read — this layout isn\'t supported yet.' + unchanged, 'error'); return; }
      } else {
        replaceStatus(`"${file.name}" isn't an invoice from an accepted supplier (${REPLACE_SUPPLIERS}).` + unchanged, 'error');
        return;
      }

      const u = {
        registry: reg,
        slices: getRegistryCoveragePeriods(reg).map(s => ({ from: s.from, to: s.to, unitDetails: (s.unitDetails || []).slice() })),
        quarterly: !!(reg.period1From || reg.period1To || (Array.isArray(reg.periods) && reg.periods.length > 0)),
        opts: { pdfUnitsOnly: true }
      };
      const result = tcrUpdateBuild(u, header, built, issues);
      if(result.blockers.length){ replaceStatus('⛔ ' + result.blockers.join(' ') + unchanged, 'error'); return; }

      // Sanity check: units whose supplier (from Unit Control) clearly isn't this one.
      const supplierKey = type === 'tcr' ? 'tcr' : 'fortbrand';
      const otherSupplier = [];
      result.newSlices.forEach(s => s.unitDetails.forEach(d => {
        const label = d.unit + ' (' + d.supplier + ')';
        if(d.supplier && normKey(d.supplier).indexOf(supplierKey) === -1 && otherSupplier.indexOf(label) === -1) otherSupplier.push(label);
      }));
      const notes = result.warnings.slice();
      if(otherSupplier.length) notes.unshift(`This is a ${supplier} PDF, but these units are recorded under another supplier: ${otherSupplier.join(', ')}. Make sure it's the right invoice.`);

      let category = result.category;
      if(!category){
        const rental = ((state.meta && state.meta.devRentals) || []).find(r => normKey(r) === 'rental');
        category = rental || '';
      }
      const slicesOut = result.newSlices;
      const units = [], leases = [];
      slicesOut.forEach(s => s.unitDetails.forEach(d => {
        if(d.unit && !units.some(x => normKey(x) === normKey(d.unit))) units.push(d.unit);
        if(d.lease && !leases.some(x => normKey(x) === normKey(d.lease))) leases.push(d.lease);
      }));
      const pseudo = Object.assign({}, reg, {
        docNumber: header.docNumber || reg.docNumber || '',
        category,
        invoiceDate: header.invoiceDateIso || reg.invoiceDate || '',
        periodStart: result.overallFrom || '',
        periodEnd: result.overallTo || '',
        units, leases, lease: leases.join(', '),
        unitDetails: slicesOut[0] ? slicesOut[0].unitDetails : [],
        periods: result.usePeriods ? slicesOut.slice(1).map(s => ({ fromDate: s.from, toDate: s.to, unitDetails: s.unitDetails })) : [],
        totalAmount: result.newTotal.toFixed(2)
      });
      delete pseudo.period1From; delete pseudo.period1To;
      if(result.usePeriods && slicesOut[0]){ pseudo.period1From = slicesOut[0].from; pseudo.period1To = slicesOut[0].to; }

      loadRegistryIntoInvoiceForm(pseudo, { source: `${supplier} PDF ${file.name}`, notes });
      const fn2 = qs('#invoiceReplaceDropFileName'); if(fn2) fn2.textContent = file.name;
      replaceStatus(`✓ Form filled from ${supplier} invoice ${header.docNumber || ''} — ${units.length} unit(s), total ${formatCurrency(result.newTotal.toFixed(2))}. Review it, then press Save Changes.`, 'ok');
    }catch(err){
      console.error('Edit Invoice PDF read error:', err);
      replaceStatus('Failed to read the PDF: ' + ((err && err.message) || err) + '.' + unchanged, 'error');
    }
  }
  wirePdfDropZone('#invoiceReplaceDropZone', '#invoiceReplaceFile', '#invoiceReplaceStatus', fillReplaceFormFromPdf);

  const sendBtn = qs('#pdfImportSendBtn');
  if(sendBtn) sendBtn.addEventListener('click', sendToRegistration);
  const clearBtn = qs('#pdfImportClearBtn');
  if(clearBtn) clearBtn.addEventListener('click', clearImport);
})();
