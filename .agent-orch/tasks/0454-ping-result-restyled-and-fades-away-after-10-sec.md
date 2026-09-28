# Task #454: Ping result: restyled and fades away after 10 seconds

- kind: work  
- source: planner  
- priority: 50 (normal)  
- created: 2026-09-28 14:52  
- files: public/app.js, public/app.css, test/ui-ping-result*.test.mjs

## Prompt

The machine Ping result (from #368: inline text under a node like 'Ping 84 ms · DNS ok (…) · head HTTPS 200 (…) · GitHub ok', in public/app.js/app.css) looks plain. Restyle it as a compact result chip group in the app's theme: a small rounded container under the node with the round-trip first in tabular figures ('84 ms'), then one pill per check (DNS, Head, Git, GitHub), each with a coloured status dot (ok = green token, slow > 500 ms = warn, failed = danger), a short label and its time, with the details and hints (e.g. the DNS failure hint) in a tooltip or tap-to-expand rather than inline paragraphs. A 'no answer' or disconnected result uses the same component with a single red pill and a one-line hint. It auto-dismisses: fade out and collapse after 10 s (pause the timer while hovered or focused, or while its details are expanded), with no motion under prefers-reduced-motion (just remove it). Pinging again replaces the previous result and restarts the timer; 'Ping all' shows one per node. It fits the compact machine cards and works at 390px. Test: a ping result renders the pills with statuses from a mocked response and disappears after 10 s (fake timers); hover pauses the timer. Run only the touched test files.

## Done when

`node --test test/ui-ping-result*.test.mjs` passes (pills with statuses render, removed after 10 s with fake timers, hover pauses)
