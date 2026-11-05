# Finance Tracker

Personal finance app for an iPhone home screen. It is a static PWA: income and expenses, categories, notes, dates, monthly recurrence, budgets, savings and emergency-fund months, goals with a monthly contribution, a projection chart, JSON backup, themes, and offline caching.

The first screen is empty. **Load demo data** fills sample numbers and keeps a **Demo data** banner on screen.

Google Sheets sync is implemented for a private spreadsheet in each signed-in user’s own Drive. It is covered by mocked tests. It has not been run against a live Google account, because this repo has no OAuth client ID and no one signed in to Google while building it. Until you add a client ID, Settings says Google sign-in is not configured.

## Privacy

[privacy.html](privacy.html). There is no support email.

## Docs

- [Google Cloud setup](docs/GOOGLE_CLOUD_SETUP.md) — what you have to click. No billing.
- [Sheets behavior](docs/MULTIUSER_SHEETS_SPEC.md) — scopes, tabs, conflicts.
- [GitHub Pages](docs/GITHUB_PAGES.md) — workflow and the URL to check after deploy.

## Scripts

```bash
npm test
npm run test:browser   # uses the system Chrome
python3 -m http.server 8765
```

## Pages

Workflow: `.github/workflows/pages.yml`. The live URL is not claimed here. After the workflow is green on `main`, check https://viizay.github.io/finance-tracker/ yourself.
