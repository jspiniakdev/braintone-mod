# BrainTone

A short brain workout inside Claude Code. Type `/braintone` while Claude works and a small pane opens with themes to pick from (quick math, physics, word puzzles, SAT, GMAT, poetry), each challenge graded on the spot, with points and a best day to beat. Esc closes it; `/braintone` brings you back where you were.

## Install

BrainTone is invite-only. Whoever runs it sends you an install command with your invite in it:

```bash
claude plugin marketplace add jspiniakdev/braintone-mod
claude plugin install braintone@braintone --config invite=inv_… --config server_url=https://api.braintone.ai
```

Mods are early access in Claude Code, so start it with them turned on, then type `/braintone`:

```bash
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude
```

The first time, the Mod swaps your invite for a token of its own and keeps it. There's nothing else to set up. Your progress is kept on the server under your name, so a second computer with the same invite picks up where you are.

## Keys

- **Menu and lists:** press the number. `m` shows the next 5, `b` goes back.
- **Multiple choice:** press the option's number. `s` skips.
- **One line:** type it, Enter sends.
- **Paragraph:** Enter adds a line, `DONE` on its own line sends. Tab goes back to an earlier line.

## What it sends

Only to `https://api.braintone.ai`: your answers, how long they took, and which challenges you opened. Nothing from your Claude session.

> This repo is published from the BrainTone source. Changes made here are overwritten.
