# 🏪 ShopHisaab — Hardware & Paint Shop Manager

Lifetime-FREE app for your shop: **Stock • Sales Billing • Udhaar (Khata) • Payments • Audit Log**
Works on all family/staff phones with LIVE sync. Cost: ₹0/month forever.

**Stack:** GitHub Pages (hosting) + Supabase Free (database/login/sync) + PWABuilder (APK)

---

## 🚀 Setup — only 4 steps (~30 min, one time)

### Step 1 — Create free database (Supabase)
1. Go to https://supabase.com → Sign up → **New project** (no card needed)
2. Name: `shophisaab` • Region: **Mumbai (ap-south-1)** • Set a DB password (save it in your diary)
3. Wait ~2 min → open **SQL Editor** (left menu)
4. Open this repo's `schema.sql` → copy ALL → paste in SQL Editor → **Run** ✅
   (This creates tables + tamper-proof audit triggers + security rules)

### Step 2 — Connect this app to your database
1. In Supabase: **Settings → API** → copy `Project URL` and `anon public` key
2. In THIS GitHub repo: click **`config.js`** → pencil icon ✏️ → paste both values between the quotes
3. Commit changes ✅

### Step 3 — Create the owner login
1. Supabase → **Authentication → Sign In / Providers** → make sure **Email** is ON
2. First person who logs into the app becomes the **owner** automatically
3. To add staff later: Authentication → Users → **Invite user** (email) → they set a password → you activate them:
   SQL Editor: `update profiles set active=true where name='Raju';`

### Step 4 — Make your APK 📱
1. Open your live app URL: `https://hanumantkumar12-coder.github.io/hardware-shop-app/`
2. Go to **https://www.pwabuilder.com** → paste that URL → **Start**
3. Click **Package for stores → Android** → leave defaults (Package ID: `com.shophisaab.app`) → **Generate → Download**
4. Unzip → inside you'll find **`app-release-signed.apk`**
5. Send APK to your phone (WhatsApp/Drive) → tap it → allow **Install unknown apps** → Install 🎉

> Tip: also do Chrome → ⋮ → *Add to Home screen* as an instant alternative while you wait.

---

## 📲 What the app does

| Feature | How |
|---|---|
| 📦 Stock | Add products (cost, sell price, min level). Low stock turns red ⚠ |
| 🧾 Sales billing | Fast billing, stock auto-reduces, cash/UPI/udhaar |
| 📒 Udhaar Khata | Customer balance auto-tracks; receive payments; WhatsApp reminders |
| 🛍 Purchases | Record supplier purchase → stock auto-increases |
| 🕵 Audit log | Owner sees WHO changed WHAT, old→new values. Tamper-proof (server-side triggers) |
| 🔐 Roles | Owner sees costs & audit. Staff cannot see cost price or delete records |
| 💾 Backup | More → Export CSV (products/customers/sales/payments) |
| 🌐 Hindi/English | One-tap toggle |

## 🔒 Safety nets (do once)
- **Weekly backup:** Supabase SQL Editor → run a dump or export CSVs monthly to Google Drive.
- **Never paused:** use daily; if closed for holidays >7 days, Supabase Dashboard → Restore (1 click, no data loss).
- The anon key in config.js is SAFE by design — protection comes from Row Level Security already enabled by schema.sql.

---
Made with ❤️ — lifetime-free stack. No monthly bills, ever.
