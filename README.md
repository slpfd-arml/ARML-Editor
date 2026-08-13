# ARML Editor

The admin tool for adding, editing, and deleting resources in **ARML**
(Alternative Response Medic Library). It is the normal, intended way to
maintain ARML's content — no coding, no spreadsheet wrangling, no build
commands.

**Live URL:** https://slpfd-arml.github.io/ARML-Editor/

This tool edits the ARML app, which lives in a **separate repo**:
- ARML (the medic-facing app): https://github.com/slpfd-arml/ARML
- ARML Editor (this tool): https://github.com/slpfd-arml/ARML-Editor

If you're an AI reading this to help someone maintain the tool: read this
whole file first. The two run modes below behave differently in ways that
matter, and the most common support question ("my change didn't show up")
almost always traces back to that distinction.

---

## Contact

Built by Kyle Jacket during an internship with the ARM program, August 2026.

Phone: (763) 607-7504
Email: kjacket0@gmail.com

---

## 1. The one-sentence architecture

**ARML Editor edits a spreadsheet. It never edits the app directly.**

```
ARML Editor  →  New_ARM_Library.xlsx  →  build-data.js  →  data.js  →  the ARML app
  (this tool)      (the data)            (the compiler)   (the output)
```

Everything the tool does — add, edit, delete, attach a PDF — ends as a
change to that one workbook, committed to the ARML repo. A build step then
turns the workbook into the app's data. **Where that build runs is the only
real difference between local mode and the two web modes below.**

---

## 2. Three ways to run it

All three edit the same workbook in the same repo and produce identical
results on medics' devices. Pick based on what the machine and network
allow, not on preference.

| | **Installed app (PWA)** (recommended) | **Browser tab** | **Local mode** |
|---|---|---|---|
| How you open it | Desktop / taskbar icon | The live URL, in Chrome or Edge | Double-click `start-ARML-editor.bat` |
| Needs Node.js installed? | **No** | **No** | Yes (or the portable copy) |
| Where the GitHub token lives | Browser storage (`localStorage`) | Browser storage (`localStorage`) | `config.json` on that machine |
| Who runs `build-data.js` | GitHub, automatically | GitHub, automatically | Your own machine, on every save |
| Attach PDFs | Yes | Yes | Yes |
| "Export update bundle" | No | No | Yes |
| Version tag reads | `(PWA)` | `(browser)` | `(local)` |

The tool detects which one it's in automatically at load, and the version
line in the header tells you which.

### Installed app (PWA) — recommended

Open the live URL in Chrome or Edge and click the install icon in the
address bar (or `⋮` → "Install ARML Editor"). You get a normal desktop and
taskbar icon that opens the tool in its own window with no address bar,
tabs, or back button — the same result the old `.bat` shortcut gave, with
nothing installed and no admin rights.

**Under the hood it is the same web app as a browser tab**, same origin and
same code. The differences are practical rather than architectural:

- **Launching** — an icon instead of a bookmark or typed URL.
- **No browser chrome** — which also means no reload button. If you ever
  need to force a refresh, use `Ctrl`+`R` (or `Ctrl`+`Shift`+`R` to bypass
  cache). Worth knowing before you need it, since the usual button isn't
  there.
- **Same browser profile** — an installed PWA runs inside the browser it
  was installed from, so it normally shares that browser's storage for the
  same site. In practice a token entered in one is usually already there in
  the other. Don't rely on that: if it prompts, just paste the token again.
  It's stored per browser profile either way, so a different browser, a
  different Windows user, or a different machine always needs its own.

### Browser tab

Identical in every functional respect — same features, same token, same
save path. Use it if you'd rather not install anything, or on a machine you
only touch occasionally.

Both of the above are the reason this tool was rebuilt: they remove every
dependency a City IT environment is likely to block — no `.exe`, no Node.js
install, no local server, no admin rights. It's a webpage.

### Local mode

Kept on purpose as a fallback. If GitHub's API is ever blocked at the
firewall while ordinary web browsing still works, local mode plus the
"Export update bundle" button is what keeps the tool usable. It's also the
only mode that can export a bundle at all. **Not deprecated.**

Its practical differences run deeper than PWA-vs-tab: the token lives in a
file rather than the browser, and the build runs on your own machine at
save time rather than on GitHub afterward.

---

## 3. First-time setup: the GitHub token

**Applies to the installed app and the browser tab alike** — they share the
same token store. (Local mode uses `config.json` instead; see section 7.)

The first time you open it, it asks for a GitHub Personal Access Token.
Without one it can read nothing and save nothing.

1. On GitHub: **Settings → Developer settings → Personal access tokens →
   Fine-grained tokens**
2. Generate one scoped to **just the ARML repo** with **Contents: Read and
   write** — nothing broader
3. Paste it into the prompt

**Where it's stored:** in that browser's `localStorage`, on that machine
only. It is never committed, never written to a file in either repo, and
never sent anywhere except `api.github.com`.

