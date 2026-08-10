/* ============================================================
   publish.js
   ------------------------------------------------------------
   Pushes build output straight to GitHub after a successful
   Add-Resource-Tool save, using the plain REST "Contents API"
   (one file = one commit) rather than the lower-level Git Data
   API (one atomic commit for several files).

   That's a deliberate simplicity-over-atomicity trade: nothing
   is racing to view the repo mid-push, and the Contents API is
   far less code to get right and to hand off to a future
   non-expert maintainer. If that trade ever stops being worth
   it, the Git Data API (blobs -> tree -> commit -> ref update)
   is the upgrade path.

   Uses Node's built-in https module - no new npm dependency,
   nothing extra for start-add-resource-tool.bat to install.
   ============================================================ */

const fs = require("fs");
const path = require("path");
const https = require("https");

const CONFIG_PATH = path.join(__dirname, "config.json");

const DEFAULT_CONFIG = {
  github: {
    enabled: false,
    owner: "",
    repo: "",
    branch: "main",
    // "api.github.com" for github.com repos. Overridable for GitHub
    // Enterprise Server, which some City IT departments run on-prem with
    // its own API host.
    apiHost: "api.github.com",
    token: ""
  }
};

// config.json holds a token and MUST NEVER be committed to the very repo
// it publishes to. If this project directory is ALSO a git working copy
// (e.g. you're using `git push` as your deploy method, not just this
// tool), add "Add-Resource-Tool/config.json" to that repo's .gitignore
// before you ever run this - a leaked PAT in public repo history can't be
// un-leaked, only revoked.
function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch (err) {
    throw new Error(`config.json exists but isn't valid JSON: ${err.message}`);
  }
  return { github: { ...DEFAULT_CONFIG.github, ...(parsed.github || {}) } };
}

// Injectable for testing - defaults to the real Node https module.
function makeRequest(transport, apiHost, method, urlPath, token, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = transport.request(
      {
        hostname: apiHost,
        path: urlPath,
        method,
        headers: {
          "User-Agent": "ARML-Add-Resource-Tool",
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          ...(payload
            ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
            : {})
        },
        timeout: 15000
      },
      res => {
        let data = "";
        res.on("data", chunk => (data += chunk));
        res.on("end", () => {
          let parsedBody = null;
          try {
            parsedBody = data ? JSON.parse(data) : null;
          } catch (e) {
            /* Non-JSON response (e.g. an HTML error page from a proxy
               intercepting the request) - leave parsedBody null and let
               the caller fall back to the raw text. */
          }
          resolve({ status: res.statusCode, body: parsedBody, raw: data });
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("GitHub request timed out after 15s")));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// Turns a raw Node network error into something a non-engineer maintainer
// can actually act on. This is the #1 City-IT gotcha from the design doc:
// TLS-inspecting proxies make Node refuse the connection with a cryptic
// certificate error that gives no hint about what's actually wrong.
function describeError(err) {
  const code = err && err.code;
  if (code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" || code === "SELF_SIGNED_CERT_IN_CHAIN") {
    return (
      "Your network is intercepting HTTPS traffic (common on managed/City networks) and Node doesn't trust the " +
      "certificate it's presenting. Ask IT for the network's root certificate (a .crt or .pem file), then set the " +
      "NODE_EXTRA_CA_CERTS environment variable to point at it and restart this tool. Your resource was still " +
      'saved locally either way - use "Export Update Bundle" in the meantime.'
    );
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return (
      "Could not reach GitHub - either this machine is offline, or the network blocks it. Your resource was " +
      'still saved locally and the app was rebuilt; use "Export Update Bundle" to distribute the update another way.'
    );
  }
  if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "ETIMEDOUT") {
    return (
      "The connection to GitHub was refused or timed out - this can happen behind some City firewalls. Your " +
      "resource was still saved locally."
    );
  }
  return err && err.message ? err.message : String(err);
}

async function getFileSha(transport, apiHost, owner, repo, branch, filePath, token) {
  const res = await makeRequest(
    transport,
    apiHost,
    "GET",
    `/repos/${owner}/${repo}/contents/${encodeURIComponent(filePath)}?ref=${encodeURIComponent(branch)}`,
    token
  );
  if (res.status === 200 && res.body && res.body.sha) return res.body.sha;
  if (res.status === 404) return null; // Doesn't exist yet - this is a create, not an update.
  if (res.status === 401) throw new Error("GitHub rejected the token (401) - it may be wrong, expired, or revoked.");
  if (res.status === 403) {
    throw new Error(
      "GitHub returned 403 - the token may lack permission for this repo, or GitHub's rate limit was hit."
    );
  }
  const msg = res.body && res.body.message ? res.body.message : `HTTP ${res.status}`;
  throw new Error(`Could not check existing file "${filePath}": ${msg}`);
}

async function putFile(transport, apiHost, owner, repo, branch, filePath, token, absoluteLocalPath, message) {
  const content = fs.readFileSync(absoluteLocalPath).toString("base64");
  const sha = await getFileSha(transport, apiHost, owner, repo, branch, filePath, token);
  const body = { message, content, branch };
  if (sha) body.sha = sha;

  const res = await makeRequest(
    transport,
    apiHost,
    "PUT",
    `/repos/${owner}/${repo}/contents/${encodeURIComponent(filePath)}`,
    token,
    body
  );
  if (res.status === 200 || res.status === 201) return { path: filePath, ok: true };
  const msg = res.body && res.body.message ? res.body.message : `HTTP ${res.status}`;
  throw new Error(`${filePath}: ${msg}`);
}

/**
 * Publishes a set of files to GitHub, one commit per file.
 * @param {string} rootDir - absolute path files are relative to (project ROOT)
 * @param {string[]} filesRelativeToRoot - e.g. ["data.js", "Assets/foo.pdf"], "/" separators
 * @param {string} commitMessage
 * @param {object} [transport] - injectable for tests; defaults to node:https
 */
async function publish(rootDir, filesRelativeToRoot, commitMessage, transport) {
  transport = transport || https;
  const config = loadConfig().github;

  if (!config.enabled) {
    return { attempted: false, reason: "GitHub publishing is disabled (config.json: github.enabled = false)." };
  }
  if (!config.owner || !config.repo || !config.token) {
    return { attempted: false, reason: "config.json is missing owner, repo, or token - publishing skipped." };
  }

  const pushed = [];
  const failed = [];

  for (const relPath of filesRelativeToRoot) {
    const abs = path.join(rootDir, ...relPath.split("/"));
    if (!fs.existsSync(abs)) {
      failed.push({ path: relPath, error: "File not found on disk - skipped." });
      continue;
    }
    try {
      const result = await putFile(
        transport,
        config.apiHost,
        config.owner,
        config.repo,
        config.branch,
        relPath,
        config.token,
        abs,
        commitMessage
      );
      pushed.push(result);
    } catch (err) {
      failed.push({ path: relPath, error: describeError(err) });
    }
  }

  return { attempted: true, pushed, failed };
}

module.exports = { loadConfig, publish, describeError, DEFAULT_CONFIG, CONFIG_PATH };
