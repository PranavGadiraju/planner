---
name: screentime
description: Turn an iPhone Screen Time screenshot (Settings > Screen Time, day view) into hourly phone-usage rows in planner via `planner screentime phone --day --hours`, reading only what the bars show and leaving unreadable hours out. Use when the user pastes a Screen Time screenshot, says "/screentime", or asks to log phone usage for a day.
---

# /screentime - log iPhone usage from a Screen Time screenshot

Availability: `planner screentime phone` arrives in **milestone 8**. Until then `bin/planner screentime phone`
exits 2 with "not available until milestone 8"; you can still read the screenshot and show the table, but say
clearly that posting is not possible yet. (Mac usage never goes through this path: the hourly LaunchAgent in
`mac/` pushes it automatically.)

## What the screenshot gives

The iPhone day view shows the daily total, one bar per hour (00-23 local, category-coloured segments), a
"Most Used" list with h/m per app, and pickups/notifications. There is no export; the only reliable numbers are
the **per-hour bar heights** and the **daily total**.

## Steps

1. **Identify the day** (the screenshot's date header, or ask) and confirm it is the *day* view, not the week view.
2. **Read each hour bar** as minutes (0-60) using the axis on the right. Write the local hour as the key:
   `{"7":12,"8":45,"9":60,...}`. Only include hours whose bar you can actually read; **omit unreadable hours**
   rather than guessing. Hours with no bar are 0 and may be omitted.
3. **Grey / unattributed time is Unknown**, never phone use: do not add it to any hour.
4. **Never spread "Most Used" apps across hours.** Per-app totals are daily totals only; mention them in the summary
   if useful, but the posted rows are per-hour totals (`app_id` `_total`).
5. **Sanity check**: the sum of your hourly minutes should be within about 5 minutes of the daily total printed at
   the top. If it is not, re-read the tallest bars, then show both numbers and let the user decide.
6. **Show the table** (hour -> minutes, plus the sum vs the printed total) and **ask before posting**.
7. **Post** (milestone 8+):

   ```sh
   planner screentime phone --day 2026-09-28 --hours '{"7":12,"8":45,"9":60}'
   ```

   The CLI converts local hours to UTC `hour_start` rows (`source='phone'`, `app_id='_total'`, seconds clamped to
   3600) and the Worker replaces that day's phone rows. On the day chart phone time only fills minutes nothing else
   already claims.

## Rules

- Never print, echo or edit tokens.
- Minutes per hour never exceed 60; a bar that touches the top is 60.
- If the screenshot is the *week* view, ask for the day view; weekly bars cannot be split into hours.
