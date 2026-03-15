# Jarvis Training Protocol

Training Jarvis to actually be useful. Follow this step by step.

---

## How It Works

1. You tell Jarvis: **"training mode"**
2. Jarvis enters training mode (asks for feedback after every task)
3. You give it a task from the list below
4. Jarvis tries to do it
5. You reply with a **feedback code** (one letter/word, listed below)
6. If Jarvis failed: say **"demo"** -- it starts recording your screen/mouse while YOU do the task, then learns from it
7. Repeat until done, then say **"training done"**

---

## Feedback Codes

Reply with ONE of these after each task. Don't type explanations -- just the code.

| Code | Meaning | What Jarvis Does |
|------|---------|-----------------|
| `g` | Good -- completed correctly | Saves the action path as a playbook |
| `f` | Failed -- couldn't complete | Records failure, asks if you want to demo |
| `s` | Stuck -- looped or froze | Records failure pattern, moves on |
| `slow` | Completed but way too slow | Records as slow path, looks for shortcuts |
| `wrong` | Did the wrong thing entirely | Records what went wrong |
| `narr` | Narrated too much / talked when it shouldn't | Records voice feedback |
| `silent` | Should have said something but didn't | Records missing proactivity |
| `p+` | Was proactive (mentioned something useful I didn't ask for) | Reinforces proactive behavior |
| `p-` | Missed a proactive opportunity | Records what it should have caught |
| `demo` | I'll show you how to do it | Starts screen recording mode |
| `skip` | Skip this task | Moves to next task |
| `done` | End training session | Exits training mode |

### Combo codes

You can combine codes with a space:

- `g p+` -- good AND proactive
- `f demo` -- failed, I'll show you
- `slow narr` -- completed slowly and talked too much
- `g silent` -- did the task but should have mentioned something

---

## Training Session Script

### Step 0: Start

Say this to Jarvis:

> "training mode"

Jarvis will confirm it's in training mode and ask you to start giving tasks.

---

### Round 1: Basic App Launching

These are the simplest tasks. Jarvis should do these silently with zero speech.

| # | Say this to Jarvis | Expected behavior | Proactive opportunity |
|---|-------------------|-------------------|----------------------|
| 1 | "open discord" | Opens Discord silently, no speech | None -- trivial task |
| 2 | "open spotify" | Opens Spotify silently | Could mention: "Spotify is already open" if it is |
| 3 | "open chrome" | Opens Chrome silently | Could mention: "Chrome is already running with 5 tabs" |
| 4 | "open notepad" | Opens Notepad silently | None |
| 5 | "open settings" | Opens Windows Settings | Could use Win+I shortcut |

**What to watch for:** Any narration = `narr`. Any "Let me open..." = `narr`. Silent completion = `g`.

---

### Round 2: App Switching

Jarvis should use `focus_window`, never click the taskbar.

| # | Say this | Expected | Proactive |
|---|---------|----------|-----------|
| 6 | "switch to discord" | focus_window("Discord"), no speech | None |
| 7 | "go to chrome" | focus_window("Chrome"), no speech | Could mention what tab is active |
| 8 | "switch to spotify" | focus_window("Spotify"), no speech | Could mention current song |
| 9 | "go back to discord" | focus_window("Discord"), no speech | None |

**What to watch for:** Taskbar clicking = `wrong`. Should use focus_window every time.

---

### Round 3: Messaging (Discord)

This is where things get real. Jarvis needs to navigate Discord's UI.

| # | Say this | Expected | Proactive |
|---|---------|----------|-----------|
| 10 | "message Mixo hey" | focus_window("Discord") > ctrl+k > type "Mixo" > Enter > type "hey" > Enter. Silent. | Could mention: "Mixo was last active 2h ago" |
| 11 | "send a message in general saying test" | Navigate to #general channel, type "test", send. Should ask confirmation before sending. | None |
| 12 | "check my DMs on discord" | Open Discord, navigate to DMs | Could mention unread count |

**What to watch for:**
- Uses ctrl+k (quick switcher) for DMs = good
- Clicks through server list manually = `slow`
- Asks confirmation before sending = good (it should for sends)
- Sends without asking = `wrong` (destructive action)

---

### Round 4: Browser Tasks

| # | Say this | Expected | Proactive |
|---|---------|----------|-----------|
| 13 | "search google for best restaurants near me" | Opens Chrome, navigates to Google, searches. Can use address bar directly. | Could mention: "You're in Calgary -- want me to add 'Calgary' to the search?" |
| 14 | "go to github.com" | Opens new tab or navigates. Should use browser_action. | None |
| 15 | "open youtube and search for karate highlights" | Navigate to YouTube, search | Could mention: "Want tournament highlights or training?" |

---

### Round 5: Email

| # | Say this | Expected | Proactive |
|---|---------|----------|-----------|
| 16 | "open gmail and compose a new email" | Navigate to Gmail, click Compose. Don't send. | Could check drafts |
| 17 | "reply to the most recent email saying thanks got it" | Open Gmail, find most recent, hit reply, type response. Ask confirmation. | Could mention: sender name, time since email, reply vs reply-all |

---

### Round 6: Multi-step Tasks

| # | Say this | Expected | Proactive |
|---|---------|----------|-----------|
| 18 | "open notepad and type 'meeting notes for today'" | Open Notepad, type text. Silent. | Could add today's date automatically |
| 19 | "take a screenshot and save it to desktop" | Win+Shift+S or Snipping Tool | None |
| 20 | "snap discord and chrome side by side" | Win+Arrow keys to snap windows | None |

---

### Round 7: Proactive Tasks (the real test)

These are designed to test whether Jarvis thinks ahead.

| # | Say this | Expected | What proactive looks like |
|---|---------|----------|--------------------------|
| 21 | "find me the cheapest flight from Calgary to San Diego in April" | Search Google Flights | Should ALSO mention: weather in SD, travel dates vs school schedule, baggage policies |
| 22 | "check the weather in Toronto" | Search weather | Should mention: "It's -5 there vs 10 here in Calgary" (comparison) |
| 23 | "email my prof about the assignment extension" | Compose email | Should flag: professional tone check, mention which class/prof if known from profile |
| 24 | "buy that keyboard I was looking at on Amazon" | Navigate to Amazon | Should flag: price comparison, coupon codes, return policy. MUST ask confirmation. |

**Rating these:** If Jarvis does the task but doesn't mention ANY extra info = `g p-` (good but missed proactivity). If it mentions useful stuff = `g p+`.

---

### Round 8: Error Recovery

Intentionally give tasks that might fail to test how Jarvis handles it.

| # | Say this | Expected | Notes |
|---|---------|----------|-------|
| 25 | "open an app that isn't installed" | Should recognize failure quickly, tell you, not loop | If loops > 2 times = `s` |
| 26 | "message someone who doesn't exist on discord" | Should try, fail gracefully, report | Should not keep trying the same search |
| 27 | "click the third button from the left" (vague) | Should ask for clarification OR take screenshot and figure it out | Asking = fine. Guessing wrong = `wrong` |

---

## Demo Mode (When Jarvis Fails)

When you reply `demo` or `f demo`, here's what happens:

1. Jarvis says: "Recording. Do the task now -- I'm watching."
2. It starts capturing:
   - Screenshots every 500ms
   - Your mouse position
   - Which window is focused
   - What changes on screen (OCR)
3. You do the task manually on your PC
4. When done, say **"done"** to Jarvis
5. Jarvis captures the final state, compares before/after
6. It saves everything as a playbook entry
7. Next time it gets the same task, it uses YOUR approach

**What Jarvis learns from demos:**
- Which window to focus first
- What keyboard shortcuts you used (tracked via window title changes)
- Where you clicked (cursor position tracking)
- What the screen looked like before and after (OCR landmarks)
- How long it took you (speed benchmark)

---

## After Training

After a training session, check these files to see what Jarvis learned:

| File | What's in it |
|------|-------------|
| `data/playbooks.json` | Successful action sequences per app |
| `data/failures.json` | What went wrong and how to avoid it |
| `data/preferences.json` | Learned user preferences |
| `data/recordings/` | Raw demo recordings with screenshots + state |

You can run multiple training sessions. Jarvis gets better each time.

---

## Quick Reference Card

Print this or keep it open during training:

```
START:    "training mode"
END:      "training done"

FEEDBACK:
  g       = good
  f       = failed
  s       = stuck/looped
  slow    = too slow
  wrong   = wrong action
  narr    = talked too much
  silent  = should have spoken
  p+      = was proactive (good)
  p-      = missed proactive opportunity
  demo    = let me show you
  skip    = next task

COMBOS:   "g p+"  "f demo"  "slow narr"
```
