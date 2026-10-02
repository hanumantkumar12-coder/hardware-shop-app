# 🏪 ShopHisaab — Hardware & Paint Shop Manager

Lifetime-FREE app for your shop: **Stock • Sales Billing • Udhaar (Khata) • Payments • Audit Log**
Works on all family/staff phones with LIVE sync. Cost: ₹0/month forever.

**Stack:** GitHub Pages (hosting) + Firebase Free (database + login) + PWABuilder (APK)

---

## 🚀 Setup — only 3 steps (~20 min, one time)

### Step 1 — Create the Firebase project (database + login)
1. Go to https://console.firebase.google.com → **Add project** → name: `hkshophisaab` (Analytics OFF is fine)
2. In the project: **Build → Firestore Database → Create database** → start in **production mode** → region **asia-south1 (Mumbai)**
3. **Build → Authentication → Get started → Sign-in method** → enable **Email/Password** (and **Google** if you want the Google button)
4. **Authentication → Settings → Authorized domains** → `hanumantkumar12-coder.github.io` is **already added** (done via the admin config API; re-add here only if it ever disappears). Needed for the Google button; password login works without it

### Step 2 — Deploy the security rules (only owners can read/write)
1. In this repo open `firestore.rules` and copy its content
2. Firebase Console → **Firestore → Rules** → paste → **Publish**
   (It allows read/write ONLY for the owner email addresses — keep that list updated when you add staff.)

### Step 3 — Connect this app + make the APK 📱
1. `config.js` in this repo already contains the Firebase config — no edit needed if this is your project
2. Open the live app URL: `https://hanumantkumar12-coder.github.io/hardware-shop-app/`
3. **Forgot Password?** → enter your email → set your first password → login
4. APK: go to **https://www.pwabuilder.com** → paste that URL → **Start** → **Package for stores → Android** → **Generate → Download** → unzip → `app-release-signed.apk`

> Tip: also do Chrome → ⋮ → *Add to Home screen* as an instant alternative while you wait.

---

## 📲 What the app does

| Feature | How |
|---|---|
| 📦 Stock | Add products (cost, sell price, min level). Low stock turns red ⚠ |
| 🧾 Sales billing | Fast billing, stock auto-reduces, cash/UPI/udhaar |
| 📒 Udhaar Khata | Customer balance auto-tracks; receive payments; WhatsApp reminders |
| 🛍 Purchases | Record supplier purchase → stock auto-increases |
| 🕵 Audit log | Owner sees WHO changed WHAT, old→new values (stored in Firestore) |
| 🔐 Roles | Owner sees costs & audit. Staff cannot see cost price or delete records |
| 💾 Backup | More → Export CSV (products/customers/sales/payments) |
| 🌐 Hindi/English | One-tap toggle |

## 🔒 Safety nets
- **Data location:** Firestore `shops/avfdpkytaxeqiuzmpxdu/...` — Console → Firestore →Export/backup anytime
- **Security:** rules in `firestore.rules` allow ONLY the owner emails — the public anon key alone grants nothing
- **Never pauses:** Firebase free Spark plan has no idle-pause behavior
- **Google login:** the github.io domain is already in Firebase authorized domains (added via admin config API); if the button ever says "domain not allowed", re-add it under Authentication → Settings → Authorized domains (Step 1.4 above)

---
Made with ❤️ — lifetime-free stack. No monthly bills, ever.
