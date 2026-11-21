# Guided home + background: strings

Every user-facing string for the new and rewritten surfaces. Rewrite the
**Draft** column in place. `{braces}` are values filled in at runtime; keep
them or move them, but say if you drop one.

Mockups: `2026-11-20-guided-home-mockups.html` next to this file.

Not covered here (unchanged in this project): the sign-in, upload, pick-tracks
and scrobbling steps, the Complete step, the large-history gate, the
progress-file conflict dialogs and the error dialog.

## Header


| ID            | When         | Draft |
| ------------- | ------------ | ----- |
| `header.beta` | Beta browser | BETA  |


## Home: first visit


| ID                  | When        | Draft                                           |
| ------------------- | ----------- | ----------------------------------------------- |
| `home.title`        | Always      | Retroactively scrobble Spotify plays to last.fm |
| `home.lede`         | Always      |                                                 |
| `home.have.title`   | Card 1      | Already got your streaming history zip?         |
| `home.have.body`    | Card 1      |                                                 |
| `home.have.button`  | Card 1      | Start                                           |
| `home.need.title`   | Card 2      | Don't have it yet?                              |
| `home.need.body`    | Card 2      |                                                 |
| `home.need.button`  | Card 2      | Show me how                                     |
| `home.already`      | Below cards | Already scrobbling on scrobblify?                        |
| `home.already.link` | Below cards | Re-connect to last.fm                           |


## Home: "I need to get it" (replaces the cards)


| ID                  | When   | Draft                                                                                                  |
| ------------------- | ------ | ------------------------------------------------------------------------------------------------------ |
| `getExport.back`    | Always | ← Back                                                                                                 |
| `getExport.title`   | Always | Get your history from Spotify                                                                          |
| `getExport.step1`   | Always | Go to {your Spotify privacy settings} and request **Extended streaming history** (not "Account data"). |
| `getExport.step2`   | Always | Wait for Spotify's email. Usually a few days.                                                          |
| `getExport.step3`   | Always | Download the ZIP and upload it in {scrobble}                                                           |
| `getExport.already` | Always |                                                                                                        |


## Home: returning visitor


| ID                                | When                          | Draft                         |
| --------------------------------- | ----------------------------- | ----------------------------- |
| `returning.title`                 | Any returning state           | Scrobbling to {username}       |
| `returning.bar`                   | Has progress                  | {done} / {total} · {pct}%     |
| `returning.continue`              | Saved progress, signed in     | Continue                      |
| `returning.signIn`                | Saved progress, not signed in | Continue                      |
| `returning.server`                | Last known job on the server  | Scrobbling in the background! |
| `returning.newImport`             | Saved progress                | {Not you?} · {Start over}                    |
| `returning.noProgress.body`       | Username only                 |                               |
| `returning.noProgress.button`     | Username only                 | Upload Spotify zip            |
| `returning.noProgress.notYou`     | Username only                 | Not you?                      |
| `returning.noProgress.needExport` | Username only                 | Show me how                   |


## About

The page keeps its existing **Who built Scrobblify?** and **Contribute** sections. **Support Scrobblify** is dropped (`about.lede` carries the coffee link), and the old FAQ is replaced by the questions below.


