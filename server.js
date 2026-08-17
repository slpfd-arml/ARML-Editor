const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const XLSX = require("xlsx");
const publisher = require("./publish.js");

const app = express();

// Single source of truth for the tool's own version - separate from
// ARML's own VERSION file, since this is a different piece of software
// with its own history. Bump this by hand following the same semver
// logic ARML itself uses: patch = fixes, minor = new features, major =
// a fundamental change to how the tool works.
const EDITOR_VERSION = "1.3.0";

// Everything is served from this same Express app (this file, index.html,
// form.js, styles.css) on one origin. That's deliberate: if index.html were
// opened directly as a file:// page instead, fetch() calls to this server
// would be cross-origin and get blocked by the browser's CORS policy with
// no server-side fix short of adding CORS headers. Serving everything from
// http://localhost:3000 sidesteps that entirely.
app.use(express.static(__dirname));

// Exposes the MAIN app's icons folder (one level up) at /shared-icons, so
// this tool's header can use the real SLP patch image without needing its
// own duplicate copy to keep in sync. Read-only - this tool never writes
// anything here.
app.use("/shared-icons", express.static(path.join(__dirname, "..", "icons")));
app.use(express.json());

// The workbook lives in ARM-Builder, one level up and over - NOT directly
// one level up. (This was the bug that made every save fail before: the
// original path pointed at a location the workbook has never actually
// been in.)
const ROOT = path.join(__dirname, "..");
const BUILDER_DIR = path.join(ROOT, "ARM-Builder");
const WORKBOOK_PATH = path.join(BUILDER_DIR, "New_ARM_Library.xlsx");
const ASSETS_DIR = path.join(ROOT, "Assets");

const VALID_CATEGORIES = [
  "Food & Basic Needs", "Housing & Shelter", "Health Care & Clinics",
  "Mental Health & Substance Use", "Transportation", "Legal / Tenant Help",
  "Benefits & Insurance", "Seniors & Disability", "Youth & Family",
  "Domestic Violence & Safety", "Immigrant / Culturally Specific"
];

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, ASSETS_DIR),
    filename: (req, file, cb) => cb(null, uniqueFilename(file.originalname))
  }),
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== "application/pdf" && !/\.pdf$/i.test(file.originalname)) {
      return cb(new Error("Only PDF files are accepted."));
    }
    cb(null, true);
  },
  limits: { fileSize: 25 * 1024 * 1024 }
});

function uniqueFilename(originalName) {
  const ext = path.extname(originalName);
  const base = path.basename(originalName, ext);
  let candidate = originalName;
  let n = 2;
  while (fileExistsAnywhereInAssets(candidate)) {
    candidate = `${base}-${n}${ext}`;
    n++;
  }
  return candidate;
}

function fileExistsAnywhereInAssets(filename) {
  const stack = [ASSETS_DIR];
  while (stack.length) {
    const dir = stack.pop();
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) stack.push(path.join(dir, entry.name));
      else if (entry.name === filename) return true;
    }
  }
  return false;
}

function toArray(v) {
  if (v === undefined || v === null || v === "") return [];
  return Array.isArray(v) ? v : [v];
}

/* ============================================================
   SHARED PARSING / FORMATTING
   Used by GET /resources (to pre-fill the edit form) and by
   POST /add + POST /update (to build the row that gets written).
   Keeping this in one place means add and edit can never quietly
   drift into handling the same field differently.
   ============================================================ */

