const SECRET_KEY = 'AGI_EQP_2026_s3cur3key';
const SHEET_ID = SpreadsheetApp.getActiveSpreadsheet().getId();

function doGet(e) {
  return handleRequest(e);
}

function doPost(e) {
  return handleRequest(e);
}

function handleRequest(e) {
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
        result = deleteRow(sheet, postData.id);
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
      case 'repairMissingIds':
        result = repairMissingIds(sheet);
        break;
      default:
        result = { error: 'Unknown action: ' + action };
    }

    return ContentService
      .createTextOutput(JSON.stringify({ success: true, data: result }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch(err) {
    return ContentService
      .createTextOutput(JSON.stringify({ success: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function getSheet(name) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sheet = ss.getSheetByName(name);
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

function deleteRow(sheetName, id) {
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
    const value = typeof data[key] === 'object' ? JSON.stringify(data[key]) : data[key];
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
