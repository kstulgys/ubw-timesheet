# ubw-timesheet

Unit4 ERP (UBW, the product once sold as Agresso) keeps employee hours in a
web timesheet that takes many clicks per week. This repository is an
[agent skill](https://agentskills.io) for coding agents that load `SKILL.md`
files: GitHub Copilot (CLI, VS Code, and JetBrains agent mode), Claude Code,
Codex, omp, and others. With it installed, you tell your agent which hours go
where, and the agent books them in the Unit4 screen itself: it drives a real
browser through [agent-browser](https://agent-browser.dev), clicks the
screen's buttons, and types into its fields, the way you would. You never run
a command yourself. The agent opens a browser window once for the sign-in and
keeps the session after that.

> **Warning:** versions before 23 September 2026 sent form posts straight to
> Unit4 instead of working the screen. Those posts skipped the screen events
> in which Unit4 computes the invoice value (`Inv.value` in a row's details),
> so the hours were saved with an invoice value of 0. The timesheet looked
> right, but the project reports showed negative invoice hours, and finance
> had to correct those weeks by hand with help from Unit4 support. The
> current version types every value into the screen and checks `Inv.value`
> after each save. No week booked this way has gone through approval and
> transfer yet. Ask your finance or project team before you book real hours
> with this skill.

## Requirements

- Windows, macOS, or Linux with Node.js 24 or newer on the machine that runs
  the agent (agent-browser needs 24; the skill's script itself has no npm
  dependencies).
- [agent-browser](https://agent-browser.dev), which brings its own Chrome.
  The agent installs it when it is missing (`npm install -g agent-browser`,
  then `agent-browser install`).
- A Unit4 account on a tenant with the "Timesheets - standard" screen. The
  defaults point at Macaw's tenant. On another tenant, tell the agent the
  tenant URL and the menu id of the timesheet screen the first time (the
  `menu_id` in the address bar when the timesheet is open).

## Install

Copy this prompt (the button in the top right corner of the box) and paste it
into your agent (GitHub Copilot, Claude Code, Codex, or another agent that
runs commands for you):

```text
Install the agent skill from https://github.com/kstulgys/ubw-timesheet by following the "Instructions for agents" section of its README, then show me my Unit4 timesheet for this week.
```

The agent downloads the skill into its skills folder, checks Node.js and
agent-browser, and starts the sign-in below the first time you ask for the
timesheet. From then on, ask for your hours in plain words.

## First use

When no session is stored, or when Unit4 wants a new sign-in, the agent says
so and a browser window opens on the Unit4 sign-in page. Sign in with your
Microsoft account, including the MFA prompt. The window closes by itself when
the timesheet loads, and the agent continues with your request. Later
requests run in a hidden browser and renew the Unit4 session without any
prompt, until Unit4 asks for Microsoft again. A hidden browser never opens
the Microsoft page, so it never sends an MFA prompt to your phone.

## What to ask

- "Log 4 hours on contoso and 4 on northwind for today."
- "Show my timesheet for last week."
- "Which work orders did I book last week?"
- "Check the invoice values of last week."
- "Submit last week's timesheet."

For each project keyword, the agent types the keyword into the work-order
field, shows the entries the field lists as numbered options, and books the
hours on the option you pick. The keyword does not need to match the name in
Unit4 exactly; the agent retries with a shorter stem.

The agent saves hours as Draft. After each save it reloads the week and
compares each row's hours with its invoice value. It sends a period for
approval only when you ask, after the period's last day. A week that crosses
a month boundary is two periods, so "last week" can mean two of them.
Transferred periods cannot be changed.

## Where data lives

`~/.ubw-timesheet/` holds the tenant settings and `browser-state.json`, the
cookies of the browser session (file mode 0600). Ask the agent to log out of
Unit4 to delete them.

The browser talks to `*.unit4cloud.com` and, during the sign-in window only,
to Microsoft. The script sends no requests of its own.

## Status

Tested in September 2026 on Linux with agent-browser 0.38 against Macaw's
tenant, on a Draft week that was emptied again afterwards: reading periods,
work-order search, booking hours on new and existing rows, removing a row,
the invoice-value check, the guards on Transferred periods, `submit
--dry-run`, and `login` with a still-valid session. Not yet run: a real
`submit`, a sign-in with Microsoft and MFA through `login`, and a week
booked this way going through approval and transfer.

A smoke test runs in GitHub Actions on Windows, macOS, and Linux with Node 24.
It covers what differs per operating system: starting the script through a
symlink or junction, starting agent-browser, and the guard that stops a
hidden browser at the Microsoft sign-in page.

## For maintainers

[`ubw-timesheet/SKILL.md`](ubw-timesheet/SKILL.md) holds the steps the agent
follows and the commands of `ubw-timesheet/scripts/ubw.mjs`.
[`ubw-timesheet/SCREEN.md`](ubw-timesheet/SCREEN.md) maps the elements of the
timesheet screen that the script clicks, types into, and reads, and says how
to look at the screen when Unit4 changes it. `node test/smoke.mjs` runs the
platform checks on any machine with agent-browser installed.

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
   temporary directory, or without git download and extract
   `https://github.com/kstulgys/ubw-timesheet/archive/refs/heads/main.zip`
   (it extracts to a folder named `ubw-timesheet-main`). The skill is the
   inner `ubw-timesheet` folder, the one that contains `SKILL.md`; copy that
   folder, not the repository root, to `<skills directory>/ubw-timesheet`.
   Done when `<skills directory>/ubw-timesheet/SKILL.md` and
   `<skills directory>/ubw-timesheet/scripts/ubw.mjs` exist.
3. **Check Node.js.** Run `node --version`. Done when it prints version 24 or
   newer. When `node` is missing or older, install the current LTS release
   (Windows: `winget install OpenJS.NodeJS.LTS`; macOS: `brew install node`;
   Linux: the distribution package or https://nodejs.org) and run
   `node --version` again in a new shell.
4. **Install agent-browser.** Run `agent-browser --version`. When it fails,
   run `npm install -g agent-browser`, then `agent-browser install` (on Linux
   `agent-browser install --with-deps`, which may ask for the user's
   password). Done when `agent-browser --version` prints a version.
5. **Use the skill now.** Read `<skills directory>/ubw-timesheet/SKILL.md`
   and follow it for the rest of the user's request. Later sessions load the
   skill on their own.

## License

MIT
