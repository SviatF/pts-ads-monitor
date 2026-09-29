# Invoice runner

This runner is intentionally separate from the Cloudflare/OpenNext request runtime. It uses a persisted authenticated Meta browser session to open Billing for only explicitly subscribed ad accounts, download newly available PDF documents, and submit them to the app invoice ingest endpoint.

The runner should be executed from a browser-capable environment such as GitHub Actions, a small VPS, or another Playwright-compatible runner.
