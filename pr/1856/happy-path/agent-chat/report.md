[TEST_PASS]
[REASON] Opened agent QA-20261121-202922-z9zo, confirmed it was idle, sent "Hello! What is 2+2?", and verified the reply contains "4".
[STEP] Step 1: Navigated to http://localhost:47891 — the Gamut app loaded with both agents listed in the sidebar.
[STEP] Step 2: Clicked QA-20261121-202922-z9zo in the sidebar — its agent page opened at /agents/qa-20261121-202922-z9zo-n5mmg21n1z.
[STEP] Step 3: Checked the agent status — the status indicator reads "idle", which satisfies the running-or-idle requirement.
[STEP] Step 4: Typed "Hello! What is 2+2?" in the composer and clicked Send — a new session "Basic Arithmetic Question Check" opened, the message appeared in the chat, and the status changed to "working".
[STEP] Step 5: Waited for the "Working..." indicator to clear (up to 180 seconds) — it cleared, the status returned to "idle", and the wait finished well within the limit.
[STEP] Step 6: Verified the response — the assistant replied "2 + 2 = 4." A screenshot was taken (step6-response.png).
