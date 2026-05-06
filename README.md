# Shift Planner (static SPA + Supabase backend)

A browser-only shift scheduling tool with **two pages**:

| Page | Who | What |
|---|---|---|
| **`register.html`** | Each team member | Pick your name, fill in your shifts, hit Save |
| **`index.html`**    | Admin (you)      | Full Register / Demand / Final Plan / People controls. PIN-protected. |

Both pages are 100% static (no backend code). They share data via a free
**Supabase** project, so what one user saves appears live on everyone
else's screen within ~1 second (Postgres realtime via WebSocket).

---

## How data is shared between users

**The short version:** every browser saves to the same Supabase table.
Person A clicks Save on `register.html` → row goes to Supabase →
Supabase pushes the change to your admin browser → your Register tab
updates instantly.

```
   ┌─────────────────────┐                              ┌─────────────────────┐
   │ Person A (laptop)   │                              │ Admin (your laptop) │
   │ register.html       │                              │ index.html          │
   └─────────┬───────────┘                              └─────────┬───────────┘
             │  POST row                                          ▲
             ▼                                                    │ realtime push
   ┌────────────────────────────  Supabase  ────────────────────────────────┐
   │  table: shift_planner                                                  │
   │  k = "people"                  v = [["ID","Name"], ["P1","Nguyen A"]…] │
   │  k = "config"                  v = {month:8, year:2026, frozen:false}  │
   │  k = "period:2026-08:register" v = [["Name","8/1",…], ["P1","C6",…]…]  │
   │  k = "period:2026-08:demand"   v = [...]                               │
   │  …                                                                     │
   └────────────────────────────────────────────────────────────────────────┘
```

`localStorage` is still used as an offline cache so the page survives a
brief network blip and loads fast on revisit. The cloud is the source of
truth — when both pages boot, they pull from Supabase and overwrite the
local cache.

---

## One-time setup (10 minutes)

### 1. Create the Supabase project

