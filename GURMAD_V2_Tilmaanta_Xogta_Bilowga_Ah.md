# GURMAD V2 — Tilmaanta Gelinta Xogta Dhabta Ah (Bilowga Shaqada)

**Ujeedada:** Hadda systemku wuxuu leeyahay Zones (5) iyo Customers (151), laakiin **Employees, Groups, Trucks, Batches waa madhan**. Tilmaankan wuxuu ku tusayaa **habka sax ah ee tartiibka** ee aad xogta dhabta ah ugu gelin lahayd — si aan wax uga qaldamin (batches ma shaqayn karaan haddii aan Groups/Employees la gelin).

**Tartiibka (muhiim — ha ka tagin):**
```
1. Zones (waa jiraan horeyba) ✅
2. Groups (qayb ka mid ah Zone) — ku dar
3. Employees (collectors, drivers, cashiers) — ku dar
4. Trucks — ku dar
5. Collection Cycles — waa jiraan horeyba (2) ✅
6. Batches — abuur marka #2-#5 la dhammeeyo
```

---

## 1. Groups (Qeybaha Zone-ka)

**Halkee:** Sidebar → **Groups** → "Create Group"

**Xogta loo baahan yahay:**
- **Zone** — dooro (tusaale: Farah Omar)
- **Group code** — magac gaaban oo *gaar ah zone-kaas gudihiisa* (tusaale: `Group 01`, `Group 02`)
- **Name** (ikhtiyaari) — magac dheeraad ah oo faahfaahsan

**Tallo:** Zone kasta wuxuu u baahan yahay ugu yaraan 1 Group ka hor inta aan Batches la abuurin, sababtoo ah customers-ku waxay ku xiran yihiin Group (ma aha Zone si toos ah).

---

## 2. Employees (Shaqaalaha)

**Halkee:** Sidebar → **Employees** → "Create Employee"

**Xogta loo baahan yahay:**
- **Full name**
- **Phone**
- **Job title** (tusaale: Driver, Collector, Accountant)
- **Employee type** — dooro: `Office`, `Collector`, `Driver`, ama `Other`
- **Zone** (ikhtiyaari — haddii uu yahay collector/driver oo zone gaar ah leh)
- **Salary**, **Join date**
- **Linked user account ID** (ikhtiyaari) — haddii shaqaaluhu leeyahay login account (username) oo horey loo abuuray "Users & Access" bogga

**Muhiim:** Collector-yada rabo inay isticmaalaan **Collector Mobile App**-ka waa inay yeeshaan:
1. Employee record (halkan)
2. User account oo `role = collector` (Sidebar → Users & Access → Create User)
3. Labadan waa in la isku xiraa "Linked user account ID" gudaha Employee-ka

---

## 3. Trucks (Gaadiidka)

**Halkee:** Sidebar → **Trucks** → "Create Truck" (button la mid ah)

Diyaari xogta gaadiidka (plate number, capacity, zone) — waa mid la mid ah habka Employees.

---

## 4. Collection Cycles

Horey ayaa loo abuuray (2 cycle: Weekly & Monthly, Farah Omar zone). Haddii aad u baahato Zones kale, Sidebar → **Collection Cycles** → "Create Cycle".

---

## 5. Batches (Shaqada Dhabta Ah)

**Halkee:** Sidebar → **Collection Cycles** → "View Batches" → "Create Batch"

**Xogta loo baahan yahay (habka la arkay live):**
1. **Zone** — dooro
2. **Collection cycle** — dooro (mid ka mid ah kuwa Zone-kaas leeyahay)
3. **Group** (ikhtiyaari) — haddii la doorto, customers-ka Group-kaas si otomaatig ah ayaa loo soo qaadaa; haddii kale customers gacanta lagu dooran karaa
4. **Customer type** — Residential ama Commercial
5. **Start date**
6. **Customers** — dooro kuwa loo baahan yahay ururinta

Marka la abuuro, Batch-ku wuxuu bilaabmaa xaalad **Draft** — waa in loo qoondeeyaa **truck** iyo **collector** (Batch Detail page-ka) ka hor inta uu noqonayo "Assigned", kadibna "In Progress".

---

## Xulashada Guud (Checklist)

- [ ] Ku dar Groups zone kasta oo aad rabto inaad ka shaqeyso
- [ ] Ku dar Employees (collectors/drivers), ku xir user accounts collector-yada
- [ ] Ku dar Trucks
- [ ] Xaqiiji Customers-ku inay ku jiraan Group sax ah (Customers → edit → dooro Group)
- [ ] Abuur Batch — dooro Zone/Cycle/Group/Customers
- [ ] Batch-ka u qoondee Truck + Collector
- [ ] Collector-ku ha ku geliyo Collector Mobile App, ha arko assignment-ka, ha bilaabo ururinta

---

**La xiriir:** Haddii aad rabto, waxaan kuu **sameyn karaa tijaabo tusaale ah** (1 Group, 1 Employee, 1 Truck, 1 Batch) oo aad daawan karto, kadibna waan tirtiri karaa — ama waxaad si toos ah u gelin kartaa xogtaada dhabta ah adigoo raacaya tilmaankan.
