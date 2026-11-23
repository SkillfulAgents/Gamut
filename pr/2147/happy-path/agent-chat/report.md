[TEST_PASS]
[REASON] Sent "Hello! What is 2+2?" to agent QA-20261123-192632-iu75 and confirmed the reply contains "4".
[STEP] Step 1: Navigated to http://localhost:47891 — the Gamut home page loaded with the sidebar listing agents QA-20261123-192632-hq83 and QA-20261123-192632-iu75.
[STEP] Step 2: Clicked QA-20261123-192632-iu75 in the sidebar — its agent page opened at /agents/qa-20261123-192632-iu75-dshmjahemu.
[STEP] Step 3: Checked the agent status indicator — it shows "idle", which satisfies the running-or-idle requirement. Screenshot saved as step3-agent-status.png.
[STEP] Step 4: Entered "Hello! What is 2+2?" in the message input (verified by snapshot) and clicked Send — the app navigated to a new session "Basic Arithmetic Question".
[STEP] Step 5: Waited for the response — it was already rendered by the time I checked, so no wait was needed.
[STEP] Step 6: Verified the assistant reply reads "2 + 2 = 4." and took a screenshot (step6-response.png). The message list shows the user message and the reply, and the agent is back to "idle".
