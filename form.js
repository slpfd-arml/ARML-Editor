const form = document.getElementById("resourceForm");
const submitBtn = document.getElementById("submitBtn");
const statusBox = document.getElementById("statusBox");
const saveProgress = document.getElementById("saveProgress");
const saveProgressLabel = document.getElementById("saveProgressLabel");
const pageTitle = document.getElementById("pageTitle");
const pageSubtitle = document.getElementById("pageSubtitle");

// Shared by performSave() and the delete flow - both go through the same
// slow round trip server-side (write workbook -> rebuild data.js -> push
// to GitHub), so both deserve the same "still working" feedback.
function showSaveProgress(label) {
  saveProgress.hidden = false;
  saveProgressLabel.hidden = false;
  saveProgressLabel.textContent = label;
}

function hideSaveProgress() {
  saveProgress.hidden = true;
  saveProgressLabel.hidden = true;
}

// Opens a modal and focuses its SAFE (non-destructive) button - not
// primarily for accessibility, though it helps that too, but so a
// reflexive Enter-press (muscle memory from dismissing other dialogs,
// or just moving fast) lands on Cancel rather than on a more
// consequential option like "Proceed Anyway." A focused <button>
// activates on Enter as standard browser behavior - this only has to
// get focus in the right place, nothing more is needed to make Enter
// "do the safe thing" by default.
function openModalSafely(modalEl, safeButton) {
  modalEl.hidden = false;
  safeButton.focus();
}

// Escape closes whichever of these is currently open, equivalent to
// clicking that modal's own Cancel button - the same "make backing out
// easy, make the risky path deliberate" principle as the Enter-key
// default above, just via a different key. Delete's own modal isn't
// listed here on purpose - its Delete button starts disabled until the
// exact name is typed, so it's already safe from any keyboard shortcut
// triggering it by accident, by a different (arguably stronger) means.
document.addEventListener("keydown", e => {
  if (e.key !== "Escape") return;
  if (!exactDuplicateModal.hidden) { exactDuplicateModal.hidden = true; return; }
  if (!similarModal.hidden) { similarModal.hidden = true; return; }
  if (!duplicateConfirmModal.hidden) { duplicateConfirmModal.hidden = true; return; }
});

/* ============================================================
   MODE STATE
   'add' and 'edit' share the exact same form and fields - the only
   differences are: whether the picker shows first, whether
   originalName/existingFiles get populated, which endpoint submit
   hits, and whether Delete is available. Keeping ONE form means an
   edit can never drift out of sync with what Add supports.
   ============================================================ */
let mode = "add";
let editingResource = null; // the full resource object currently loaded, or null

const modeAddBtn = document.getElementById("modeAddBtn");
const modeEditBtn = document.getElementById("modeEditBtn");
const editPicker = document.getElementById("editPicker");
const editSearchInput = document.getElementById("editSearchInput");
const editResultsList = document.getElementById("editResultsList");
const editPickerHint = document.getElementById("editPickerHint");
const editBackRow = document.getElementById("editBackRow");
const editBackBtn = document.getElementById("editBackBtn");
const originalNameField = document.getElementById("originalNameField");
const existingFilesField = document.getElementById("existingFilesField");
const existingFilesSection = document.getElementById("existingFilesSection");
const existingFileRows = document.getElementById("existingFileRows");
const filesHeading = document.getElementById("filesHeading");
const deleteBtn = document.getElementById("deleteBtn");

let allResources = [];
let resourcesLoaded = false;

function switchToAddMode() {
  mode = "add";
  editingResource = null;
  modeAddBtn.classList.add("active");
  modeEditBtn.classList.remove("active");
  editPicker.hidden = true;
  editBackRow.hidden = true;
  pageTitle.textContent = "ARML Editor";
  pageSubtitle.textContent = "Saves directly to the workbook and pushes the update to ARML.";
  submitBtn.textContent = "Save Resource";
  deleteBtn.hidden = true;
  existingFilesSection.hidden = true;
  filesHeading.textContent = "Files";
  resetFormFields();
  form.hidden = false;
}

