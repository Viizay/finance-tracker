# GitHub Pages

Repository: https://github.com/Viizay/finance-tracker

Expected project-site URL, **after** a green Pages deploy on `main`:

https://viizay.github.io/finance-tracker/

That URL was **not** verified while this branch was opened. A workflow on `main` is what publishes the site. This branch does not deploy by itself, and this change set must not be merged by the agent that opened it.

## Workflow

`.github/workflows/pages.yml` runs on a push to `main` and on manual dispatch. It copies the static site to `_site` (HTML, CSS, JS, icons, Chart.js, docs, privacy page) and deploys with the official Pages actions. Paths in the app are relative (`./`), so the `/finance-tracker/` project path resolves.

## Turn Pages on

Someone with admin on the repo needs to set the Pages source to **GitHub Actions** once:

1. https://github.com/Viizay/finance-tracker/settings/pages
2. Build and deployment → Source: **GitHub Actions**
3. Merge the pull request into `main` (or run the workflow after the file is on `main`).
4. Wait until the **Deploy GitHub Pages** workflow is green.
5. Open https://viizay.github.io/finance-tracker/ and confirm the empty dashboard loads. Only then is the site live.

If the settings page has no GitHub Actions source until the workflow file is on `main`, merge first, then set the source, then re-run the workflow if it did not start.

The OAuth JavaScript origin for that host is `https://viizay.github.io` with no path. See `GOOGLE_CLOUD_SETUP.md`.

## Local preview

```bash
python3 -m http.server 8765
# http://127.0.0.1:8765/
```

To mimic the project path, serve the repo through any static server mounted at `/finance-tracker/`. The browser smoke test does that.