| ID                  | When      | Draft                                                                                                                                                                                                                                                                                  |
| ------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `about.title`       | Always    | About                                                                                                                                                                                                                                                                                  |
| `about.lede`        | Always    | Scrobblify is a free tool that scrobbles your Spotify listening history to last.fm. I built it to help out fellow music data nerds! If you want to say thank you, you can {buy me a coffee}(https://buymeacoffee.com/nikosavas) :)                                                                                         |
| `faq.dates.q`       | Collapsed | Why do old plays get today's date?                                                                                                                                                                                                                                                     |
| `faq.dates.a`       | Expanded  | Last.fm only accepts plays from the last two weeks with their real date (probably to avoid overloading their servers/gaming the system). If you have thoughts about this, please let them know! You won't run into this issue on {ListenBrainz} so I recommend checking that out if you want fully accurate data.                          |
| `faq.days.q`        | Collapsed | Why does it take so long?                                                                                                                                                                                                                                                              |
| `faq.days.a`        | Expanded  | [Last.fm](http://Last.fm) has a maximum 750 scrobbles per day per user, so scrobblify has to go that slowly.                                                                                                                                                                           |
| `faq.duplicates.q`  | Collapsed | Will it add duplicates?                                                                                                                                                                                                                                                                |
| `faq.duplicates.a`  | Expanded  | Yes, the idea of scrobblify is that you get the correct **counts** of each track listen, so it'll scrobble one time for every time you listened to a song on spotify. Plays already on Last.fm are skipped if you tick "Check for duplicates" (last two weeks only).                                                                                                                  |
| `faq.data.q`        | Collapsed | Where does my data go?                                                                                                                                                                                                                                                                 |
| `faq.data.a`        | Expanded  | Your zip file is never uploaded and stays on your browser. If you scrobble using the background service, the plays get uploaded there associated with your username. There is an option to do all the scrobbling locally in which case nothing is stored on Scrobblify's server. Scrobblify does log usage and errors so I can fix bugs. |
| `faq.leave.q`       | Collapsed |                                                                                                                                                                                                                                                                                        |
| `faq.leave.a`       | Expanded  |                                                                                                                                                                                                                                                                                        |
| `faq.wrongExport.q` | Collapsed |                                                                                                                                                                                                                                                                                        |
| `faq.wrongExport.a` | Expanded  |                                                                                                                                                                                                                                                                                        |
| `faq.newPlays.q`    | Collapsed |                                                                                                                                                                                                                                                                                        |
| `faq.newPlays.a`    | Expanded  |                                                                                                                                                                                                                                                                                        |


## Choosing how to send

The small-import dialog and the saved-progress prompt are unchanged.


| ID                              | When                                      | Draft                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `choice.title`                  | Beta, ≥ 750 left, server has room         | {count} plays                                                                                                                                                                                                                                                                                                                         |
| `choice.lede`                   | Same                                      | This will take {days} days to scrobble. Scrobblify can now do it for you, or you can do it yourself by returning each day to scrobble.<br><br>(only if the user selected the checkbox to scrobble older tracks) Plays older than 2 weeks **will not have the correct date** and instead show the date of whenever they got scrobbled. |
| `choice.server`                 | Same                                      | Let Scrobblify scrobble for me                                                                                                                                                                                                                                                                                                        |
| `choice.fine`                   | Same                                      | You'll need to sign in {Details}                                                                                                                                                                                                                                                                                                      |
| `choice.details.dates`          | Details open                              | Only your username and tracks listened to are uploaded, nothing else. Once the scrobbling is done, your tracks are removed from the service.                                                                                                                                                                                         |
| `choice.details.dates.already`  | Details open, every play already re-dated |                                                                                                                                                                                                                                                                                                                                       |
| `choice.details.key`            | Details open                              | You can stop the import at any time by returning here, or by {revoking access } in last.fm                                                                                                                                                                                                                                            |
| `choice.details.upload`         | Details open                              |                                                                                                                                                                                                                                                                                                                                       |
| `choice.details.beta`           | Details open                              | This is in BETA. See anything weird? Email me at niko@savas.ca                                                                                                                                                                                                                                                                        |
| `choice.tab`                    | Same                                      | or {scrobble locally}                                                                                                                                                                                                                                                                                                                 |
| `choice.midRun`                 | Scrobble step, stopped, offer allowed     | Scrobble the rest for me -&gt;                                                                                                                                                                                                                                                                                                        |
| `scrobble.savedHint`            | Scrobble step, stopped, progress saved    | Stopped. You can resume at any time.                                                                                                                                                                                                                                                                                                  |
| `scrobble.savedHint.background` | Same, offer allowed                       | Stopped. You can resume at any time, or {have scrobblify scrobble the rest for you}.                                                                                                                                                                                                                                                  |


## Status page


| ID                            | When                                             | Draft                                                                                                                                                          |
| ----------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status.bar`                  | All states                                       | {done} / {total} · {pct}%                                                                                                                                      |
| `status.pause`                | `active`                                         | Pause                                                                                                                                                          |
| `status.resume`               | `paused`                                         | Resume                                                                                                                                                         |
| `status.moveBack`             | Most states                                      | Scrobble the rest locally                                                                                                                                      |
| `status.cancel`               | Most states                                      | Cancel                                                                                                                                                         |
| `status.safeToClose`          | `active`                                         | You can close this tab.                                                                                                                                        |
| `status.active`               | `active`                                         | This will finish around {date}                                                                                                                                 |
| `status.dayFull`              | `active`, today's share sent                     | Can't upload any more due to [last.fm](http://last.fm) rules. Will continue at {time}                                                                          |
| `status.paused`               | `paused`                                         | Paused                                                                                                                                                         |
| `status.needsReauth`          | `needs_reauth`                                   | Last.fm signed us out                                                                                                                                          |
| `status.needsReauth.button`   | `needs_reauth`                                   | Sign in again                                                                                                                                                  |
| `status.needsAttention`       | `needs_attention`                                | Scrobblify stopped after repeated errors. (The server's reason goes in a tooltip.) |
| `status.dormant`              | `dormant`                                        | You paused your scrobbling. We'll delete your progress from our servers after {date} (any tracks you've scrobbled will stay on last.fm)                        |
| `status.dormant.full`         | `dormant`, no room                               | Paused by scrobblify. A lot of people are scrobbling! Feel free to {buy me a coffee}(https://buymeacoffee.com/nikosavas) so I can run more servers! You can {scrobble locally} or try again later. |
| `status.dormant.button`       | `dormant`                                        | Reconnect                                                                                                                                                      |
| `status.exporting`            | `exporting`                                      | Downloading progress from scrobblify servers...                                                                                                                |
| `status.completed`            | `completed`                                      | Done                                                                                                                                                           |
| `status.rejected`             | `completed`, failed > 0                          | · {n} rejected by [Last.fm](http://Last.fm) (if this is unexpected please email niko@savas.ca)                                                                 |
| `status.completed.button`     | `completed`                                      | Check it out!                                                                                                                                                  |
| `status.failed`               | `failed`                                         | Scrobbling stopped. (The server's reason goes in a tooltip.) |
| `status.noSession`            | No server sign-in (14 days passed, other device) | Scrobblify is scrobbling for you, expecting to finish around {date}                                                                                            |
| `status.noSession.button`     | Same                                             | Sign in                                                                                                                                                        |
| `status.noSession.hint`       | Same                                             | Sign in to manage it                                                                                                                                       |
| `status.cancel.confirm.title` | Cancel clicked                                   | Stop scrobbling                                                                                                                                                |
| `status.cancel.confirm.body`  | Cancel clicked                                   | Your remaining tracks will be deleted from our servers. The {done} already scrobbled to last.fm will stay there.    |
| `status.cancel.confirm.yes`   | Cancel clicked                                   | Cancel                                                                                                                                                         |
| `status.cancel.confirm.no`    | Cancel clicked                                   | Keep scrobbling                                                                                                                                                |
| `status.checking`             | Asking the server whether a job exists           | Checking for active scrobbling...                                                                                                                              |


## Server unreachable


| ID                     | When                            | Draft                                                                    |
| ---------------------- | ------------------------------- | ------------------------------------------------------------------------ |
| `outage.body`          | No answer from the server       | Can't reach scrobblify servers right now.                                |
| `outage.retry`         | Same                            | Try again                                                                |
| `outage.continue`      | Same, no local ownership record | Continue locally anyway                                                  |
| `outage.continue.warn` | Same                            | If scrobblify server is also sending, you may get duplicates on last.fm. |


## Notices (one line above the page)

These are today's `backgroundNotice` messages, shortened. Each currently
shows in the banner; in the new design they share one alert line above the
status page or the steps.


| ID                              | When                                                | Draft                                                                                                                  |
| ------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `notice.sessionExpired`         | Ownership check needs a fresh server sign-in        | Sign in again so we can check your scrobbling progress.                                                                |
| `notice.sessionExpired.button`  | Same                                                | Fix now                                                                                                                |
| `notice.reauthUnreachable`      | Server sign-in couldn't start                       | Couldn't reach our server. Try again in a few minutes.                                                                 |
| `notice.reauthFailed`           | Server sign-in came back failed                     | Signing in to our server didn't work. Try again.                                                                       |
| `notice.reauthNeedsLastfm`      | Server sign-in with no Last.fm user                 | Sign in to Last.fm first, then try again.                                                                              |
| `notice.reauth.button`          | Generic server sign-in button                       | Sign in to our server                                                                                                  |
| `notice.liveElsewhere`          | Server says a job is running for this user          | Your import is running on our server, so this tab won't send anything.                                                 |
| `notice.handedOver`             | This browser handed its queue over, no job visible  | These tracks are now being scrobbled by scrobblify's servers.{ It has sent {done} of {total}.} Sign in to check on it. |
| `notice.staleCopy`              | This tab's queue is out of date                     | This tab is out of date. Reload to continue.                                                                           |
| `notice.handoffOtherTab`        | Another tab is handing over                         | Another tab is moving this import to our server. One moment.                                                           |
| `notice.handoffOtherTabStuck`   | That handover didn't finish                         | A handover in another tab didn't finish. Refresh in a few minutes.                                                     |
| `notice.handedOverCouldntClear` | Handed over, old local copy couldn't be deleted     | Your import is running on our server. This tab won't send anything.                                                    |
| `notice.handedOverOk`           | Handover finished                                   | Your import is now running on our server.                                                                              |
| `notice.ownershipUnknown`       | Couldn't confirm whether the server took over       | We couldn't check with our server, so this tab is on hold. Refresh in a few minutes.                                   |
| `notice.haltTimeout`            | Tab couldn't stop sending in time to hand over      | Couldn't pause this tab in time, so nothing was moved. Try again in a moment.                                          |
| `notice.atCapacity`             | Server full at handover                             | Our server is full right now. Keep going in this tab, or try later.                                                    |
| `notice.handoffFailed`          | Handover refused for another reason                 | Couldn't move this to our server. Nothing changed.                                                                     |
| `notice.handoffAbandoned`       | User came back without finishing Last.fm approval   | The move wasn't finished, so nothing changed.                                                                          |
| `notice.handoffNoToken`         | Last.fm approval came back without a token          | Last.fm didn't finish the approval, so nothing changed.                                                                |
| `notice.handoffNoSession`       | Approval came back without a session                | Last.fm didn't finish the approval, so nothing changed.                                                                |
| `notice.uploading`              | Uploading the queue                                 | Uploading your tracks… {done} of {total}                                                                               |
| `notice.handoffUnknown`         | Upload finished, result unknown                     | We can't tell if the move worked. Reload in a minute, and don't resume here until then.                                |
| `notice.uploadFailed`           | Upload failed                                       | The upload didn't finish. Nothing changed.                                                                             |
| `notice.movedBack`              | Move back succeeded                                 | Your tracks are back in this tab. Press Resume to carry on.                                                            |
| `notice.movedBack.uncertain`    | Move back, some sends unconfirmed                   | Your tracks are back in this tab. {n} may show up twice on Last.fm because we couldn't confirm them.                   |
| `notice.movedBackStuck`         | Copied back, but the server job couldn't be stopped | Your tracks are back, but our server hasn't stopped yet. Try Move back again in a moment.                              |
| `notice.moveBackFailed`         | Move back failed (error dialog)                     | Couldn't move your progress back. It's safe on our server.                                                             |
| `notice.holdOn.beta`            | Scrobble pressed while still checking (beta)        | One moment, still checking our server.                                                                                 |
| `notice.holdOn`                 | Same, not beta                                      | One moment, still getting ready.                                                                                       |

## Added after the first rewrite

| ID | When | Draft |
| --- | --- | --- |
| `choice.over60` | Server choice, more than 60 days of plays | That's more than 60 days of scrobbling, so you'll need to come back after 60 days and sign in again to finish. |
| `signin.checking.title` | Back from Last.fm after choosing | Signed in as {username} |
| `signin.checking.body` | Same, "Check for duplicates" ticked | Checking for plays already on Last.fm… |
| `signin.dupes.title` | Some plays were skipped as duplicates | {count} plays to scrobble |
| `signin.dupes.body` | Same | Skipped {skipped} that are already on Last.fm. |
| `signin.dupes.button` | Same | Start |
| `signin.nothing.title` | "Already scrobbling on scrobblify?", nothing anywhere | Nothing to resume |
| `signin.nothing.body` | Same | Scrobblify isn't scrobbling anything for you, and this browser has no saved progress. |
| `signin.nothing.button` | Same | Upload Spotify zip |
| `signin.nothing.file` | Same | Have a progress file? {Upload it here}. |
| `moveBack.explain.title` | "Scrobble the rest locally", this browser has no Last.fm sign-in | Scrobble the rest locally? |
| `moveBack.explain.body` | Same | Scrobblify talks to Last.fm in two ways, one for its server and one for your browser, so Last.fm will ask you to approve Scrobblify again. You won't lose your progress. |
| `moveBack.explain.yes` | Same | Continue to Last.fm |
| `moveBack.explain.no` | Same | Cancel |
| `status.needsAttention.button` | `needs_attention` (the server hit repeated errors; it can be resumed) | Try again |
| `status.noSession.otherDevice` | No server sign-in, and this browser didn't hand the import over (no progress numbers available) | Scrobblify is scrobbling for you! |
| `status.dormant.signedOut` | `dormant`, was signed out (day 60, or access revoked) before going on hold | Your sign-in to scrobblify expired. If you don't sign in before {date} we'll delete your progress from our servers (any tracks already scrobbled will stay on last.fm). |
| `status.dormant.errors` | `dormant`, was stopped by repeated errors before going on hold | Scrobblify stopped after repeated errors. Please let me know at niko@savas.ca |
| `status.newImport` | `completed` or `failed` job | Start a new import |