function switchToEditMode() {
  mode = "edit";
  editingResource = null;
  modeAddBtn.classList.remove("active");
  modeEditBtn.classList.add("active");
  editPicker.hidden = false;
  form.hidden = true;
  loadResourceList();
}

modeAddBtn.addEventListener("click", switchToAddMode);
modeEditBtn.addEventListener("click", switchToEditMode);
editBackBtn.addEventListener("click", switchToEditMode);

async function loadResourceList() {
  editPickerHint.textContent = "Loading…";
  editResultsList.innerHTML = "";
  try {
    const data = await DataLayer.getResources();
    allResources = data.resources || [];
    resourcesLoaded = true;
    editPickerHint.textContent = `${allResources.length} resources. Type to filter.`;
    renderResultsList(editSearchInput.value);
  } catch (err) {
    editPickerHint.textContent = "Couldn't load the resource list. Is the server still running?";
  }
}

editSearchInput.addEventListener("input", () => renderResultsList(editSearchInput.value));

function renderResultsList(filterText) {
  const q = filterText.trim().toLowerCase();
  const filtered = q
    ? allResources.filter(r => r.name.toLowerCase().includes(q))
    : allResources;

  editResultsList.innerHTML = "";

  if (!filtered.length) {
    const li = document.createElement("li");
    li.className = "edit-results-empty";
    li.textContent = resourcesLoaded ? "No matches." : "";
    editResultsList.appendChild(li);
    return;
  }

  filtered.forEach(r => {
    const li = document.createElement("li");
    const nameEl = document.createElement("span");
    nameEl.textContent = r.name;
    const catEl = document.createElement("span");
    catEl.className = "result-category";
    catEl.textContent = r.broadCategory;
    li.appendChild(nameEl);
    li.appendChild(catEl);
    li.addEventListener("click", () => loadResourceIntoForm(r));
    editResultsList.appendChild(li);
  });
}

function loadResourceIntoForm(resource) {
  editingResource = resource;
  resetFormFields();

  document.getElementById("nameField").value = resource.name;
  document.querySelector('[name="parent"]').value = resource.parent;
  document.querySelector('[name="type"]').value = resource.type;
  document.querySelector('[name="broadCategory"]').value = resource.broadCategory;
  document.querySelector('[name="services"]').value = resource.services;
  document.querySelector('[name="notes"]').value = resource.notes;
  document.querySelector('[name="contact"]').value = resource.contact;
  document.querySelector('[name="email"]').value = resource.email;
  document.querySelector('[name="phone"]').value = resource.phone;
  document.querySelector('[name="altPhone"]').value = resource.altPhone;
  document.querySelector('[name="fax"]').value = resource.fax;
  document.querySelector('[name="altFax"]').value = resource.altFax;
  document.querySelector('[name="tty"]').value = resource.tty;
  document.querySelector('[name="website"]').value = resource.website;
  document.querySelector('[name="address"]').value = resource.address;
  document.querySelector('[name="hours"]').value = resource.hours;

  document.querySelectorAll(".tag-input").forEach(wrapper => {
    wrapper._setValues(resource.keywords.slice());
  });

  originalNameField.value = resource.name;
  keptExistingFiles = resource.files.map(f => ({ ...f }));
  renderExistingFileRows();
  existingFilesSection.hidden = keptExistingFiles.length === 0;
  filesHeading.textContent = "Add More Files";

  pageTitle.textContent = `Editing: ${resource.name}`;
  pageSubtitle.textContent = "Changes save directly to the workbook and push to ARML.";
  submitBtn.textContent = "Save Changes";
  deleteBtn.hidden = false;

  editPicker.hidden = true;
  editBackRow.hidden = false;
  form.hidden = false;
  hideStatus();
}

/* ---------- EXISTING FILES (edit mode) ----------
   Removing here only unlinks the file from THIS resource - see the
   in-page hint and the server-side comment in server.js for why the
   physical PDF is deliberately never deleted from this flow. */
let keptExistingFiles = [];

