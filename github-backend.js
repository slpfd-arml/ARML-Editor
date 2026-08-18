/* ============================================================
   github-backend.js
   ------------------------------------------------------------
   Does what server.js + publish.js do, but from inside the browser,
   for when ARML Editor is running as a static site on GitHub Pages
   with no local Node server behind it.

   IMPORTANT DIFFERENCE FROM THE LOCAL VERSION:
   The local version runs build-data.js synchronously on every save,
   so it can report exactly which built files got pushed in the same
   response. build-data.js can't run in a browser at all - it shells
   out to detect-fillable.js and detect-ccitt-images.js, which parse
   PDF binaries on disk with pdf-lib. There's no browser equivalent.

   So this file does the one thing a browser CAN do: commit the
   updated workbook straight to the ARML repo via the GitHub API. A
   GitHub Action in that repo (rebuild-on-workbook-change.yml) notices
   the workbook changed and runs the real, unmodified build-data.js on
   GitHub's own servers, then commits data.js/version.json/etc. back.
   That's what makes the change show up on devices a few minutes later
   - same end result as the local version, just with GitHub doing the
   build step instead of your own machine.

   KEEP IN SYNC: mergeLegacyTags, parseFilesField, buildFilesValue,
   rowFromBody, and VALID_CATEGORIES are duplicated from server.js on
   purpose - same reasoning as server.js's own comment about
   build-data.js's copy: small, stable, and duplicating beats sharing
   a module across a browser bundle and a Node app.
   ============================================================ */

const GITHUB_OWNER = "slpfd-arml";
const GITHUB_REPO = "ARML";
const GITHUB_BRANCH = "main";
const WORKBOOK_PATH = "ARM-Builder/New_ARM_Library.xlsx";
const API_HOST = "https://api.github.com";
const EDITOR_VERSION = "1.3.2"; // keep in step with package.json's version by hand

const VALID_CATEGORIES = [
  "Food & Basic Needs", "Housing & Shelter", "Health Care & Clinics",
  "Mental Health & Substance Use", "Transportation", "Legal / Tenant Help",
  "Benefits & Insurance", "Seniors & Disability", "Youth & Family",
  "Domestic Violence & Safety", "Immigrant / Culturally Specific"
];

/* ---------- TOKEN HANDLING ----------
   Desktop-only tool, so a native prompt() is fine - no need for a
   styled modal. Token lives only in this browser's localStorage; it
   is never written to any file, never committed, never sent anywhere
   except api.github.com. */
function getToken() {
  let token = localStorage.getItem("arml_editor_token");
  if (!token) token = promptForToken();
  return token;
}

function promptForToken() {
  const token = window.prompt(
    "Paste your GitHub Personal Access Token to enable saving.\n\n"
  );
  if (token && token.trim()) {
    localStorage.setItem("arml_editor_token", token.trim());
    return token.trim();
  }
  return null;
}

function clearToken() {
  localStorage.removeItem("arml_editor_token");
}

// Exposed so a "Change Token" button elsewhere in the UI can call it.
window.ARMLClearGitHubToken = function () {
  clearToken();
  window.alert("Token cleared. You'll be prompted again on your next save.");
};

/* Prompts for a token only if one isn't already stored, and reports
   whether we ended up with one. Exposed so the UI can ask for the token
   at load time instead of ambushing someone mid-save - it's a much
   better moment to hand over a credential than after they've already
   typed out a whole resource. Returns false if they dismiss the prompt,
   which is a legitimate choice: the connection light then explains the
   situation and clicking it re-prompts, so dismissing isn't a dead end. */
window.ARMLEnsureGitHubToken = function () {
  if (localStorage.getItem("arml_editor_token")) return true;
  return Boolean(promptForToken());
};

