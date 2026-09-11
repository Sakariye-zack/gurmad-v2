# GURMAD V2 — Waxa Ka Hadhay (Xaalada Session-kan Kadib)

**Taariikhda:** 2026-09-11 | Baseline: git HEAD `0e5ed79`

---

## 🔴 Muhiim ah — Production Ka Hor Loo Baahan Yahay

| # | Shay | Xaalad |
|---|---|---|
| 1 | **Virus/malware scanning** (documents/attachments) | Weli **lama xalin** — ma jirto infrastructure scanning ah oo hadda jira system-ka. Waa mid production ka hor loo baahan yahay haddii customers/staff ay upload gareeyaan files aan la hubin. |
| 2 | **Collector photo-capture UI (frontend)** | Backend-ku **dhammaystiran yahay** (`POST/GET /collection-sync/photo`, tijaabo dhammaystiran). Laakiin `CollectionActionScreen.jsx` weli wuxuu kaliya "proof of camera access" qabanayaa — **kama qaadanayo sawir dhab ah**, kuma keydinayo offline queue-ga (IndexedDB), mana u soo diri karo backend-ka. Tani waa shaqo UI ah oo weyn (camera capture + canvas snapshot + queue wiring). |

## 🟡 Dhexdhexaad ah

| # | Shay | Xaalad |
|---|---|---|
| 3 | **Batches/Collection data** | `batches`, `groups`, `routes`, `tasks`, `employees` — dhammaantood waa **madhan** (0 xog). Tan waa go'aan ganacsi (aad go'aamin doonto marka la bilaabo shaqada dhabta ah), ma aha khalad — sida horey loogu sheegay. |
| 4 | **~35 Future CR** oo kale (Import approval workflow, XLSX support, document versioning, retention policy, iwm) | Waxay ku jiraan `GURMAD_V2_Future_CR_Register_Consolidated.md` — dhammaantood waa go'aamo ganacsi oo la sugayo, kama dhigna khalad. |
| 5 | **Phase 1-5 deep re-verification** | Session-kan **lama dib u tijaabin live** Phase 1-5 modules-ka (HR/Payroll, Fleet, Procurement, Customer Portal backend, Inventory) — waxaa la aqbalay xaaladdoodii "CLOSED" ee hore (git commits + docs), ma aha tijaabo cusub oo la sameeyay session-kan. |

## 🟢 Hoose — Design/Polish

| # | Shay | Xaalad |
|---|---|---|
| 6 | Customer Portal iyo Collector — bogagga kale (Dashboard, Invoices, Assignments, iwm) | Login-yada oo kaliya ayaa la "dispatch manifest" qaab cusub loo sameeyay. Bogagga kale ee dhammaan saddexda app ma haystaan isku-qaab design ah — waxay sii wataan design-kii hore ee "plain" ahaa. |
| 7 | Sidebar-ka iyo App-ka guud | Ma haystaan "dispatch" theme-ka — kaliya login pages-ka ayaa loo beddelay. |

---

## ✅ Waxa Dhammaystiran (Session-kan)

- Phase 6-10 (Master Program) — dhammaystiran, si live ah loo tijaabiyay
- Nav-gaps (18+2 bog) — la xaliyay
- Content-sniffing security fix — 6 goobood, la xaliyay
- Collector photo-upload **backend** — la dhisay, la tijaabiyay
- Company logo — public GET endpoint + Sidebar/login display — la xaliyay
- Login-yada saddexdaba (Staff/Portal/Collector) — design cusub, la tijaabiyay live

---

**Talo:** Haddii aad doonayso inaad horumar sii wadato, waxaan ku talin lahaa:
1. **Muhiimka #1** (virus scanning) — u baahan production infrastructure decision (adiga baa go'aamin kara)
2. **Muhiimka #2** (collector camera UI) — shaqo dhab ah oo la bilaabi karo hadda haddii aad rabto
3. Kuwa kale — waa go'aamo ganacsi oo aan lagama-maarmaan ahayn hadda.
