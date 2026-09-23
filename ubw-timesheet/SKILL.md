---
name: ubw-timesheet
description: Read, fill, and submit Unit4 ERP (UBW, Agresso) timesheets by working the Unit4 web screen in a real browser through agent-browser. Use when the user wants to log hours on work orders, see a week's timesheet, submit a week for approval, or log in to Unit4 for the first time.
license: MIT
---

# Unit4 timesheets

The Unit4 web UI is slow to click through. `scripts/ubw.mjs` does the clicking
for you: it drives a real browser through the
[agent-browser](https://github.com/vercel-labs/agent-browser) CLI, presses the
buttons of the "Timesheets - standard" screen, and types into its fields, the
way a person does. Unit4 computes values such as the invoice value only in
its own screen events, so hours must go in through the screen and never
through direct HTTP requests. The user talks to you in plain language and
never runs a command; you run every command, including the sign-in.

Run every command as `node <this skill dir>/scripts/ubw.mjs <command>`; add
`--json` when you need to parse the output. Invoked without a request, do
steps 1 to 3 for today and report the period.

## Rules

- Change the timesheet only through `ubw.mjs` or through clicks and
  keystrokes in the Unit4 screen with agent-browser. Never send requests to
  `unit4cloud.com` yourself (no `curl`, `fetch`, or form posts), and never
  copy cookies out of the browser.
- The script opens and closes its own agent-browser session
  (`ubw-timesheet`). When you open that session yourself, close it again
  before you yield.
- Save nothing that the user did not ask for. When you work the screen by
  hand, ask the user before you press Save or Ready.

## Vocabulary

- **Period**: the unit a timesheet is saved in. Usually one Monday-to-Sunday
  week, but a week that crosses a month boundary is split in two periods
  ("Aug end", "Sept start"). `show` prints the period's dates.
- **Work order**: what hours are booked on, code like `101012-10003`. Each
  timesheet row is one work order with time code `0` (normal hours).
- **Status**: `Draft` (editable), `Ready` (sent for approval; rows show
  `Ready` or `Closed`), `Transferred` (processed). Change Draft rows only.
  The period carries a status of its own, above the rows: approval needs the
  period status at `Ready` as well, and `show` prints it on the first line.
- **Inv.value**: the invoice value of a row, shown in the row's details (the
  Zoom button). It must equal the row's `Sum`; `check` compares them.

## Steps

1. **Have agent-browser.** Read the agent-browser skill first: `skill://agent-browser`
   when your harness offers it, otherwise run `agent-browser skills get core`.
   When `agent-browser --version` fails (or a command exits with code 3),
   install it for the user: `npm install -g agent-browser`, then
   `agent-browser install` (on Linux `agent-browser install --with-deps`,
   which may ask for the user's password; tell the user first). Node.js 24 or
   newer is needed for both. Done when `agent-browser --version` prints a
   version.
2. **Check the session.** Run `whoami`. Unit4 renews an idle session by
   itself, without prompting anyone. Exit code 2 means the user has to sign
   in once: tell the user that a browser window opens now for the Unit4
   sign-in and that Microsoft may ask for MFA, then run `login` yourself with
   a timeout of at least five minutes (when your shell cannot wait that long,
   start `login` in the background and poll `whoami` until it exits 0). Done
   when `whoami` prints the user's `userId`.
3. **Read the period.** Run `show <YYYY-MM-DD>` for a date in the target
   period (`show today` for the current one). Done when you have the period's
   dates, its status, and every row with its hours.
4. **Let the user pick the work orders.** For each project keyword the user
   gives, run `search <keyword>` now, in this turn; the list changes over
   time, so never reuse a list from an earlier turn or from memory. Present
   the matches as numbered options with code and description, mark the one
   the user booked most recently (from `show` of the previous period), and
   wait for the choice. An empty result usually means the keyword is spelled
   differently in Unit4 (`vwfs` is listed as `VWPFS`): retry with a shorter
   stem of at least four letters. When Unit4 says "Too many values", use a
   longer word.
5. **Book the hours.** One `set <work-order> <date>=<hours> ...` per work
   order. The command adds the row when it is missing, types each day's
   hours, saves as Draft, reloads the period, and checks the hours and
   `Inv.value` of the row. Done when the command exits 0, every requested day
   shows the requested hours, and the printed total matches what the user
   expects.
6. **Submit only on request.** `submit <date>` marks every row, presses
   Ready, sets the period status to Ready, and saves, which sends the period
   for approval. Do this only when the user asks for it, the period has
   ended, the user has confirmed the totals from `show`, and `check <date>`
   reports every row `ok`. `submit <date> --dry-run` does every step except
   Save. Done when the first line of the output reads `status Ready (N)` and
   every row shows `Ready`.

## Commands

| Command | Effect |
| --- | --- |
| `login` | Opens a browser window on Unit4 and waits until the user has signed in; closes it by itself when the session is still valid. `--url` and `--menu` override the tenant defaults when the user names another tenant; `--fresh` forgets the stored session first. |
| `whoami` | Prints user id, name, tenant, and the current period. |
| `show [DATE]` | Period, days, rows, totals. Default `today`. |
| `search WORDS` | Types the longest word into the work-order field of a new row and reads the drop-down list; keeps entries whose code or description contain every word. The row is never saved. |
| `set WO DATE=H [DATE=H ...]` | Types hours on the work order's row (adds the row when missing), saves as Draft, and verifies hours and `Inv.value`. Normal hours (time code `0`) only. Dates may span periods. |
| `delete WO DATE` | Marks the work order's row, presses Delete, and saves. |
| `submit [DATE] [--dry-run] [--label L]` | Rows Ready + period Ready + Save (sends for approval). `--label` is the Status label when the screen is not in English. |
| `check [DATE]` | Opens each row's details and compares `Sum` with `Inv.value`. Exit 1 when a row differs. |
| `logout` | Forgets the stored browser session. |

Exit codes: 0 ok, 1 error, 2 sign-in needed, 3 agent-browser missing.

## When something fails

- Exit code 3: agent-browser is missing. Install it (step 1) and run the
  command again.
- Exit code 2: the session is gone. Run `login` yourself; the user signs in
  once (with MFA) in the window that opens.
- "not editable": the row is Closed or Transferred. Report it; do not retry.
- "saved with Sum ... but Inv.value ...", or `check` reports `NO`: the hours
  are saved, but the project would invoice the wrong amount. Stop booking and
  tell the user which row and period it is. Do not submit the period. The
  user can correct the row in the Unit4 web UI: retype one day's hours, save,
  and check that `Inv.value` in the row's details equals the row's `Sum`.
- "not found on the timesheet screen", timeouts, or parse errors: Unit4
  changed the screen. `SCREEN.md` maps the elements the script uses. Look at
  the screen with agent-browser (`snapshot`, `screenshot`) to see what
  changed, report it to the user, and fix `scripts/ubw.mjs` only by changing
  which element it clicks or types into.
