---
"@e2e-dev/html-reporter": patch
---

New package: `htmlReporter()` writes the run as one HTML page, `.e2e/report.html`, that opens from disk with no server. It lists the tests by file with status tabs and search, and shows each test's attempts, error, steps, screenshots, and video, with each step linked to its moment in the video. Agent steps show their explanation, the actions they took, the model, tokens and cost, and whether the step replayed from the cache. A failed assertion shows the expected and received values with the difference marked, above the test code around the failing call, and every step opens to its code. **copy prompt** on a failed test copies its failure, steps, and file paths for a coding agent. The page has a light and a dark theme, following the system's by default. `media: 'embed'` puts screenshots and videos in the page so the one file is the whole report, and `media: 'none'` leaves them out.