**This is a real credential — treat it like a password.** If it's ever
exposed, revoke it on GitHub immediately and generate a new one. Clicking
the connection light (below) lets you paste in the replacement.

**Each browser profile needs its own token.** The installed app and a
browser tab on the same machine normally share one, since they're the same
profile — but a different browser, a different Windows user, or a different
machine each needs its own. That's a consequence of storing it browser-side
rather than in a shared file, and it's the safer arrangement: revoking one
person's access doesn't disturb anyone else's.

---

## 4. The connection light

Next to the version number in the header is a colored dot that answers one
question: **will Save actually work right now?** Click it any time to
re-check; click it when there's no valid token and it re-prompts.

| Light | Meaning |
|---|---|
| 🟢 Green | Connected to ARML, token has write access — ready to save |
| 🟡 Amber | No token entered yet — click to enter one |
| 🔴 Red | Something will block saving; the text says which |

The red states are worth naming because they point at different fixes:

- **"Token rejected"** — revoked, expired, or mistyped. Click to re-enter.
- **"Token is read-only"** — the token works but lacks **Contents: Read and
  write**. Generate a new one with the right permission.
- **"Can't see slpfd-arml/ARML"** — wrong repo, or the token isn't scoped
  to it.
- **"Can't reach api.github.com"** — offline, or the network is blocking
  GitHub's API. This is the case local mode exists for.

**Why it checks GitHub and not the ARML website:** pinging ARML would only
prove a website is up. It would show green with no token, a revoked token,
a read-only token, or a firewalled API — every situation where saving is
actually broken. Asking GitHub about the repo's permissions is the only
check that answers the real question.

---

## 5. Using it

Two tabs: **Add New** and **Edit or Delete Existing**.

- **Add New** — fill in the form, attach any PDFs, hit Save.
- **Edit or Delete Existing** — search, pick a resource, change what you
  need. Delete requires typing the resource's exact name to confirm.

**Broad Category is the field that matters most.** It's what drives the
app's category browsing. "Organization Type" is free text for reference
only and doesn't affect anything the medics see.

**Search Tags never appear on the resource card.** They exist purely to
make a resource findable — alternate names, common misspellings, services
someone might search for by a different word.

### The guardrails

ARML Editor tries to catch likely mistakes before they become data:

- **Exact duplicate name** — hard block. Edit the existing entry or choose
  a different name.
- **Similar name** — soft warning with three choices: cancel, jump to
  editing the existing one, or confirm this really is separate. It's a
  warning and not a block on purpose: a wrong hard block would stop a
  legitimate addition with no way through except editing the workbook by
  hand, which is exactly what this tool exists to avoid.
- **Delete** — requires typing the exact resource name. There is no
  one-click delete and no undo.

### Attaching PDFs

Attach them in the form; they're committed to `Assets/` in the ARML repo
automatically. Filename collisions are handled by appending `-2`, `-3`, and
so on rather than overwriting an existing file.

Removing a file from a resource in edit mode only **unlinks** it — the PDF
itself stays in `Assets/`, because the same file is often used by more than
one resource.

**Limit: 25 MB per file.** Larger files are rejected before upload with a
message saying so.

---

## 6. What happens after you hit Save

This is the part worth understanding, because it explains the delay.

**Installed app or browser tab (identical paths):**
1. Editor commits the updated workbook to the ARML repo
2. A GitHub Action (`.github/workflows/rebuild-on-workbook-change.yml` in
   the **ARML** repo) notices the workbook changed and runs `build-data.js`
   on GitHub's servers
3. The Action commits the regenerated `data.js`, `version.json`,
   `assets-manifest.json`, and `service-worker.js`
4. GitHub Pages redeploys

**Local mode:** steps 1–3 all happen on your machine at save time, then
push.

**Either way, allow a few minutes.** Save is not instant publication.
Roughly 1–2 minutes for the Action, plus GitHub Pages' CDN cache (about 10
minutes) before every device reliably sees it. A brief window where a
device says "update available," updates, and still reports the old version
is the CDN catching up — it resolves on its own. **Rule of thumb: wait ~10
minutes after saving before updating devices.** Past 15 minutes, something
is actually wrong.

**To check whether the build succeeded:** the ARML repo's **Actions** tab.
A green check means the rebuild ran and committed. A red X means the
workbook change is committed but the app data was never regenerated —
open the failed run to see why.

---

## 7. Local mode setup

Only needed if the web versions are blocked, or you need "Export update
bundle."

`start-ARML-editor.bat` needs Node.js. It checks `node-portable/` first and
falls back to a system-wide install.

**On the portable copy:** `node-portable/node.exe`, if present, is the
official Node.js Windows binary from nodejs.org, code-signed by the OpenJS
Foundation — not a repackaged executable. That said, signing doesn't
guarantee a City IT environment will run it: some organizations block any
`.exe` launched from removable media by Group Policy regardless of
signature, and endpoint tools sometimes flag unfamiliar executables on
first run (Windows SmartScreen's "Windows protected your PC" prompt is a
warning, not a block — "More info → Run anyway" clears it *if* the person
has permission). Worth testing on a representative machine before relying
on it. If it's blocked, nothing is lost: the launcher falls back to a
system-installed Node.js with no code changes.

