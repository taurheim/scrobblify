# Adversarial review prompt

Fill in the `<…>` parts and send one per finding to a `general-purpose`
subagent. Paste evidence verbatim; don't summarise it into your conclusion.

```text
You are reviewing a claimed bug in scrobblify (C:\path\to\worktree), a Vue app
that scrobbles Spotify history to Last.fm. Your job is to PROVE THIS CLAIM
WRONG. You succeed by finding the flaw, not by agreeing. Do not modify files.

Claim: <one sentence: what goes wrong, for whom>

Evidence offered:
- Queries run and their results: <verbatim SQL + key rows>
- Example users and windows: <username, UTC from/to>
- Code path: <file:line>

Before starting, read the "Debugging with PostHog" section of AGENTS.md and
.github/skills/hunting-posthog-bugs/queries.md. Use the PostHog MCP tool
(always filter properties.app = 'scrobblify').

Attack it from every angle that applies:
1. Semantics: does an event or property actually mean what the claim assumes?
   Check the code that emits it, not just the docs.
2. Query: wrong filter, join, partition or time window? Rows from another app,
   another import, or before the fields existed? Write your OWN query from
   scratch rather than re-running the ones above.
3. Expected behaviour: Last.fm throttling, deliberate design (look for code
   comments explaining it), or user action (e.g. importing an old file)?
4. Already fixed: does every occurrence predate a relevant merge
   (git --no-pager log --date=iso-strict)?
5. Mechanism: does the cited code really produce the observed sequence? Is
   there a different path that explains it better?
6. Scale: does the claim hold for most affected users, or only the examples?
   Pull 2-3 users the claim did NOT cite and check them.

Budget: about 10 queries. Then return:
- Verdict: DISPROVED, WEAKENED or SURVIVED.
- The strongest alternative explanation you tested, and the evidence for or
  against it (queries + rows, file:line).
- If WEAKENED: the narrowest claim the evidence still supports.
```