// Keywords and Service Tags used to be two separate columns with the same
// actual purpose (invisible search fuel). Consolidated into one field, the
// same way build-data.js was - see the matching comment there for the full
// reasoning. This merges both columns for display/edit purposes; writing
// only ever targets "Keywords" going forward (see rowFromBody below), so a
// resource fully consolidates onto one column the next time it's saved.
// KEEP IN SYNC: ARM-Builder/build-data.js has an identical function.
function mergeLegacyTags(keywordsRaw, serviceTagsRaw) {
  const kw = String(keywordsRaw || "").split(",").map(s => s.trim()).filter(Boolean);
  const st = String(serviceTagsRaw || "").split(";").map(s => s.trim()).filter(Boolean);
  const seen = new Set();
  const merged = [];
  for (const term of [...kw, ...st]) {
    const key = term.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(term);
    }
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

function buildFilesValue(keptItems, newFiles, newLabels, newLinks) {
  const keptPart = keptItems.map(item => {
    if (item.type === "link") {
      const base = item.label && item.label !== item.url ? `${item.label}|${item.url}` : item.url;
      return `${base}|link`;
    }
    const base = item.label && item.label !== item.filename ? `${item.label}|${item.filename}` : item.filename;
    return item.marker ? `${base}|${item.marker}` : base;
  });
  const newFilesPart = (newFiles || []).map((f, i) => {
    const label = (newLabels[i] || "").trim();
    return label ? `${label}|${f.filename}` : f.filename;
  });
  const newLinksPart = (newLinks || []).map(l => {
    const label = (l.label || "").trim();
    const url = (l.url || "").trim();
    return `${label && label !== url ? `${label}|${url}` : url}|link`;
  });
  return [...keptPart, ...newFilesPart, ...newLinksPart].join("; ");
}

function rowFromBody(body, filesValue) {
  return {
    "Resource Name": (body.name || "").trim(),
    "Parent Organization/Agency": body.parent || "",
    "Organization Type": body.type || "",
    "Services Provided": body.services || "",
    // Contact Person is a retired column - the app's card renderer never
    // reads it (contactBlock() in ARML's app.js has no r.contact
    // reference), so there's no form field for it and this always writes
    // empty. Same "stop writing, let it clear out over time" treatment as
    // Service Tags below.
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
    // Service Tags is a retired column - never written to going forward.
    // A resource that still has legacy data there gets it folded into
    // Keywords automatically (see mergeLegacyTags) the moment it's loaded
    // into this form for an edit, so saving naturally clears this out.
    "Service Tags": ""
  };
}

function runBuildAndPublish(res, resourceName, commitMessage, uploadedFiles, successVerb) {
  execFile("node", ["build-data.js"], { cwd: BUILDER_DIR }, async (err, stdout, stderr) => {
    if (err) {
      console.error("Build step failed:", stderr || err.message);
      return res.json({
        message: `"${resourceName}" was ${successVerb} in the workbook, but rebuilding the app's data failed. Run build-data.js manually in ARM-Builder to finish.`,
        buildError: stderr || err.message
      });
    }

    const filesToPublish = [
      "data.js",
      "version.json",
      "assets-manifest.json",
      "service-worker.js",
      ...(uploadedFiles || []).map(f => `Assets/${f.filename}`)
    ];

    let publishResult;
    try {
      publishResult = await publisher.publish(ROOT, filesToPublish, commitMessage);
    } catch (publishErr) {
      publishResult = { attempted: true, pushed: [], failed: [{ path: "(all)", error: String(publishErr) }] };
    }

    let message = `"${resourceName}" ${successVerb} and pushed to ARML. Reload ARML to update.`;
    if (publishResult.attempted && publishResult.failed.length === 0) {
      message += ` Published to GitHub (${publishResult.pushed.length} file${publishResult.pushed.length === 1 ? "" : "s"}).`;
    } else if (publishResult.attempted && publishResult.failed.length > 0) {
      message += ` GitHub publish had ${publishResult.failed.length} problem(s) - see details below. The local build is fine either way.`;
    }

    res.json({ message, publish: publishResult });
  });
}

function readRows() {
  const wb = XLSX.readFile(WORKBOOK_PATH);
  const rows = XLSX.utils.sheet_to_json(wb.Sheets["Resource List"], { defval: "" });
  return { wb, rows };
}

// Only mutates wb.Sheets["Resource List"] in memory - does NOT write to
// disk. Callers write once, via saveWorkbook(), after every sheet this
// request touches (Resource List + possibly a sub-contact sheet) has been
// updated, so a save can never land half-written.
function writeRows(wb, rows) {
  const header = rows.length
    ? Object.keys(rows[0])
    : ["Resource Name","Parent Organization/Agency","Organization Type","Services Provided",
       "Contact Person","Email Address","Phone","Alternate Phone","Fax","Alternate Fax","TTY",
       "Website","Street Address","Notes","Hours","Keywords","Files","Broad Category","Service Tags"];
  wb.Sheets["Resource List"] = XLSX.utils.json_to_sheet(rows, { header });
}

function saveWorkbook(wb) {
  XLSX.writeFile(wb, WORKBOOK_PATH);
}

/* ============================================================
   SUB-CONTACTS ("Related Contacts")
   Live in their own worksheet(s), one row per sub-contact, joined back to
   a resource by an exact "Parent Resource" name match - the same shape
   CAP-HC Contacts and (formerly) St Stephens Contacts were hand-authored
   in. ARM-Builder/build-data.js auto-discovers any sheet shaped this way
   (see its own matching comment), so a sheet created here just works on
   the ARML side with no further wiring.
   ============================================================ */
const CORE_SHEET_NAMES = new Set(["Read Me", "Resource List", "Release of Information", "Screening Tools"]);
const SUB_CONTACT_COLUMNS = [
  "Parent Resource", "Sub-Contact Name", "Category", "Audience", "Services / Purpose",
  "Phone", "Fax", "Email", "Website", "Location", "Hours / Availability", "Access Instructions",
  "Notes", "Source"
];
// "audience" and "source" were never rendered anywhere in ARML's app.js -
// see the longer comment history in this repo. "access" IS rendered (an
// "Access:" line in subContactsBlock()) and CAP-HC's real data uses it,
// so unlike the other two this one is a deliberate product decision, not
// a dead-field cleanup: it stays wired on the read/render side (CAP-HC's
// existing Access Instructions keeps showing exactly as before), but has
// no field in the "+ Add Sub-Contact" form going forward. All three are
// kept here so this tool can still READ an existing sheet without
// erroring, but re-saving a resource's sub-contacts through this tool
// clears all three going forward, same as Contact Person above - not
// preserved, since there's no form field to carry the old value through.
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

// Maps every resource name that has sub-contacts to { sheetName, items }.
// Scans each sub-contact sheet exactly once regardless of how many
// resources' rows it holds.
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

// Valid, unique Excel sheet name for a brand new sub-contact sheet -
// "<Resource Name> Contacts", stripped of characters Excel disallows in
// sheet names and truncated to fit the 31-char limit.
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

// Replaces whatever sub-contact rows a resource currently has (found by
// ORIGINAL name, so a rename moves the rows rather than orphaning them)
// with a fresh set written under its current name. Rows belonging to
// other resources that happen to share the same sheet are read and
// rewritten untouched. An empty new list removes the resource's rows -
// deleting the whole sheet if nothing else is left in it.
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

app.get("/resource-names", (req, res) => {
  try {
    const { rows } = readRows();
    res.json({ names: rows.map(r => r["Resource Name"]).filter(Boolean) });
  } catch (err) {
    res.status(500).json({ error: "Could not read the workbook: " + err.message });
  }
});

/* GET /resources - full list, parsed into form-ready shape, for the
   Edit/Delete picker. Small enough (161 resources) to ship whole and
   filter client-side rather than building a search endpoint. */
app.get("/resources", (req, res) => {
  try {
    const { wb, rows } = readRows();
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
    res.json({ resources });
  } catch (err) {
    res.status(500).json({ error: "Could not read the workbook: " + err.message });
  }
});

app.post("/add", upload.array("files"), (req, res) => {
  try {
    const body = req.body;
    const name = (body.name || "").trim();
    const broadCategory = (body.broadCategory || "").trim();

    if (!name) return res.status(400).json({ error: "Resource Name is required." });
    if (!VALID_CATEGORIES.includes(broadCategory)) {
      return res.status(400).json({ error: "Please choose a valid Broad Category from the list." });
    }

    const { wb, rows } = readRows();

    const duplicate = rows.find(r => String(r["Resource Name"]).trim().toLowerCase() === name.toLowerCase());
    if (duplicate) {
      return res.status(409).json({
        error: `"${name}" already exists in the Resource List. Use Edit instead of Add, or use a distinguishing name.`
      });
    }

    const fileLabels = toArray(body.fileLabels);
    let newLinks = [];
    try { newLinks = JSON.parse(body.newLinks || "[]"); } catch { newLinks = []; }
    const filesValue = buildFilesValue([], req.files || [], fileLabels, newLinks);

    let subContacts = [];
    try { subContacts = JSON.parse(body.subContacts || "[]"); } catch { subContacts = []; }

    rows.push(rowFromBody(body, filesValue));
    writeRows(wb, rows);
    upsertSubContacts(wb, null, name, subContacts);
    saveWorkbook(wb);

    runBuildAndPublish(res, name, `Add resource: ${name}`, req.files, "saved");
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to save resource: " + err.message });
  }
});

/* POST /update - originalName travels with the submission from the moment
   the resource was loaded into the form, untouched even if Name itself
   gets edited. That's what lets a rename update the right row instead of
   creating a duplicate or silently failing to find itself. */
app.post("/update", upload.array("files"), (req, res) => {
  try {
    const body = req.body;
    const originalName = (body.originalName || "").trim();
    const name = (body.name || "").trim();
    const broadCategory = (body.broadCategory || "").trim();

    if (!originalName) {
      return res.status(400).json({ error: "Missing original resource reference - please re-open this resource from the Edit list and try again." });
    }
    if (!name) return res.status(400).json({ error: "Resource Name is required." });
    if (!VALID_CATEGORIES.includes(broadCategory)) {
      return res.status(400).json({ error: "Please choose a valid Broad Category from the list." });
    }

    const { wb, rows } = readRows();

    const rowIndex = rows.findIndex(r => String(r["Resource Name"]).trim() === originalName);
    if (rowIndex === -1) {
      return res.status(404).json({
        error: `Couldn't find "${originalName}" in the workbook anymore - it may have been edited or removed elsewhere. Refresh the Edit list and try again.`
      });
    }

    if (name.toLowerCase() !== originalName.toLowerCase()) {
      const collision = rows.find((r, i) => i !== rowIndex && String(r["Resource Name"]).trim().toLowerCase() === name.toLowerCase());
      if (collision) {
        return res.status(409).json({
          error: `"${name}" already exists as a different resource. Choose a different name, or edit that entry instead.`
        });
      }
    }

    let keptItems = [];
    try { keptItems = JSON.parse(body.existingFiles || "[]"); } catch { keptItems = []; }

    const fileLabels = toArray(body.fileLabels);
    let newLinks = [];
    try { newLinks = JSON.parse(body.newLinks || "[]"); } catch { newLinks = []; }
    const filesValue = buildFilesValue(keptItems, req.files || [], fileLabels, newLinks);

    let subContacts = [];
    try { subContacts = JSON.parse(body.subContacts || "[]"); } catch { subContacts = []; }

    rows[rowIndex] = rowFromBody(body, filesValue);
    writeRows(wb, rows);
    upsertSubContacts(wb, originalName, name, subContacts);
    saveWorkbook(wb);

    const commitMsg = name === originalName ? `Edit resource: ${name}` : `Edit resource: ${originalName} -> ${name}`;
    runBuildAndPublish(res, name, commitMsg, req.files, "updated");
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update resource: " + err.message });
  }
});

/* POST /delete - confirmName checked server-side too, not just gated by
   the client's type-to-confirm UI - defense in depth for an irreversible
   action on safety-critical data. Only removes the workbook row;
   underlying PDFs in /Assets are left alone, since the same file can
   legitimately be referenced by more than one resource. */
app.post("/delete", (req, res) => {
  try {
    const name = (req.body.name || "").trim();
    const confirmName = (req.body.confirmName || "").trim();

    if (!name) return res.status(400).json({ error: "Missing resource name." });
    if (confirmName !== name) {
      return res.status(400).json({ error: "Confirmation text didn't match the resource name exactly. Nothing was deleted." });
    }

    const { wb, rows } = readRows();
    const rowIndex = rows.findIndex(r => String(r["Resource Name"]).trim() === name);
    if (rowIndex === -1) {
      return res.status(404).json({ error: `Couldn't find "${name}" in the workbook - it may have already been removed.` });
    }

    rows.splice(rowIndex, 1);
    writeRows(wb, rows);
    upsertSubContacts(wb, name, name, []);
    saveWorkbook(wb);

    runBuildAndPublish(res, name, `Delete resource: ${name}`, [], "deleted");
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete resource: " + err.message });
  }
});

app.get("/publish-status", (req, res) => {
  try {
    const config = publisher.loadConfig().github;
    res.json({
      version: EDITOR_VERSION,
      enabled: config.enabled,
      configured: Boolean(config.owner && config.repo && config.token),
      owner: config.owner,
      repo: config.repo,
      branch: config.branch
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/publish", async (req, res) => {
  try {
    const filesToPublish = ["data.js", "version.json", "assets-manifest.json", "service-worker.js"];
    const result = await publisher.publish(ROOT, filesToPublish, "Manual republish");
    res.json({ publish: result });
  } catch (err) {
    res.status(500).json({ error: "Publish failed: " + err.message });
  }
});

app.post("/export-bundle", (req, res) => {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const zipName = `ARML-bundle-${timestamp}.zip`;
  const zipPath = path.join(ROOT, zipName);

  const psCommand =
    `Compress-Archive -Path '${ROOT}\\*' -DestinationPath '${zipPath}' -Force ` +
    `-CompressionLevel Optimal`;

  execFile(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", psCommand],
    { cwd: ROOT, timeout: 120000 },
    (err, stdout, stderr) => {
      if (err) {
        return res.status(500).json({
          error:
            "Could not create the zip bundle: " +
            (stderr || err.message) +
            ". If PowerShell is blocked on this machine, zip the main ARML folder manually instead."
        });
      }
      res.json({ message: `Bundle created: ${zipName}`, filename: zipName });
    }
  );
});

app.use((err, req, res, next) => {
  if (err) return res.status(400).json({ error: err.message });
  next();
});

app.listen(3000, () => {
  console.log("ARML Editor running at http://localhost:3000");
});
