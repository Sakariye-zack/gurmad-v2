// Ops pages clarity: Districts / Groups / Batches list columns, the
// dashboard Setup checklist, the "Advanced" sidebar sub-group and the
// legacy-page help banner.
export const OPS_PAGES = {
  // Sidebar
  'nav.group.advanced': { en: 'Advanced', so: 'Horumarsan' },

  // Legacy-page banner (Cycles, Batches, Calendar)
  'opsp.legacyBanner': { en: "Daily work is now done from Today's list. These pages are for manual/advanced use.", so: 'Shaqada maalinlaha ah hadda waxaa laga qabtaa Liiska Maanta. Boggaggan waxaa loogu talagalay isticmaal gacan ah ama horumarsan.' },
  'opsp.goToday': { en: "Open Today's list", so: 'Fur Liiska Maanta' },

  // Shared column labels
  'opsp.col.groups': { en: 'Groups', so: 'Kooxaha' },
  'opsp.col.zones': { en: 'Zones', so: 'Zonaha' },
  'opsp.col.subZones': { en: 'Sub Zones', so: 'Sub Zone-yo' },
  'opsp.col.customers': { en: 'Customers', so: 'Macaamiisha' },
  'opsp.col.collectors': { en: 'Collectors', so: 'Ururiyayaasha' },
  'opsp.col.district': { en: 'District', so: 'Degmo' },
  'opsp.col.source': { en: 'Source', so: 'Isha' },
  'opsp.col.date': { en: 'Date', so: 'Taariikh' },
  'opsp.col.subZone': { en: 'Sub Zone', so: 'Sub Zone' },
  'opsp.col.collector': { en: 'Collector', so: 'Ururiye' },
  'opsp.col.truck': { en: 'Truck', so: 'Gaari' },
  'opsp.moreN': { en: '+{n}', so: '+{n}' },

  // Districts
  'opsp.districtsSubtitle': { en: 'Each district holds Groups › Zones › Sub Zones › Customers.', so: 'Degmo kastaa waxay leedahay Kooxo › Zonooyin › Sub Zone-yo › Macaamiil.' },
  'opsp.legacyField': { en: 'legacy', so: 'hore' },
  'opsp.legacyHint': { en: 'Legacy — no longer used for daily lists. Work days live on each Sub Zone.', so: 'Kii hore — looma isticmaalo liisaska maalinlaha. Maalmaha shaqadu waxay ku jiraan Sub Zone kasta.' },

  // Groups
  'opsp.empty': { en: 'Empty', so: 'Madhan' },
  'opsp.emptyHint': { en: 'No customers and no Sub Zones yet', so: 'Weli macaamiil iyo Sub Zone midna ma laha' },

  // Batches
  'opsp.sourceManual': { en: 'Manual', so: 'Gacan' },
  'opsp.sourceAuto': { en: 'Auto', so: 'Toos' },
  'opsp.allSources': { en: 'All sources', so: 'Dhammaan ilaha' },
  'opsp.anyDate': { en: 'Any date', so: 'Taariikh kasta' },
  'opsp.clearDate': { en: 'Clear date', so: 'Tirtir taariikhda' },

  // Setup checklist
  'opsp.setup.title': { en: 'Setup checklist', so: 'Liiska diyaarinta' },
  'opsp.setup.allSet': { en: 'All set — daily lists can run.', so: 'Wax walba waa diyaar — liisaska maalinlaha way shaqayn karaan.' },
  'opsp.setup.recommended': { en: 'Recommended improvements ({n})', so: 'Hagaajinno lagu talinayo ({n})' },
  'opsp.setup.intro': { en: 'These gaps keep Sub Zones or customers off the automatic daily lists:', so: 'Cilladahan ayaa Sub Zone-yo ama macaamiil ka reebaya liisaska tooska ah:' },
  'opsp.setup.loadFailed': { en: 'Could not load the setup checklist.', so: 'Liiska diyaarinta lama soo rari karin.' },
  'opsp.setup.no_collector': { en: 'Sub Zones without a collector', so: 'Sub Zone-yo aan ururiye lahayn' },
  'opsp.setup.collector_no_employee': { en: 'Collector has no employee record', so: 'Ururiyaha ma laha diiwaan shaqaale' },
  'opsp.setup.collector_type_mismatch': { en: 'Collector type does not match the customers', so: 'Nooca ururiyaha kuma habboona macaamiisha' },
  'opsp.setup.no_work_days': { en: 'Sub Zones without work days', so: 'Sub Zone-yo aan maalmo shaqo lahayn' },
  'opsp.setup.no_truck': { en: 'Sub Zones without a truck', so: 'Sub Zone-yo aan gaari lahayn' },
  'opsp.setup.no_start_point': { en: 'Sub Zones without a start point', so: 'Sub Zone-yo aan bar bilow lahayn' },
  'opsp.setup.customers_without_subzone': { en: 'Active customers without a Sub Zone', so: 'Macaamiil firfircoon oo aan Sub Zone lahayn' },
  'opsp.setup.customers_without_location': { en: 'Active customers without a map location', so: 'Macaamiil firfircoon oo aan goob khariidad lahayn' },
  'opsp.setup.more': { en: '+{n} more', so: '+{n} kale' },
  'opsp.setup.open': { en: 'Open', so: 'Fur' },
};
