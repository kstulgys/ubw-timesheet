# How the timesheet screen talks to the server

Maintenance notes for `scripts/ubw.mjs`. Everything below was recorded from
Chrome while a user filled a week on
`https://ubw.unit4cloud.com/nl_mcw_prod_web` (tenant `nl_mcw_prod_web`,
client `LT1`) in September 2026. Field ids such as `1574` come from the screen
definition and may differ per tenant; the script discovers them from the page
instead of hard-coding them.

## Login and session

Two sessions stack on each other:

1. **Unit4 Identity Services** (IDS, `s-eu-ids1.unit4cloud.com`, an
   OpenID Connect server). Its cookies are `idsrv` and `idsrv.session`
   (path `/identity`) plus `u4ids.sessionid`. Microsoft Entra ID sits behind
   IDS and enforces MFA (`amr` in the id_token is `["pwd","mfa"]`).
2. **The app** (`ubw.unit4cloud.com`): `ASP.NET_SessionId`, `.ASPXAUTH`,
   `ubw_session` (load balancer, rotates on every response), `state`,
   `nonce`. `GET /api/session/current` reports
   `{"active":true,"userId":"LT0000001","client":"LT1","timeleft":36000000000}`;
   `timeleft` is in 100 ns ticks (60 minutes). Any request extends it. After
   60 idle minutes `active` is `false` and pages answer `302` to
   `/Login/Login.aspx`. Postbacks need no CSRF token or extra header.

Silent renewal (`Session.renew`) rebuilds tier 2 from tier 1 without any
Microsoft round trip:

1. `GET /Login/Login.aspx?ReturnUrl=%2fnl_mcw_prod_web%2fDefault.aspx` →
   `302` to `https://s-eu-ids1.unit4cloud.com/identity/connect/authorize?client_id=nl_mcw_prod_web&response_type=id_token+token&response_mode=form_post&redirect_uri=<Login.aspx?ReturnUrl=...>&state=...&nonce=...`
   and sets fresh `state`/`nonce` cookies on the app.
