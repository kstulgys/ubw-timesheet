# The timesheet screen, element by element

Maintenance notes for `scripts/ubw.mjs`. The script works the Unit4 web UI
through the agent-browser CLI: it clicks buttons and types into fields, and it
reads the rendered page to see the result. It never posts forms or calls
Unit4 endpoints itself, because Unit4 runs its own logic in the screen's
events (see "Invoice value"). Everything below was observed in Chrome on
`https://ubw.unit4cloud.com/nl_mcw_prod_web` (tenant `nl_mcw_prod_web`,
client `LT1`) in September 2026. Field ids such as `1574` come from the
screen definition and may differ per tenant; the script finds them from
lookup titles and column names instead of hard-coding them.

## Browser session and sign-in

The script uses one agent-browser session, `ubw-timesheet` (override with
`UBW_SESSION`). Each command starts it with
`--state ~/.ubw-timesheet/browser-state.json`, works the screen, writes the
cookies back with `state save`, and closes the session. `logout` deletes the
state file.

Two sign-ins stack on each other:

1. **Unit4 Identity Services** (`s-eu-ids1.unit4cloud.com`, OpenID Connect),
   with Microsoft Entra ID and MFA behind it.
2. **The app** (`ubw.unit4cloud.com`), whose session ends after 60 idle
   minutes.

When the app session has ended, opening the screen redirects through the
identity server and back without any input, as long as the identity server
still knows the browser. When it wants Microsoft again, the browser would
land on `login.microsoftonline.com`. Headless commands abort that page with
`network route ... --abort`, so a stale session never shows a Microsoft page
or sends an MFA prompt; the command exits with code 2. `login` runs headed
without that route, and the user signs in in the window.

## Frames

`Container.aspx?type=topgen&menu_id=TS1611&...` holds the screen in
`<iframe id="contentContainerFrame">` (`ContentContainer.aspx`). The screen
needs its container: opened as a top-level page, its buttons do nothing.
agent-browser actions go into the frame with `frame #contentContainerFrame`;
`eval` runs in the top document, so the script reads the screen through
`document.querySelector("#contentContainerFrame").contentDocument`.

## Waiting for the server

Every button, and every field with a server-side change event, reloads the
frame with a full-page postback. The form carries a hidden input
`postbackCounter` that the page raises by one on each postback. The script
reads it before an action and waits until the reloaded document has
`readyState === "complete"` and a higher counter. Fields that validate on
the client (the header Status) cause no postback.

## How the script clicks and types

Before each action the script marks the target element with the attribute
`data-ubw-target` (JavaScript in the frame only sets the attribute), then
runs `agent-browser click|check|focus [data-ubw-target]`. Typing is
`focus`, select all (`Control+a`, `Meta+a` on macOS), `keyboard type`, and
`press Tab`; Tab fires the field's `onchange`, which is the postback.

## Elements

Header section prefix: `b$s71$s84$s85$l84s85$ctl00$`. Grid prefix:
`b$s89$g89s90$`. Element ids are the names with `$` replaced by `_`.

| What | Element | Action |
| --- | --- | --- |
| Date in period | input `<hdr>date_in_period$i` | type the date in the user's format (`datePattern` in an inline script), Tab; postback loads that period |
| Status (period) | `DataListControl` titled "Status": `<hdr>1551$Editor`, `$RowValue` | type the label (`Ready`), Tab; client-side, `$RowValue` turns `N` (Ready) or `P` (Draft) |
| Name | lookup titled "Name": `$RowValue` = user id, `$RowDescription` = name | read only |
| Add | button `<grid>buttons$_newButton` | click; postback adds an editable row |
| Delete | button `<grid>buttons$_deleteButton` | click after marking rows; postback removes them |
| Ready / Draft (rows) | buttons whose `onclick` has `action:SetSubmitStatus` / `action:SetDraftStatus` | click after marking rows; postback |
| Mark a row | checkbox `<grid>rowN$_delete` | `check` (a plain click did not stick) |
| Open a row for editing | any cell `<td>` of row `<grid>rowN` (`onclick` `TG.GS.ER`) | click; postback turns the row into the `EditRow`. A Closed or Transferred row gets no inputs |
| Work order | input `<grid>rowN$1574$Editor` in the edit row | type the code, Tab; postback fills project, activity, description |
| Hours | input `<grid>rowN$reg_valueK$i`, one per day | type, Tab; postback per cell (see "Invoice value") |
| Row details | button `<grid>rowN$zoom` | click; postback opens the "Time entry" dialog, section `b$s93$...` |
| Close dialog | button `b$_dialogclose` | click; postback |
| Save | link `b$tblsysSave` | click; postback saves the period |

