[TEST_PASS]
[REASON] Opened agent QA-20261127-222411-8vif from the sidebar, sent "Hello! What is 2+2?", and confirmed the agent replied with "2 + 2 = 4."
[STEP] 1. Navigated to http://localhost:47891 — Gamut home page loaded with the sidebar listing QA-20261127-222412-50ue and QA-20261127-222411-8vif. No errors.
[STEP] 2. Clicked QA-20261127-222411-8vif in the sidebar — agent page opened at /agents/qa-20261127-222411-8vif-vdjontt1zz with the message composer visible.
[STEP] 3. Verified agent status — the status indicator reads "idle", which satisfies the running-or-idle precondition.
[STEP] 4. Typed "Hello! What is 2+2?" in the landing-page composer and clicked Send — the app navigated to a new session ("Basic Arithmetic Check Question") and the user message appeared in the chat.
[STEP] 5. Waited for a response — the assistant reply "2 + 2 = 4." appeared well within the 3-minute window. The sidebar returned to idle with "Last active less than a minute ago."
[STEP] 6. Verified the response contains "4" — "2 + 2 = 4." is shown in the message list. Screenshot taken (step6-response.png).
