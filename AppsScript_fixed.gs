const SECRET_KEY = 'AGI_EQP_2026_s3cur3key';
const SHEET_ID = SpreadsheetApp.getActiveSpreadsheet().getId();

function doGet(e) {
  return handleRequest(e);
}

function doPost(e) {
  return handleRequest(e);
}

function handleRequest(e) {
  // Serialize every request this script handles. Without this, two requests that arrive at
  // nearly the same moment (two open tabs, a background auto-refresh overlapping a save, or
  // the brief overlap while a new deployment is rolling out) can interleave their sheet reads
  // and writes — e.g. one request's getMeta() reads the "meta" sheet half-way through another
  // request's saveMeta() writing it, or two saveMeta() calls race and the one that finishes
  // last silently wins with whatever (possibly stale/incomplete) data it started with. That
  // race is what was erasing Developer tab config lists. Waiting for the lock makes requests
  // queue instead of interleave.
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
  } catch (lockErr) {
    return ContentService
      .createTextOutput(JSON.stringify({ success: false, error: 'Server is busy handling another request — please try again in a moment.' }))
      .setMimeType(ContentService.MimeType.JSON);
  }
  try {
    const params = e.parameter || {};
    const postData = e.postData ? JSON.parse(e.postData.contents) : {};

    // ── Security check ──────────────────────────────
    const key = params.secret || postData.secret;
    if(key !== SECRET_KEY){
      return ContentService
        .createTextOutput(JSON.stringify({ success: false, error: 'Unauthorized' }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    // ────────────────────────────────────────────────

    const action = params.action || postData.action;
    const sheet = params.sheet || postData.sheet;

    let result;

    switch(action) {
      case 'getAll':
        result = getAllRows(sheet);
        break;
      case 'save':
        result = saveRow(sheet, postData.data);
        break;
      case 'update':
        result = updateRow(sheet, postData.id, postData.data);
        break;
      case 'delete':
        result = deleteRow(sheet, postData.id, postData.fallbackMatch);
        break;
      case 'getMeta':
        result = getMeta();
        break;
      case 'saveMeta':
        result = saveMeta(postData.data);
        break;
      case 'bulkSave':
        result = bulkSave(sheet, postData.data);
        break;
      case 'bulkDelete':
        result = bulkDelete(sheet, postData.ids);
        break;
      case 'repairMissingIds':
        result = repairMissingIds(sheet);
        break;
      default:
        // Throwing here (instead of returning {error: ...} inside a success:true response)
        // means an action the client knows about but this deployment doesn't yet — e.g. a new
        // action added to the client before this file was redeployed — fails loudly with a
        // console error the client actually sees, rather than silently reporting "success"
        // while doing nothing. That silent-no-op is exactly what made bulkDelete look like it
        // worked (the UI updated locally) while never actually touching the sheet.
        throw new Error('Unknown action: ' + action);
    }

    return ContentService
      .createTextOutput(JSON.stringify({ success: true, data: result }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch(err) {
    return ContentService
      .createTextOutput(JSON.stringify({ success: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  } finally {
    lock.releaseLock();
  }
}

function getSheet(name) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    // Fall back to a case-insensitive, whitespace-trimmed match — protects against a tab
    // name that differs only by stray spacing or casing from what the app requests (this is
    // exactly the class of bug that made the whole app fail to load over one mismatched
    // sheet name).
    const target = name.toString().trim().toLowerCase();
    sheet = ss.getSheets().find(s => s.getName().trim().toLowerCase() === target);
  }
  if (!sheet) throw new Error('Sheet not found: ' + name);
  return sheet;
}

function formatVal(v) {
  if (v instanceof Date) {
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, '0');
    const d = String(v.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + d;
  }
  if (v === null || v === undefined) return '';
  return v;
}

function getAllRows(sheetName) {
  const sheet = getSheet(sheetName);
  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return [];
  const headers = data[0];
  return data.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = formatVal(row[i]); });
    return obj;
  });
}

// Reads the current header row and appends a new column for any key present in `data`
// that doesn't already have a matching header — so new fields are never silently
// dropped again (this is what was happening to "leases" and "unitDetails").
function ensureHeaders(sheet, data) {
  const lastCol = Math.max(sheet.getLastColumn(), 1);
  let headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const missing = Object.keys(data).filter(k => headers.indexOf(k) === -1);
  if (missing.length > 0) {
    sheet.getRange(1, headers.length + 1, 1, missing.length).setValues([missing]);
    headers = headers.concat(missing);
  }
  return headers;
}

function saveRow(sheetName, data) {
  const sheet = getSheet(sheetName);
  data = data || {};
  // Every saved row must have a real, unique id — never rely on the caller alone for this.
  if (!data.id) data.id = Utilities.getUuid();
  const headers = ensureHeaders(sheet, data);
  const row = headers.map(h => data[h] !== undefined ? data[h] : '');
  sheet.appendRow(row);
  return { saved: true, id: data.id };
}

function updateRow(sheetName, id, data) {
  const sheet = getSheet(sheetName);
  data = data || {};
  const headers = ensureHeaders(sheet, data);
  const allData = sheet.getDataRange().getValues();
  const idCol = headers.indexOf('id');
  if (idCol === -1) throw new Error('No id column found');
  // Never match on a blank id — with several rows sharing a blank id, that would silently
  // update whichever one happens to come first instead of the intended row.
  if (!id) throw new Error('Cannot update a row without a valid id');
  for (let i = 1; i < allData.length; i++) {
    if (String(allData[i][idCol]) === String(id)) {
      const row = headers.map((h, ci) => data[h] !== undefined ? data[h] : (ci < allData[i].length ? allData[i][ci] : ''));
      sheet.getRange(i + 1, 1, 1, headers.length).setValues([row]);
      return { updated: true, id };
    }
  }
  throw new Error('Row not found: ' + id);
}

function deleteRow(sheetName, id, fallbackMatch) {
  const sheet = getSheet(sheetName);
  const allData = sheet.getDataRange().getValues();
  const headers = allData[0];
  const idCol = headers.indexOf('id');
  if (idCol === -1) throw new Error('No id column found');
  if (!id) throw new Error('Cannot delete a row without a valid id');
  for (let i = 1; i < allData.length; i++) {
    if (String(allData[i][idCol]) === String(id)) {
      sheet.deleteRow(i + 1);
      return { deleted: true, id };
    }
  }

  // Fall back to matching by other identifying fields (e.g. wdNumber + docNumber) when the id
  // itself can't be found — protects against a row whose id ended up blank or mismatched from
  // an earlier write issue, which would otherwise leave that row permanently un-deletable.
  if (fallbackMatch && typeof fallbackMatch === 'object') {
    const matchKeys = Object.keys(fallbackMatch).filter(k => fallbackMatch[k] !== undefined && fallbackMatch[k] !== '');
    if (matchKeys.length > 0) {
      const colIdxs = matchKeys.map(k => headers.indexOf(k));
      if (colIdxs.every(ci => ci !== -1)) {
        for (let i = 1; i < allData.length; i++) {
          const isMatch = matchKeys.every((k, mi) => String(allData[i][colIdxs[mi]]).trim().toLowerCase() === String(fallbackMatch[k]).trim().toLowerCase());
          if (isMatch) {
            sheet.deleteRow(i + 1);
            return { deleted: true, id: allData[i][idCol], matchedByFallback: true };
          }
        }
      }
    }
  }

  throw new Error('Row not found: ' + id);
}

function getMeta() {
  const sheet = getSheet('meta');
  const data = sheet.getDataRange().getValues();
  const meta = {};
  for (let i = 1; i < data.length; i++) {
    const key = data[i][0];
    let value = data[i][1];
    if (typeof value === 'string') {
      try { value = JSON.parse(value); } catch(e) {}
    }
    if (key) meta[key] = value;
  }
  return meta;
}

function saveMeta(data) {
  const sheet = getSheet('meta');
  const existing = sheet.getDataRange().getValues();
  Object.keys(data).forEach(key => {
    const incoming = data[key];

    // Guard against silently wiping out real configuration data (Developer tab lists, etc.):
    // if the incoming value for this key is an empty array but the sheet currently holds a
    // non-empty array for it, keep what's there instead of overwriting it. A stale browser
    // tab, or a request that raced with another one, can otherwise send back an incomplete
    // snapshot and blank out data another session just added. Emptying a list all the way to
    // zero items only ever happens one row at a time from the Developer tab anyway, so this
    // only blocks the one genuinely destructive case (silently zeroing something populated) —
    // if you ever truly need to clear the very last item, do it directly in this sheet.
    if (Array.isArray(incoming) && incoming.length === 0) {
      let skip = false;
      for (let i = 1; i < existing.length; i++) {
        if (existing[i][0] === key) {
          let currentVal = existing[i][1];
          if (typeof currentVal === 'string') {
            try { currentVal = JSON.parse(currentVal); } catch (e) {}
          }
          if (Array.isArray(currentVal) && currentVal.length > 0) {
            Logger.log('saveMeta: refusing to overwrite non-empty "' + key + '" with an empty array.');
            skip = true;
          }
          break;
        }
      }
      if (skip) return; // leave this key untouched, continue with the rest of the payload
    }

    const value = typeof incoming === 'object' ? JSON.stringify(incoming) : incoming;
    let found = false;
    for (let i = 1; i < existing.length; i++) {
      if (existing[i][0] === key) {
        sheet.getRange(i + 1, 2).setValue(value);
        existing[i][1] = value;
        found = true;
        break;
      }
    }
    if (!found) sheet.appendRow([key, value]);
  });
  return { saved: true };
}

function bulkSave(sheetName, dataArray) {
  if (!dataArray || dataArray.length === 0) return { saved: 0 };
  const sheet = getSheet(sheetName);
  dataArray.forEach(d => { if (!d.id) d.id = Utilities.getUuid(); });

  // Ensure headers cover the union of every key across all records in this batch
  let headers = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 1)).getValues()[0];
  const allKeys = new Set();
  dataArray.forEach(d => Object.keys(d).forEach(k => allKeys.add(k)));
  const missing = Array.from(allKeys).filter(k => headers.indexOf(k) === -1);
  if (missing.length > 0) {
    sheet.getRange(1, headers.length + 1, 1, missing.length).setValues([missing]);
    headers = headers.concat(missing);
  }

  const rows = dataArray.map(data => headers.map(h => data[h] !== undefined ? data[h] : ''));
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, headers.length).setValues(rows);
  return { saved: rows.length };
}

