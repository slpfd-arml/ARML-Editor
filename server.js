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
const EDITOR_VERSION = "1.2.0";

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

function parseFilesField(str) {
  return String(str || "")
    .split(";")
    .map(s => s.trim())
    .filter(Boolean)
    .map(entry => {
      const pipeIdx = entry.indexOf("|");
      return pipeIdx === -1
        ? { label: entry, filename: entry }
        : { label: entry.slice(0, pipeIdx).trim(), filename: entry.slice(pipeIdx + 1).trim() };
    });
}

function buildFilesValue(keptFiles, newFiles, newLabels) {
  const keptPart = keptFiles.map(f => (f.label && f.label !== f.filename ? `${f.label}|${f.filename}` : f.filename));
  const newPart = (newFiles || []).map((f, i) => {
    const label = (newLabels[i] || "").trim();
    return label ? `${label}|${f.filename}` : f.filename;
  });
  return [...keptPart, ...newPart].join("; ");
}

function rowFromBody(body, filesValue) {
  return {
    "Resource Name": (body.name || "").trim(),
    "Parent Organization/Agency": body.parent || "",
    "Organization Type": body.type || "",
    "Services Provided": body.services || "",
    "Contact Person": body.contact || "",
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

function writeRows(wb, rows) {
  const header = rows.length
    ? Object.keys(rows[0])
    : ["Resource Name","Parent Organization/Agency","Organization Type","Services Provided",
       "Contact Person","Email Address","Phone","Alternate Phone","Fax","Alternate Fax","TTY",
       "Website","Street Address","Notes","Hours","Keywords","Files","Broad Category","Service Tags"];
  wb.Sheets["Resource List"] = XLSX.utils.json_to_sheet(rows, { header });
  XLSX.writeFile(wb, WORKBOOK_PATH);
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
    const { rows } = readRows();
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
        files: parseFilesField(r["Files"])
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
    const filesValue = buildFilesValue([], req.files || [], fileLabels);

    rows.push(rowFromBody(body, filesValue));
    writeRows(wb, rows);

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

    let keptFiles = [];
    try { keptFiles = JSON.parse(body.existingFiles || "[]"); } catch { keptFiles = []; }

    const fileLabels = toArray(body.fileLabels);
    const filesValue = buildFilesValue(keptFiles, req.files || [], fileLabels);

    rows[rowIndex] = rowFromBody(body, filesValue);
    writeRows(wb, rows);

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
