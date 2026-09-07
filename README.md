# ubw-timesheet

Unit4 ERP (UBW, the product once sold as Agresso) keeps employee hours in a
web timesheet that takes many clicks per week. This repository is an
[agent skill](https://agentskills.io) for coding agents that load `SKILL.md`
files: GitHub Copilot (CLI, VS Code, and JetBrains agent mode), Claude Code,
Codex, omp, and others. With it installed, you tell your agent which hours go
where, and the agent books them by sending the same form posts the browser
sends. You never run a command yourself: the agent opens a browser window
once for the sign-in and keeps the session alive after that.

## Requirements

- Windows, macOS, or Linux with Node.js 18 or newer on the machine that runs
  the agent. The script has no npm dependencies.
- Chrome, Edge, or Brave, used once for the sign-in.
- A Unit4 account on a tenant with the "Timesheets - standard" screen. The
  defaults point at Macaw's tenant. On another tenant, tell the agent the
  tenant URL and the menu id of the timesheet screen the first time (the
  `menu_id` in the address bar when the timesheet is open).

## Install

Paste this into your agent (GitHub Copilot, Claude Code, Codex, or another
agent that runs commands for you):

> Install the agent skill from https://github.com/kstulgys/ubw-timesheet by
> following the "Instructions for agents" section of its README, then show me
> my Unit4 timesheet for this week.

The agent downloads the skill into its skills folder, checks that Node.js is
present, and starts the sign-in below the first time you ask for the
timesheet. From then on, ask for your hours in plain words.

## First use

When no session is stored, or when Unit4 wants a new sign-in, the agent says
so and a browser window opens on the Unit4 sign-in page. Sign in with your
Microsoft account, including the MFA prompt. The window closes by itself when
the timesheet loads, and the agent continues with your request. Later
requests renew the session silently, with no MFA prompt, until Unit4 asks for
Microsoft again.

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
web UI and has not run from the script yet.

A smoke test runs in GitHub Actions on Windows, macOS, and Linux with Node 18
and 22. It covers what differs per operating system: browser discovery, the
pipe the script uses to talk to the browser, reading cookies from it, and
starting the script through a symlink or junction. The sign-in window itself
has been used on Linux only.

## For maintainers

[`ubw-timesheet/SKILL.md`](ubw-timesheet/SKILL.md) holds the steps the agent
follows and the commands of `ubw-timesheet/scripts/ubw.mjs`.
[`ubw-timesheet/PROTOCOL.md`](ubw-timesheet/PROTOCOL.md) documents the
requests, field names, and markup the script depends on, and how to record
new traffic when Unit4 changes the screen. `node test/smoke.mjs` runs the
platform checks on any machine with a Chromium browser.

## Instructions for agents

You were asked to install this skill. Do the steps in order and report each
result in one line.

1. **Pick the skills directory** of the agent you are, under the user's home
   directory (`~`; on Windows `%USERPROFILE%`): GitHub Copilot
   `~/.copilot/skills`, Claude Code `~/.claude/skills`, every other agent
   (Codex, omp, ...) `~/.agents/skills`. Create it when it is missing. Done
   when the directory exists.
2. **Download the skill.** With GitHub CLI 2.90 or newer installed, run
   `gh skill install kstulgys/ubw-timesheet ubw-timesheet --scope user` (add
   `--agent claude-code` or `--agent codex` when you are that agent).
   Otherwise clone `https://github.com/kstulgys/ubw-timesheet` into a
   temporary directory (without git, download and extract
   `https://github.com/kstulgys/ubw-timesheet/archive/refs/heads/main.zip`)
   and copy its `ubw-timesheet` folder to `<skills directory>/ubw-timesheet`.
   Done when `<skills directory>/ubw-timesheet/SKILL.md` and
   `<skills directory>/ubw-timesheet/scripts/ubw.mjs` exist.
3. **Check Node.js.** Run `node --version`. Done when it prints version 18 or
   newer. When `node` is missing or older, install the current LTS release
   (Windows: `winget install OpenJS.NodeJS.LTS`; macOS: `brew install node`;
   Linux: the distribution package or https://nodejs.org) and run
   `node --version` again in a new shell.
4. **Use the skill now.** Read `<skills directory>/ubw-timesheet/SKILL.md`
   and follow it for the rest of the user's request. Later sessions load the
   skill on their own.

## License

MIT