2. `GET` that authorize URL with the IDS cookies → `200` with a bare HTML
   `<form method='post' action='<Login.aspx?ReturnUrl=...>'>` holding
   `id_token`, `access_token`, `token_type`, `expires_in`, `scope`, `state`,
   `session_state`. A `302` here means IDS wants Microsoft again: stop, do
   not follow it (a headless browser that follows it triggers an MFA push on
   the user's phone).
3. `POST` those fields to the form action with the app cookies → `302` to
   `/nl_mcw_prod_web/Default.aspx` and `Set-Cookie: .ASPXAUTH=...`.

How long IDS keeps its session is not documented; when step 2 stops
answering with the form, the user logs in again through the browser.

`login` starts a Chromium browser with `--remote-debugging-pipe` and a
private profile under `~/.ubw-timesheet/browser-profile`, opens
`/Default.aspx`, polls `Target.getTargets` until a page sits on the app
outside `/Login/`, reads every `*.unit4cloud.com` cookie with
`Storage.getCookies` (tier 1 and tier 2), verifies them against
`/api/session/current`, then sends `Browser.close`. `session.json` stores the
cookie list; `config.json` stores `baseUrl`, `menuId`, `client`, `userId`.

## The screen

`GET /ContentContainer.aspx?type=topgen&menu_id=TS1611&activityStepId=1-1&addLaunchIndication=false&client=LT1`
returns the full ASP.NET WebForms page for the "Timesheets - standard"
screen, positioned on today's period. Every action is a `POST` of the whole
form to the same URL; the response is the whole page again.

The form is posted like a browser does: every `<input>` with a name, except
buttons and unchecked checkboxes. The script adds:

| Field | Value |
| --- | --- |
| `__EVENTTARGET` | control name that fires, see below |
| `__EVENTARGUMENT` | the literal string `undefined`, or an action |
| `__VIEWSTATE`, `__VIEWSTATEGENERATOR` | echoed from the last response |
| `postbackCounter` | previous value + 1 |
| `<field>$IsDirty` | `true` for every changed field |

Header section fields (prefix seen: `b$s71$s84$s85$l84s85$ctl00$`):

| Field | Meaning |
| --- | --- |
| `…$date_in_period$i` | date in the user's format; changing it and firing `…$date_in_period` loads that period |
| `…$1548$Editor` / `$RowValue` / `$RowDescription` | period code, e.g. `202643`, description `202643 (Sept start)` |
| `…$1551$RowValue` / `$RowDescription` | status `P` Draft, `N` Ready, `T` Transferred |
| `…$normalhrs_schedule$i` | scheduled hours for the period |

Lookup fields are `<DataListControl id="..._Control" title="Period" context="...">`
elements; the script maps the `title` ("Period", "Status", "Work order",
"Time code", "Activity") to the field name, so the numeric ids are never
hard-coded.

Locale comes from an inline script:
`datePattern:'M/d/yyyy'`, `decimalSep:'.'`. Day column titles ("Tue 9/1")
carry no year; the script picks the year closest to the date in period.

## The grid

Table `id="b_s89_g89s90"` (`role="grid"`). The header row
(`<tr class="Header ...">`) has `<th data-fieldname="...">` per column:
`status`, `timecode`, `work_order`, `project`, `activity`, `description`,
`reg_unit`, `reg_value1`..`reg_valueN` (one per day of the period, the
`title` holds the day label), `reg_value` (sum). Data rows are
`<tr id="b_s89_g89s90_rowN">`; the sum row is `id="..._sumRow"`. Cells follow
the header order; text sits in `data-originalText`.

Exactly one row is editable at a time (`class="EditRow"`, inputs named
`b$s89$g89s90$rowN$...`); the others are `ListItem`/`AltListItem` rows with
plain text. Rows are sorted by project, so a new row moves after it gets a
work order. Postbacks used:

| Action | `__EVENTTARGET` | `__EVENTARGUMENT` | Extra fields |
| --- | --- | --- | --- |
| Load a period | `<hdr>date_in_period` | `undefined` | new `…$date_in_period$i` |
| Add row | `<grid>buttons$_newButton` | `undefined` | |
| Set work order | `<grid>rowN$1574$Control` | `validate` | `…$1574$Editor` and `…$1574$RowValue` both = code (`RowValue` is what the server reads) |
| Edit an existing row | `<grid>rowN$_edit` | `undefined` | |
| Change hours | `<grid>rowN$reg_valueK` (the cell, without `$i`) | `undefined` | `…$reg_valueK$i` = `8.00`, `IsDirty` = `true`; one postback per changed day, as the cell's `onchange` does |
| Save | `b$tblsysSave` | `undefined` | |
| Row details | `<grid>rowN$zoom` | `action:Zoom` | opens the "Time entry" dialog, section `b$s93$…` |
| Ready / Draft (rows) | button whose onclick has `action:SetSubmitStatus` / `action:SetDraftStatus` | that action string | `<grid>rowN$_delete=on` for each selected row, then Save |
| Ready / Draft (period) | `<hdr>1551$Control` | `validate` | `…$1551$Editor` and `…$1551$RowDescription` = the label, `…$1551$RowValue` = `N` or `P`, `IsDirty` = `true`, then Save |
| Delete rows | `<grid>buttons$_deleteButton` | `undefined` | `<grid>rowN$_delete=on`, then Save |

Responses carry the outcome in three places:

- `<table id="errorList">` and `<table id="warningList">`: `<li>` items, for
  example `Activity: Illegal value for the project` when a work order was
  posted without `RowValue`.
- A script `U4.selfservice.displayRiaMsg({ title:'Success', message:'Timesheet for X in period 202643 has been saved as a draft', messageType:'success' ...})`
  after Save. The wording after a status change tells you how far the change
  got: "Parts of the timesheet for X in period 202643 have been sent for
  approval" when the rows are Ready under a Draft header, and "Timesheet for X
  in period 202643 has been sent for approval" when the header is Ready too.
- The re-rendered grid itself.

## Invoice value

Each row carries an invoice value next to its hours. The grid does not show
it; the row's Zoom dialog does, as `Sum` (`…$reg_value$i`) and `Inv.value`
(`…$inv_value$i`). The project reports use `Inv.value` as the invoice base.

The server sets `Inv.value` only in the change event of an hour cell, the
postback the browser fires when you leave the cell. Hours posted together
with Save are stored, but `Inv.value` stays at `0.00`, and the project
reports then show the week as negative invoice hours. Periods 202644 and
202645 were booked that way in September 2026. So every changed day gets its
own cell postback before Save, and a check after a booking compares `Sum`
with `Inv.value` in the Zoom dialog.

## Two statuses

A period holds a status in the header field and a status on each grid row, and
approval needs both at `Ready`. The grid buttons move the rows, the header
field moves the period. A submit therefore presses the row button first and
sets the header field after that; a period left with Ready rows under a Draft
header stays with the employee.

The way back is not symmetric. A row that is already Ready keeps that status:
the Draft button returns no message for it, whether the header is Ready or
Draft at the time of the post. Only the header goes back to `P`, so the
approver has to reject the timesheet to make the rows editable again.

## Work order lookup

`POST /System/Services/DataListService.aspx` with form fields
`Search=<text>&Context=<context>&BatchStart=1&BatchSize=50`. `Context` is the
`context` attribute of the row's work order `DataListControl`, base64 of
`TTS025^<screen instance>^TS1611^LT1^1574^<row index>`. The answer is XML:
`<item><value>101012-10003</value><descr>...</descr></item>`; the first item
is the search text with `[NEW]` as description. The match is a
case-insensitive substring of code or description, whole phrase. The server
ignores `BatchStart`/`BatchSize`: it returns at most 50 items and
`<hasmoredata>True</hasmoredata>` when the search needs narrowing. The lookup
is unfiltered only on a row without a work order; once a row has one,
results narrow to that project, so the script searches on a freshly added
row and never saves it.

## Recording new traffic

Set `UBW_DEBUG=<dir>` to make the script write every page it receives to
`<dir>/screen-<timestamp>.html`; that is usually enough to see what changed.

For new interactions, attach to the logged-in tab over CDP and log
`Network.*` events (request headers, post data, `Network.getResponseBody`)
while clicking through the UI; each click is one full-page `POST` to
`ContentContainer.aspx`. Diff the posted field sets between consecutive
postbacks to see what a control changes.
