# Mobile queue viewport check (task #131)

Checked in Playwright Chromium with a 700 CSS-pixel-high mobile viewport. The local fixture at `.agent-orch/queue-fixture.html` uses the app's `public/app.css`, queue modal/card classes and structure, 16 rows, long titles, long dependency labels, badges, and dependents indented through three levels. Served on spare port 3999 with `python3 -m http.server 3999 --bind 127.0.0.1`; no live app process or data was used. Measurements were taken after the sheet animation (350 ms), then `#qBody.scrollTop` was set to its `scrollHeight`.

| CSS viewport width | Document scrollWidth | Queue panel left–right | First row left–right | Deepest row left–right | `#qBody` scrollTop / range | Last row top–bottom after scroll | Last grip / chevron left–right | Result |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 320 | 320 | 0–320 | 12–308 | 60–308 | 2253 / 2253 | 494–672 | 69–78 / 290–295 | Pass |
| 375 | 375 | 0–375 | 12–363 | 60–363 | 1922 / 1922 | 514–672 | 69–78 / 345–350 | Pass |
| 390 | 390 | 0–390 | 12–378 | 60–378 | 1766 / 1766 | 514–672 | 69–78 / 360–365 | Pass |

At all three widths, browser assertions passed for `document.documentElement.scrollWidth === innerWidth`, the panel and every row inside the viewport, the close button inside the viewport, and the last row plus its grip and chevron inside the viewport and scroll area's visible bounds after scrolling. At 1024px, the queue panel remained 760px wide (132–892) and the same row and scroll assertions passed. Before the change, the panel measured about 692px wide at 320, 375 and 390px viewport widths.

Visual captures via `node bin/shot.mjs <fixture-url> --mobile --wait=500`: before `.agent-orch/shots/20260925-202530-127-0-0-1-3999-agent-orch-queue-before-html.png` (fixture loaded the committed, pre-fix stylesheet); after `.agent-orch/shots/20260925-202532-127-0-0-1-3999-agent-orch-queue-fixture-html.png` (fixture loaded the updated stylesheet).