## Reading the screen

The script parses the frame's `outerHTML` after each postback, so input
values are the ones the server rendered:

- Grid: table `b_s89_g89s90`. The header row (`<tr class="Header ...">`) has
  `<th data-fieldname="...">` per column: `status`, `timecode`, `work_order`,
  `project`, `activity`, `description`, `reg_unit`, `reg_value1` to
  `reg_valueN` (one per day; the `title` holds the day label, such as "Mon
  9/21", without the year), `reg_value` (sum). Rows are `<tr
  id="b_s89_g89s90_rowN">`, the sum row is `..._sumRow`. Text sits in
  `data-originalText`. Rows are sorted by project.
- Row details: `b$s93$...$reg_value$i` is `Sum`, `b$s93$...$inv_value$i` is
  `Inv.value`.
- Messages: `<table id="errorList">` and `<table id="warningList">` hold
  `<li>` items. After Save an inline script calls
  `U4.selfservice.displayRiaMsg({ title:'Success', message:'Timesheet for X
  in period 202646 has been saved as a draft', ... })`.

## Work order search

Typing into the work-order field of a new row opens a drop-down,
`<div id="..._1574_Popup">`, with `<tr role="option">` rows of code and
description. The first row is the typed text with `[NEW]`. The drop-down
sometimes misses the first keystrokes; typing a character and deleting it
brings it up. For short or common text the drop-down shows only the notice
"Too many values. Please narrow your search." The typed row is never saved;
closing the browser discards it.

## Invoice value

Each row carries an invoice value next to its hours. The grid does not show
it; the row details do, as `Sum` and `Inv.value`. The project reports use
`Inv.value` as the invoice base.

Unit4 sets `Inv.value` in the change event of an hour cell, which is the
postback the browser fires when you leave the cell. An earlier version of
this tool posted all hours together with Save, without those events. Unit4
stored the hours but left `Inv.value` at `0.00`, and the project reports
showed the weeks as negative invoice hours (periods 202644 and 202645 in
September 2026). That is why the tool now types every value into the screen
and reads `Inv.value` back after each save.

## Two statuses

A period holds a status in the header field and a status on each grid row,
and approval needs both at `Ready`. The row buttons move the rows, the
header field moves the period. `submit` therefore marks the rows, presses
Ready, sets the header Status to Ready, and saves once. With only the rows
Ready, Unit4 answers "Parts of the timesheet ... have been sent for
approval" and the week stays with the employee.

The way back is not symmetric. A row that is already Ready keeps that status
when Draft is pressed; only the header goes back. The approver has to reject
the timesheet to make the rows editable again.

`submit --dry-run` was run against a Draft period: rows turned Ready and the
Status field took `N`, and closing without Save left the period Draft. A
real `submit` through the screen has not been run yet.

## When the screen changes

Open the screen with agent-browser (`open` the container URL with the stored
state, `frame #contentContainerFrame`, `snapshot -i`, `screenshot`) and
compare the ids above with what the page shows. `UBW_DEBUG=<dir>` makes the
script write every page it reads to `<dir>/screen-<timestamp>.html`.
