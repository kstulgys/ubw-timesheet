# ubw-timesheet

Unit4 ERP (UBW, the product once sold as Agresso) keeps employee hours in a
web timesheet that takes many clicks per week. This repository is an
[agent skill](https://agentskills.io) plus a single-file Node.js CLI that
reads, fills, and submits that timesheet by sending the same form posts the
browser sends. A coding agent that loads `SKILL.md` files (Claude Code, Codex,
omp, and others) can book a week from one chat message. The CLI also works on
its own in a terminal.

After the one-time login the script needs no browser. It sends HTTP requests
to the timesheet screen and renews the session by itself.

## Requirements

- Node.js 18 or newer. The script has no npm dependencies.
- Chrome, Edge, or Brave on the machine, used once for the SSO login.
- A Unit4 account on a tenant that has the "Timesheets - standard" screen.
  The defaults point at Macaw's tenant (`nl_mcw_prod_web`, menu `TS1611`).
  See [Other tenants](#other-tenants) for anything else.

## Install

Clone the repository into the directory your agent scans for skills.
`~/.agents/skills` is the cross-agent location (Codex, omp, and others read
it). Claude Code reads `~/.claude/skills`; clone there too, or add a symlink.

```sh
git clone https://github.com/kstulgys/ubw-timesheet ~/.agents/skills/ubw-timesheet
ln -s ~/.agents/skills/ubw-timesheet ~/.claude/skills/ubw-timesheet   # Claude Code
```

For a project-scoped install, clone into `<repo>/.agents/skills/ubw-timesheet`.

Without an agent, clone anywhere and add an alias:

```sh
alias ubw='node ~/ubw-timesheet/scripts/ubw.mjs'
```

The examples below use `ubw` as the command name.

## Log in once

```sh
ubw login
```

A browser window opens on the Unit4 sign-in page. Sign in with your Microsoft
account, including the MFA prompt. When the timesheet home page loads, the
script copies the session cookies, closes the window, and prints your user id
and client. From then on the script renews the session on its own. Run
`login` again only when a command exits with code 2.

On a machine without a browser, paste the `Cookie` header of a logged-in
request instead: `ubw login --cookie "name=value; ..."`. Such a session
cannot renew itself and ends after 60 idle minutes.

## Ask your agent

With the skill installed, prompts like these work:

- "Log 4 hours on contoso and 4 on northwind for today."
- "Show my timesheet for last week."
- "Submit last week's timesheet."

The agent runs a fresh work-order search for each keyword, shows the matches
as numbered options, books the hours you choose as Draft, and sends the week
for approval only when you ask for it. The steps are in
[`SKILL.md`](SKILL.md).

## Use the CLI directly

Show a period. A date selects the period that contains it. A week that
crosses a month boundary is two periods.

```
$ ubw show 2026-09-01
Period 202643 (202643 (Sept start)): 2026-09-01 to 2026-09-06, status Ready (N), normal hours 32
workOrder     timecode  status  description                             Tue 9/1  Wed 9/2  Thu 9/3  Fri 9/4  Sat 9/5  Sun 9/6  sum
101012-10003  0         Closed  Contoso - Mobile sprint team            4.00     4.00     8.00     8.00     0.00     0.00     24.00
101375-10042  0         Ready   Northwind - Frontend | API integration  4.00     4.00     0.00     0.00     0.00     0.00     8.00
TOTAL                                                                   8.00     8.00     8.00     8.00     0.00     0.00     32.00
```

Find work orders. The server matches the longest word as a phrase against
code and description and returns at most 50 rows. The other words filter that
list.

```
$ ubw search northwind frontend
workOrder     description
101375-10042  Northwind - Frontend | API integration
101375-10043  Northwind - Frontend | CI/CD setup
```

Book hours. `set` adds the row when it is missing, saves the period as Draft,
and prints the row as the server stored it. The dates may fall in different
periods.

```
$ ubw set 101375-10042 2026-09-07=4 2026-09-08=4
Timesheet for Doe, Jane in period 202644 has been saved as a draft
workOrder     description                             status  09-07  09-08  09-09  09-10  09-11  09-12  09-13  sum
101375-10042  Northwind - Frontend | API integration  Draft   4.00   4.00   0.00   0.00   0.00   0.00   0.00   8.00
```

Send the week for approval after its last day:

```
$ ubw submit 2026-09-07
```

The server answers "has been sent for approval", and the next `show` reports
the period as Ready. `submit --draft` sets the rows back to Draft.

`ubw help` lists every command. `--json` on any command prints
machine-readable output. Exit code 2 means the session is gone and `login`
is needed.

## Draft and Ready

A period is Draft while you work on it, Ready after you send it for
approval, and Transferred after processing. `set` and `delete` save as Draft.
Only `submit` moves a period to Ready. Run it after the last day of the
period. The script refuses to change a Transferred period.

## Other tenants

Pass the tenant URL and the menu id of the timesheet screen on the first
login. The script stores them for later runs.

```sh
ubw login --url https://ubw.unit4cloud.com/<tenant> --menu TS1611
```

The menu id is the `menu_id` in the address bar when the timesheet is open.
Field ids differ per tenant, and the script reads them from the page, so you
do not need other settings.

## Where data lives

`~/.ubw-timesheet/` (or `$UBW_HOME`) holds `config.json` (tenant, client,
user id), `session.json` (cookies, mode 0600), and `browser-profile/` (the
private profile the login window uses). `ubw logout` deletes all three.

The script sends requests to `*.unit4cloud.com` only. The browser in the
login window is the only thing that contacts Microsoft. Silent renewal talks
to Unit4 Identity Services and never causes an MFA prompt. When Unit4 wants
Microsoft again, the script stops with exit code 2 and asks for `login`.

| Variable | Effect |
| --- | --- |
| `UBW_HOME` | Data directory instead of `~/.ubw-timesheet`. |
| `UBW_BROWSER` | Path to the browser executable when the script finds none. |
| `UBW_DEBUG` | Directory. The script writes every page it receives there. |

## Status

Tested in September 2026 on Linux with Chrome 152 against `nl_mcw_prod_web`:
login, silent renewal, `show`, `search`, `set` (new and existing rows),
`delete`, and the guards on Transferred periods. `submit` replays
the request sequence recorded from the web UI and has not run from the script
yet. Browser discovery for Windows and macOS is in the script, but nobody has
run it yet.

## When Unit4 changes the screen

[`PROTOCOL.md`](PROTOCOL.md) documents the requests, field names, and markup
the script depends on, and how to record new traffic.

## License

MIT
