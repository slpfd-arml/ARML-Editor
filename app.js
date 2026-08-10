const searchInput = document.getElementById("searchInput");
const resourceItems = document.getElementById("resourceItems");
const detailContent = document.getElementById("detailContent");
const resourceListPane = document.getElementById("resourceListPane");
const listBackBar = document.getElementById("listBackBar");
const backBtn = document.getElementById("backBtn");
const listBackLabel = document.getElementById("listBackLabel");
const allResourcesRow = document.getElementById("allResourcesRow");
const toolsBtn = document.getElementById("toolsBtn");
const insuranceBtn = document.getElementById("insuranceBtn");
const roiBtn = document.getElementById("roiBtn");

/* HELPERS */
function formatPhone(raw) {
  if (!raw) return "";
  const digits = String(raw).replace(/\D/g, "");
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  if (digits.length === 11 && digits[0] === "1") {
    return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  return String(raw); // not a clean 10-digit number — show as typed rather than mangle it
}

function telHref(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  return digits ? `tel:${digits}` : "";
}

// Small self-contained outline icons (no external font/CDN - has to work offline).
// currentColor + inline-flex wrapper so CSS `color` controls the icon color.
const ICON_SVG = {
  phone: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/>',
  mail: '<path d="M2 6h20v12H2z"/><path d="M22 6l-10 7L2 6"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20"/>',
  pin: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/>',
  "house-search": '<path d="M4 11.5L12 4l8 7.5"/><path d="M6 10v9a1 1 0 0 0 1 1h3v-5h4v3.3"/><circle cx="17" cy="17" r="3.2"/><path d="M19.3 19.3L22 22"/>',
  clipboard: '<rect x="6" y="4" width="12" height="17" rx="2"/><path d="M9 4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1H9z"/><path d="M9 12l2 2 4-4"/>',
  "doc-sign": '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 15l6-6 2 2-6 6H9v-2z"/>',
  "id-card": '<rect x="2" y="5" width="20" height="14" rx="2"/><circle cx="8" cy="12" r="2"/><path d="M14 10h6M14 14h4"/>',
  heart: '<path d="M12 21s-7-4.5-9.5-9A5.5 5.5 0 0 1 12 6a5.5 5.5 0 0 1 9.5 6c-2.5 4.5-9.5 9-9.5 9z"/>'
};

function icon(name, size) {
  size = size || 13;
  return `<svg class="icon-${name}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICON_SVG[name]}</svg>`;
}

// Same heart path for both states - only the fill toggles. This is deliberate:
// using two different characters/glyphs for outline vs filled (like Unicode
// ♥/♡) renders as two genuinely different shapes depending on font, which is
// exactly the mismatch this replaced.
function heartIcon(filled) {
  return `<svg width="28" height="28" viewBox="0 0 24 24" fill="${filled ? "currentColor" : "none"}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICON_SVG.heart}</svg>`;
}

// Resolves a site-relative path (e.g. "Assets/foo.pdf") against the page's
// actual current location. More reliable than a bare relative href when the
// app is opened as a local file, synced through OneDrive, or opened on iPad.
function toFileUrl(relPath) {
  const base = window.location.href.replace(/index\.html$/, "");
  return base + relPath.replace(/^\/*/, "");
}

// navigator.standalone is iOS-only and true only when the app was launched
// from a home-screen icon (not a normal Safari tab). This matters because
// target="_blank" is silently ignored in that mode - there's no browser
// chrome to open a "new tab" into, so a PDF link just navigates the app's
// own view away from itself, with no back button and no address bar to
// recover with. Regular Safari tabs and desktop/Android browsers are
// unaffected and keep the normal new-tab behavior.
const IS_IOS_STANDALONE = typeof navigator !== "undefined" && navigator.standalone === true;

// Builds the href/target (or href/download) attribute string for a PDF
// link, generated once per render site so all four call sites (sub-contact
// files, screening tools, insurance guide, ROI files) stay consistent.
// In iOS standalone mode this forces a download instead of a navigation -
// iOS reliably hands that off to its native Share/Save sheet, which escapes
// the trap target="_blank" can't, and has the side benefit of leaving a
// real copy in the Files app for offline reference.
function fileLinkAttrs(url, label) {
  if (IS_IOS_STANDALONE) {
    const safeName = (label || "document").replace(/[^\w\-. ]+/g, "").trim() || "document";
    return `href="${url}" download="${safeName}.pdf"`;
  }
  return `href="${url}" target="_blank" rel="noopener"`;
}

// Formats "123 Main St, Anytown, MN 55555" as two lines (street / city-state-zip),
// wrapped in a clickable Apple Maps link. Handles multiple semicolon-separated
// locations, trailing parenthetical notes, and addresses missing the comma
// before the city. Falls back to showing the address as-is, still linked, if
// it doesn't match a recognizable "...CITY, ST ZIP" pattern at all.
function formatAddress(raw) {
  if (!raw) return "";

  function parseOne(segment) {
    const addr = segment.replace(/\s+/g, " ").trim();
    const m = addr.match(/^(.*?),?\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?)\s*(\([^)]*\))?$/);
    const mapsUrl = `https://maps.apple.com/?q=${encodeURIComponent(addr)}`;
    if (!m) {
      return `<a href="${mapsUrl}" target="_blank">${addr}</a>`;
    }
    let rest = m[1].replace(/,\s*$/, "");
    const lastComma = rest.lastIndexOf(",");
    let street, city;
    if (lastComma !== -1) {
      street = rest.slice(0, lastComma).trim();
      city = rest.slice(lastComma + 1).trim();
    } else {
      const words = rest.split(/\s+/);
      city = words.pop();
      street = words.join(" ");
    }
    const note = m[4] ? ` ${m[4]}` : "";
    return `<a href="${mapsUrl}" target="_blank">${icon("pin")} ${street}<br>${city}, ${m[2]} ${m[3]}${note}</a>`;
  }

  return String(raw).split(";").map(s => s.trim()).filter(Boolean).map(parseOne).join("<br><br>");
}

// "Tuesday 1:00 PM–4:00 PM; Wednesday–Thursday 9:00 AM–12:00 PM and 1:00 PM–4:00 PM"
// -> one line per semicolon-separated day-group, with "and" between two time
// ranges (only when it sits between an AM/PM marker and a digit, so it doesn't
// touch "Saturday, Sunday, and holidays"-style day lists) turned into a comma.
function formatHours(raw) {
  if (!raw) return "";
  return String(raw)
    .split(/[;\r\n]+/)
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => s.replace(/(AM|PM)\s+and\s+(\d)/gi, "$1, $2"))
    .join("<br>");
}

/* FAVORITES — persisted in localStorage, keyed by resource name */
const FAVORITES_KEY = "armLibraryFavorites";

function getFavorites() {
  try {
    const raw = localStorage.getItem(FAVORITES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
}

function isFavorite(name) {
  return getFavorites().includes(name);
}

function toggleFavorite(name) {
  const favs = getFavorites();
  const idx = favs.indexOf(name);
  if (idx === -1) {
    favs.push(name);
  } else {
    favs.splice(idx, 1);
  }
  try {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(favs));
  } catch (e) {
    // storage unavailable (private browsing, quota, etc.) - favoriting just won't persist
  }
  return favs.includes(name);
}

/* CATEGORY LIST / RESOURCE LIST TOGGLE — the left pane shares one space
   between browsing categories (red) and viewing a resource list (grey),
   instead of a separate chip bar competing for space with the list. */
function showCategoryList() {
  resourceListPane.classList.add("category-mode");
  listBackBar.classList.remove("visible");
  allResourcesRow.hidden = false;
  searchInput.value = "";

  const categories = ARM_DATA.categories || [];
  resourceItems.innerHTML = "";

  categories.forEach(cat => {
    const count = ARM_DATA.resources.filter(r => (r.categories || []).includes(cat)).length;
    const row = document.createElement("li");
    row.className = "category-row";
    row.innerHTML = `<span>${cat}</span><span><span class="cat-count">${count}</span><span class="chev">›</span></span>`;
    row.addEventListener("click", () => {
      const filtered = ARM_DATA.resources.filter(r => (r.categories || []).includes(cat));
      showResourceList(filtered, cat);
    });
    resourceItems.appendChild(row);
  });
}

function showResourceList(list, label) {
  resourceListPane.classList.remove("category-mode");
  listBackBar.classList.add("visible");
  allResourcesRow.hidden = true;
  listBackLabel.textContent = label;
  renderResources(list);
}

backBtn.addEventListener("click", () => {
  showCategoryList();
});

allResourcesRow.addEventListener("click", () => {
  showResourceList(ARM_DATA.resources, "All resources");
});

/* UNIFIED RESOURCE RENDERER — always alphabetical */
function renderResources(list) {
  resourceItems.innerHTML = "";

  const sorted = [...list].sort((a, b) => a.name.localeCompare(b.name));

  sorted.forEach(r => {
    const li = document.createElement("li");
    li.className = "resource-row";
    li.innerHTML = `<span>${r.name}</span><span class="chev">›</span>`;

    li.addEventListener("click", () => {
      document.querySelectorAll("#resourceItems li").forEach(item => {
        item.classList.remove("selected");
      });
      li.classList.add("selected");
      showDetail(r);
    });

    resourceItems.appendChild(li);
  });
}

/* DETAIL PANEL */
function showDetail(resource) {
  const favActive = isFavorite(resource.name);
  detailContent.innerHTML = `
    <div class="detail-heading-row">
      <h2>${resource.name}</h2>
      <button class="fav-heart${favActive ? " active" : ""}" id="favHeartBtn" aria-label="Toggle favorite" aria-pressed="${favActive}">${heartIcon(favActive)}</button>
    </div>
    ${resource.parent ? `<div class="detail-parent">${resource.parent}</div>` : ""}
    ${resource.type ? `<div class="detail-type">${resource.type}</div>` : ""}
    ${(resource.phone || resource.website) ? `
      <div class="detail-actions">
        ${resource.phone ? `<a class="detail-action-btn primary" href="${telHref(resource.phone)}">${icon("phone")} Call</a>` : ""}
        ${resource.website ? `<a class="detail-action-btn" href="${resource.website}" target="_blank">${icon("globe")} Website</a>` : ""}
      </div>
    ` : ""}
    ${section("Overview", resource.services)}
    ${section("Contact", contactBlock(resource))}
    ${section("Related Contacts", subContactsBlock(resource))}
    ${section("Documents & Files", fileBlock(resource))}
    ${section("Notes", resource.notes)}
  `;

  document.getElementById("favHeartBtn").addEventListener("click", () => {
    const nowActive = toggleFavorite(resource.name);
    const heart = document.getElementById("favHeartBtn");
    heart.innerHTML = heartIcon(nowActive);
    heart.classList.toggle("active", nowActive);
    heart.setAttribute("aria-pressed", nowActive);
  });
}

function section(title, content) {
  const cleaned = (content || "")
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, "")
    .trim();

  if (!cleaned) return "";

  return `
    <div class="detail-section">
      <h3>${title}</h3>
      <div class="detail-section-content">${content}</div>
    </div>
  `;
}

function contactBlock(r) {
  return `
    ${r.phone ? `<p>${icon("phone")} ${formatPhone(r.phone)}</p>` : ""}
    ${r.altPhone ? `<p>${icon("phone")} <strong>Alt:</strong> ${formatPhone(r.altPhone)}</p>` : ""}
    ${r.fax ? `<p><strong>Fax:</strong> ${formatPhone(r.fax)}</p>` : ""}
    ${r.altFax ? `<p><strong>Alt Fax:</strong> ${formatPhone(r.altFax)}</p>` : ""}
    ${r.tty ? `<p><strong>TTY:</strong> ${formatPhone(r.tty)}</p>` : ""}
    ${r.email ? `<p>${icon("mail")} <a href="mailto:${r.email}">${r.email}</a></p>` : ""}
    ${r.address ? `<p>${formatAddress(r.address)}</p>` : ""}
    ${r.hours ? `<p><strong>Hours:</strong><br>${formatHours(r.hours)}</p>` : ""}
  `;
}

/* SUB-CONTACTS — e.g. St. Stephen's individual shelter/program contacts */
function subContactsBlock(r) {
  if (!r.subContacts || !r.subContacts.length) return "";

  return r.subContacts
    .map(c => {
      const meta = [c.category, c.audience].filter(Boolean).join(" · ");
      return `
        <div class="sub-contact">
          <h4>${c.name}</h4>
          ${meta ? `<p class="sub-contact-meta">${meta}</p>` : ""}
          ${c.purpose ? `<p>${c.purpose}</p>` : ""}
          ${c.phone ? `<p><strong>Phone:</strong> ${formatPhone(c.phone)}</p>` : ""}
          ${c.location ? `<p><strong>Location:</strong> ${c.location}</p>` : ""}
          ${c.hours ? `<p><strong>Hours:</strong> ${c.hours}</p>` : ""}
          ${c.access ? `<p><strong>Access:</strong> ${c.access}</p>` : ""}
          ${c.notes ? `<p><strong>Notes:</strong> ${c.notes}</p>` : ""}
          ${c.website ? `<p>${icon("globe")} <a href="${c.website}" target="_blank">Visit Website</a></p>` : ""}
        </div>
      `;
    })
    .join("");
}

/* FIXED FILE BLOCK — FRIENDLY NAMES + MULTIPLE FILES */
function fileBlock(r) {
  if (!r.files || !r.files.length) return "";

  return r.files
    .map(file => {
      return `<p><a ${fileLinkAttrs(toFileUrl(file.path), file.label)}>${file.label}</a></p>`;
    })
    .join("");
}

/* SEARCH — always searches everything, regardless of category/resource state */
searchInput.addEventListener("input", e => {
  const term = e.target.value.toLowerCase().trim();

  if (!term) {
    showCategoryList();
    return;
  }

  const filtered = ARM_DATA.resources.filter(r => {
    const haystack = [r.name, r.keywords, r.services, r.parent]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return haystack.includes(term);
  });

  resourceListPane.classList.remove("category-mode");
  listBackBar.classList.add("visible");
  allResourcesRow.hidden = true;
  listBackLabel.textContent = `Search results for "${e.target.value.trim()}"`;
  renderResources(filtered);
});

/* AUTO COLLAPSE KEYBOARD ON SCROLL
   passive:true lets Safari scroll without waiting to see if this handler
   calls preventDefault() - a genuine smoothness win. Only blur when the
   input actually has focus, rather than firing on every scroll tick. */
resourceItems.addEventListener("scroll", () => {
  if (document.activeElement === searchInput) {
    searchInput.blur();
  }
}, { passive: true });

/* SCREENING TOOLS MODAL */
const toolsModal = document.getElementById("toolsModal");
const toolsTableBody = document.getElementById("toolsTableBody");
const closeToolsModal = document.getElementById("closeToolsModal");

toolsBtn.addEventListener("click", () => {
  renderScreeningTools();
  toolsModal.classList.add("open");
});

closeToolsModal.addEventListener("click", () => {
  toolsModal.classList.remove("open");
});

function renderScreeningTools() {
  toolsTableBody.innerHTML = "";

  ARM_DATA.screening_tools.forEach(tool => {
    const row = document.createElement("tr");

    const toolLink = (tool.files && tool.files.length)
      ? tool.files
          .map(f => `<a ${fileLinkAttrs(toFileUrl(f.path), f.label)}>${f.label}</a>`)
          .join(", ")
      : tool.tool;

    row.innerHTML = `
      <td>${tool.domain}</td>
      <td>${toolLink}</td>
      <td>${tool.purpose}</td>
    `;

    toolsTableBody.appendChild(row);
  });
}

/* INSURANCE GUIDE BUTTON */
insuranceBtn.addEventListener("click", () => {
  if (!ARM_DATA.insurance_guide_path) {
    alert("The Insurance Guide PDF couldn't be found when the app was last built. Check the build console output and confirm the file is in /Assets.");
    return;
  }
  const url = toFileUrl(ARM_DATA.insurance_guide_path);
  if (IS_IOS_STANDALONE) {
    // window.open() has no "download" equivalent - only an <a> tag does.
    // Build one, click it programmatically, then discard it. Same escape
    // hatch as fileLinkAttrs() above, just triggered from JS instead of
    // rendered into innerHTML.
    const a = document.createElement("a");
    a.href = url;
    a.download = "Insurance Guide.pdf";
    document.body.appendChild(a);
    a.click();
    a.remove();
  } else {
    window.open(url, "_blank");
  }
});

/* PULLED-OUT TOOLS — too heavily used to bury in the resource list */
document.getElementById("waypointBtn").addEventListener("click", () => {
  window.open("https://gis.hennepin.us/waypoint/", "_blank");
});

document.getElementById("ysnBtn").addEventListener("click", () => {
  window.open("https://ysnmn.org/", "_blank");
});

/* RELEASE OF INFORMATION MODAL */
const roiModal = document.getElementById("roiModal");
const roiTableBody = document.getElementById("roiTableBody");
const closeRoiModal = document.getElementById("closeRoiModal");

roiBtn.addEventListener("click", () => {
  renderRoiContacts();
  roiModal.classList.add("open");
});

closeRoiModal.addEventListener("click", () => {
  roiModal.classList.remove("open");
});

function renderRoiContacts() {
  roiTableBody.innerHTML = "";

  (ARM_DATA.release_of_information || []).forEach(org => {
    const row = document.createElement("tr");

    const addressLine = org.address ? `<div class="roi-sub">${formatAddress(org.address)}</div>` : "";

    const orgCell = [org.organization, addressLine]
      .filter(Boolean)
      .join("");

    const phoneCell = [
      org.phone ? formatPhone(org.phone) : "",
      org.altPhone ? `<div class="roi-sub">Alt: ${formatPhone(org.altPhone)}</div>` : ""
    ].filter(Boolean).join("");

    const faxCell = [
      org.fax ? formatPhone(org.fax) : "",
      org.altFax ? `<div class="roi-sub">Alt: ${formatPhone(org.altFax)}</div>` : ""
    ].filter(Boolean).join("");

    const emailCell = org.email ? `<a href="mailto:${org.email}">${org.email}</a>` : "";
    const formsCell = (org.files && org.files.length)
      ? org.files.map(f => `<div class="roi-sub"><a ${fileLinkAttrs(toFileUrl(f.path), f.label)}>${f.label}</a></div>`).join("")
      : "";

    row.innerHTML = `
      <td>${orgCell}${org.notes ? `<div class="roi-sub">${org.notes}</div>` : ""}</td>
      <td>${phoneCell}</td>
      <td>${faxCell}</td>
      <td>${emailCell}</td>
      <td>${formsCell}</td>
    `;

    roiTableBody.appendChild(row);
  });
}

/* FAVORITES MODAL */
const favBtn = document.getElementById("favBtn");
const favModal = document.getElementById("favModal");
const favList = document.getElementById("favList");
const favEmpty = document.getElementById("favEmpty");
const closeFavModal = document.getElementById("closeFavModal");

favBtn.addEventListener("click", () => {
  renderFavorites();
  favModal.classList.add("open");
});

closeFavModal.addEventListener("click", () => {
  favModal.classList.remove("open");
});

function renderFavorites() {
  const favNames = getFavorites();
  const favResources = ARM_DATA.resources
    .filter(r => favNames.includes(r.name))
    .sort((a, b) => a.name.localeCompare(b.name));

  favList.innerHTML = "";
  favEmpty.style.display = favResources.length ? "none" : "block";

  favResources.forEach(r => {
    const li = document.createElement("li");
    li.textContent = r.name;
    li.addEventListener("click", () => {
      favModal.classList.remove("open");
      showResourceList(favResources, "Favorites");
      showDetail(r);
    });
    favList.appendChild(li);
  });
}

/* INIT */
showCategoryList();

/* ============================================================
   UPDATE / OFFLINE SYNC
   ------------------------------------------------------------
   The app knows which build it IS from ARM_DATA.meta.buildId
   (stamped by build-data.js). It compares that against the
   published version.json. No localStorage involved on purpose -
   iOS can clear it, and an app that forgets its own version
   would nag to "update" to the build it's already running.

   On file:// (ARML.exe / OneDrive-synced desktop copy) this
   whole section stays out of the way: there's no origin to
   fetch from, and OneDrive sync is already the update
   mechanism there.
   ============================================================ */

const versionTag = document.getElementById("versionTag");
const updateBtn = document.getElementById("updateBtn");
const updateLabel = document.getElementById("updateLabel");

const META = (typeof ARM_DATA !== "undefined" && ARM_DATA.meta) ? ARM_DATA.meta : {};
const INSTALLED_BUILD = META.buildId || null;
const INSTALLED_VERSION = META.version || null;
const IS_FILE_PROTOCOL = location.protocol === "file:";

versionTag.textContent = INSTALLED_VERSION ? `ARML v${INSTALLED_VERSION}` : "ARML";

let updateState = "idle";
let statusTimer = null;

function setUpdateUI(state, info) {
  updateState = state;
  info = info || {};
  clearTimeout(statusTimer);

  updateBtn.classList.remove("available", "busy", "problem");

  switch (state) {
    case "checking":
      updateBtn.hidden = false;
      updateBtn.disabled = true;
      updateBtn.classList.add("busy");
      updateLabel.textContent = "Checking…";
      break;

    case "available":
      updateBtn.hidden = false;
      updateBtn.disabled = false;
      updateBtn.classList.add("available");
      updateLabel.textContent = "Update available";
      break;

    case "downloading": {
      updateBtn.hidden = false;
      updateBtn.disabled = true;
      updateBtn.classList.add("busy");
      const { done, total } = info;
      updateLabel.textContent = total
        ? `Downloading ${done} of ${total}…`
        : "Preparing…";
      break;
    }

    case "current":
      updateBtn.hidden = false;
      updateBtn.disabled = true;
      updateLabel.textContent = "Up to date";
      statusTimer = setTimeout(() => setUpdateUI("idle"), 3000);
      break;

    case "offline":
      updateBtn.hidden = false;
      updateBtn.disabled = true;
      updateBtn.classList.add("problem");
      updateLabel.textContent = "Offline";
      statusTimer = setTimeout(() => setUpdateUI("idle"), 4000);
      break;

    case "problem":
      updateBtn.hidden = false;
      updateBtn.disabled = false;
      updateBtn.classList.add("problem");
      updateLabel.textContent = info.short || "Update failed — retry";
      if (info.detail) updateBtn.title = info.detail;
      break;

    case "idle":
    default:
      updateBtn.hidden = true;
      updateBtn.disabled = false;
      updateLabel.textContent = "Update";
      updateBtn.removeAttribute("title");
      break;
  }
}

async function checkForUpdate(manual) {
  if (IS_FILE_PROTOCOL) return;
  if (updateState === "downloading") return;
  // A background check must not silently wipe a problem the user hasn't
  // acted on yet - otherwise a partial download reports itself for two
  // seconds and then quietly disappears. Manual checks may override it.
  if (updateState === "problem" && !manual) return;

  if (manual) setUpdateUI("checking");

  try {
    // Cache-busting query on top of no-store: some proxies ignore the header.
    const res = await fetch(`version.json?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`version.json returned ${res.status}`);
    const remote = await res.json();

    if (!INSTALLED_BUILD) {
      // Running a data.js built before build IDs existed. Offer the update -
      // taking it is how the app gets a build ID in the first place.
      setUpdateUI("available");
      return;
    }

    if (remote.buildId && remote.buildId !== INSTALLED_BUILD) {
      setUpdateUI("available");
    } else {
      setUpdateUI(manual ? "current" : "idle");
    }
  } catch (err) {
    setUpdateUI(manual ? "offline" : "idle");
  }
}

// After a new service worker installs it calls skipWaiting(), so it activates
// and claims this page. Waiting for that before precaching means the files
// land in the NEW shell cache rather than the one about to be discarded.
function waitForNewController(reg) {
  return new Promise(resolve => {
    if (!reg.installing && !reg.waiting) return resolve();

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      navigator.serviceWorker.removeEventListener("controllerchange", finish);
      resolve();
    };

    navigator.serviceWorker.addEventListener("controllerchange", finish);
    // Don't hang forever if the swap never fires - precaching against the
    // current worker is still better than a button that does nothing.
    setTimeout(finish, 15000);
  });
}

async function runUpdate() {
  if (IS_FILE_PROTOCOL) return;

  setUpdateUI("downloading", { done: 0, total: 0 });

  if (!("serviceWorker" in navigator) || !navigator.serviceWorker.controller) {
    // No service worker (first load, or unsupported). A plain reload still
    // picks up the new files - it just won't precache PDFs for offline.
    location.reload();
    return;
  }

  try {
    const reg = await navigator.serviceWorker.ready;
    await reg.update();
    await waitForNewController(reg);

    const target = navigator.serviceWorker.controller;
    if (!target) {
      location.reload();
      return;
    }
    target.postMessage({ type: "PRECACHE_ALL" });
  } catch (err) {
    setUpdateUI("problem", {
      short: "Update failed — retry",
      detail: String(err && err.message ? err.message : err)
    });
  }
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", event => {
    const msg = event.data || {};

    if (msg.type === "PRECACHE_PROGRESS") {
      setUpdateUI("downloading", { done: msg.done, total: msg.total });
      return;
    }

    if (msg.type === "PRECACHE_DONE") {
      // Reload so the page picks up the freshly cached shell and data.
      // Any files that failed are reported after the reload rather than
      // being swallowed - a partial download shouldn't look like success.
      try {
        if (msg.failed && msg.failed.length) {
          sessionStorage.setItem("armlPartialUpdate", String(msg.failed.length));
        }
      } catch (e) { /* sessionStorage unavailable - not worth failing over */ }
      location.reload();
      return;
    }

    if (msg.type === "PRECACHE_ERROR") {
      setUpdateUI("problem", { short: "Update failed — retry", detail: msg.message });
    }
  });
}

updateBtn.addEventListener("click", () => {
  if (updateState === "available" || updateState === "problem") runUpdate();
});

versionTag.addEventListener("click", () => checkForUpdate(true));

/* Report a partial download from the previous session, once. */
(function reportPartialUpdate() {
  try {
    const n = sessionStorage.getItem("armlPartialUpdate");
    if (n) {
      sessionStorage.removeItem("armlPartialUpdate");
      setUpdateUI("problem", {
        short: `${n} file${n === "1" ? "" : "s"} didn't download`,
        detail: "Tap to retry. The app still works; some PDFs may be unavailable offline."
      });
    }
  } catch (e) { /* no sessionStorage - nothing to report */ }
})();

if (!IS_FILE_PROTOCOL) {
  // Quiet background check shortly after launch, and again whenever the app
  // is brought back to the foreground (e.g. carried into Wi-Fi range).
  setTimeout(() => checkForUpdate(false), 2500);

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && updateState !== "downloading") checkForUpdate(false);
  });

  window.addEventListener("online", () => checkForUpdate(false));
}