1. Go to <https://supabase.com> and sign up (free, GitHub login works).
2. **New project** → choose any name and a strong DB password (Supabase
   will keep it for you, you don't need to remember it).
3. Wait ~1 minute for provisioning.

### 2. Create the table + policies

In the Supabase dashboard → **SQL Editor** → **New query** → paste **all
of this** and click **Run**:

```sql
-- One key/value table for the entire app state
create table if not exists shift_planner (
  k          text primary key,
  v          jsonb,
  updated_at timestamptz default now()
);

-- Allow the anonymous role (the one your static page uses) to read & write.
-- This is fine because the admin PIN gate keeps random visitors out of
-- index.html, and the only "writes" the register page can do are limited
-- to a row in the register table.
alter table shift_planner enable row level security;

drop policy if exists "anon read"   on shift_planner;
drop policy if exists "anon insert" on shift_planner;
drop policy if exists "anon update" on shift_planner;
drop policy if exists "anon delete" on shift_planner;

create policy "anon read"   on shift_planner for select using (true);
create policy "anon insert" on shift_planner for insert with check (true);
create policy "anon update" on shift_planner for update using (true) with check (true);
create policy "anon delete" on shift_planner for delete using (true);

-- Push changes over websocket so other browsers see updates instantly
alter publication supabase_realtime add table shift_planner;
```

### 3. Get your project URL + anon key

In Supabase → **Project Settings** → **API**:

- Copy **Project URL** → e.g. `https://xxxxx.supabase.co`
- Copy **anon public** key → starts with `eyJhbGciOi...`

### 4. Paste them into `js/config.js`

Open `js/config.js` and fill in the two strings:

```js
window.APP_CONFIG = {
  SUPABASE_URL:      "https://xxxxx.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOi.....",
  TABLE_NAME:        "shift_planner",
  POLL_INTERVAL_MS:  15000,
};
```

### 5. Deploy

Commit + push to GitHub → enable Pages (**Settings → Pages → Deploy from
branch → main → / (root)**) → wait ~1 minute. Done.

Your URLs will be:

- Admin:    `https://<user>.github.io/<repo>/index.html`
- Register: `https://<user>.github.io/<repo>/register.html`

Share the **Register** URL with the team. Keep the **Admin** URL + PIN
to yourself.

### 6. First-time admin PIN

Open `index.html` for the first time after pasting your Supabase keys.
You'll be prompted to **set the admin PIN**. Pick anything 4+
characters. The PIN is hashed (SHA-256) and stored in the cloud — every
admin browser will then prompt for the same PIN.

To change the PIN later: open the Supabase dashboard → **Table Editor**
→ `shift_planner` → delete the row where `k = 'admin_pin_hash'`. Next
admin to open `index.html` will be asked to set a new one.

---

## Folder structure

```
.
├── index.html              ← admin page (PIN-protected)
├── register.html           ← end-user page (open access)
├── css/
│   └── style.css
├── js/
│   ├── config.js           ← Supabase URL + anon key (edit me!)
│   ├── csv.js              ← CSV parser/serializer
│   ├── cloud.js            ← Supabase wrapper (SDK loaded from CDN)
│   ├── storage.js          ← localStorage cache + cloud sync
│   ├── scheduler.js        ← scheduling algorithm
│   ├── exporter.js         ← Excel + JSON download
│   ├── app.js              ← admin-page UI controller
│   └── register-app.js     ← register-page UI controller
├── data/
│   └── seed.js             ← (optional) one-time data snapshot
├── .nojekyll               ← tells GitHub Pages NOT to run Jekyll
├── .gitignore
└── README.md
```

External CDN libraries used at runtime:

- `@supabase/supabase-js` v2 — for cloud sync + realtime
- `xlsx-js-style` — for the styled Excel export

Everything else is hand-written vanilla JS. No build step.

---

## Features

### Admin page (`index.html`)

- **PIN-gated** — first load asks you to set a PIN, future loads check it
- **Live cloud sync** — green "live" badge in the header; turns yellow
  while writes are in flight and red on errors
- 4 tabs: Register / Demand / Final Plan / People
- Per-month storage (switch between months, the dropdown shows which are
  saved)
- **Freeze plan** → read-only mode for everyone (admin + users)
- **Generate Plan**: smart incremental rebuild OR full regenerate, with
  a verification report that includes a shift-distribution matrix
- Conflict detection: unknown shift codes, Sunday registrations,
  over-registered shifts, capacity-vs-demand fatals
- **Export Excel** (styled .xlsx) and **Backup JSON** / **Restore JSON**

### Register page (`register.html`)

- Just one card: pick your name, edit your row, Save
- Sundays auto-set to N and locked
- Shows your assigned shifts after the admin generates the Final Plan
- Browser remembers your name so you don't have to pick it again
- Updates live if the admin changes the active month or freezes the plan

---

## How the data is laid out in Supabase

One table, key-value style:

| `k` | `v` (jsonb) |
|---|---|
| `config` | `{"month":8,"year":2026,"frozen":false}` |
| `admin_pin_hash` | `"<sha256 hex of your PIN>"` |
| `people` | `[["ID","Name"], ["P1","Nguyen A"], ...]` (CSV rows as JSON) |
| `period:2026-08:demand`             | CSV rows as JSON |
| `period:2026-08:register`           | CSV rows as JSON |
| `period:2026-08:final`              | CSV rows as JSON |
| `period:2026-08:demand_snapshot`    | CSV rows as JSON |
| `period:2026-08:register_snapshot`  | CSV rows as JSON |

You can browse / edit any of this directly in the Supabase **Table
Editor** — useful for emergencies or backups.

---

## Local-only mode (no Supabase)

If you leave `SUPABASE_URL` and `SUPABASE_ANON_KEY` empty in
`js/config.js`, the app falls back to localStorage-only mode (the
original behaviour). The PIN gate is skipped because there's no
multi-user concern.

Useful for testing, offline use, or a single-user setup where you don't
want to depend on Supabase.

---

## Troubleshooting

| Problem | Fix |
| --- | --- |
| "local only" badge appears, no live sync | `js/config.js` is empty or has the wrong URL/key. Open DevTools console for the exact error. |
| "sync error" badge | A cloud write failed. Check console — usually it's an RLS policy missing (re-run the SQL block). |
| Register page can't see the People list | Admin hasn't created any people yet, or RLS `select` policy is missing. |
| Forgot the admin PIN | Supabase dashboard → Table Editor → `shift_planner` → delete row where `k='admin_pin_hash'`. |
| Two users editing the same person's row | Last save wins (~few seconds apart is safe). For totally simultaneous edits, the second save overwrites the first. |
| Excel export is broken | `xlsx-js-style` CDN is blocked by your network. Download `xlsx.bundle.js` from jsDelivr and host it locally; update the `<script src=…>` in `index.html`. |

---

## Privacy notes

- The Supabase **anon key** is safe to commit publicly — it only grants
  access defined by your Row-Level-Security policies.
- The PIN hash is stored in the cloud (SHA-256), not the PIN itself.
- The PIN gate is a *light* protection: anyone who really wants to read
  your `shift_planner` table can do so via the anon key. For real
  security, replace the open RLS policies above with **Supabase Auth**
  (sign-in required) and lock writes to authenticated users only —
  ask if you want me to add this.
- `data/seed.js` may contain personal names from your existing data. If
  you push to a **public** repo and don't want that exposed, delete
  `data/seed.js` before pushing.

---

## What's where, in one sentence

- **Algorithm** lives in `js/scheduler.js` (a faithful port of the old
  Python `build_schedule.py`).
- **Cloud sync** lives in `js/cloud.js` (a thin wrapper over Supabase).
- **Storage abstraction** lives in `js/storage.js` (localStorage cache +
  cloud writes).
- **Admin UI** lives in `js/app.js`.
- **End-user UI** lives in `js/register-app.js`.
- **Configuration** is one file: `js/config.js`.
