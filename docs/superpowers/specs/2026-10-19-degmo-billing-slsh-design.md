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

### Tusaale

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

### Bille
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
