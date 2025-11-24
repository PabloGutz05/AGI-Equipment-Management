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
