AGI Vehicle Lease Management

A small static web app that stores vehicle lease data in your browser's localStorage. Supports export/import as JSON.

Files
- index.html: Main app
- styles.css: Simple styles
- app.js: App logic, localStorage persistence, import/export

How to run
- Open `index.html` in your browser (double-click or right-click -> Open with). No server required.

Data storage
- Data is saved to localStorage under the key `agi_vehicle_lease_v1`.
- Export will download a JSON file of the current state.
- Import will replace the current local data after confirmation.

PowerShell (optional)
To open the app in the default browser from PowerShell run:

Start-Process -FilePath "index.html"

Notes
- This is intentionally minimal. If you want a packaged Electron/desktop app, or server-backed storage, tell me and I can scaffold that next.

---
## Publish to GitHub Pages (automatic)

I included a GitHub Actions workflow at `.github/workflows/gh-pages.yml` which will publish the repository root to the `gh-pages` branch whenever you push to `main`.

Steps:

1. Create a GitHub repository and push your project to `main` (use the commands below from your project folder):

```powershell
git init
git add .
git commit -m "Initial commit"
git remote add origin <your-remote-url>
git branch -M main
git push -u origin main
```

2. On GitHub, open the repository Settings -> Pages and set the source to the `gh-pages` branch (the workflow will create and update it) or select `main`/`/ (root)` if you prefer.

3. After pushing to `main`, the Actions tab will show the workflow running. When finished the site will be live at:
	`https://<your-github-username>.github.io/<repo>/`

If you'd like I can also:
- Add a small `deploy` script to package.json
- Customize the workflow to publish only a `docs/` folder instead of the root

