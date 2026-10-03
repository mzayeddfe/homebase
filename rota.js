/* rota.js — pure scheduling logic. No DOM, so it runs in the browser and in Node for testing.
 *
 * How the rota works
 * - Weeks are numbered from a fixed Monday (1 Jan 2024), so both phones always calculate the
 *   same rota with no server needed. Only the ticks are synced.
 * - Daily chores alternate day by day, and the pattern flips every week.
 * - "Heavy" (daunting) chores strictly alternate each time they come round.
 * - Disinfecting chores lean to person A and organising chores lean to person B: the preferred
 *   person gets them 3 times in 4, and the other person takes a turn the 4th time.
 * - General chores alternate, then are moved between people to balance total minutes.
 * - Each person's chores are spread across the week so no day goes over 30 minutes.
 */
(function (root) {
  'use strict';

  const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const EPOCH_MS = Date.UTC(2024, 0, 1); // a Monday
  const WEEK_MS = 7 * 24 * 3600 * 1000;
  const DAILY_CAP = 30;
  const PERIOD = { daily: 1, weekly: 1, fortnightly: 2, monthly: 4 };
  const PREF = { disinfect: 'A', organise: 'B' };

  // owner: '' = on the rota, 'A' or 'B' = always that person
  // day: -1 = any day, 0-6 = fixed weekday (Mon = 0), e.g. bin day
  // offset: which week of the cycle a fortnightly (0-1) or monthly (0-3) chore falls in
  const c = (id, name, minutes, freq, cat, extra) =>
    Object.assign({ id, name, minutes, freq, cat, owner: '', heavy: false, day: -1, offset: 0, notes: '' }, extra || {});

  const DEFAULT_CHORES = [
    // Daily
    c('kitchen-reset', 'Kitchen reset', 10, 'daily', 'neutral', {
      notes: 'Load and run the dishwasher, or unload it if it has finished. Wipe counters, hob and sink.' }),

    // Own rooms
    c('bedroom-a', 'Clean your bedroom', 20, 'weekly', 'neutral', { owner: 'A', notes: 'Tidy, dust surfaces, vacuum, empty the bin.' }),
    c('bedding-a', 'Change your bedding', 10, 'weekly', 'neutral', { owner: 'A' }),
    c('bedroom-b', 'Clean your bedroom', 20, 'weekly', 'neutral', { owner: 'B', notes: 'Tidy, dust surfaces, vacuum, empty the bin.' }),
    c('bedding-b', 'Change your bedding', 10, 'weekly', 'neutral', { owner: 'B' }),

    // Weekly shared
    c('bathroom-clean', 'Bathroom: toilet, sink, taps and floor', 20, 'weekly', 'disinfect', {
      notes: 'Spray toilet, sink and taps with disinfectant and leave for the time on the bottle before wiping. Mop the floor last.' }),
    c('shower-scrub', 'Scrub shower and tiles, clear plughole hair', 20, 'weekly', 'disinfect', { heavy: true,
      notes: 'Spray tiles, tray and screen, leave 5 minutes, scrub, rinse. Pull hair out of the plughole cover so it does not build into a clog.' }),
    c('mop-floors', 'Mop kitchen and dining floors', 15, 'weekly', 'disinfect'),
    c('high-touch', 'Disinfect handles, switches, remotes and dining table', 15, 'weekly', 'disinfect'),
    c('vacuum', 'Vacuum dining area and hallway', 15, 'weekly', 'neutral'),
    c('bins', 'Bins and recycling out, fresh liners', 10, 'weekly', 'neutral', {
      notes: 'Set a fixed day in the chore settings to match your bin collection.' }),
    c('porches', 'Sweep front and back porches, shake doormats', 15, 'weekly', 'neutral'),
    c('fridge-check', 'Fridge check: bin old food, tidy shelves', 10, 'weekly', 'organise'),
    c('declutter', 'Reset dining area and entrance: shoes, coats, post', 15, 'weekly', 'organise'),
    c('towels', 'Wash, fold and put away towels and tea towels', 15, 'weekly', 'organise'),
    c('restock', 'Restock loo roll, soap, sponges, dishwasher tablets', 10, 'weekly', 'organise', {
      notes: 'Note anything running low so it goes on the shopping list.' }),

    // Fortnightly
    c('shower-drain', 'Unclog the shower drain', 15, 'fortnightly', 'disinfect', { heavy: true, offset: 0,
      notes: 'Lift the drain cover and pull out hair with a drain snake or hair-grabber tool. Pour in half a cup of bicarbonate of soda, then a cup of white vinegar. Leave 10–15 minutes, then flush with hot water. A plughole hair catcher makes this much easier next time.' }),
    c('sink-drains', 'Clear and freshen kitchen and bathroom plugholes', 10, 'fortnightly', 'disinfect', { offset: 0,
      notes: 'Remove plugs and strainers, clean off build-up, then bicarbonate of soda and hot water down each drain.' }),
    c('bathmat', 'Wash bath mat and shower curtain, or clean the screen', 10, 'fortnightly', 'neutral', { offset: 0 }),
    c('dishwasher-filter', 'Clean dishwasher filter and spray arms', 10, 'fortnightly', 'disinfect', { offset: 1,
      notes: 'Twist out the filter at the bottom, rinse under the tap and scrub with an old toothbrush. Check the spray arm holes are clear.' }),
    c('microwave', 'Clean inside the microwave', 10, 'fortnightly', 'disinfect', { offset: 1,
      notes: 'Microwave a bowl of water with lemon or vinegar for 3 minutes, leave 2 minutes, then wipe.' }),
    c('mirrors', 'Clean mirrors and glass', 10, 'fortnightly', 'neutral', { offset: 1 }),
    c('cupboard', 'Organise one kitchen cupboard or drawer', 10, 'fortnightly', 'organise', { offset: 1 }),

    // Monthly (every 4 weeks)
    c('oven', 'Deep clean oven and hob', 25, 'monthly', 'disinfect', { heavy: true, offset: 0 }),
    c('dishwasher-cycle', 'Run an empty dishwasher cleaning cycle', 5, 'monthly', 'disinfect', { offset: 0 }),
    c('fridge-deep', 'Deep clean fridge: empty, wipe, reorganise', 20, 'monthly', 'organise', { heavy: true, offset: 1 }),
    c('showerhead', 'Descale shower head and taps', 10, 'monthly', 'disinfect', { offset: 1,
      notes: 'Soak the shower head in white vinegar (or tie a bag of vinegar round it) for 30 minutes while you do something else, then run hot water through it.' }),
    c('bin-wash', 'Wash and disinfect kitchen and outdoor bins', 15, 'monthly', 'disinfect', { heavy: true, offset: 2 }),
    c('porch-deep', 'Porches: wipe doors and furniture, clear cobwebs and leaves', 15, 'monthly', 'neutral', { offset: 2 }),
    c('skirting', 'Dust skirting boards, door frames and light shades', 15, 'monthly', 'neutral', { offset: 3 }),
    c('pantry', 'Organise food cupboards and check dates', 20, 'monthly', 'organise', { offset: 3 }),
  ];

  const mod = (n, m) => ((n % m) + m) % m;
  const other = (p) => (p === 'A' ? 'B' : 'A');

  function hash(s) {
    let h = 7;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return Math.abs(h);
  }

  function mondayOf(date) {
    const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    d.setDate(d.getDate() - mod(d.getDay() - 1, 7));
    return d;
  }
  function weekIndexOf(date) {
    const m = mondayOf(date);
    return Math.round((Date.UTC(m.getFullYear(), m.getMonth(), m.getDate()) - EPOCH_MS) / WEEK_MS);
  }
  function mondayOfWeek(w) {
    const d = new Date(EPOCH_MS + w * WEEK_MS);
    return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  }
  const dayIndexOf = (date) => mod(date.getDay() - 1, 7);

  function isDue(ch, w) {
    const p = PERIOD[ch.freq] || 1;
    return p === 1 || mod(w, p) === mod(Number(ch.offset) || 0, p);
  }

  function pickPerson(ch, w) {
    if (ch.owner === 'A' || ch.owner === 'B') return ch.owner;
    const occ = Math.floor(w / (PERIOD[ch.freq] || 1)); // how many times this chore has come round
    const h = hash(ch.id);
    const alternate = mod(occ + h, 2) === 0 ? 'A' : 'B';
    if (ch.heavy) return alternate;
    const pref = PREF[ch.cat];
    if (pref) return mod(occ + h, 4) === 3 ? other(pref) : pref;
    return alternate;
  }

  const minutesFor = (items, p) => items.reduce((s, i) => s + (i.person === p ? i.chore.minutes : 0), 0);

  // Move movable chores from the busier person to the quieter one until within 10 minutes.
  function balance(items) {
    for (let guard = 0; guard < 30; guard++) {
      const gap = minutesFor(items, 'A') - minutesFor(items, 'B');
      if (Math.abs(gap) <= 10) return;
      const from = gap > 0 ? 'A' : 'B';
      const to = other(from);
      const g = Math.abs(gap);
      // Prefer moving chores the receiver prefers, then general chores, then anything else.
      const rank = (i) => (PREF[i.chore.cat] === to ? 0 : PREF[i.chore.cat] ? 2 : 1);
      const options = items
        .filter((i) => i.person === from && !i.locked && i.chore.minutes < g)
        .sort((x, y) => rank(x) - rank(y)
          || Math.abs(g - 2 * x.chore.minutes) - Math.abs(g - 2 * y.chore.minutes)
          || x.key.localeCompare(y.key));
      if (!options.length) return;
      options[0].person = to;
    }
  }

  // Spread each person's chores over the week, never over the daily cap if it can be avoided.
  function pack(items) {
    for (const p of ['A', 'B']) {
      const mine = items.filter((i) => i.person === p);
      const used = [0, 0, 0, 0, 0, 0, 0];
      mine.filter((i) => i.day !== null).forEach((i) => { used[i.day] += i.chore.minutes; });
      const loose = mine.filter((i) => i.day === null)
        .sort((x, y) => y.chore.minutes - x.chore.minutes || x.key.localeCompare(y.key));
      for (const it of loose) {
        let best = -1;
        for (let d = 0; d < 7; d++) {
          if (used[d] + it.chore.minutes <= DAILY_CAP && (best < 0 || used[d] < used[best])) best = d;
        }
        if (best < 0) best = used.indexOf(Math.min(...used));
        it.day = best;
        used[best] += it.chore.minutes;
      }
    }
  }

  // Returns [{ key, chore, person: 'A'|'B', day: 0-6 }] for week index w.
  function buildWeek(chores, w) {
    const items = [];
    for (const ch of chores) {
      if (!ch || !ch.minutes) continue;
      const fixedOwner = ch.owner === 'A' || ch.owner === 'B';
      if (ch.freq === 'daily') {
        const h = hash(ch.id);
        for (let d = 0; d < 7; d++) {
          const person = fixedOwner ? ch.owner : (mod(d + w + h, 2) === 0 ? 'A' : 'B');
          items.push({ key: `${w}:${ch.id}:${d}`, chore: ch, person, day: d, locked: true });
        }
      } else if (isDue(ch, w)) {
        const day = Number(ch.day);
        const person = pickPerson(ch, w);
        const swapTurn = !!PREF[ch.cat] && person !== PREF[ch.cat]; // keep the variety week in place
        items.push({
          key: `${w}:${ch.id}`, chore: ch, person,
          day: day >= 0 && day <= 6 ? day : null,
          locked: fixedOwner || !!ch.heavy || swapTurn,
        });
      }
    }
    balance(items);
    pack(items);
    return items;
  }

  const api = { DAYS, DAILY_CAP, PERIOD, DEFAULT_CHORES, buildWeek, weekIndexOf, mondayOfWeek, dayIndexOf, hash };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Rota = api;
})(typeof window !== 'undefined' ? window : globalThis);
