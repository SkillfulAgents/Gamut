[TEST_PASS]
[REASON] Sent "Hello! What is 2+2?" to agent QA-20261124-084713-1g15 in the browser and confirmed the reply contains 4.
[STEP] 1. Navigated to http://localhost:47891 — the Gamut home page loaded with the sidebar listing QA-20261124-084713-1g15.
[STEP] 2. Clicked QA-20261124-084713-1g15 in the sidebar — its agent page opened (URL /agents/qa-20261124-084713-1g15-2xwuaemu1e). Screenshot: step2-agent-selected.png.
[STEP] 3. Checked the agent status — the header shows "idle", which satisfies the running-or-idle requirement.
[STEP] 4. Typed "Hello! What is 2+2?" in the composer and clicked Send — a new session "Basic Arithmetic Greeting Check" opened, showing the message and "Working..." with the agent status "working". Screenshot: step4-message-typed.png.
[STEP] 5. Waited for "Working..." to disappear (up to 180 seconds) — the reply "2 + 2 = 4." appeared and the agent returned to "idle" well within the limit.
[STEP] 6. Verified the response mentions 4 — "2 + 2 = 4." is shown in the chat. Screenshot: step6-response-verified.png.

Console showed 0 errors on every snapshot (4 WebGL driver warnings and one "Banner not shown" info message). No bugs found.