function renderExistingFileRows() {
  existingFileRows.innerHTML = "";
  keptExistingFiles.forEach((f, i) => {
    const row = document.createElement("div");
    row.className = "existing-file-row";

    const name = document.createElement("span");
    name.className = "file-name";
    name.textContent = f.label && f.label !== f.filename ? `${f.label} (${f.filename})` : f.filename;

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "file-remove";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => {
      keptExistingFiles.splice(i, 1);
      renderExistingFileRows();
      syncExistingFilesField();
    });

    row.appendChild(name);
    row.appendChild(remove);
    existingFileRows.appendChild(row);
  });
  syncExistingFilesField();
}

function syncExistingFilesField() {
  existingFilesField.value = JSON.stringify(keptExistingFiles);
}

/* ---------- TAG-CHIP INPUTS (Keywords, Service Tags) ---------- */
document.querySelectorAll(".tag-input").forEach(wrapper => {
  const field = wrapper.dataset.field;
  const tagsEl = wrapper.querySelector(".tags");
  const entry = wrapper.querySelector(".tag-entry");
  let values = [];

  function render() {
    tagsEl.innerHTML = "";
    values.forEach((val, i) => {
      const chip = document.createElement("span");
      chip.className = "tag-chip";
      chip.textContent = val;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "tag-remove";
      remove.textContent = "×";
      remove.setAttribute("aria-label", `Remove ${val}`);
      remove.addEventListener("click", () => {
        values.splice(i, 1);
        render();
      });
      chip.appendChild(remove);
      tagsEl.appendChild(chip);
    });
  }

  function addFromInput() {
    const val = entry.value.trim();
    if (val && !values.includes(val)) {
      values.push(val);
      render();
    }
    entry.value = "";
  }

  entry.addEventListener("keydown", e => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addFromInput();
    } else if (e.key === "Backspace" && !entry.value && values.length) {
      values.pop();
      render();
    }
  });
  entry.addEventListener("blur", addFromInput);

  wrapper._getValues = () => values;
  wrapper._setValues = (arr) => { values = arr; render(); };
  wrapper._field = field;
});

/* ---------- FILE PICKER (newly added files, both modes) ---------- */
const fileInput = document.getElementById("fileInput");
const fileRows = document.getElementById("fileRows");
let pickedFiles = [];