**Token in local mode** goes in `config.json` (`enabled`, `owner`, `repo`,
`branch`, `token`) — not the browser prompt. `config.json` is listed in
`.gitignore` specifically so a real token can't be committed to the repo it
publishes to. **Do not remove that line.**

---

## 8. What's in this repo

| File / folder | What it is |
|---|---|
| `index.html`, `styles.css` | The tool's interface |
| `form.js` | All form behavior — validation, duplicate detection, modals, connection light |
| `data-layer.js` | Detects browser vs. local mode and routes every call accordingly |
| `github-backend.js` | Web modes (installed app / browser tab): talks to the GitHub API directly |
| `server.js`, `publish.js` | Local mode only: the small Express server and its GitHub push logic |
| `config.json` | Local mode settings. Holds a token when configured — **gitignored, never commit a real one** |
| `service-worker.js` | Offline caching + PWA installability |
| `manifest.json` | PWA metadata (name, icons, colors) |
| `vendor/xlsx.full.min.js` | SheetJS, vendored locally on purpose (see below) |
| `start-ARML-editor.bat` | Local mode launcher |
| `node-portable/` | Optional portable Node.js for local mode |
| `editor-icon-*.png`, `.ico` | App icons |

**Why SheetJS is vendored instead of loaded from a CDN:** a CDN is both an
offline hole and exactly the kind of third-party domain a City IT network
may block outright — which would break the tool with no obvious cause.
Same library, same version, served from this repo.

---

## 9. Making changes to the tool itself

**There is no build step. Edit a file, commit, push — that's the whole
process.** This is deliberately different from ARML, which requires running
`build-data.js` after any change to its shell files. ARML Editor has no
generated files and no content hash to keep in sync.

The service worker is **network-first**, the opposite of ARML's. ARML is
cache-first because a medic in a basement needs the cached copy to win.
The Editor is an admin tool used at a desk, where serving stale editing
code is worse than a slightly slower load. A consequence worth knowing:
**your edits go live on the next load, with no version bump required.**

Two exceptions:

- **Adding a brand-new file** — add it to `SHELL_FILES` in
  `service-worker.js`, or it won't be available offline. That list is not
  auto-generated (unlike ARML's).
- **Changing the displayed version** — three places, all by hand:
  `package.json`, `EDITOR_VERSION` in `github-backend.js`, and
  `CACHE_VERSION` in `service-worker.js`.

---

## 10. Troubleshooting

**"I saved but nothing changed in ARML."**
Check the ARML repo's **Actions** tab. If the latest run is red, the
workbook was committed but never rebuilt. If it's green and it's been under
10 minutes, that's the CDN — wait.

**The connection light is red.**
Read the message; each one points at a different fix (see section 4).

**It asks for a token every time.**
`localStorage` is being cleared — usually private/incognito browsing, or a
browser set to clear site data on exit. Use a normal window.

**"Bundle export isn't available in the browser version."**
Correct — that feature needs a real filesystem. Use local mode, or download
the ARML repo as a zip from GitHub (**Code → Download ZIP**).

**A PDF won't attach.**
Over 25 MB, or the token lacks write access. The error says which.

**The installed app looks stale, or I need to reload it and there's no
reload button.**
`Ctrl`+`R` refreshes; `Ctrl`+`Shift`+`R` bypasses cache. The service worker
is network-first, so a plain reload is normally enough to pick up the
newest version of the tool.

**The installed app won't open / the icon is gone.**
Nothing is lost — the token and all data live in the browser profile, not
the installed shortcut. Open the live URL in Chrome or Edge and re-install
from the address bar. Everything should still be there.

**Nothing loads at all; the resource list is empty.**
Almost always the token. An amber or red light confirms it.

---

## 11. Security notes

**The token is the access control.** There's no separate password on the
site, on purpose: every read and write already requires a valid GitHub
token, so a second gate would be gating the same door twice.

**What the token can do:** read and write the ARML repo, and nothing else,
if scoped as described in section 3. It cannot touch other repos, account
settings, or anything outside that scope.

**What's stored in the browser:** the token, and nothing else. No patient
data, no call data, no PII — none of that exists anywhere in ARML or this
tool.

**If a token is exposed:** revoke it on GitHub immediately (**Settings →
Developer settings → Personal access tokens**), generate a new one, and
paste it in via the connection light. Revoking is instant and doesn't
affect anyone else's token.

**GitHub is making 2FA mandatory as of September 2, 2026 (00:00 UTC).**
Existing tokens keep working — GitHub explicitly exempts them so automation
doesn't break — but browser access to github.com gets restricted until 2FA
is enabled. Whoever holds the `slpfd-arml` account should turn it on rather
than wait for the deadline.

---

## Version

**Last updated:** August 2026
**Version:** ARML Editor v1.2.0
**Hosting:** GitHub Pages
**Status:** Ready for production
