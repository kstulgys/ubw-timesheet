# ubw-timesheet

Unit4 ERP (UBW, the product once sold as Agresso) keeps employee hours in a
web timesheet that takes many clicks per week. This repository is an
[agent skill](https://agentskills.io) for coding agents that load `SKILL.md`
files (Claude Code, Codex, omp, and others). With it installed, you tell your
agent which hours go where, and the agent books them by sending the same form
posts the browser sends. You never run a command yourself: the agent opens a
browser window once for the sign-in and keeps the session alive after that.

## Requirements

- Node.js 18 or newer on the machine that runs the agent. The script has no
  npm dependencies.
- Chrome, Edge, or Brave, used once for the sign-in.
- A Unit4 account on a tenant with the "Timesheets - standard" screen. The
  defaults point at Macaw's tenant. On another tenant, tell the agent the
  tenant URL and the menu id of the timesheet screen the first time (the
  `menu_id` in the address bar when the timesheet is open).

## Install

Clone the repository into the directory your agent scans for skills.
`~/.agents/skills` is the cross-agent location (Codex, omp, and others read
it). Claude Code reads `~/.claude/skills`; clone there too, or add a symlink.

```sh
git clone https://github.com/kstulgys/ubw-timesheet ~/.agents/skills/ubw-timesheet
ln -s ~/.agents/skills/ubw-timesheet ~/.claude/skills/ubw-timesheet   # Claude Code
```

For a project-scoped install, clone into `<repo>/.agents/skills/ubw-timesheet`.

## First use

Ask your agent for your timesheet. When no session is stored, or when Unit4
wants a new sign-in, the agent says so and a browser window opens on the
Unit4 sign-in page. Sign in with your Microsoft account, including the MFA
prompt. The window closes by itself when the timesheet loads, and the agent
continues with your request. Later requests renew the session silently, with
no MFA prompt, until Unit4 asks for Microsoft again.

## What to ask

- "Log 4 hours on contoso and 4 on northwind for today."
- "Show my timesheet for last week."
- "Which work orders did I book last week?"
- "Submit last week's timesheet."

For each project keyword, the agent searches the work-order list at that
moment, shows the matches as numbered options, and books the hours on the
option you pick. The keyword does not need to match the name in Unit4
exactly; the agent retries with a shorter stem.

The agent saves hours as Draft. It sends a period for approval only when you
ask, after the period's last day. A week that crosses a month boundary is two
periods, so "last week" can mean two of them. Transferred periods cannot be
changed.

## Where data lives

`~/.ubw-timesheet/` holds the tenant settings, the session cookies (file mode
0600), and the private browser profile the sign-in window uses. Ask the agent
to log out of Unit4 to delete the cookies and the profile.

The script sends requests to `*.unit4cloud.com` only. The browser in the
sign-in window is the only thing that contacts Microsoft. Session renewal
talks to Unit4 Identity Services and never causes an MFA prompt.

## Status

Tested in September 2026 on Linux with Chrome 152 against Macaw's tenant:
sign-in, session renewal, reading periods, work-order search, booking hours on
new and existing rows, removing a row, and the guards on transferred periods.
Sending a period for approval replays the request sequence recorded from the
web UI and has not run from the script yet. Browser discovery for Windows and
macOS is in the script, but nobody has run it yet.

## For maintainers

[`SKILL.md`](SKILL.md) holds the steps the agent follows and the commands of
`scripts/ubw.mjs`. [`PROTOCOL.md`](PROTOCOL.md) documents the requests, field
names, and markup the script depends on, and how to record new traffic when
Unit4 changes the screen.

## License

MIT
