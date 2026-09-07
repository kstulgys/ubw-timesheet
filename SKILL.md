---
name: ubw-timesheet
description: Read, fill, and submit Unit4 ERP (UBW, Agresso) timesheets through a CLI that talks to the timesheet screen directly. Use when the user wants to log hours on work orders, see a week's timesheet, submit a week for approval, or log in to Unit4 for the first time.
---

# Unit4 timesheets

The Unit4 web UI is slow to click through. `scripts/ubw.mjs` sends the same
requests the UI sends and prints the result. Node 18 or newer, no packages.

Run every command as `node <this skill dir>/scripts/ubw.mjs <command>`; add
`--json` when you need to parse the output.

## Vocabulary

- **Period**: the unit a timesheet is saved in. Usually one Monday-to-Sunday
  week, but a week that crosses a month boundary is split in two periods
  ("Aug end", "Sept start"). `show` prints the period's dates.
- **Work order**: what hours are booked on, code like `101012-10003`. Each
  timesheet row is one work order plus a time code (`0` = normal hours).
- **Status**: `Draft` (editable), `Ready` (sent for approval; rows show
  `Ready` or `Closed`), `Transferred` (processed). Change Draft rows only.

## Steps

1. **Check the session.** Run `whoami`. The tool renews an idle session by
   itself, without prompting anyone. Exit code 2 means renewal failed: run
   `login`, tell the user a browser window opened and that Microsoft may ask
   for MFA, and wait until the command prints their `userId`.
2. **Read the period.** Run `show <YYYY-MM-DD>` for a date in the target
   period (`show today` for the current one). Done when you have the period's
   dates, its status, and every row with its hours.
3. **Let the user pick the work orders.** For each project keyword the user
   gives, run `search <keyword>` now, in this turn; the list changes over
   time, so never reuse a list from an earlier turn or from memory. Present
   the matches as numbered options with code and description, mark the one
   the user booked most recently (from `show` of the previous period), and
   wait for the choice. An empty result usually means the keyword is spelled
   differently in Unit4 (`vwfs` is listed as `VWPFS`): retry with a shorter
   stem such as the first two or three letters. When the output says the
   server capped the list, add a second word to narrow it.
4. **Book the hours.** One `set <work-order> <date>=<hours> ...` per work
   order. The command adds the row when it is missing, saves as Draft, and
   prints the saved row. Done when every requested day shows the requested
   hours and the printed total for the period matches what the user expects.
5. **Submit only on request.** `submit <date>` marks every row of the period
   Ready and sends it for approval. Do this only when the user asks for it,
   the period has ended, and the user has confirmed the totals from `show`.
   Done when the output says "sent for approval".

## Commands

| Command | Effect |
| --- | --- |
| `login` | Renews silently when it can; otherwise opens a browser for SSO. `--url` and `--menu` override the tenant defaults; `--fresh` forces the window. |
| `whoami` | Prints user, client, and minutes left in the session. |
| `show [DATE]` | Period, days, rows, totals. Default `today`. |
| `search WORDS` | Fresh server lookup of work orders; keeps rows whose code or description contain every word. Server returns at most 50 matches for the longest word. |
| `set WO DATE=H [DATE=H ...]` | Writes hours on the work order's row and saves as Draft. `--timecode` for non-normal hours. Dates may span periods. |
| `delete WO DATE` | Removes the work order's row from DATE's period and saves. |
| `submit [DATE] [--draft]` | Ready + save (sends for approval). `--draft` sets rows back to Draft. |
| `logout` | Forgets the stored session and browser profile. |

## When something fails

- Exit code 2: the session is gone and silent renewal failed. Run `login`;
  the user signs in once (with MFA) in the window that opens.
- "not editable": the row is Closed or Transferred. Report it; do not retry.
- No browser found: set `UBW_BROWSER` to a Chrome, Edge, or Brave executable,
  or run `login --cookie "<Cookie header of a logged-in request>"`.
- Parse errors or wrong values: Unit4 changed the screen. `PROTOCOL.md`
  documents the requests and markup the script relies on and how the traffic
  was captured, so you can fix `scripts/ubw.mjs`.
