// Calendar event clarity (Sub Zone / collector / progress / Auto vs manual
// range) and Collection Cycles cleanup (close ended cycles, Ended chip,
// end-date auto-fill).
export const CALENDAR_CYCLES = {
  // Calendar legend
  'calc.legendAuto': { en: "daily list — click opens Today's list for that day", so: 'liiska maalinlaha — riix si aad u furto Liiska Maanta ee maalintaas' },
  'calc.legendManual': { en: 'manual batch over several days (Oct 19 → Oct 25) — click opens the batch', so: 'koox shaqo gacan ah oo maalmo badan socota (Oct 19 → Oct 25) — riix si aad u furto kooxda' },
  'calc.legendOverdue': { en: 'overdue', so: 'waqtigii dhaafay' },
  'calc.legendProgress': { en: '3/12 = serviced / customers', so: '3/12 = la qabtay / macaamiisha' },

  // Cycles cleanup
  'calc.ended': { en: 'Ended', so: 'Dhammaaday' },
  'calc.endedHint': { en: 'The end date has passed but the cycle is still open.', so: 'Taariikhda dhammaadku way dhaaftay laakiin wareeggu weli wuu furan yahay.' },
  'calc.closeEnded': { en: 'Close ended cycles', so: 'Xir wareegyada dhammaaday' },
  'calc.closeEndedTitle': { en: 'Close ended cycles?', so: 'Ma xiraysaa wareegyada dhammaaday?' },
  'calc.closeEndedBody': { en: '{n} open manual cycle(s) have an end date before today and will be closed. Automatic cycles and cycles that end today or later are not touched.', so: '{n} wareeg gacan ah oo furan ayaa taariikhdooda dhammaadku ka horreysaa maanta waana la xiri doonaa. Wareegyada tooska ah iyo kuwa maanta ama ka dib dhammaanaya lama taabanayo.' },
  'calc.closeEndedNone': { en: 'There are no ended manual cycles to close.', so: 'Ma jiraan wareegyo gacan ah oo dhammaaday oo la xiro.' },
  'calc.closeEndedDone': { en: '{n} cycle(s) closed', so: '{n} wareeg ayaa la xiray' },
  'calc.endAutoFilled': { en: 'Filled from the start date and cycle type — you can change it.', so: 'Waxaa laga buuxiyay taariikhda bilowga iyo nooca wareegga — waad beddeli kartaa.' },
  'calc.spanRuleWeekly': { en: 'A weekly cycle is exactly 7 days.', so: 'Wareeg toddobaadle ah waa 7 maalmood oo keliya.' },
  'calc.spanRuleMonthly': { en: 'A monthly cycle is 28 to 31 days.', so: 'Wareeg bille ah waa 28 ilaa 31 maalmood.' },
};
