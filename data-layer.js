/* ============================================================
   data-layer.js
   ------------------------------------------------------------
   One codebase, two ways of running:
     - LOCAL:   start-ARML-editor.bat launches server.js (Express).
                DataLayer just wraps the same fetch("/resources") etc.
                calls form.js always used, unchanged in behavior.
     - BROWSER: hosted as a static site on GitHub Pages, no server.
                DataLayer routes the same calls through
                github-backend.js instead, which talks to the GitHub
                API directly.

   form.js only ever calls DataLayer.xxx() - it doesn't know or care
   which mode it's in. Detection happens once, at load, by trying to
   reach the local server; if that fails (because there IS no server,
   as on GitHub Pages), it falls back to GitHub mode automatically.
   ============================================================ */

const DataLayer = (() => {
  let mode = null; // "local" | "browser", set by detectMode()

  async function detectMode() {
    if (mode) return mode;
    try {
      const res = await fetch("/publish-status", { cache: "no-store" });
      mode = res.ok ? "local" : "browser";
    } catch {
      mode = "browser";
    }
    return mode;
  }

  /* ---------- ENVIRONMENT DETECTION ----------
     TWO SEPARATE QUESTIONS, deliberately not merged:

       detectMode()   "Is there a local server behind this page?"
                      -> local | browser. Decides which BACKEND runs,
                         and therefore whether a token is needed at all
                         (local mode's token lives in config.json,
                         server-side, and is never prompted for here).

       getContext()   "How is this page being displayed?"
                      -> local | browser | pwa. Cosmetic/informational
                         only - which label to show the user.

     Merging these is a real bug, not a style choice: the service worker
     registers in BOTH modes, so the local Editor can be installed as a
     PWA too. In that case display is "pwa" but the backend is still
     "local", and anything keyed on display would wrongly announce that
     the user will be prompted for a token they'll never be asked for. */
  async function getContext() {
    const backendMode = await detectMode();
    if (backendMode === "local") return "local";
    const standalone =
      (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) ||
      window.navigator.standalone === true;
    return standalone ? "pwa" : "browser";
  }

  const CONTEXT_LABELS = { local: "local", browser: "browser", pwa: "PWA" };
  const local = {
    async getResources() {
      const res = await fetch("/resources");
      return res.json();
    },
    async getResourceNames() {
      const res = await fetch("/resource-names");
      return res.json();
    },
    async addResource(formData) {
      const res = await fetch("/add", { method: "POST", body: formData });
      const out = await res.json();
      return { ok: res.ok, ...out };
    },
    async updateResource(formData) {
      const res = await fetch("/update", { method: "POST", body: formData });
      const out = await res.json();
      return { ok: res.ok, ...out };
    },
    async deleteResource(name, confirmName) {
      const res = await fetch("/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, confirmName })
      });
      const out = await res.json();
      return { ok: res.ok, ...out };
    },
    async getPublishStatus() {
      const res = await fetch("/publish-status");
      return res.json();
    },
    async republish() {
      const res = await fetch("/publish", { method: "POST" });
      const out = await res.json();
      return { ok: res.ok, ...out };
    },
    async exportBundle() {
      const res = await fetch("/export-bundle", { method: "POST" });
      const out = await res.json();
      return { ok: res.ok, ...out };
    },
    /* Local mode can't ask GitHub directly the way browser mode does -
       the token lives in config.json on the server side and never
       reaches this page. server.js already reports what it knows via
       /publish-status, so that's reused rather than inventing a second
       endpoint. Less precise than the browser check (it confirms config
       is present, not that GitHub accepted it), and the wording below
       says so rather than implying a stronger guarantee. */
    async checkConnection() {
      try {
        const res = await fetch("/publish-status", { cache: "no-store" });
        if (!res.ok) return { state: "error", message: "Local server isn't responding. Is start-ARML-editor.bat still running?" };
        const s = await res.json();
        if (!s.enabled) return { state: "warn", message: "GitHub publishing is off in config.json — saves stay local only." };
        if (!s.configured) return { state: "error", message: "config.json is missing owner/repo/token — publishing will be skipped." };
        return { state: "ok", message: `Configured to publish to ${s.owner}/${s.repo} (${s.branch}).` };
      } catch {
        return { state: "error", message: "Local server isn't responding. Is start-ARML-editor.bat still running?" };
      }
    }
  };

  /* ---------- BROWSER MODE - delegates to github-backend.js ---------- */
  const browser = {
    async getResources() { return window.ARMLGitHubBackend.getResources(); },
    async getResourceNames() { return window.ARMLGitHubBackend.getResourceNames(); },
    async addResource(formData) { return window.ARMLGitHubBackend.addResource(formData); },
    async updateResource(formData) { return window.ARMLGitHubBackend.updateResource(formData); },
    async deleteResource(name, confirmName) { return window.ARMLGitHubBackend.deleteResource(name, confirmName); },
    async getPublishStatus() { return window.ARMLGitHubBackend.getPublishStatus(); },
    // Republish / export-bundle have no browser equivalent - the workbook
    // commit IS the publish action in this mode, and zip export needs a
    // real filesystem. Callers check for these being undefined-safe no-ops.
    async republish() {
      return { ok: false, error: "Retry isn't needed in the browser version - each save already commits straight to GitHub. If a save failed, just save again." };
    },
    async exportBundle() {
      return { ok: false, error: "Bundle export isn't available in the browser version. Download the ARML repo as a zip from GitHub instead (Code -> Download ZIP)." };
    },
    async checkConnection() { return window.ARMLGitHubBackend.checkConnection(); }
  };

  async function backend() {
    return (await detectMode()) === "local" ? local : browser;
  }

  return {
    getResources: async (...a) => (await backend()).getResources(...a),
    getResourceNames: async (...a) => (await backend()).getResourceNames(...a),
    addResource: async (...a) => (await backend()).addResource(...a),
    updateResource: async (...a) => (await backend()).updateResource(...a),
    deleteResource: async (...a) => (await backend()).deleteResource(...a),
    getPublishStatus: async (...a) => (await backend()).getPublishStatus(...a),
    republish: async (...a) => (await backend()).republish(...a),
    exportBundle: async (...a) => (await backend()).exportBundle(...a),
    checkConnection: async (...a) => (await backend()).checkConnection(...a),
    detectMode,
    getContext,
    contextLabel: async () => CONTEXT_LABELS[await getContext()]
  };
})();

window.DataLayer = DataLayer;

/* No separate password gate. In browser mode, every read and write in
   github-backend.js already requires a valid GitHub token before it does
   anything - nothing loads, nothing saves, without one. The token IS the
   access control; a second password on top of it would just be gating
   the same door twice for no added protection. */
