/* ============================================================
   ARML Editor — Service Worker

   DELIBERATELY DIFFERENT FROM THE MAIN ARML APP'S SERVICE WORKER.
   ARML (the medic-facing library) is cache-first: a medic in a
   basement with no signal needs the cached copy to win. The Editor
   is the opposite situation - it's an admin tool, used at a desk,
   and serving a stale copy of the editing code is strictly worse
   than a slightly slower load. So this is NETWORK-FIRST for
   everything it caches: always try the live file, fall back to
   cache only when the network genuinely isn't there.

   That choice also sidesteps the failure mode where a code fix is
   published but devices keep running the old cached copy because
   nothing told them to look again.

   WHAT IS NEVER CACHED (and why):
     api.github.com      Every read and write must hit the real API.
                         A cached workbook or a cached commit
                         response would mean editing stale data or
                         silently "succeeding" while offline.
     Local server routes In local mode (start-ARML-editor.bat ->
                         server.js), /resources, /add, /update,
                         /delete, /publish etc. are live Express
                         endpoints. Caching them would break the
                         local Editor entirely.
     Non-GET requests    POST/PUT are actions, not documents.
   ============================================================ */

const CACHE_VERSION = 'arml-editor-v1.2.0';

/* The shell: everything needed to load the Editor UI itself. The
   vendored xlsx build is included on purpose - it used to load from
   cdnjs, which is both an offline hole and a plausible thing for a
   city IT network to block outright. */
const SHELL_FILES = [
  './',
  'index.html',
  'styles.css',
  'form.js',
  'data-layer.js',
  'github-backend.js',
  'manifest.json',
  'vendor/xlsx.full.min.js',
  'slp-patch.png',
  'editor-icon-192.png',
  'editor-icon-512.png'
];

/* Local-mode Express routes - must always go straight to the server.
   Matched by pathname so they're skipped in local mode; on GitHub
   Pages these paths simply don't exist, so the check costs nothing. */
const LOCAL_API_PATHS = [
  '/resources',
  '/resource-names',
  '/add',
  '/update',
  '/delete',
  '/publish',
  '/publish-status',
  '/export-bundle'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      // Individually, not addAll: addAll rejects the whole install if a
      // SINGLE file 404s, which would leave the Editor with no service
      // worker at all over one stray filename.
      .then(cache => Promise.allSettled(SHELL_FILES.map(f => cache.add(f))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k.startsWith('arml-editor-') && k !== CACHE_VERSION)
            .map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Cross-origin (api.github.com above all) - never touch it.
  if (url.origin !== self.location.origin) return;

  // Local Express endpoints - never touch them either.
  if (LOCAL_API_PATHS.some(p => url.pathname.endsWith(p))) return;

  // Network-first, cache as fallback. See header comment for why this
  // is inverted relative to the main ARML app.
  event.respondWith(
    fetch(req)
      .then(res => {
        if (res && res.ok) {
          const clone = res.clone();
          caches.open(CACHE_VERSION).then(c => c.put(req, clone));
        }
        return res;
      })
      .catch(() =>
        caches.match(req).then(hit => {
          if (hit) return hit;
          if (req.mode === 'navigate') return caches.match('index.html');
          return Promise.reject(new Error('offline and not cached'));
        })
      )
  );
});
