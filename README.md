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
 - Report tab: the "Units With ≥2 Consecutive Months Without Invoicing" list excludes units whose Status is "Disabled".
 - Report tab: the "Units Missing Coverage" table includes only units whose Status is "Operational" (disabled units are excluded).
 - Report tab: the "Units Missing Coverage" table visually marks days with other statuses: Overlap (red), Credit (yellow border), Covered (green), and Disabled periods (red border on white when not covered).
 - Report tab: the "Units Fully Covered" table also displays day-level statuses for Overlap (red), Credit (yellow border), and Disabled periods (red cell background; green square if covered, white square with red border if not), in addition to Covered (green).
 - Report tab: the "Units with Yellow Frame Dates (Credit)" table mirrors Unit Overview formatting for disabled periods (red cell background) and shows overlap/coverage consistently.
 - Report tab: the "Units with Red Highlighted Dates (Overlaps)" table mirrors Unit Overview formatting for disabled periods (red cell background) and shows covered/disabled states consistently.
 - Report tab: counting for the above table starts in Jan 2022 (earlier months are ignored for streak calculation).
 - Report tab: the consecutive-months counter considers only Rental invoices (other categories are ignored).