// Deletes every row in `sheetName` whose id is in `ids`, in one pass — counterpart to
// bulkSave, for the same reason: deleting many rows one request at a time (e.g. un-marking a
// wide manual-coverage drag) means that many separate lock-acquire-and-write cycles, which
// doesn't hold up under a large batch the way one bulk pass does.
//
// Rewrites the whole data range in one setValues() call instead of calling sheet.deleteRow()
// once per row: each deleteRow() triggers a full sheet reflow, so a loop of ~100+ of them for
// one wide un-mark drag could run long enough to blow past the client's 30s request timeout —
// the delete would still be mid-flight server-side if the operator refreshed right after
// Accept, which looks exactly like the delete silently didn't happen (the sheet briefly still
// has the old rows). One read + one write is dramatically faster regardless of row count.
function bulkDelete(sheetName, ids) {
  if (!ids || ids.length === 0) return { deleted: 0 };
  const sheet = getSheet(sheetName);
  const idSet = new Set(ids.map(String));
  const allData = sheet.getDataRange().getValues();
  const headers = allData[0];
  const idCol = headers.indexOf('id');
  if (idCol === -1) throw new Error('No id column found');

  const keptRows = [];
  let deleted = 0;
  for (let i = 1; i < allData.length; i++) {
    if (idSet.has(String(allData[i][idCol]))) {
      deleted++;
    } else {
      keptRows.push(allData[i]);
    }
  }
  if (deleted === 0) return { deleted: 0 };

  const numCols = headers.length;
  sheet.getRange(2, 1, allData.length - 1, numCols).clearContent();
  if (keptRows.length > 0) {
    sheet.getRange(2, 1, keptRows.length, numCols).setValues(keptRows);
  }
  return { deleted: deleted };
}

// One-time repair: fills in a fresh unique id for any row in `sheetName` whose id column
// is currently blank. Safe to run repeatedly (already-filled rows are left untouched).
// Run it either from the app (action: 'repairMissingIds') or directly in the Apps Script
// editor: select this function in the dropdown next to "Run", then click Run.
function repairMissingIds(sheetName) {
  sheetName = sheetName || 'invoices';
  const sheet = getSheet(sheetName);
  const allData = sheet.getDataRange().getValues();
  const headers = allData[0];
  const idCol = headers.indexOf('id');
  if (idCol === -1) throw new Error('No id column found');
  let fixed = 0;
  for (let i = 1; i < allData.length; i++) {
    if (!allData[i][idCol]) {
      sheet.getRange(i + 1, idCol + 1).setValue(Utilities.getUuid());
      fixed++;
    }
  }
  Logger.log('Fixed ' + fixed + ' row(s) with missing ids in "' + sheetName + '"');
  return { fixed: fixed };
}
