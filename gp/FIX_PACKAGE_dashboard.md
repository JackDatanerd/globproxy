# Fix package: Dashboard UI (Section 5)

Bugs: supplier guard on dashboard credentials (toDashboardCredential); shared saveBlob/saveTextFile so downloads work on Firefox/Safari (fleet export, 2FA backup codes, mfa-setup codes, admin CSVs); ASN picker ISP-name search; custom sticky-duration input (MinutesInput); duration label (formatDurationMinutes); default auto-allocate NumberField; billing table horizontal scroll; invalid pt-4.5 class; auto-recharge "Turn off" works regardless of other fields (+ client validation, retry, aria-expanded).

Gaps: copy-all / download for named sticky sessions; fleet export includes named sessions; delete-session confirm; Playwright, Puppeteer, cURL-env, Go, PHP snippets; bulk pause/resume/delete on the proxy list.

Deliberately not changed: IP-whitelist wording (supplier semantics unverified).
