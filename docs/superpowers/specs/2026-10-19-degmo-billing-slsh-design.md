# Naqshad (Spec): Kala-qaybinta Degmo, Lacag go'an oo SLSH ah, iyo Invoice Bille/Maalinle

> **DRAFT: adiga ayaa saxaya.** Meel kasta oo **[GO'AAN]** ku qoran tahay, weli jawaab lagama helin.
> Wax kasta oo aad beddeli rabto, toos ugu qor faylkan, kadibna ii sheeg.

---

## Ujeeddada

Nidaamka GURMAD waxaa lagu samaynayaa saddex isbeddel:
1. Macaamiisha waxaa loo kala qaybinayaa **Degmo → Group → Zone → Route (albaab)**.
2. Macmiilka waxaa la siin karaa **lacag go'an oo SLSH ah** oo bil kasta isku mid ah, tusaale 30,000 SLSH.
3. Invoice-yadu waxay noqonayaan laba nooc, **Maalinle** iyo **Bille**, waxayna si toos ah u samaysmayaan.

Dhisiddu waxay u socon doontaa sida kala horreynta hoose. Qayb kasta waa la dhisayaa, waa la tijaabinayaa, waana la dirayaa ka hor inta aan la bilaabin tan xigta.

---

## Qaybta 1: Kala-qaybinta macaamiisha

### CUSBOONAYSIIN (2026-11-05, ereyada isticmaalaha): kala-horreynta kama dambaysta ah

> Isticmaaluhu wuxuu qoray: `Group 2 › Farah Omar (Baarsiigo) › zone › Sub Zone 1 › Caasha (C-572)`

Heerarku waa **5**, albaabkuna wuxuu ka mid yahay xogta macmiilka:

```
Group 2                         ← heerka ugu sarreeya
  └─ Degmo: Farah Omar  (aagga Baarsiigo)
       └─ Zone
            └─ Sub Zone 1
                 └─ Macmiil: Caasha (C-572, albaab 572)
```

Tani way ka duwan tahay nidaamka hadda: Group-ku wuxuu ku jiraa Degmada gudaheeda, heerka "Zone" ee u dhexeeya Degmada iyo Sub Zone-kana ma jiro. Waa dib-u-dhisid, ma aha beddel magac oo keliya.

- **LA GO'AAMIYAY (2026-11-05):** Group-yada waxaa laga samayn karaa Farah Omar iyo Sheekh Bashiir labadaba. Group kasta wuxuu ka tirsan yahay **hal degmo**. Laba degmo waxay yeelan karaan Group isku magac ah (tusaale "Group 2"), oo kala duwan. Nidaamka hadda sidan ayuu u shaqeeyaa: code-ka Group-ku wuxuu gaar u yahay degmada gudaheeda oo keliya. Sidaa darteed `Group 2 › Farah Omar` waa **qaabka qoraalka** oo keliya, Group-kuna wali Degmada ayuu ka hoos yimaadaa.
- **[GO'AAN]** "Baarsiigo" ma magaca aagga Degmada ayuu yahay, mise waa magaca Group-ka?
- **LA GO'AAMIYAY (2026-11-05):** bill collector-ka waxaa loo xilsaarayaa **Sub Zone-ka** (sidii hore).
- **LA GO'AAMIYAY (2026-11-05):** Zone waa **heer cusub**. Wuxuu ka tirsan yahay hal Group, wuxuuna leeyahay Sub Zone-yo badan:
  ```
  Group 2 › Farah Omar (Baarsiigo)
    └─ Zone A
         ├─ Sub Zone 1  (collector: Ahmed)
         └─ Sub Zone 2  (collector: Ahmed)
  ```
- **LA GO'AAMIYAY (2026-11-05):** Sub Zone kasta wuxuu leeyahay hal collector. Hal collector wuxuu yeelan karaa **ilaa 10 Sub Zone**. Sub Zone-ka 11-aad waa la diidayaa, fariin ayaana soo baxaysa.

**Sida loo dhisayo (farsamo):**
- Waxaa la abuurayaa miis cusub, `group_zones`: id, group_id, code, name, status. Code-ku wuxuu gaar u yahay Group-ka gudihiisa.
  - Magaca `zones` lama isticmaali karo, maxaa yeelay wuxuu horeyba u yahay miiska Degmooyinka.
- `routes` (Sub Zone) waxaa lagu darayaa `group_zone_id`. Sub Zone-yada hadda jira waxay bannaan ahaanayaan ilaa Zone loo doorto, kadibna Zone-ka ayaa noqonaya waalidkooda.
- Foomka macmiilka: Degmo › Group › Zone › Sub Zone › albaab.
- **[GO'AAN]** Groups-ka hadda jira (4 Group, oo batch-yo ku xidhan yihiin) maxaa lagu sameeyaa marka la rogo?

Xeerarka cusub ee lambarka macmiilka:
- **Albaabku waa qasab** marka macmiil cusub la diiwaangelinayo, waana **tirooyin oo keliya** (tusaale 572).
- **Customer # = `C-` + albaabka.** Albaabka 572 wuxuu noqonayaa C-572. Albaab hal god ah waxaa lagu hormarinayaa eber: 7 wuxuu noqonayaa C-07.
- Goobta Customer # ee gacanta lagu qori jiray waa laga saarayaa foomka abuurista.
- Haddii C-<albaab> horay u jiro, waa la diidayaa (409), fariin ayaana sheegaysa in albaab kale la isticmaalo.
- **LA GO'AAMIYAY (2026-11-05): beddelka albaabka iyo lambarka wuxuu u baahan yahay oggolaansho.**
  - Marka albaabka macmiil la beddelo, isbeddelku **toos uma dhaco**. Waxaa la abuurayaa **codsi** (albaabka cusub iyo C-<albaab> cusub).
  - **Admin**-ka ayaa oggolaanaya ama diidaya. Gudoomiyuhu wuu codsan karaa, laakiin ma oggolaan karo. Tani waa qiyaas; isticmaaluhu wuu beddeli karaa.
  - Marka la oggolaado, albaabka iyo Customer #-ku way isbeddelayaan. **Invoice-yada cusub** waxaa ku qormaya lambarka cusub. Invoice-yadii hore waxay sii haystaan lambarkii hore ee lagu daabacay. (Invoice-yadu horeyba waxay keydiyaan magacyada xilliga la sameeyay; lambarka macmiilka waxaa lagu darayaa sidaas oo kale.)
  - Codsiga, oggolaanshaha iyo diidmadaba waxaa lagu qorayaa audit log-ka.
- Macaamiisha hadda jira (C-01, C-02…) waxba iskama beddelayaan. **Caasha C-04 waxaa loo beddelayaa C-572.**
- Bogga macmiilka iyo liiska waxay muujinayaan `Degmo › Group › Sub Zone`, iyo Customer #-ka.
- Import-ka CSV: macmiilka aan albaab lahayn waa la diidayaa, kan albaab leh wuxuu helayaa C-<albaab>.
  - **[GO'AAN]** Ma sidan ayaad rabtaa, mise import-ku wuxuu sii wadayaa lambar toos ah haddii albaab la waayo?

### Tusaale (qoraalkii hore)

```
Degmo:   Farah Omar
  └─ Group:  Group 2  (aagga Baarsiigo)
       └─ Zone:   Sub Zone 1
            └─ Route: 572   (albaabka Caasha)
                 └─ Macmiilka: Caasha
```

### Habka: magacyada ayaa la beddelayaa, xogta lama wareejinayo
Zones-ka hadda jira (Farah Omar, Sheekh Bashiir) dhab ahaantii waa Degmooyin. Sidaa darteed:

| Nidaamka hadda | Waxa uu noqonayo |
|---|---|
| Zone (Farah Omar, Sheekh Bashiir) | **Degmo** |
| Group (wuxuu ka hoos yimaadaa Zone-ka) | **Group** (Degmada ayuu ka hoos yimaadaa) |
| Route (wuxuu ka hoos yimaadaa Group-ka) | **Zone / Sub Zone** |
| (ma jiro) | **Route = albaabka** (goob cusub oo macmiilka ah) |

- Database-ka magacyada miisaska lama beddelayo (`zones`, `groups`, `routes`). Magacyada **shaashadaha iyo warbixinnada** ayaa la beddelayaa, si khatar u yaraato.
- Macaamiisha, batch-yada iyo invoice-yada hadda Farah Omar / Sheekh Bashiir ku xidhan waxba iskama beddelayaan.

### Xeerarka
- **Degmo:** Farah Omar iyo Sheekh Bashiir (horeyba way u jiraan).
- **Group:** wuxuu ka tirsan yahay hal Degmo, wuxuuna leeyahay magac iyo aag (tusaale Baarsiigo).
- **Zone (Sub Zone):** wuxuu ka tirsan yahay hal Group. Zone kasta waxaa u shaqeeya **hal bill collector**.
  - **LA GO'AAMIYAY:** collector-ka waxaa loo xilsaarayaa Sub Zone kasta (hal collector, hal Sub Zone).
- **Route / Albaab:**
  - Waa lambarka albaabka macmiilka (tusaale 572).
  - **Hal macmiil** ayuu u gaar yahay.
  - Nidaamka oo dhan **hal mar** ayuu ka jiri karaa.
- **Macmiilka:** waxaa loo doortaa Sub Zone-ka. Group-ka iyo Degmada si toos ah ayaa looga ogaanayaa.

### Xogta hadda jirta
- Groups iyo Routes-ka hadda jira (tusaale Group 1 / Route 1) waa **tijaabo, waana la tirtirayaa**.
- Degmooyinka (Farah Omar, Sheekh Bashiir) iyo macaamiishooda waxba lagama beddelayo.
- Macaamiisha hadda jira, albaabkoodu iyo Sub Zone-koodu waxay bannaan ahaanayaan ilaa la galiyo.
- **LA GO'AAMIYAY:** xogta tusaalaha waa la abuurayaa nidaamka dhabta ah, kadib deploy-ga: Group 2 (Baarsiigo, Farah Omar), Sub Zone 1, iyo Caasha oo leh albaabka 572. Taleefanka Caasha waxaa la weydiinayaa isticmaalaha.

### Shaashadaha
- **Degmooyin:** bogga "Zones" ee hadda ayaa loo beddelayaa "Degmooyin".
- **Groups:** dooro Degmada. Faahfaahinta Group-ka waxay muujinaysaa Sub Zones-ka ku jira (kuwii hore loogu yeedhi jiray "Routes").
- **Foomka macmiilka:**
  - Dooro Zone-ka, waxaana muuqanaya *Farah Omar › Group 2 › Sub Zone 1*.
  - Goobta **Albaab / Route #** waa la geliyaa.
- **Liiska macaamiisha:** shaandhayn lagu sameeyo Degmo, Group, Zone iyo baadhitaanka lambarka albaabka.
- Meelaha kale ee Group/Route isticmaala waxaa loo beddelayaa habka cusub:
  - Batch-yada
  - Khariidadda
  - Warbixinnada
  - App-ka collector-ka
  - Import/Export-ka CSV

---

## Qaybta 2: Lacag go'an oo SLSH ah

### Xeerarka
- Marka macmiilka la diiwaangelinayo waxaa la dooranayaa **lacagta**, USD ama **SLSH**, iyo **qaddarka bishii** (tusaale 30,000 SLSH).
- Lacagtu **ma kordhayso mana dhimmanayso**. Bil kasta intaas oo keliya ayaa lagu dalacayaa.
- **[GO'AAN]** Invoice-ka macmiilka SLSH-ka ah maxaa lagu qorayaa?
  1. **SLSH oo keliya:** invoice-ku waa 30,000 SLSH, isbeddelka sicirka sarrifkuna ma taabanayo. Warbixinnada USD-ga ah waxaa loo beddelayaa sicirka maalinta.
  2. **USD:** invoice-ku waa USD, waxaana laga xisaabinayaa 30,000 SLSH iyadoo la adeegsanayo sicirka 1-da bisha.
- **[GO'AAN]** Macmiilka SLSH-ka ah, ma ku bixin karaa USD (ama Zaad/eDahab USD)? Haa / Maya

---

## Qaybta 3: Invoice Maalinle iyo Bille

### Maalinle
- Invoice ayaa si toos ah u samaysmaya **maalin kasta**, ama **mar kasta oo macmiilka loo shaqeeyo**.
- **[GO'AAN]** Labadan midkee?
  1. Maalin kasta si toos ah, xitaa haddii aan loo shaqayn.
  2. Keliya marka collector-ku calaamadiyo in loo shaqeeyay, sida batch-yada hadda.

### LA GO'AAMIYAY (2026-11-06)
- **Maalinle:** invoice waxaa la samaynayaa **marka loo shaqeeyo oo keliya**, macmiil kasta oo maalintaas collector-ku calaamadiyay serviced. Maalinta aan loo shaqayn, invoice ma jiro.
- **Bille, macaamiisha lacag go'an leh** (tusaale 30,000 SLSH): invoice-ka waxaa si toos ah loo samaynayaa **28-ka bisha**, hal mar oo keliya bishii, waana lacagta go'an.
  - 28 waxaa loo doortay maxaa yeelay bil kasta way leedahay, Febraayo-na ku jirto. Isticmaaluhu wuxuu yidhi "28 ilaa 29".
- **LA GO'AAMIYAY:** qiimaha macmiil kasta waa **heshiis gaar ah**, oo la qoro marka la diiwaangelinayo (Fee + Lacagta). Invoice-ku had iyo jeer waa qiimahaas, lacagtaas.
  - **SLSH go'an:** tusaale 30,000 SLSH. Isbeddelka sicirka ma taabanayo.
  - **USD (sarif u fasax):** invoice-ku waa USD. Macmiilku wuxuu ku bixin karaa SLSH, iyadoo la adeegsanayo sicirka maalinta, sida hadda.
  - Macmiil bille ah oo aan qiime lahayn: invoice looma samaynayo, waxaana lagu soo warramayaa liiska "maqan" si admin-ku u buuxiyo.
- **LA GO'AAMIYAY:** macmiil bisha dhexdeeda la diiwaangeliyay wuxuu 28-ka helayaa **invoice bil buuxda**, qaybin ma jirto.

### Bille
- **LA GO'AAMIYAY (2026-11-05):** macmiil kasta oo **guri (residential)** ah wuxuu bishii helayaa **hal invoice oo keliya**. Invoice-ka waxaa ku qoran **maalmihii loo shaqeeyay** bishaas.
- Invoice ayaa si toos ah u samaysmaya **1-da bisha**, macmiil kasta oo bille ah.
- Invoice-ka waxaa ku qoran **4 toddobaad**. Toddobaad kasta waxaa lagu qorayaa **maalinta loo shaqeeyay**, oo ah taariikhda collector-ku calaamadiyay.
- **[GO'AAN]** Haddii toddobaad aan loo shaqayn, maxaa dhacaya?
  1. Lacagtu isma beddelayso, waana la qorayaa "lama shaqayn".
  2. Lacagta waa laga jarayaa.
- **[GO'AAN]** Bil 5 toddobaad leh (tusaale 29-31 maalmood), toddobaadka 5-aad maxaa lagu sameeyaa?
- **[GO'AAN]** Macmiil bisha dhexdeeda la diiwaangeliyay, invoice-kiisa koowaad:
  1. Waa la qaybinayaa (inta maalmood ee hadhay oo keliya).
  2. Bisha xigta ayuu bilaabanayaa.

### Habka toos u samaysma
- Server-ka waxaa ku shaqaynaya hawl maalinle ah, oo la socodsiiyo saacad la doortay, tusaale 00:05.
- Hal macmiil laba invoice isku bil ama isku maalin kuma yeelanayo, xitaa haddii hawsha laba jeer la socodsiiyo.
- Admin-ku wuxuu arki karaa invoice-yada la sameeyay, wuuna dib u socodsiin karaa.

---

## Tijaabooyinka (dhammaan qaybaha)
- Lambar albaab oo labanlaaban waa la diidayaa.
- Zone → Group → Degmo si sax ah ayaa loo muujinayaa (tusaalaha Caasha).
- Batch-ka Group-ka wuxuu soo qaadanayaa macaamiisha Zones-ka Group-kaas oo dhan.
- Macmiilka 30,000 SLSH ah wuxuu helayaa invoice 30,000 SLSH ah bil kasta, xitaa haddii sicirka sarrifku isbeddelo.
- Invoice-ka bille ah 1-da bisha ayuu samaysmaa, hal mar oo keliya.
- Invoice-ka maalinlaha ah hal mar oo keliya ayuu maalintii samaysmaa.

---

## Qorshaha dhisidda (Plan, kooban)

| # | Shaqada | Waxa la beddelayo |
|---|---|---|
| 1 | Database: goobta albaabka macmiilka (`door_number`, unique); tirtirka Groups/Routes-ka tijaabada | `server/db.js` |
| 2 | API: albaabka macmiilka iyo baadhitaanka | `server/routes/customers.js` |
| 3 | Shaashadaha: Zone→Degmo, Route→Sub Zone (magacyo), foomka iyo liiska macaamiisha | `client/src/pages/`, `i18n` |
| 4 | Beddelidda batch-yada, khariidadda, warbixinnada, app-ka collector-ka iyo CSV | `batches.js`, `map.js`, `reports.js`, `collectionSync.js`, `masterDataEntities.js` |
| 5 | Tijaabooyin, browser check, deploy | `server/test/` |
| 6 | Qaybta 2: lacagta iyo qaddarka bishii ee macmiilka | `customers`, `invoices`, `payments` |
| 7 | Qaybta 3: invoice bille iyo maalinle oo toos u samaysma | hawl cusub oo server-ka ah, `invoices.js` |

Qayb kasta: tijaabo → commit → adiga oo oggolaada → deploy.

---

## Qaybta 3: naqshadda la oggolaaday (2026-11-06)

1. **Hawsha toos ah:** server-ka gudihiisa waxaa ku shaqaynaya saacad, saacad kasta hal mar. Maaha cron dibadda ah.
   - **Bille:** 28-ka bisha (ama marka server-ku kaco haddii 28-ka la dhaafay), invoice ayaa loo samaynayaa macmiil kasta oo leh `status = active`, `billing_type = monthly` iyo fee. Invoice-ku waa fee-ga iyo lacagtiisa.
     - Bil kasta hal invoice oo keliya: unique index `(customer_id, billing_period)`.
   - **Maalinle:** habeen kasta 23:30 (wakhtiga shirkadda), invoice ayaa loo samaynayaa booqasho kasta oo `serviced` ah oo maalintaas ah, macaamiisha `billing_type = daily` oo fee leh. Invoice-ku wuxuu ku xidhan yahay `batch_customer_id`.
     - Laba invoice isku booqasho uma samaysmaan.
   - Macmiil aan fee lahayn waa la boodayaa, waxaana lagu darayaa liiska "skipped".
   - Admin: badhanka **Generate now** (idempotent).
2. **Invoice SLSH ah:** wixii la bixiyay waxaa lagu xisaabinayaa lacagta invoice-ka.
   - Lacag SLSH ah = qaddarkeeda.
   - Lacag USD ah = `amount_usd × sicirka lacag bixinta` (sicirka hadda jira haddii aan la hayn).
   - Warbixinnada USD-ga ah: invoice SLSH ah ÷ sicirka hadda jira.
3. **Invoice bille ah:** wuxuu muujinayaa shax toddobaadyo ah (1-7, 8-14, 15-21, 22-28/dhammaadka bisha). Toddobaad kasta waxaa ku qoran maalmihii serviced, laga soo qaaday `batch_customers.status_at`. Waxaa lagu muujinayaa bogga invoice-ka, .docx-ka iyo preview-ga.
4. **Shaashadda:** bogga Invoices waxaa ku jira kaarka "Auto-billing", oo muujinaya:
   - run-kii ugu dambeeyay
   - macaamiisha la booday
   - badhanka Generate now
   
   Invoice kasta waxaa ku qoran calaamad "Auto · Nov 2026" ama "Auto · daily".
