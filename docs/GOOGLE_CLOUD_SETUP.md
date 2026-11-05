# Google Cloud setup

The app is ready to call Google, and the automated tests use a fake Google API. Nobody has signed in with a real Google account for this project, and there is no OAuth client ID in the repo. Live sync is not done until you finish the steps below and see a private spreadsheet appear in your own Drive.

Do not turn on billing. Do not start a free trial. Do not enter a credit card. Creating an OAuth client and enabling the Sheets and Drive APIs for a user-consented app does not require a billing account. If a screen insists on a billing account, stop and leave it.

The publisher has to do this in a browser while signed into Google. An agent cannot create the client without that login, and it must not ask for the Google password.

## 1. Project and APIs

1. Open [Google Cloud Console](https://console.cloud.google.com/).
2. Create or select a project. Leave billing disabled.
3. APIs & Services → Library. Enable **Google Sheets API**.
4. Enable **Google Drive API**.
5. Do not enable any other API for this app.

## 2. OAuth consent screen

The current console labels this **Google Auth platform** → Branding / Audience / Data access. Older consoles label it **OAuth consent screen**.

1. User type: **External**.
2. App name: `Finance Tracker`.
3. User support email: the Gmail account you are signed in with.
4. Leave the app in **Testing**. Do not click Publish.
5. Scopes / Data access. Add only:
   - `openid`
   - `https://www.googleapis.com/auth/userinfo.email`
   - `https://www.googleapis.com/auth/userinfo.profile`
   - `https://www.googleapis.com/auth/drive.file`
6. Do not add `https://www.googleapis.com/auth/spreadsheets` or `https://www.googleapis.com/auth/drive`. Those are sensitive or restricted and would see every spreadsheet or every Drive file. Official Sheets scope list: `drive.file` is the recommended non-sensitive scope for files this app creates. https://developers.google.com/workspace/sheets/api/scopes
7. Audience → Test users. Add every Google account that will use the app, including yours. Testing allows up to 100 test users.

Because the request includes `drive.file`, Testing mode shows a warning and the grant expires seven days after consent. This app does not use a refresh token. When sync stops, open the app and tap **Reconnect Google**. That button is a user gesture, which is what Google Identity Services requires for a new access token. https://developers.google.com/identity/oauth2/web/guides/use-token-model

Identity-only scopes would not expire that way, but this app cannot isolate accounts or create a file without the scopes above. `drive.file` by itself does not return the account id (`sub`).

Publishing to production, and brand verification, require a homepage and privacy policy on a domain you verify in Search Console. `github.io` is GitHub’s domain, so you cannot verify it as yours. Stay in Testing for personal use. Do not buy a domain for this.

## 3. OAuth client ID

1. Google Auth platform → Clients → Create client → **Web application**.
2. Authorized JavaScript origins — origin means scheme, host, and port. No path:
   - `https://viizay.github.io`
   - `http://127.0.0.1:8765`
   - `http://localhost:8765`
3. Do not add `https://viizay.github.io/finance-tracker`. Google rejects a path on a JavaScript origin. https://support.google.com/cloud/answer/15549257
4. Authorized redirect URIs: leave empty. The GIS token client uses a popup, not a redirect. https://developers.google.com/identity/oauth2/web/guides/use-token-model
5. Do not download a client secret and do not commit a credentials JSON file. A browser app must not use a secret.
6. Copy the client ID. It ends in `.apps.googleusercontent.com`.

If the console refuses to save `https://viizay.github.io` because `github.io` is not an authorized domain you own, that is a Google restriction. The Testing client can still be created with the localhost origins, and the GitHub Pages origin can be tried again after you see the exact error. Do not switch the project to production to get past that error.

## 4. Put the client ID in the app

Either paste it in the app under Settings → Google Sheets → Save client ID on this device (stored only in that browser), or set `googleClientId` in `config.js`. The value is public. Leave it empty in git until you are ready to commit it.

Then:

1. Open the site over http://127.0.0.1:8765 or, after Pages is actually live, `https://viizay.github.io/finance-tracker/`.
2. Settings → Connect Google.
3. On the consent screen, leave **every** box checked. If Drive file access is unchecked, the app refuses to sign you in.
4. Tap Sync now. The first successful sync should create **Finance Tracker** in **your** My Drive.
5. In Google Drive, open the file’s Share dialog and confirm it is private to you. The app never sends a sharing permission.
6. Sign out in the app. Sign in with a different test user. Sync should create a different file. It must not open the first user’s file.

Access tokens last about an hour. After that, Sync asks you to reconnect. Your on-device entries stay either way.

## 5. What is still not proven

Unit tests mock Drive and Sheets. They check private create, one file per mocked account, retry without duplicate rows, expiry, and soft delete. They do not prove Google accepts `drive.file` for `files.list` of app-created files on a real project. If that call returns 403, the app shows an error and does not create a second file. The device that already saved the file id can keep syncing it.

Official references:

- Token model: https://developers.google.com/identity/oauth2/web/guides/use-token-model
- Sheets scopes: https://developers.google.com/workspace/sheets/api/scopes
- Sheets create (file lands in the user’s Drive root): https://developers.google.com/workspace/sheets/api/guides/create
- Drive `drive.file`: https://developers.google.com/workspace/drive/api/guides/api-specific-auth
- Testing audience and the 7-day grant: https://support.google.com/cloud/answer/10311615
- OAuth app states: https://developers.google.com/identity/protocols/oauth2/production-readiness/overview
- JavaScript origins cannot include a path: https://support.google.com/cloud/answer/15549257