/* ---------- GITHUB CONTENTS API ---------- */
async function githubRequest(pathPart, options = {}) {
  const token = getToken();
  if (!token) throw new Error("No GitHub token entered - can't save without one.");

  const res = await fetch(`${API_HOST}/repos/${GITHUB_OWNER}/${GITHUB_REPO}${pathPart}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      ...(options.headers || {})
    }
  });

  if (res.status === 401) {
    // Deliberately does NOT clear the stored token. It used to, so the
    // next save would re-prompt - but that made a background call (the
    // eager resource preload at load) able to wipe the credential before
    // checkConnection could look at it, turning "token revoked" into
    // "no token", which points at a different fix. The token now stays
    // put and the connection light offers re-entry instead.
    throw new Error("GitHub rejected the token (401) - it may be wrong, expired, or revoked. Click the connection light to enter a new one.");
  }
  if (res.status === 403) {
    throw new Error("GitHub returned 403 - the token may lack permission for this repo, or GitHub's rate limit was hit.");
  }
  return res;
}

// Encodes each path SEGMENT separately (not the whole string, which would
// turn "Assets/foo.pdf"'s own "/" into "%2F" and break the path). Without
// this, an uploaded file named e.g. "Room #204 Flyer.pdf" has the "#"
// parsed by fetch() as a URL fragment - everything from "#" onward is
// silently dropped from the request, so GitHub receives a PUT to a
// truncated path instead of the real one. "?" causes the same class of
// truncation via the query-string delimiter.
function encodeGitHubPath(filePath) {
  return filePath.split("/").map(encodeURIComponent).join("/");
}

async function getFileContent(filePath) {
  const res = await githubRequest(`/contents/${encodeGitHubPath(filePath)}?ref=${encodeURIComponent(GITHUB_BRANCH)}`);
  if (!res.ok) throw new Error(`Couldn't load ${filePath} from GitHub (status ${res.status}).`);
  const json = await res.json();
  return { sha: json.sha, base64: json.content.replace(/\n/g, "") };
}

async function putFileContent(filePath, base64Content, message, sha) {
  const res = await githubRequest(`/contents/${encodeGitHubPath(filePath)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, content: base64Content, branch: GITHUB_BRANCH, sha })
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message || `GitHub rejected the write to ${filePath} (status ${res.status}).`);
  }
  return res.json();
}

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/* ---------- WORKBOOK READ/WRITE (SheetJS - same library server.js uses,
   just the browser build instead of the Node build) ---------- */
async function loadWorkbook() {
  const { sha, base64 } = await getFileContent(WORKBOOK_PATH);
  const buffer = base64ToArrayBuffer(base64);
  const wb = XLSX.read(buffer, { type: "array" });
  return { wb, sha };
}

function readRows(wb) {
  return XLSX.utils.sheet_to_json(wb.Sheets["Resource List"], { defval: "" });
}

function writeRowsToWorkbook(wb, rows) {
  // KEEP IN SYNC with server.js's writeRows() - union of every row's keys,
  // not just rows[0]'s: rowFromBody() always produces the same fixed 19
  // keys, so if row 0 happens to be the one just rewritten by this save,
  // taking its keys alone would silently drop any column beyond those 19
  // (e.g. a legacy or hand-added Excel column) from the ENTIRE sheet, not
  // just that row.
  const header = rows.length
    ? Array.from(rows.reduce((keys, row) => { Object.keys(row).forEach(k => keys.add(k)); return keys; }, new Set()))
    : ["Resource Name", "Parent Organization/Agency", "Organization Type", "Services Provided",
       "Contact Person", "Email Address", "Phone", "Alternate Phone", "Fax", "Alternate Fax", "TTY",
       "Website", "Street Address", "Notes", "Hours", "Keywords", "Files", "Broad Category", "Service Tags"];
  wb.Sheets["Resource List"] = XLSX.utils.json_to_sheet(rows, { header });
}

/* ============================================================
   SUB-CONTACTS ("Related Contacts") - ported from server.js.
   KEEP IN SYNC with server.js's identically-named functions - see this
   file's own top-of-file note on why the duplication is intentional.
   ============================================================ */
const CORE_SHEET_NAMES = new Set(["Read Me", "Resource List", "Release of Information", "Screening Tools"]);
const SUB_CONTACT_COLUMNS = [
  "Parent Resource", "Sub-Contact Name", "Category", "Audience", "Services / Purpose",
  "Phone", "Fax", "Email", "Website", "Location", "Hours / Availability", "Access Instructions",
  "Notes", "Source"
];
// "audience", "source", and "access" are real workbook columns not
// written by the "+ Add Sub-Contact" form - see server.js's identical
// comment (KEEP IN SYNC) for the full explanation, including why
// "access" (unlike the other two) is a deliberate product decision
// rather than a dead-field cleanup: CAP-HC's real Access Instructions
// data still renders exactly as before, it just isn't form-editable here.
const SUB_CONTACT_KEY_TO_COLUMN = {
  name: "Sub-Contact Name", category: "Category", audience: "Audience", purpose: "Services / Purpose",
  phone: "Phone", fax: "Fax", email: "Email", website: "Website", location: "Location",
  hours: "Hours / Availability", access: "Access Instructions", notes: "Notes", source: "Source"
};
const SUB_CONTACT_COLUMN_TO_KEY = Object.fromEntries(
  Object.entries(SUB_CONTACT_KEY_TO_COLUMN).map(([k, v]) => [v, k])
);

function findSubContactSheetNames(wb) {
  return wb.SheetNames.filter(name => {
    if (CORE_SHEET_NAMES.has(name)) return false;
    if (!wb.Sheets[name]) return false;
    const aoa = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: "" });
    return aoa.some(r => String(r[0] || "").trim() === "Parent Resource");
  });
}

function readAllSubContacts(wb) {
  const map = new Map();
  findSubContactSheetNames(wb).forEach(sheetName => {
    const aoa = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: "" });
    const headerRowIdx = aoa.findIndex(r => String(r[0] || "").trim() === "Parent Resource");
    if (headerRowIdx === -1) return;
    const headers = aoa[headerRowIdx].map(h => String(h || "").trim());
    aoa.slice(headerRowIdx + 1).forEach(rowArr => {
      if (!rowArr.some(c => String(c || "").trim())) return;
      const row = {};
      headers.forEach((h, i) => { if (h) row[h] = rowArr[i]; });
      const parentName = String(row["Parent Resource"] || "").trim();
      if (!parentName) return;
      if (!map.has(parentName)) map.set(parentName, { sheetName, items: [] });
      map.get(parentName).items.push({
        name: String(row["Sub-Contact Name"] || "").trim(),
        category: String(row["Category"] || "").trim(),
        audience: String(row["Audience"] || "").trim(),
        purpose: String(row["Services / Purpose"] || "").trim(),
        phone: String(row["Phone"] || "").trim(),
        fax: String(row["Fax"] || "").trim(),
        email: String(row["Email"] || "").trim(),
        website: String(row["Website"] || "").trim(),
        location: String(row["Location"] || "").trim(),
        hours: String(row["Hours / Availability"] || "").trim(),
        access: String(row["Access Instructions"] || "").trim(),
        notes: String(row["Notes"] || "").trim(),
        source: String(row["Source"] || "").trim()
      });
    });
  });
  return map;
}

function subContactSheetName(resourceName, wb) {
  const suffix = " Contacts";
  const maxBase = 31 - suffix.length;
  let base = String(resourceName || "").replace(/[:\\/?*[\]]/g, "").trim() || "Resource";
  if (base.length > maxBase) base = base.slice(0, maxBase).trim();

  const taken = new Set(wb.SheetNames);
  let candidate = `${base}${suffix}`;
  let n = 2;
  while (taken.has(candidate)) {
    const numSuffix = ` ${n}`;
    candidate = `${base.slice(0, Math.max(0, maxBase - numSuffix.length))}${suffix}${numSuffix}`;
    n++;
  }
  return candidate;
}

function upsertSubContacts(wb, originalName, newName, subContacts) {
  const lookupName = originalName || newName;
  const map = readAllSubContacts(wb);
  const mine = map.get(lookupName);
  const existingSheetName = mine ? mine.sheetName : null;

  const otherRows = [];
  if (existingSheetName) {
    for (const [parentName, entry] of map.entries()) {
      if (entry.sheetName !== existingSheetName || parentName === lookupName) continue;
      entry.items.forEach(it => {
        otherRows.push(SUB_CONTACT_COLUMNS.map(col =>
          col === "Parent Resource" ? parentName : (it[SUB_CONTACT_COLUMN_TO_KEY[col]] || "")
        ));
      });
    }
  }

  const newRows = subContacts.map(sc => SUB_CONTACT_COLUMNS.map(col =>
    col === "Parent Resource" ? newName : (sc[SUB_CONTACT_COLUMN_TO_KEY[col]] || "")
  ));

  const allDataRows = [...otherRows, ...newRows];

  if (allDataRows.length === 0) {
    if (existingSheetName) {
      delete wb.Sheets[existingSheetName];
      wb.SheetNames = wb.SheetNames.filter(n => n !== existingSheetName);
    }
    return;
  }

  const sheetName = existingSheetName || subContactSheetName(newName, wb);
  const aoaOut = [
    [`${newName} — Sub-Contact Cards`],
    [`Each row is a related contact, viewable under the parent ${newName} resource.`],
    [],
    SUB_CONTACT_COLUMNS,
    ...allDataRows
  ];
  wb.Sheets[sheetName] = XLSX.utils.aoa_to_sheet(aoaOut);
  if (!wb.SheetNames.includes(sheetName)) wb.SheetNames.push(sheetName);
}

async function commitWorkbook(wb, sha, commitMessage) {
  const out = XLSX.write(wb, { type: "array", bookType: "xlsx" });
  const base64 = arrayBufferToBase64(out);
  return putFileContent(WORKBOOK_PATH, base64, commitMessage, sha);
}

/* ---------- SHARED PARSING/FORMATTING - ported from server.js ---------- */
function toArray(v) {
  if (v === undefined || v === null || v === "") return [];
  return Array.isArray(v) ? v : [v];
}

function mergeLegacyTags(keywordsRaw, serviceTagsRaw) {
  const kw = String(keywordsRaw || "").split(",").map(s => s.trim()).filter(Boolean);
  const st = String(serviceTagsRaw || "").split(";").map(s => s.trim()).filter(Boolean);
  const seen = new Set();
  const merged = [];
  for (const term of [...kw, ...st]) {
    const key = term.toLowerCase();
    if (!seen.has(key)) { seen.add(key); merged.push(term); }
  }
  return merged;
}

// Mirrors ARM-Builder/build-data.js's parseFiles() marker scheme: a
// trailing "|link" tags an entry as an external URL rather than a
// filename to resolve under /Assets. "|fillable"/"|inapp" are build-time-
// only overrides this tool doesn't set itself, but a hand-added one on an
// existing entry is preserved verbatim on the next save rather than
// silently dropped.
function parseFilesField(str) {
  return String(str || "")
    .split(";")
    .map(s => s.trim())
    .filter(Boolean)
    .map(entry => {
      let parts = entry.split("|").map(s => s.trim()).filter(s => s !== "");
      let marker = null;
      const last = parts.length > 1 ? parts[parts.length - 1].toLowerCase() : "";
      if (last === "link" || last === "fillable" || last === "inapp") {
        marker = last;
        parts = parts.slice(0, -1);
      }
      const label = parts.length > 1 ? parts[0] : "";
      const target = parts.length > 1 ? parts[parts.length - 1] : parts[0];

      if (marker === "link") {
        return { type: "link", label: label || target, url: target };
      }
      return { type: "file", label: label || target, filename: target, marker: marker || null };
    });
}

function buildFilesValue(keptItems, newFiles, newLinks) {
  const keptPart = keptItems.map(item => {
    if (item.type === "link") {
      const base = item.label && item.label !== item.url ? `${item.label}|${item.url}` : item.url;
      return `${base}|link`;
    }
    const base = item.label && item.label !== item.filename ? `${item.label}|${item.filename}` : item.filename;
    return item.marker ? `${base}|${item.marker}` : base;
  });
  const newFilesPart = (newFiles || []).map(f => (f.label ? `${f.label}|${f.filename}` : f.filename));
  const newLinksPart = (newLinks || []).map(l => {
    const label = (l.label || "").trim();
    const url = (l.url || "").trim();
    return `${label && label !== url ? `${label}|${url}` : url}|link`;
  });
  return [...keptPart, ...newFilesPart, ...newLinksPart].join("; ");
}

/* ---------- FILE UPLOAD (Assets/) ----------
   Mirrors server.js's multer + uniqueFilename behavior: new PDFs always
   land flat in Assets/ (never a subfolder), and a name collision gets
   "-2", "-3", etc. appended rather than overwriting an existing file.
   The local version checks collisions by walking the Assets folder on
   disk; here, the equivalent is one recursive Git Trees API call - far
   cheaper than a Contents API call per existing file. */
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // matches server.js's multer limit

async function getAssetFilenames() {
  const res = await githubRequest(`/git/trees/${GITHUB_BRANCH}?recursive=1`);
  if (!res.ok) throw new Error(`Couldn't list repo files from GitHub (status ${res.status}).`);
  const json = await res.json();
  if (json.truncated) {
    console.warn("GitHub's file listing was truncated (very large repo) - a filename collision could be missed.");
  }
  return new Set(
    (json.tree || [])
      .filter(e => e.type === "blob" && e.path.startsWith("Assets/"))
      .map(e => e.path.split("/").pop())
  );
}

function uniqueFilename(originalName, takenNames) {
  const dotIdx = originalName.lastIndexOf(".");
  const ext = dotIdx === -1 ? "" : originalName.slice(dotIdx);
  const base = dotIdx === -1 ? originalName : originalName.slice(0, dotIdx);
  let candidate = originalName;
  let n = 2;
  while (takenNames.has(candidate)) {
    candidate = `${base}-${n}${ext}`;
    n++;
  }
  takenNames.add(candidate); // claim immediately so two new files in the same save can't collide with each other
  return candidate;
}

// Uploads every new PDF attached in this submission, one commit per file
// (same one-file-per-commit trade publish.js already makes, for the same
// reason - simplicity over atomicity). Returns [{filename, label}] in the
// same order the files were picked, for buildFilesValue to consume.
// PARTIAL-FAILURE NOTE: if file 2 of 3 fails, files before it are already
// committed to Assets/ (orphaned - not yet referenced by any resource)
// and the error is thrown up to the caller, which reports it and does NOT
// write the workbook. Re-running the save will re-check names against the
// now-updated tree and pick up cleanly; nothing is corrupted, just a
// harmless unused file sitting in Assets/ until someone notices.
async function uploadNewFiles(formData) {
  const files = formData.getAll("files").filter(f => f && f.size > 0);
  if (files.length === 0) return [];

  for (const f of files) {
    if (f.size > MAX_UPLOAD_BYTES) {
      throw new Error(`"${f.name}" is ${(f.size / 1024 / 1024).toFixed(1)} MB, over the 25 MB limit. Compress it or split it up before attaching.`);
    }
  }

  const labels = formData.getAll("fileLabels");
  const takenNames = await getAssetFilenames();
  const uploaded = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const finalName = uniqueFilename(file.name, takenNames);
    const buffer = await file.arrayBuffer();
    const base64 = arrayBufferToBase64(buffer);
    await putFileContent(`Assets/${finalName}`, base64, `Attach file: ${finalName}`);
    uploaded.push({ filename: finalName, label: (labels[i] || "").trim() });
  }
  return uploaded;
}

function rowFromBody(body, filesValue) {
  return {
    "Resource Name": (body.name || "").trim(),
    "Parent Organization/Agency": body.parent || "",
    "Organization Type": body.type || "",
    "Services Provided": body.services || "",
    // Contact Person is a retired column - see server.js's identical
    // comment (KEEP IN SYNC).
    "Contact Person": "",
    "Email Address": body.email || "",
    "Phone": body.phone || "",
    "Alternate Phone": body.altPhone || "",
    "Fax": body.fax || "",
    "Alternate Fax": body.altFax || "",
    "TTY": body.tty || "",
    "Website": body.website || "",
    "Street Address": body.address || "",
    "Notes": body.notes || "",
    "Hours": body.hours || "",
    "Keywords": toArray(body.keywords).join(", "),
    "Files": filesValue,
    "Broad Category": (body.broadCategory || "").trim(),
    "Service Tags": ""
  };
}

// A FormData built by form.js's normal submit handler; converts it into the
// same flat "body" shape server.js's req.body would have had, so
// rowFromBody works unmodified.
function formDataToBody(formData) {
  const body = {};
  for (const [key, value] of formData.entries()) {
    if (key === "files" || key === "fileLabels") continue; // not supported yet - see note in buildFilesValue
    if (body[key] !== undefined) {
      body[key] = Array.isArray(body[key]) ? [...body[key], value] : [body[key], value];
    } else {
      body[key] = value;
    }
  }
  return body;
}

const DEFERRED_PUBLISH_NOTE = " ARML will rebuild automatically in a few minutes.";

/* ---------- PUBLIC API - same surface as the local /resources, /add,
   /update, /delete, /publish-status endpoints ---------- */

async function getResources() {
  const { wb } = await loadWorkbook();
  const rows = readRows(wb);
  const subContactsMap = readAllSubContacts(wb);
  const resources = rows
    .filter(r => r["Resource Name"])
    .map(r => ({
      name: r["Resource Name"],
      parent: r["Parent Organization/Agency"] || "",
      type: r["Organization Type"] || "",
      broadCategory: r["Broad Category"] || "",
      services: r["Services Provided"] || "",
      contact: r["Contact Person"] || "",
      email: r["Email Address"] || "",
      phone: r["Phone"] || "",
      altPhone: r["Alternate Phone"] || "",
      fax: r["Fax"] || "",
      altFax: r["Alternate Fax"] || "",
      tty: r["TTY"] || "",
      website: r["Website"] || "",
      address: r["Street Address"] || "",
      notes: r["Notes"] || "",
      hours: r["Hours"] || "",
      keywords: mergeLegacyTags(r["Keywords"], r["Service Tags"]),
      files: parseFilesField(r["Files"]),
      subContacts: (subContactsMap.get(r["Resource Name"]) || { items: [] }).items
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { resources };
}

async function getResourceNames() {
  const { wb } = await loadWorkbook();
  const rows = readRows(wb);
  return { names: rows.map(r => r["Resource Name"]).filter(Boolean) };
}

async function addResource(formData) {
  try {
    const body = formDataToBody(formData);
    const name = (body.name || "").trim();
    const broadCategory = (body.broadCategory || "").trim();

    if (!name) return { ok: false, error: "Resource Name is required." };
    if (!VALID_CATEGORIES.includes(broadCategory)) {
      return { ok: false, error: "Please choose a valid Broad Category from the list." };
    }

    const { wb, sha } = await loadWorkbook();
    const rows = readRows(wb);

    const duplicate = rows.find(r => String(r["Resource Name"]).trim().toLowerCase() === name.toLowerCase());
    if (duplicate) {
      return { ok: false, error: `"${name}" already exists in the Resource List. Use Edit instead of Add, or use a distinguishing name.` };
    }

    const uploaded = await uploadNewFiles(formData);
    let newLinks = [];
    try { newLinks = JSON.parse(body.newLinks || "[]"); } catch { newLinks = []; }
    const filesValue = buildFilesValue([], uploaded, newLinks);

    let subContacts = [];
    try { subContacts = JSON.parse(body.subContacts || "[]"); } catch { subContacts = []; }

    rows.push(rowFromBody(body, filesValue));
    writeRowsToWorkbook(wb, rows);
    upsertSubContacts(wb, null, name, subContacts);
    await commitWorkbook(wb, sha, `Add resource: ${name}`);

    return {
      ok: true,
      message: `"${name}" saved and pushed to GitHub.${DEFERRED_PUBLISH_NOTE}`,
      publish: {
        attempted: true,
        pushed: [...uploaded.map(f => ({ path: `Assets/${f.filename}` })), { path: WORKBOOK_PATH }],
        failed: []
      }
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function updateResource(formData) {
  try {
    const body = formDataToBody(formData);
    const originalName = (body.originalName || "").trim();
    const name = (body.name || "").trim();
    const broadCategory = (body.broadCategory || "").trim();

    if (!originalName) {
      return { ok: false, error: "Missing original resource reference - please re-open this resource from the Edit list and try again." };
    }
    if (!name) return { ok: false, error: "Resource Name is required." };
    if (!VALID_CATEGORIES.includes(broadCategory)) {
      return { ok: false, error: "Please choose a valid Broad Category from the list." };
    }

    const { wb, sha } = await loadWorkbook();
    const rows = readRows(wb);

    const rowIndex = rows.findIndex(r => String(r["Resource Name"]).trim() === originalName);
    if (rowIndex === -1) {
      return { ok: false, error: `Couldn't find "${originalName}" in the workbook anymore - it may have been edited or removed elsewhere. Refresh the Edit list and try again.` };
    }

    if (name.toLowerCase() !== originalName.toLowerCase()) {
      const collision = rows.find((r, i) => i !== rowIndex && String(r["Resource Name"]).trim().toLowerCase() === name.toLowerCase());
      if (collision) {
        return { ok: false, error: `"${name}" already exists as a different resource. Choose a different name, or edit that entry instead.` };
      }
    }

    let keptItems = [];
    try { keptItems = JSON.parse(body.existingFiles || "[]"); } catch { keptItems = []; }
    const uploaded = await uploadNewFiles(formData);
    let newLinks = [];
    try { newLinks = JSON.parse(body.newLinks || "[]"); } catch { newLinks = []; }
    const filesValue = buildFilesValue(keptItems, uploaded, newLinks);

    let subContacts = [];
    try { subContacts = JSON.parse(body.subContacts || "[]"); } catch { subContacts = []; }

    rows[rowIndex] = rowFromBody(body, filesValue);
    writeRowsToWorkbook(wb, rows);
    upsertSubContacts(wb, originalName, name, subContacts);

    const commitMsg = name === originalName ? `Edit resource: ${name}` : `Edit resource: ${originalName} -> ${name}`;
    await commitWorkbook(wb, sha, commitMsg);

    return {
      ok: true,
      message: `"${name}" updated and pushed to GitHub.${DEFERRED_PUBLISH_NOTE}`,
      publish: {
        attempted: true,
        pushed: [...uploaded.map(f => ({ path: `Assets/${f.filename}` })), { path: WORKBOOK_PATH }],
        failed: []
      }
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function deleteResource(name, confirmName) {
  try {
    if (!name) return { ok: false, error: "Missing resource name." };
    if (confirmName !== name) {
      return { ok: false, error: "Confirmation text didn't match the resource name exactly. Nothing was deleted." };
    }

    const { wb, sha } = await loadWorkbook();
    const rows = readRows(wb);
    const rowIndex = rows.findIndex(r => String(r["Resource Name"]).trim() === name);
    if (rowIndex === -1) {
      return { ok: false, error: `Couldn't find "${name}" in the workbook - it may have already been removed.` };
    }

    rows.splice(rowIndex, 1);
    writeRowsToWorkbook(wb, rows);
    upsertSubContacts(wb, name, name, []);
    await commitWorkbook(wb, sha, `Delete resource: ${name}`);

    return {
      ok: true,
      message: `"${name}" deleted and pushed to GitHub.${DEFERRED_PUBLISH_NOTE}`,
      publish: { attempted: true, pushed: [{ path: WORKBOOK_PATH }], failed: [] }
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/* ---------- CONNECTION STATUS ----------
   Answers the only question that actually matters before someone spends
   ten minutes typing a resource: "will Save work right now?"

   Deliberately does NOT ping the ARML site. ARML is static files on
   GitHub Pages - it has no server, and the Editor never writes to it
   directly. Reaching ARML would prove only that a website is up, and
   would show green in every single case where saving is actually
   broken: no token, revoked token, read-only token, api.github.com
   firewalled, wrong repo name. Asking GitHub about the repo answers the
   real question, because it's the same API and the same credential that
   an actual save would use.

   Uses the repo endpoint rather than a write test on purpose - it
   reports permissions.push without creating a junk commit to find out. */
async function checkConnection() {
  const token = localStorage.getItem("arml_editor_token");
  if (!token) {
    // Wording assumes the load-time prompt (see form.js initConnStatus)
    // has already happened and been dismissed - "you'll be asked on your
    // first save" would be stale advice now that we ask up front.
    return { state: "warn", message: "No token — click here to enter one. Saving won't work until you do." };
  }

  try {
    const res = await fetch(`${API_HOST}/repos/${GITHUB_OWNER}/${GITHUB_REPO}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
      cache: "no-store"
    });

    if (res.status === 401) {
      // Deliberately does NOT clear the stored token the way
      // githubRequest() does. Clearing here would make the very next
      // status render report "No token yet", which is a different and
      // misleading problem - the user HAS a token, it's just been
      // revoked or mistyped, and telling them that is the whole point.
      return { state: "error", message: "Token rejected by GitHub — it may be revoked or mistyped. Saving will fail." };
    }
    if (res.status === 404) {
      // 404 rather than 403 is what GitHub returns for a repo the token
      // can't see at all - indistinguishable from "doesn't exist" by
      // design, so say both rather than guessing wrong.
      return { state: "error", message: `Can't see ${GITHUB_OWNER}/${GITHUB_REPO} — wrong repo name, or the token has no access to it.` };
    }
    if (!res.ok) {
      return { state: "error", message: `GitHub returned ${res.status}. Saving may fail.` };
    }

    const repo = await res.json();
    const canPush = repo.permissions && repo.permissions.push;
    if (!canPush) {
      return { state: "error", message: "Token is read-only — it can load resources but Save will fail. Needs write access." };
    }
    return { state: "ok", message: "Connected to ARML — ready to save." };
  } catch (err) {
    // A network-level throw here (rather than an HTTP status) is the
    // signature of api.github.com being unreachable - offline, or
    // blocked by a network filter, which is a realistic failure on a
    // city network and worth naming explicitly rather than showing a
    // generic error.
    return { state: "error", message: "Can't reach api.github.com — you're offline, or the network is blocking it." };
  }
}


async function getPublishStatus() {
  const configured = Boolean(localStorage.getItem("arml_editor_token"));
  return {
    version: EDITOR_VERSION,
    enabled: true,
    configured,
    owner: GITHUB_OWNER,
    repo: GITHUB_REPO,
    branch: GITHUB_BRANCH,
    mode: "browser"
  };
}

window.ARMLGitHubBackend = {
  getResources,
  getResourceNames,
  addResource,
  updateResource,
  deleteResource,
  getPublishStatus,
  checkConnection
};
