# Homebase

Homebase is a phone-friendly household app. It starts as a chore tracker for two people, hosted free on GitHub Pages.

- **Today** shows each person's chores for the day (never more than 30 minutes), plus anything left from earlier in the week.
- **Week** shows the full week for both people, with progress. Use the arrows to look ahead.
- **Chores** lets you edit, add or delete chores: minutes, frequency, type, fixed day (e.g. bin day), and how-to notes.
- **Settings** covers names, whose phone it is, sync and backups.

## How the rota works

The rota is calculated from the date, so both phones always show the same assignments. Only the ticks need syncing.

| Rule | Effect |
|---|---|
| Daily kitchen reset | Alternates day by day; the pattern flips weekly so nobody always gets 4 days |
| Own bedroom and bedding | Always the owner |
| Disinfecting chores | Person A 3 weeks in 4, person B takes a turn the 4th week |
| Organising chores | Person B 3 weeks in 4, person A takes a turn the 4th week |
| Daunting chores (shower scrub, shower drain, oven, deep fridge, bin wash) | Strictly take turns every time they come round |
| General chores | Alternate, then shuffled to keep both people's weekly minutes within 10 of each other |
| Daily limit | Each person's chores are spread so no day goes over 30 minutes |

Tested over two years of weeks with the default list: no day over 30 minutes, weekly totals within 5 minutes of each other (about 3 hours each).

If you add chores and a day goes over 30 minutes, the Week view shows it in red. Shorten or remove something, or make it less frequent.

## Covering and reassigning

- **Covering for someone:** tick any task on either person's list. The minutes count towards whoever ticked it (the phone's owner), and the task shows "done by …". The Week view shows each person's minutes done, including time spent covering.
- **Reassigning:** tap a task's name (or **Reassign**) to move it to the other person or another day. This changes that one task only; the rota carries on as normal the following week. **Back to rota** undoes it.
- **Correcting a tick:** the same screen has a **Done?** box, so if a task was ticked on the wrong phone you can change who gets the credit.

To change a chore permanently, edit it in the **Chores** tab instead (for example, set **Who** to always one person).

## 1. Put the app online (GitHub Pages)

1. On GitHub, create a new **public** repository called `homebase`. (Pages is only free on public repos. No chore data is stored here.)
2. Click **Add file → Upload files** and drag in `index.html`, `rota.js` and `app.js`. Commit.
3. Go to **Settings → Pages**. Under *Build and deployment*, choose **Deploy from a branch**, branch `main`, folder `/ (root)`. Save.
4. After a minute or two, the app is live at `https://YOUR-USERNAME.github.io/homebase/`.

At this point the app works, but ticks stay on each phone. Step 2 makes them shared.

## 2. Share ticks between both phones

Ticks and chore edits are saved to a JSON file in a **private** repo, using the GitHub API.

1. Create a new **private** repository called `homebase-data`. Tick **Add a README file** so the `main` branch exists.
2. Create a token: profile picture → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
   - Repository access: **Only select repositories** → `homebase-data`
   - Permissions: **Contents → Read and write** (Metadata read-only is added automatically)
   - Set an expiry and put a reminder in your calendar to renew it.
3. On each phone, open the app, go to **Settings → Sync between phones**, and enter your username, `homebase-data`, and the token. Tap **Save and sync**.

The dot in the top corner shows sync status: green synced, amber syncing, red failed (tap it to retry, or check Settings for the reason). The app pulls changes when opened and every minute while open.

**About the token:** it can only read and write that one private repo, and it's stored in each phone's browser. Share it with your housemate privately (not in a group chat). If a phone is lost, delete the token on GitHub and make a new one.

## 3. Add logins

1. Once sync works on one device, go to **Settings → Logins**. Enter a password for each person (twice each) and tap **Create login file**. This downloads `config.js`.
2. Upload `config.js` to the app repo, next to `index.html` (replace any older one).
3. From then on, the link shows a login box. Each person logs in with their own password, on any phone or laptop, and Homebase knows who they are: ticks are credited to whoever is logged in. The header shows who's logged in, and tapping it logs out.

Nobody needs the GitHub token on their phone; logging in sets up sync automatically.

**How it works:** `config.js` holds the sync details (including the token) encrypted twice with AES-256, once with each person's password (keys derived with 600,000 rounds of PBKDF2). Whichever copy your password opens tells the app who you are. Without either password the file is unreadable, so it's safe in a public repo.

**What it does and doesn't protect:**
- Your data (names, ticks, edits) lives in the private repo and is only reachable after logging in.
- It's a household login, not a security boundary between the two of you: both logins unlock the same data, and either person can still mark a task as done by the other in the task screen (useful for fixing mistakes).
- The code and default chore list in the public repo are readable by anyone. Don't put anything personal in the code files.
- Because `config.js` is public, someone could try guessing passwords offline. Use 12+ characters each; four random words is plenty.
- "Keep me logged in on this device" skips the login next time. Untick it on shared devices.
- To change a password or the token, create a new login file and replace `config.js`. Everyone logs in again.
- An older single-password `config.js` still works as before, with "This phone belongs to" in Settings.

## 4. Add it to your home screen

- **iPhone (Safari):** Share → **Add to Home Screen**
- **Android (Chrome):** ⋮ menu → **Add to Home screen** or **Install app**

## Files

| File | What it does |
|---|---|
| `index.html` | Layout, styles and the chore editor |
| `config.js` | Optional. Encrypted logins and sync settings, created in Settings → Logins |
| `rota.js` | Default chore list and the scheduling rules. No browser code, so you can test it with Node |
| `app.js` | Screens, ticking, editing, sync and backups |

To change the default chores, edit `DEFAULT_CHORES` in `rota.js`. Existing phones keep their saved list until you use **Settings → Reset chores to defaults**.

## Next: cooking rota and shopping list

The saved data already includes empty `meals` and `ingredients` lists, and sync merges them, so the next stage can be added without a migration. A suggested shape:

```json
{
  "ingredients": [{ "id": "onion", "name": "Onion", "unit": "", "aisle": "Veg" }],
  "meals": [{
    "id": "chilli", "name": "Chilli", "servings": 4,
    "items": [{ "ingredient": "onion", "qty": 1 }, { "ingredient": "mince", "qty": 500 }]
  }],
  "mealPlan": { "143": { "0": { "meal": "chilli", "cook": "A" } } }
}
```

The shopping list for a week would then add up `items` across the planned meals, scaled by servings and grouped by aisle, plus anything flagged by the weekly restock chore. Cooking could go on the same rota by treating "Cook dinner" as a chore whose minutes count towards a separate cooking allowance rather than the 30-minute cleaning limit.
