[TEST_PASS]
[REASON] Opened agent QA-20261123-184024-8phb, sent "Hello! What is 2+2?", and confirmed the agent replied with "2 + 2 = 4."
[STEP] 1. Navigated to http://localhost:47891 — Gamut home loaded with the sidebar listing QA-20261123-184025-tblw and QA-20261123-184024-8phb, both idle.
[STEP] 2. Clicked QA-20261123-184024-8phb in the sidebar — agent page opened at /agents/qa-20261123-184024-8phb-3w7so88ncy (screenshot step1-home.png).
[STEP] 3. Verified status — header shows "idle", so the status check passes.
[STEP] 4. Typed "Hello! What is 2+2?" into the composer and clicked Send — the page navigated to a new session (Basic Arithmetic Question Check) and the message appeared in the message list.
[STEP] 5. Waited for a response — the assistant reply "2 + 2 = 4." appeared, well within the 3-minute limit, and the status returned to idle.
[STEP] 6. Verified the response mentions "4" and took a screenshot (step6-response.png) — the response reads "2 + 2 = 4.", so the check passes.
