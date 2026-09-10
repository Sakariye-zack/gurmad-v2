# GURMAD V2 — Future CR Register (Consolidated) — Business Owner Review

**Diyaariyay:** Phase 8/9 Gap Audit, 2026-09-10. Liiskan wuxuu ka kooban yahay dhammaan waxyaabaha si ula kac ah **loo dhigay CLOSED phases-ka** (Phase 5, 6, 7) — mid kastaaba wuxuu u baahan yahay go'aan ganacsi (Business Owner decision) ka hor inta aan la dhisin. Midkoodna **ma aha khalad** ama qabyo koodh ah — waa hadal la og yahay.

Habka: mid kasta waxaa lagu qeexay **Muhiimad** (High/Medium/Low — talo, ma aha go'aan) iyo **Sababta loo dhigay**.

---

## 🔴 MUHIIM (talo: fiiri ugu horeya)

| # | CR | Sabab loo dhigay | Talo |
|---|---|---|---|
| 1 | **Document Content-Sniffing Validation** (Phase 5) | Validation-ka file-ka waxa uu ku tiirsan yahay extension/MIME-type oo la sheegay, ma aha inspection dhabta ah. | Haddii dad ka baxsan shirkadda (customers) ay upload gareeyaan documents, waa mid loo baahan yahay production ka hor. |
| 2 | **Virus/Malware Scanning** (Phase 5) | Ma jiro infrastructure scanning ah oo hadda jira. | Waa khatar production, laakiin waa "production infrastructure dependency" — kama go'na Phase-kan. |
| 3 | **Collector Photo Upload Backend Route** (la helay Phase 8 Audit) | Collector-ku wuxuu "sawir" qaadaa marka uu "serviced" calaamadeeyo, laakiin **backend-ku ma haysto route uploads sawirrada** — sawirku wuxuu ku hadhaa taleefanka gudihiisa oo kaliya, lama xaqiijin karo mustaqbalka. | Haddii sawirka collection-ka loogu baahan yahay caddayn (evidence), tan waa in la dhiso — waa endpoint cusub + file storage. |

## 🟡 DHEXDHEXAAD (talo: qorshee marka la hela xilli)

| # | CR | Sabab |
|---|---|---|
| 4 | **Import Approval Workflow** (Phase 6) | Hadda import-ku waa hal-qofle (single-actor), sida dhammaan create-actions kale ee systemka. Haddii aad rabto in loo baahdo laba-qof-oggolaansho ka hor import weyn, waa go'aan cusub oo governance ah. |
| 5 | **XLSX Import/Export** (Phase 6) | Hadda CSV kaliya. Excel waa khatar cusub (formula injection heer kale ah) oo aan mid loo diyaarin. |
| 6 | **Employee/Group/Route Import** (Phase 6) | Ma jiro "canonical key" (aqoonsi dhab ah) oo la aqoonsaday saddexdaas — waa go'aan aad u baahan tahay inaad qeexdo (tusaale: employee code) ka hor inta import la ogolaan. |
| 7 | **Sensitive Employee Field Export** (photo, ID document, guarantor info) | Hadda si automatic ah ayaa laga reebay export-ka. Su'aal: ma jirtaa role kasta oo mudan inuu arko xogtaas oo dhan? |
| 8 | **Head of Cashiers / Cashier — Master-Data Export Rights** | Hadda labadan role midna kuma jiraan export-ka. Ma loo baahan yahay? |
| 9 | **Document Versioning** | Hadda kaliya "old vs new" ayaa la kaydiyaa. Multi-draft browsing (tusaale: 5 nuqul oo contract ah) lama taageerin. |
| 10 | **Retention Policy + Orphan File Sweep** | **Ku xiran sharci/xeer shirkadeed** oo aan hadda jirin — ilaa aad go'aamiso muddada xogtu ay tahay in la haysto, wax lama tirtirayo. |

## 🟢 HOOSE (talo: kaliya haddii loo baahdo mustaqbalka)

11–20. XLSX preview, streaming export, whole-import undo, mixed-zone import files, downloadable error-report CSV, import provenance tracking, per-row import audit, asynchronous import processing, Supplier/Inventory-Store canonical key, Asset Register import, HR/Procurement/Inventory/Asset/Customer/Supplier document attachments (7 module-specific CRs), production object storage migration, signed URLs, production backup infrastructure for file binaries, legacy document/archive migration.

*(Faahfaahin buuxa oo mid kasta — sabab, halbeeg §, iyo go'aan la sugayo — waxay ku jiraan `GURMAD_V2_Phase5_Document_File_Decisions.md` iyo `GURMAD_V2_Phase6_Import_Export_Master_Data_Governance_Decisions.md`.)*

---

## Go'aan aan hadda kaa rabno (haddii aad rabto inaan wax ka qabanno)

Kuma jiro wax go'aan ah oo **lagama maarmaan ah** si Phase 9/10 loo dhammaystiro — liiskan waa backlog dukumentigaysan, waana la aqbali karaa "as-is" (dhammaan waa deferred, production wali NOT AUTHORIZED). Haddii aad rabto in mid ka mid ah la wado, ii sheeg lambarka (#1-20) — haddii kale, waan u sii wadi doonaa Phase 9-ka intiisa kale (functional gap audit-ka guud ee ~30 modules) iyada oo aan liiskan la taaban.

**Xaalada guud:** Production — **NOT AUTHORIZED — UNTOUCHED**.
