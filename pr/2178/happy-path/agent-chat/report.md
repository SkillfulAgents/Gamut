[TEST_PASS]
[REASON] Opened agent QA-20261124-023915-pxwy, confirmed it was idle, sent "Hello! What is 2+2?", and verified the reply contains 4.
[STEP] 1. Navigated to http://localhost:47891 — the Gamut home page loaded with the sidebar listing QA-20261124-023915-pxwy (idle). Screenshot not taken for this step.
[STEP] 2. Clicked QA-20261124-023915-pxwy in the sidebar — the agent page opened at /agents/qa-20261124-023915-pxwy-k816e504up.
[STEP] 3. Verified agent status — the header status reads "idle", which satisfies the running-or-idle requirement. Screenshot saved as step3-agent-idle.png.
[STEP] 4. Sent "Hello! What is 2+2?" from the agent landing input — the session opened and the user message appeared in the message list.
[STEP] 5. Waited for a response — the reply "2 + 2 = 4." was already in the list when checked, and the status had returned to idle. No activity indicator was visible at that point.
[STEP] 6. Verified the response mentions "4" — "2 + 2 = 4." is shown as the assistant reply. Screenshot saved as step6-response.png.
