[TEST_PASS]
[REASON] Opened the QA-20261123-233317-6s4j agent, confirmed it was idle, sent "Hello! What is 2+2?", and verified the reply contains "4".
[STEP] Step 1: Navigated to http://localhost:47891 — Gamut loaded with the sidebar listing both agents; no errors.
[STEP] Step 2: Clicked the "QA-20261123-233317-6s4j" agent in the sidebar — its agent page opened at /agents/qa-20261123-233317-6s4j-e9waqok3xz.
[STEP] Step 3: Checked the status indicator — it shows "idle", which satisfies the running-or-idle requirement. Screenshot saved as step2-3-agent-idle.png.
[STEP] Step 4: Typed "Hello! What is 2+2?" into the message box and sent it — the page navigated to a new session and the message appeared in the chat. Screenshot saved as step4-message-typed.png.
[STEP] Step 5: Waited for a response — "2 + 2 = 4." appeared within a few seconds, well inside the 3-minute limit, and the status stayed "idle".
[STEP] Step 6: Verified the response mentions "4" ("2 + 2 = 4.") and took a screenshot, saved as step6-response-4.png.