function prettyLabel(filename) {
  return filename
    .replace(/\.pdf$/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

fileInput.addEventListener("change", () => {
  pickedFiles = pickedFiles.concat(Array.from(fileInput.files));
  fileInput.value = "";
  renderFileRows();
});

function renderFileRows() {
  fileRows.innerHTML = "";
  pickedFiles.forEach((file, i) => {
    const row = document.createElement("div");
    row.className = "file-row";

    const name = document.createElement("span");
    name.className = "file-name";
    name.textContent = file.name;

    const label = document.createElement("input");
    label.type = "text";
    label.className = "file-label";
    label.value = prettyLabel(file.name);
    label.placeholder = "Link text shown in the app";

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "file-remove";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => {
      pickedFiles.splice(i, 1);
      renderFileRows();
    });

    row.appendChild(name);
    row.appendChild(label);
    row.appendChild(remove);
    fileRows.appendChild(row);
  });
}

/* ---------- FUZZY DUPLICATE DETECTION ----------
   A SOFT warning, never a block - this tool has one operator adding
   things deliberately, not a bulk import, so a two-second "yep, that's
   different" is cheap. A wrong hard block is not: it'd stop a real
   addition dead with no way through except editing the workbook by hand,
   exactly what this tool exists to avoid.

   Two DIFFERENT thresholds, not one combined score - found by testing
   against the real 161-resource ARML workbook, not guessed. Token-set
   similarity (comparing the WORDS each name contains) is the reliable
   signal. Raw character-level similarity turned out to be systematically
   fooled by a long shared suffix ("Food Shelf", "Health Center") even
   when the actual distinguishing word (CAPI/ICA/PROP/Pet) is completely
   different - real false positives found in this exact dataset. It still
   catches genuine single-word typos token comparison alone would miss
   (e.g. "Vehicle" -> "Vehical"), so it stays as a secondary signal - just
   gated much higher so a shared generic suffix alone can't trigger it. */
function normalizeForSimilarity(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[.,'"()&/-]/g, " ")
    .split(/\s+/)
    .filter(w => w && !["the", "a", "an", "of", "and", "inc", "llc", "program", "programs"].includes(w))
    .join(" ")
    .trim();
}

function tokenSetSimilarity(a, b) {
  const setA = new Set(normalizeForSimilarity(a).split(/\s+/).filter(Boolean));
  const setB = new Set(normalizeForSimilarity(b).split(/\s+/).filter(Boolean));
  if (setA.size === 0 || setB.size === 0) return 0;
  const intersection = [...setA].filter(w => setB.has(w)).length;
  const union = new Set([...setA, ...setB]).size;
  return intersection / union;
}

function levenshteinRatio(a, b) {
  a = normalizeForSimilarity(a);
  b = normalizeForSimilarity(b);
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return 1 - dp[m][n] / Math.max(m, n);
}

const TOKEN_SIMILARITY_THRESHOLD = 0.72;
const LEVENSHTEIN_SIMILARITY_THRESHOLD = 0.85;

function isSimilarName(a, b) {
  return tokenSetSimilarity(a, b) >= TOKEN_SIMILARITY_THRESHOLD || levenshteinRatio(a, b) >= LEVENSHTEIN_SIMILARITY_THRESHOLD;
}

// excludeName is the resource's OWN original name during an edit, so
// saving with the name unchanged (or lightly tweaked) never flags itself
// - only a rename that lands close to a DIFFERENT real resource warns.
function findSimilarNames(candidateName, allNames, excludeName) {
  const excludeLower = (excludeName || "").trim().toLowerCase();
  return allNames
    .filter(n => n.trim().toLowerCase() !== excludeLower)
    .filter(n => isSimilarName(candidateName, n))
    .sort((a, b) => tokenSetSimilarity(candidateName, b) - tokenSetSimilarity(candidateName, a));
}

/* ---------- DUPLICATE-NAME DETECTION (silent - surfaced via dialogs at
   submit time, not text under the field, which is easy to tab past
   without noticing) ---------- */
const nameField = document.getElementById("nameField");
let existingNames = [];       // lowercased, for the exact-match check
let existingNamesCased = [];  // original casing, for dialog message text
let isExactDuplicate = false;
let exactDuplicateMatchName = null;
let hasUnacknowledgedSimilarWarning = false;
let pendingSimilarMatchName = null; // the single CLOSEST fuzzy match, for the dialog

DataLayer.getResourceNames()
  .then(data => {
    existingNamesCased = data.names || [];
    existingNames = existingNamesCased.map(n => n.toLowerCase());
  })
  .catch(() => {});

// Fetched eagerly (not just when Edit mode opens) so the fuzzy-match
// dialog can jump straight into editing the matched resource without an
// extra round trip - and so the matched name is GUARANTEED to be
// findable in this same array afterward, since it's the same array the
// match came from in the first place.
DataLayer.getResources()
  .then(data => { allResources = data.resources || []; })
  .catch(() => {});

nameField.addEventListener("input", () => {
  const raw = nameField.value.trim();
  const val = raw.toLowerCase();
  const ownName = mode === "edit" && editingResource ? editingResource.name : "";
  const isOwnName = val === ownName.toLowerCase();

  if (val && !isOwnName && existingNames.includes(val)) {
    isExactDuplicate = true;
    exactDuplicateMatchName = existingNamesCased.find(n => n.toLowerCase() === val) || raw;
    hasUnacknowledgedSimilarWarning = false;
    pendingSimilarMatchName = null;
    return;
  }
  isExactDuplicate = false;
  exactDuplicateMatchName = null;

  if (!raw) {
    hasUnacknowledgedSimilarWarning = false;
    pendingSimilarMatchName = null;
    return;
  }

  const matches = findSimilarNames(raw, allResources.map(r => r.name), ownName);
  if (matches.length) {
    hasUnacknowledgedSimilarWarning = true;
    pendingSimilarMatchName = matches[0]; // closest match drives the dialog
  } else {
    hasUnacknowledgedSimilarWarning = false;
    pendingSimilarMatchName = null;
  }
});

/* ---------- FORM RESET ---------- */
function resetFormFields() {
  form.reset();
  pickedFiles = [];
  renderFileRows();
  keptExistingFiles = [];
  existingFilesField.value = "[]";
  existingFileRows.innerHTML = "";
  document.querySelectorAll(".tag-input").forEach(wrapper => wrapper._setValues([]));
  originalNameField.value = "";
  isExactDuplicate = false;
  exactDuplicateMatchName = null;
  hasUnacknowledgedSimilarWarning = false;
  pendingSimilarMatchName = null;
}

/* ---------- SUBMIT (Add or Update, depending on mode) ---------- */
form.addEventListener("submit", async e => {
  e.preventDefault();
  hideStatus();

  // Exact match is checked FIRST and takes priority - it's a real hard
  // block (the server rejects it regardless), so there's no "Proceed
  // Anyway" option here the way there is for a fuzzy match.
  if (isExactDuplicate && exactDuplicateMatchName) {
    exactDuplicateModalMessage.textContent =
      `A resource named "${exactDuplicateMatchName}" already exists. This can't be saved as a new entry - edit the existing one instead, or choose a different name.`;
    openModalSafely(exactDuplicateModal, exactDuplicateCancelBtn);
    return;
  }

  // A fuzzy match pauses the save rather than blocking it outright - the
  // person gets a real choice (go edit the resource that already exists,
  // or confirm this genuinely is something different) instead of either
  // silently creating a duplicate or being stopped cold.
  if (hasUnacknowledgedSimilarWarning && pendingSimilarMatchName) {
    similarModalMessage.textContent =
      `Similar resource "${pendingSimilarMatchName}" already exists. Would you like to edit the existing resource instead?`;
    openModalSafely(similarModal, similarCancelBtn);
    return;
  }

  await performSave();
});

async function performSave() {
  const originalLabel = submitBtn.textContent;
  submitBtn.disabled = true;
  submitBtn.textContent = mode === "edit" ? "Saving Changes…" : "Saving…";
  showSaveProgress("Saving — rebuilding the app and publishing to GitHub.");

  try {
    const formData = new FormData();
    new FormData(form).forEach((value, key) => formData.append(key, value));

    document.querySelectorAll(".tag-input").forEach(wrapper => {
      wrapper._getValues().forEach(v => formData.append(wrapper._field, v));
    });

    pickedFiles.forEach(file => formData.append("files", file));
    document.querySelectorAll(".file-label").forEach(input => {
      formData.append("fileLabels", input.value.trim());
    });

    const out = mode === "edit"
      ? await DataLayer.updateResource(formData)
      : await DataLayer.addResource(formData);

    if (!out.ok) {
      showStatus(out.error || "Something went wrong.", "error");
      return;
    }

    showStatus(out.message, out.buildError ? "warning" : "success");
    renderPublishDetail(out.publish);

    if (!out.buildError) {
      const savedName = nameField.value.trim();
      if (mode === "add") {
        resetFormFields();
        existingNames.push(savedName.toLowerCase());
      } else {
        // Edit: return to the (freshly reloaded) picker rather than
        // leaving a stale form open - the natural next action is either
        // editing something else or going back to Add.
        existingNames = existingNames.filter(n => n !== editingResource.name.toLowerCase());
        existingNames.push(savedName.toLowerCase());
        setTimeout(switchToEditMode, 900);
      }
    }
  } catch (err) {
    showStatus("Couldn't save: " + (err.message || "unexpected error. If running locally, check that start-ARML-editor.bat is still running."), "error");
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = originalLabel;
    hideSaveProgress();
    // Fires on success AND failure on purpose - a failed save is exactly
    // when the connection light most needs to stop saying "ready".
    document.dispatchEvent(new CustomEvent("arml:saved"));
  }
}

/* ---------- SIMILAR-RESOURCE MODAL (three-way choice) ---------- */
/* ---------- EXACT-DUPLICATE MODAL (hard block - Cancel or Edit Existing only) ---------- */
const exactDuplicateModal = document.getElementById("exactDuplicateModal");
const exactDuplicateModalMessage = document.getElementById("exactDuplicateModalMessage");
const exactDuplicateCancelBtn = document.getElementById("exactDuplicateCancelBtn");
const exactDuplicateEditExistingBtn = document.getElementById("exactDuplicateEditExistingBtn");

exactDuplicateCancelBtn.addEventListener("click", () => {
  exactDuplicateModal.hidden = true;
});

exactDuplicateEditExistingBtn.addEventListener("click", () => {
  exactDuplicateModal.hidden = true;
  const target = allResources.find(r => r.name === exactDuplicateMatchName);
  if (!target) {
    showStatus("Couldn't load that resource - try again from the Edit tab.", "error");
    return;
  }
  mode = "edit";
  modeAddBtn.classList.remove("active");
  modeEditBtn.classList.add("active");
  loadResourceIntoForm(target);
});

const similarModal = document.getElementById("similarModal");
const similarModalMessage = document.getElementById("similarModalMessage");
const similarCancelBtn = document.getElementById("similarCancelBtn");
const similarEditExistingBtn = document.getElementById("similarEditExistingBtn");
const similarProceedBtn = document.getElementById("similarProceedBtn");

const duplicateConfirmModal = document.getElementById("duplicateConfirmModal");
const duplicateCancelBtn = document.getElementById("duplicateCancelBtn");
const duplicateConfirmBtn = document.getElementById("duplicateConfirmBtn");

// Cancel: just close the modal. The person's typed data is untouched and
// nothing was sent to the server - they're free to edit the name or try
// saving again.
similarCancelBtn.addEventListener("click", () => {
  similarModal.hidden = true;
});

// Jumps straight into editing the resource that matched, abandoning
// whatever was being added/edited here - loadResourceIntoForm() handles
// all the visual state, but mode/tab-active state is Add-mode-specific
// wiring it doesn't own, so that part happens here.
similarEditExistingBtn.addEventListener("click", () => {
  similarModal.hidden = true;
  const target = allResources.find(r => r.name === pendingSimilarMatchName);
  if (!target) {
    showStatus("Couldn't load that resource - try again from the Edit tab.", "error");
    return;
  }
  mode = "edit";
  modeAddBtn.classList.remove("active");
  modeEditBtn.classList.add("active");
  loadResourceIntoForm(target);
});

// Proceeding doesn't save immediately - one more explicit confirmation
// that this is intentionally a second, separate entry.
similarProceedBtn.addEventListener("click", () => {
  similarModal.hidden = true;
  openModalSafely(duplicateConfirmModal, duplicateCancelBtn);
});

duplicateCancelBtn.addEventListener("click", () => {
  duplicateConfirmModal.hidden = true;
});

duplicateConfirmBtn.addEventListener("click", async () => {
  duplicateConfirmModal.hidden = true;
  hasUnacknowledgedSimilarWarning = false;
  await performSave();
});

/* ---------- DELETE ---------- */
const deleteModal = document.getElementById("deleteModal");
const deleteModalName = document.getElementById("deleteModalName");
const deleteConfirmInput = document.getElementById("deleteConfirmInput");
const deleteConfirmBtn = document.getElementById("deleteConfirmBtn");
const deleteCancelBtn = document.getElementById("deleteCancelBtn");

deleteBtn.addEventListener("click", () => {
  if (!editingResource) return;
  deleteModalName.textContent = editingResource.name;
  deleteConfirmInput.value = "";
  deleteConfirmBtn.disabled = true;
  deleteModal.hidden = false;
  deleteConfirmInput.focus();
});

deleteConfirmInput.addEventListener("input", () => {
  deleteConfirmBtn.disabled = !editingResource || deleteConfirmInput.value !== editingResource.name;
});

deleteCancelBtn.addEventListener("click", () => { deleteModal.hidden = true; });

deleteConfirmBtn.addEventListener("click", async () => {
  if (!editingResource) return;
  const name = editingResource.name;
  deleteConfirmBtn.disabled = true;
  deleteConfirmBtn.textContent = "Deleting — rebuilding & publishing, this can take a bit…";

  try {
    const out = await DataLayer.deleteResource(name, deleteConfirmInput.value);
    deleteModal.hidden = true;

    if (!out.ok) {
      showStatus(out.error || "Delete failed.", "error");
      return;
    }

    showStatus(out.message, out.buildError ? "warning" : "success");
    renderPublishDetail(out.publish);
    existingNames = existingNames.filter(n => n !== name.toLowerCase());
    setTimeout(switchToEditMode, 900);
  } catch (err) {
    showStatus("Couldn't delete: " + (err.message || "unexpected error."), "error");
    deleteModal.hidden = true;
  } finally {
    deleteConfirmBtn.textContent = "Delete";
  }
});

function showStatus(text, kind) {
  statusBox.textContent = text;
  statusBox.className = "status-box " + kind;
  statusBox.hidden = false;
}

function hideStatus() {
  statusBox.hidden = true;
}

/* ---------- PUBLISH STATUS ---------- */
const publishDetail = document.getElementById("publishDetail");

function renderPublishDetail(publish) {
  if (!publishDetail) return;

  if (!publish || !publish.attempted) {
    publishDetail.hidden = true;
    publishDetail.innerHTML = "";
    return;
  }

  const rows = [];
  publish.pushed.forEach(p => rows.push(`<li class="publish-ok">✓ ${p.path}</li>`));
  publish.failed.forEach(f => rows.push(`<li class="publish-fail">✕ ${f.path} — ${f.error}</li>`));

  publishDetail.innerHTML = `<strong>GitHub publish:</strong><ul>${rows.join("")}</ul>` +
    (publish.failed.length
      ? `<button type="button" id="retryPublishBtn" class="btn-secondary">Retry publish</button>
         <button type="button" id="exportBundleBtn" class="btn-secondary">Export update bundle instead</button>`
      : "");
  publishDetail.hidden = false;

  const retryBtn = document.getElementById("retryPublishBtn");
  if (retryBtn) retryBtn.addEventListener("click", retryPublish);
  const exportBtn = document.getElementById("exportBundleBtn");
  if (exportBtn) exportBtn.addEventListener("click", exportBundle);
}

async function retryPublish() {
  const btn = document.getElementById("retryPublishBtn");
  if (btn) { btn.disabled = true; btn.textContent = "Retrying…"; }
  try {
    const out = await DataLayer.republish();
    if (!out.ok) {
      showStatus(out.error || "Retry failed.", "error");
      return;
    }
    renderPublishDetail(out.publish);
    if (out.publish.failed.length === 0) {
      showStatus("Published to GitHub successfully.", "success");
    }
  } catch (err) {
    showStatus("Couldn't retry: " + (err.message || "unexpected error."), "error");
  }
}

async function exportBundle() {
  const btn = document.getElementById("exportBundleBtn");
  if (btn) { btn.disabled = true; btn.textContent = "Creating bundle…"; }
  try {
    const out = await DataLayer.exportBundle();
    if (!out.ok) {
      showStatus(out.error || "Could not create the bundle.", "error");
      return;
    }
    showStatus(`${out.message} — find it in the main ARML folder.`, "success");
  } catch (err) {
    showStatus("Couldn't create the bundle: " + (err.message || "unexpected error."), "error");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Export update bundle instead"; }
  }
}

/* Version tag shows the display CONTEXT (local / browser / PWA), while
   everything about tokens keys off the BACKEND mode instead - see
   data-layer.js's getContext() comment for why conflating the two is a
   real bug rather than a nitpick.

   No more publishConfigNote: it used to restate what the connection
   light already says one line below it - "GitHub publishing is on,
   ready to save" next to a dot that says exactly that. Removed for both
   modes, not just browser - the local-mode text ("see config.json") was
   the one piece of genuinely non-duplicate info it carried, but a
   config problem there already surfaces as the light's own error state,
   so it wasn't worth keeping a whole row around for that alone. */
Promise.all([DataLayer.getPublishStatus(), DataLayer.contextLabel()])
  .then(([status, contextLabel]) => {
    const versionEl = document.getElementById("editorVersionTag");
    if (versionEl && status.version) {
      versionEl.textContent = `ARML Editor v${status.version} (${contextLabel})`;
    }
  })
  .catch(() => {});

/* ---------- INITIAL STATE ---------- */
switchToAddMode();

/* ---------- CONNECTION STATUS LIGHT ----------
   Checks whether saving will actually work, and says so before someone
   spends ten minutes filling out the form. See github-backend.js's
   checkConnection() for why this asks GitHub about repo permissions
   rather than pinging the ARML site (a ping would show green in every
   case where saving is actually broken). */
const connStatusBtn = document.getElementById("connStatus");
const connStatusText = document.getElementById("connStatusText");

function setConnStatus(state, message) {
  if (!connStatusBtn) return;
  connStatusBtn.classList.remove("conn-ok", "conn-warn", "conn-error", "conn-unknown", "conn-checking");
  connStatusBtn.classList.add("conn-" + state);
  connStatusText.textContent = message;
  connStatusBtn.title = state === "checking" ? "Checking…" : "Click to re-check connection";
}

async function refreshConnStatus() {
  setConnStatus("checking", "Checking connection…");
  try {
    const result = await DataLayer.checkConnection();
    setConnStatus(result.state, result.message);
  } catch (err) {
    setConnStatus("error", "Couldn't check connection: " + (err.message || "unexpected error."));
  }
}

/* Clicking the light re-checks. If we're in browser/PWA mode and there
   still isn't a token, clicking re-opens the token prompt instead -
   which is what makes dismissing the initial prompt recoverable without
   a page reload. */
async function onConnStatusClick() {
  const backendMode = await DataLayer.detectMode();
  if (backendMode === "browser") {
    // Re-prompt when there's no token OR when the stored one was
    // rejected - both are "this credential needs replacing", and the
    // light is the one obvious place to fix it.
    const rejected = connStatusBtn.classList.contains("conn-error") &&
                     /rejected|read-only/i.test(connStatusText.textContent);
    if (!localStorage.getItem("arml_editor_token") || rejected) {
      localStorage.removeItem("arml_editor_token");
      window.ARMLEnsureGitHubToken();
    }
  }
  refreshConnStatus();
}

/* Ask for the token at LOAD, not on first save. Keyed on backend mode,
   not display mode: local mode reads its token from config.json
   server-side and must never prompt here, whether or not it happens to
   be running as an installed PWA. Dismissing is allowed - the light
   goes amber and explains, and clicking it prompts again.

   ORDER MATTERS: check FIRST, then prompt only if the check says no
   token exists. Prompting blindly up front meant a REVOKED token got
   reported as "no token" - a materially different problem pointing at a
   different fix (re-paste vs. go generate a new one on GitHub). */
async function initConnStatus() {
  const backendMode = await DataLayer.detectMode();
  if (backendMode !== "browser") {
    refreshConnStatus();
    return;
  }

  if (!localStorage.getItem("arml_editor_token")) {
    window.ARMLEnsureGitHubToken();
  }
  refreshConnStatus();
}

if (connStatusBtn) {
  connStatusBtn.addEventListener("click", onConnStatusClick);
  initConnStatus();
}

/* Re-check after every save attempt, success or failure. This is exactly
   when the answer is most likely to have just changed: a token gets
   entered on first save, or a save fails because the network dropped
   since page load. Without this the light could sit on a stale "ready"
   while saves are failing. */
document.addEventListener("arml:saved", refreshConnStatus);
