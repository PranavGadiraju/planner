---
name: label
description: Turn a nutrition-label photo (or typed label numbers) into a per-100 g food in planner via `planner food add --json`, with serving-gram handling, the 4/4/9 sanity check and an explicit confirmation before posting. Use when the user pastes a food label, says "/label", or asks to add a food from a package.
---

# /label - add a food from a nutrition label

Availability: `planner food add` and `planner eat` are live (`planner food add --help` prints the flags). Exit
code 1 means the Worker could not be reached or the token was rejected: report the error as printed and stop;
never retry with another token or edit where tokens live.

## Steps

1. **Read the label.** From the photo or text take: product name, brand (if printed), serving size as printed
   (e.g. "2/3 cup (55 g)"), and per-serving kcal, protein, carbs, fat, plus fiber and total sugars when printed.
   Read each digit as printed. **Never invent or "correct" a digit**; if a number is unreadable, ask.
2. **Serving grams.** Use the gram (or mL treated as g for water-like liquids) figure printed next to the household
   measure. If only a household measure is printed ("1 cup", "3 pieces") with no grams, **ask the user to weigh a
   serving** and wait for the number. Do not guess a gram weight.
3. **Per-100 g math.** factor = 100 / serving_g; multiply every per-serving value by the factor and round to 0.1.
   (Same formula as `per100FromServing` in `src/shared/nutrition.ts`.) If the label already prints per-100 g
   values, use those directly and skip the conversion.
4. **4/4/9 check.** implied = 4 x protein + 4 x carbs + 9 x fat (per serving). Flag, but never block, when
   |implied - kcal| > max(15 % of kcal, 25 kcal). A flag usually means fiber/sugar-alcohol accounting or a misread
   digit; re-read the digits once before showing the table.
5. **Show the table** and wait for confirmation. Format:

   | | per serving (55 g) | per 100 g |
   |---|---|---|
   | kcal | 210 | 381.8 |
   | protein g | 6 | 10.9 |
   | carbs g | 40 | 72.7 |
   | fat g | 3 | 5.5 |
   | fiber g | 4 | 7.3 |
   | sugar g | 12 | 21.8 |

   plus the name, brand, serving text, and the 4/4/9 line ("implied 211 kcal vs 210 on label - ok" or "FLAG: ...").
   **Ask "Post this?" and post only after an explicit yes.**
6. **Post**: one call to

   ```sh
   planner food add --json '{"name":"...","brand":"...","serving_g":55,"serving_text":"2/3 cup (55 g)","per_serving":{"kcal":210,"protein_g":6,"carb_g":40,"fat_g":3,"fiber_g":4,"sugar_g":12},"label_json":{...raw numbers as read...}}'
   ```

   The Worker converts to per-100 g, stores `source='claude'` (badged "from Claude" in the app) and returns the
   stored row plus any 4/4/9 warning. Print the returned id and the per-100 g values.
7. Offer `planner eat --food <id> --grams <n>` to log it now.

## Rules

- Never print, echo or edit tokens (`PLANNER_TOKEN`, Keychain items, `.dev.vars`, `wrangler secret`).
- One food per call; a multi-product photo is several rounds of steps 1-6.
- Mixed units: kcal only (convert kJ / 4.184 if a label prints only kJ and say so).
