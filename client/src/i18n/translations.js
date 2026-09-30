// Somali/English bilingual support (user-requested: 'admin ka staffka iyo
// customersku ba... somali iyo english ba loo badali karo'). A flat
// key->{en, so} dictionary rather than a nested-namespace i18n library —
// this app has no existing i18n infrastructure, and a lightweight lookup
// table is enough for a toggle-able UI without a new heavy dependency.
//
// Scope, disclosed: this covers navigation, login, and account-security
// surfaces — the highest-traffic, most-universal text. Translating every
// business page's own copy (Invoices, Payroll, Reports, etc. — hundreds
// of strings across dozens of pages) is a much larger follow-on effort,
// not attempted in this pass; those pages render in English regardless
// of the selected language until translated the same way (add the key
// here, call t('key') at the call site).
export const TRANSLATIONS = {
  // Sidebar — top-level + group names
  'nav.dashboard': { en: 'Dashboard', so: 'Guriga' },
  'nav.group.operations': { en: 'Operations', so: 'Hawlaha' },
  'nav.group.financial': { en: 'Financial', so: 'Maaliyadda' },
  'nav.group.hr': { en: 'HR & Payroll', so: 'Shaqaalaha & Mushaharka' },
  'nav.group.fleet': { en: 'Fleet', so: 'Gawaarida' },
  'nav.group.procurement': { en: 'Procurement', so: 'Iibsiga' },
  'nav.group.inventory': { en: 'Inventory', so: 'Alaabta' },
  'nav.group.reports': { en: 'Reports & Complaints', so: 'Warbixinnada & Cabashada' },
  'nav.group.documents': { en: 'Documents & Data', so: 'Dukumentiyada & Xogta' },
  'nav.group.administration': { en: 'Administration', so: 'Maamulka' },
  'nav.customers': { en: 'Customers', so: 'Macaamiisha' },
  'nav.zones': { en: 'Zones', so: 'Zonaha' },
  'nav.groups': { en: 'Groups', so: 'Kooxaha' },
  'nav.collectionCycles': { en: 'Collection Cycles', so: 'Wareegyada Ururinta' },
  'nav.batches': { en: 'Batches', so: 'Kooxaha Shaqada' },
  'nav.calendar': { en: 'Calendar', so: 'Jadwalka' },
  'nav.map': { en: 'Map', so: 'Khariidada' },
  'nav.billing': { en: 'Billing', so: 'Lacag-bixinta' },
  'nav.invoices': { en: 'Invoices', so: 'Qaansheegyada' },
  'nav.debts': { en: 'Debts', so: 'Deymaha' },
  'nav.cashout': { en: 'Cashout', so: 'Lacagta Laga Saaray' },
  'nav.exchangeRate': { en: 'Exchange Rate', so: 'Sicirka Sarrifka' },
  'nav.employees': { en: 'Employees', so: 'Shaqaalaha' },
  'nav.attendance': { en: 'Attendance', so: 'Xaadiriinta' },
  'nav.leaveRequests': { en: 'Leave Requests', so: 'Codsiyada Fasaxa' },
  'nav.leaveTypes': { en: 'Leave Types', so: 'Noocyada Fasaxa' },
  'nav.payroll': { en: 'Payroll', so: 'Mushaharka' },
  'nav.payrollHistory': { en: 'Payroll History', so: 'Taariikhda Mushaharka' },
  'nav.hrReports': { en: 'HR Reports', so: 'Warbixinno Shaqaale' },
  'nav.trucks': { en: 'Trucks', so: 'Gawaarida' },
  'nav.fleetMaintenance': { en: 'Fleet Maintenance', so: 'Dayactirka Gawaarida' },
  'nav.fuelRecords': { en: 'Fuel Records', so: 'Diiwaanka Shidaalka' },
  'nav.documentExpiry': { en: 'Document Expiry', so: 'Dhicitaanka Dukumentiga' },
  'nav.suppliers': { en: 'Suppliers', so: 'Bixiyayaasha' },
  'nav.procurementRequests': { en: 'Procurement Requests', so: 'Codsiyada Iibsiga' },
  'nav.purchaseOrders': { en: 'Purchase Orders', so: 'Amarrada Iibsiga' },
  'nav.inventoryItems': { en: 'Inventory Items', so: 'Alaabta Bakhaarka' },
  'nav.inventoryStores': { en: 'Inventory Stores', so: 'Bakhaarrada' },
  'nav.stockMovements': { en: 'Stock Movements', so: 'Dhaqdhaqaaqa Alaabta' },
  'nav.inventoryAdjustments': { en: 'Inventory Adjustments', so: 'Hagaajinta Bakhaarka' },
  'nav.assets': { en: 'Assets', so: 'Hantida' },
  'nav.reports': { en: 'Reports', so: 'Warbixinnada' },
  'nav.collectionHistory': { en: 'Collection History', so: 'Taariikhda Ururinta' },
  'nav.complaints': { en: 'Complaints', so: 'Cabashada' },
  'nav.documents': { en: 'Documents', so: 'Dukumentiyada' },
  'nav.dataImport': { en: 'Data Import', so: 'Soo-gelinta Xogta' },
  'nav.dataExport': { en: 'Data Export', so: 'Dhoofinta Xogta' },
  'nav.usersAccess': { en: 'Users & Access', so: 'Isticmaalayaasha & Ogolaanshaha' },
  'nav.rolesPermissions': { en: 'Roles & Permissions', so: 'Doorarka & Ogolaanshaha' },
  'nav.auditSecurity': { en: 'Audit & Security', so: 'Baaritaanka & Ammaanka' },
  'nav.systemSettings': { en: 'System Settings', so: 'Dejinta Nidaamka' },
  'nav.accountSecurity': { en: 'Account Security', so: 'Ammaanka Akoonka' },
  'nav.myHr': { en: 'My HR', so: 'Shaqaalanimadayda' },
  'nav.tasks': { en: 'Tasks', so: 'Hawlaha' },
  'nav.logout': { en: 'Log out', so: 'Ka bax' },

  // Top bar
  'topbar.searchPlaceholder': { en: 'Search customers, invoices, employees…', so: 'Raadi macaamiil, qaansheeg, shaqaale…' },
  'topbar.changePhoto': { en: 'Change Photo', so: 'Beddel Sawirka' },
  'topbar.uploading': { en: 'Uploading…', so: 'La soo shubayaa…' },

  // Login (staff)
  'login.heroTitle': { en: 'Keeping the routes running, zone by zone.', so: 'Wadooyinka ururinta si joogto ah u sii wadaya, zone kasta.' },
  'login.heroSubtitle': { en: 'Collection scheduling, cashout reconciliation, and fleet operations for every zone — one dispatch terminal.', so: 'Jadwalka ururinta, xisaabinta lacagta, iyo maamulka gawaarida zone kasta — hal nidaam oo dhan.' },
  'login.zones': { en: 'Zones', so: 'Zonaha' },
  'login.trucks': { en: 'Trucks', so: 'Gawaarida' },
  'login.uptime': { en: 'Uptime', so: 'Shaqaynta' },
  'login.username': { en: 'USERNAME', so: 'MAGACA ISTICMAALAHA' },
  'login.password': { en: 'PASSWORD', so: 'ERAYGA SIRTA AH' },
  'login.authCode': { en: 'AUTH CODE', so: 'CODKA XAQIIJINTA' },
  'login.signIn': { en: 'Sign In', so: 'Soo Gal' },
  'login.footer': { en: 'Waste Collection & Management Network', so: 'Nidaamka Ururinta & Maamulka Qashinka' },

  // Account Security
  'security.title': { en: 'Account Security', so: 'Ammaanka Akoonka' },
  'security.subtitle': { en: 'Password and session management for your own account.', so: 'Maaraynta ereyga sirta ah iyo fadhiyada akoonkaaga.' },
  'security.changePassword': { en: 'Change Password', so: 'Beddel Ereyga Sirta ah' },
  'security.currentPassword': { en: 'Current Password', so: 'Ereyga Sirta ah ee Hadda' },
  'security.newPassword': { en: 'New Password', so: 'Ereyga Sirta ah ee Cusub' },
  'security.activeSessions': { en: 'Active Sessions', so: 'Fadhiyada Firfircoon' },
  'security.logoutAll': { en: 'Log Out of All Devices', so: 'Ka Bax Dhammaan Qalabka' },
  'security.twoFactor': { en: 'Two-Factor Authentication', so: 'Xaqiijinta Laba-Tallaabo' },
  'security.twoFactorEnabled': { en: 'Enabled — a code from your authenticator app is required every time you sign in.', so: 'Waa shaqaynayaa — waxaa loo baahan yahay koodh ka yimaada app-kaaga xaqiijinta marka aad soo gasho mar walba.' },
  'security.enable2fa': { en: 'Enable 2FA', so: 'Shaqaysii 2FA' },
  'security.disable2fa': { en: 'Disable 2FA', so: 'Damiyi 2FA' },
};

export const LANGUAGES = ['en', 'so'];
export const LANGUAGE_LABELS = { en: 'EN', so: 'SO' };
