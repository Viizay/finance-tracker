# Multi-user Google Sheets

Status: **implemented in the static app and covered by mocked tests**. Live Google sign-in has **not** been run. There is no OAuth client ID in this repo, and the app must not embed a publisher-owned spreadsheet id.

## What changed from the first draft

The first draft recommended only `drive.file`, with identity scopes optional. That is not enough to keep accounts apart. The token-model access token does not include a Google account id unless the request also includes identity scopes. The app now requests:

- `openid`
- `https://www.googleapis.com/auth/userinfo.email`
- `https://www.googleapis.com/auth/userinfo.profile`
- `https://www.googleapis.com/auth/drive.file`

All four are non-sensitive. `https://www.googleapis.com/auth/spreadsheets` and `https://www.googleapis.com/auth/drive` are not requested. Sheets’ own scope table lists `drive.file` as the recommended non-sensitive scope for files the app creates: https://developers.google.com/workspace/sheets/api/scopes

The access token is held in memory only (`createTokenStore`). Sign-out calls `google.accounts.oauth2.revoke` when a token is still in memory, then drops it. A new token is requested only from Connect, Reconnect, or Sync, which are clicks. https://developers.google.com/identity/oauth2/web/guides/use-token-model

Userinfo `sub` is the storage key. Email is display only. If `sub` is missing, nothing is saved.

## On-device keys

```
finance-tracker:v1:guest
finance-tracker:v1:user:<sub>
finance-tracker:v1:sheet:<sub>
finance-tracker:v1:queue:<sub>
finance-tracker:v1:base:<sub>
finance-tracker:v1:conflicts:<sub>
finance-tracker:v1:session          # sub, email, name — not an access token
finance-tracker:v1:publicClientId   # public client id override, optional
```

The old `finance-tracker-v1` blob is copied to the guest key once.

Sign-out clears the session pointer and the memory token. It does **not** delete `user:<sub>`. The next person on the browser sees the guest profile, not the previous account. “Remove this account from this device” deletes that account’s keys. The Drive file is not deleted.

Guest rows move into an account only after a yes on the dialog. Choosing “Keep separate” leaves the guest key alone and loads that account’s own key (empty if new).

## Spreadsheet

Created with Drive `files.create`:

- `mimeType`: `application/vnd.google-apps.spreadsheet`
- name: `Finance Tracker`
- `appProperties.financeTracker = 1`
- no `permissions` field, so Drive’s default is private to the creator

The id is saved **before** tab setup, so a failed setup retries the same id. Setup renames the first tab and adds the missing ones: Transactions, Budgets, Goals, Settings, Summary. Headers, currency formats, a frozen header row, and formulas are applied. Data writes use `values.update` on a rectangle (RAW), not `values.append`, so a retry replaces rows instead of duplicating them. Dates stay ISO text. Deleted is the string `TRUE` / `FALSE`. Summary formulas use `LEFT(date, 7)` so they do not depend on locale date parsing.

A second device with no saved id calls Drive `files.list` with:

```
appProperties has { key='financeTracker' and value='1' }
and trashed = false
and mimeType = 'application/vnd.google-apps.spreadsheet'
```

That is not a listing of every spreadsheet. The Sheets guide says an unfiltered spreadsheet list needs a restricted Drive scope; this query is only for files this app marked. If the call fails, sync stops and does not create another file. This lookup is **not live-verified**.

The oldest matching file is kept when several exist. Two devices that both create a file before either lists it can still end up with two private files. The app will not delete the extra one.

## Sync

Local rows are the offline copy. Sync is explicit, plus an optional “Sync after each save” switch that does nothing when the token is missing.

Queue ops are a durable dirty log. They are not applied a second time during sync. Success clears the queue. Failure leaves it.

Merge, per id, against the `updated_at` stored at the last successful sync:

- only local changed → upload local
- only remote changed → adopt remote
- content equal → no conflict, safe to retry
- both changed → keep the spreadsheet row, store the local row in conflicts

There is no atomic revision guard. Two overlapping writes can still lose one of them; the last successful write is what the sheet keeps. The UI says that.

Schema version lives in Settings. A higher remote version aborts before any write.

## Tabs

| Tab | Columns |
| --- | --- |
| Transactions | id, type, amount, category, date, note, recurring, deleted, created_at, updated_at |
| Budgets | id, category, monthly_limit, deleted, created_at, updated_at, plus a spent_this_month formula |
| Goals | id, name, target, current_amount, target_date, monthly_contribution, deleted, created_at, updated_at, plus a remaining formula |
| Settings | key, value (schema_version, savings_balance, theme, is_demo, sync_on_save, settings_updated_at, projection, last_sync_at) |
| Summary | income, spending, net, savings rate, savings balance, emergency-fund months, schema, last sync — formulas |

Monthly transactions are one stored template. The UI expands them. Generated ids (`<id>@YYYY-MM`) are not written back and are dropped on import so a month is not counted twice.
