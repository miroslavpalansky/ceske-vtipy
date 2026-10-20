# České vtipy

*Smutné ráno + dobrý vtip = veselé ráno*

A phone-first web app (installable PWA) for the 1,283 jokes from the old @cz_vtipy Twitter account. Three tabs:

- **Vtipy:** one joke card at a time, with its category ("Kategorie: Pepíček") and number on top; dialogues are laid out one line per speaker. Swipe right (or 👍) if it's funny, left (or 👎) if not. There's undo, share and arrow keys on a computer. Each phone remembers what it has already seen, so nobody gets repeats until they've been through everything. Jokes with few votes are shown a bit more often so that every joke gets rated. Until votes come in, jokes that did well on Twitter come up a little sooner.
- **Žebříček:** the top 50, either *Trendy* (votes from the last 30 days) or *Všech dob* (all votes), filterable by category. Ranked by the lower bound of the Wilson score interval, so a joke at 3 out of 3 doesn't beat one at 180 out of 200.
- **Moje:** the jokes you swiped right, saved on your phone, ready to share.
- **Pošli nám vtip:** visitors can submit a joke. It lands in the sheet hidden until you approve it.

| Part | Where it lives | What it does |
|---|---|---|
| Database | Google Sheet **České vtipy – databáze** (your Drive) | Jokes, votes, score, categories, submissions (*Vtipy* tab); a log of recent votes for Trendy (*Hlasy* tab). Instructions are on the *Návod* tab. |
| Backend | Apps Script attached to that sheet (`apps-script/`) | A small JSON API: serves the jokes, records votes, takes submissions |
| Website | GitHub Pages (`site/`) | The app itself: static HTML/CSS/JS, service worker, icons, fonts |

All of it is free and there are no keys or passwords to manage.

## Going live (about 10 minutes)

### 1. Website on GitHub Pages
1. Create a **public** repository named `ceske-vtipy` under your account (`miroslavpalansky`).
2. The website files are at the root of this repository, so that `index.html` is at the top level.
3. Repository → Settings → Pages → Source: *Deploy from a branch*, branch `main`, folder `/ (root)`. Save.
4. After a minute the site is at `https://miroslavpalansky.github.io/ceske-vtipy/`. It will say it isn't connected yet; that's expected.

If you use another repository name or a custom domain, change `SITE_URL` in `config.js` and the two `og:` URLs in `index.html`.

### 2. Backend in the Google Sheet
1. Open the sheet → **Extensions → Apps Script**.
2. Replace the contents of `Code.gs` with `apps-script/Code.gs`.
3. Project Settings (gear) → tick *Show "appsscript.json" manifest file* → open `appsscript.json` and replace it with `apps-script/appsscript.json`.
4. Choose the function **setup** and press **Run**. Google asks for permission: *Review permissions* → your account → *Advanced* → *Go to … (unsafe)* → *Allow*. It says "unverified" only because it's your own script. The log should say `OK: 1283 vtipů na webu.`
5. **Deploy → New deployment** → type *Web app* → Execute as: *Me* → Who has access: *Anyone* → Deploy. Copy the URL that ends in `/exec`.

### 3. Connect the two
In the repository, edit `config.js` and set `API_URL: 'https://script.google.com/macros/s/…/exec'`. Commit, then open the site.

## Everyday use
- **Approve a submitted joke:** it appears at the bottom of the *Vtipy* tab with source *Od čtenáře* and *Na webu* unticked. Tick it to publish, or delete the row.
- **Add your own joke:** type it into the *Vtip* column on the first empty row. ID, source, *Na webu* and date fill in by themselves, and it's live within two minutes.
- **Remove a joke from the site:** untick *Na webu*.
- **Categories:** column O *Kategorie*. Change it freely; a new name simply becomes a new filter chip.
- **Review list:** column P *Ke kontrole* names why a joke might not be fit to publish (racism, Holocaust, children and sex…). It is only a note for you: the site never shows it, and the joke stays live until you untick *Na webu*. Use the filter on the header row to show only flagged rows.
- **Hlasy** tab: one row per vote change, used for Trendy. The script deletes rows older than 30 days by itself; don't edit it.
- **Score** (column G) is a formula; sort or filter by it in the sheet, but don't type into it.
- After changing the website files: raise the `?v=` number in `index.html` and `sw.js` (and `VERSION` in `sw.js`), so phones that already visited pick up the new version.
- After changing `Code.gs`: **Deploy → Manage deployments → Edit → Version: New version**, so the web app URL stays the same.

## Limits worth knowing
- One vote per joke per device. Someone determined could clear their browser and vote again; for a joke site that's acceptable.
- Submissions are limited to 30 an hour in total, have a hidden spam trap, and exact duplicates of existing jokes are ignored.
- The site caches the joke list for two minutes, so other people's new votes appear with a short delay.

## Repository layout
The website files sit at the top level (that is what GitHub Pages serves). `apps-script/` holds the backend code that lives in the Google Sheet (Extensions → Apps Script). The local dev server and tests are kept outside this public repository.

Fonts: Big Shoulders Display and Literata (SIL Open Font License), self-hosted in `fonts/`.
