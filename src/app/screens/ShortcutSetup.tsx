// The exact recipe for the "Planner Tap" Shortcut, the six NFC automations and the wind-down reminder.
import { SubBar } from '../components/TopBar'
import { Icon } from '../components/Icon'
import { toast } from '../components/Toast'
import { allRoutineItems, settings, today } from '../data/store'
import { minusMinutes } from '../data/format'

async function copy(text: string, what: string): Promise<void> {
  try { await navigator.clipboard.writeText(text); toast(`${what} copied`) } catch { toast('Copy failed — select the text instead', { kind: 'danger' }) }
}

export function ShortcutSetup() {
  const url = `${location.origin}/api/tap`
  const s = settings.value
  const items = (today.value?.routine_items ?? allRoutineItems.value).filter((i) => i.active && !i.deleted_at)
  const windAt = minusMinutes(s.bed_target, s.winddown_min)
  return (
    <>
      <SubBar title="Shortcut & NFC" fallback="#/settings" />
      <main class="content no-tabs fade">
        <section class="card">
          <div class="card-head"><span class="card-title">Endpoint</span><button type="button" class="btn btn-sm btn-ghost" onClick={() => copy(url, 'URL')}><Icon name="copy" size={16} /> Copy</button></div>
          <div class="code-box">{url}</div>
          <dl class="kv" style={{ marginTop: '12px' }}>
            <dt>Method</dt><dd class="mono">POST</dd>
            <dt>Header</dt><dd class="mono">Authorization: Bearer &lt;SHORTCUT_TOKEN&gt;</dd>
            <dt>Body</dt><dd class="mono">JSON · item = Shortcut Input</dd>
            <dt>Reply</dt><dd class="mono">{'{ok, action, item, local_day, message}'}</dd>
          </dl>
        </section>

        <section class="card">
          <div class="card-head"><span class="card-title">Item slugs</span><span class="small faint">what each tag sends</span></div>
          <div class="row-wrap">
            {items.map((i) => (
              <button type="button" key={i.id} class="chip" onClick={() => copy(i.id, i.id)} title={i.name}>
                <span class="mono">{i.id}</span><span class="faint small">{i.name}</span>
              </button>
            ))}
            <button type="button" class="chip" onClick={() => copy('bed', 'bed')}><span class="mono">bed</span><span class="faint small">nightstand</span></button>
            <button type="button" class="chip" onClick={() => copy('wake', 'wake')}><span class="mono">wake</span><span class="faint small">optional</span></button>
            <button type="button" class="chip" onClick={() => copy('winddown', 'winddown')}><span class="mono">winddown</span><span class="faint small">reminder</span></button>
          </div>
          <p class="small muted" style={{ marginTop: '10px' }}>Routine tags: first tap starts, second tap (3+ min later) finishes. The first routine tap of the morning also marks you awake.</p>
        </section>

        <section class="card">
          <div class="card-head"><span class="card-title">1 · The "Planner Tap" shortcut</span></div>
          <ol class="steps">
            <li>Buy plain <strong>NTAG213</strong> stickers (25 mm). Do <strong>not</strong> write URL records to them; leave them blank.</li>
            <li>Shortcuts → <strong>+</strong> → name it <code>Planner Tap</code>.</li>
            <li>Add <strong>Get Contents of URL</strong>: URL <code>{url}</code>, Method <code>POST</code>. Under Headers add <code>Authorization</code> = <code>Bearer &lt;SHORTCUT_TOKEN&gt;</code>. Request Body <code>JSON</code>, one field: key <code>item</code>, value <strong>Shortcut Input</strong>.</li>
            <li>Add <strong>Get Dictionary Value</strong>: get value for key <code>ok</code> in <em>Contents of URL</em>.</li>
            <li>Add <strong>If</strong>: <em>Dictionary Value</em> <code>is</code> <code>true</code> → inside (optional): <strong>Get Dictionary Value</strong> for key <code>message</code> → <strong>Show Notification</strong> with it, e.g. "Run done · 41 min".</li>
            <li>In the <em>Otherwise</em> branch: <strong>Show Notification</strong> <code>Planner failed: [Shortcut Input]</code>. (Get Contents of URL does not fail on a 4xx body, and a missing value never satisfies "is true", so a bad token, a typo or a non-JSON reply always lands here.)</li>
            <li>Run it once by hand with input <code>shower</code> and choose <strong>Always Allow</strong> for the network request. Then check the tap log here.</li>
          </ol>
        </section>

        <section class="card">
          <div class="card-head"><span class="card-title">2 · Six NFC automations</span></div>
          <ol class="steps">
            <li>Shortcuts → <strong>Automation</strong> → <strong>+</strong> → <strong>NFC</strong> → <strong>Scan</strong> the sticker and name it after its slug.</li>
            <li>Choose <strong>Run Immediately</strong> and turn on <strong>Notify When Run</strong> for the first week.</li>
            <li>Action: <strong>Run Shortcut</strong> → <code>Planner Tap</code> with <strong>Input</strong> set to the slug text, e.g. <code>shower</code>.</li>
            <li>Repeat for <code>{items.map((i) => i.id).concat('bed').join('</code>, <code>')}</code>. Shortcuts keys on the tag UID, so every sticker needs its own automation.</li>
            <li>Gesture: raise the phone (Face ID), touch the top edge to the sticker for about a second; nothing opens. The screen must be on and the phone unlocked once since boot.</li>
          </ol>
        </section>

        <section class="card">
          <div class="card-head"><span class="card-title">3 · Wind-down reminder</span><span class="badge badge-sleep num">{windAt}</span></div>
          <ol class="steps">
            <li>Automation → <strong>+</strong> → <strong>Time of Day</strong> → <code>{windAt}</code> daily (bed target {s.bed_target} − {s.winddown_min} min), Run Immediately.</li>
            <li>Action: <strong>Show Notification</strong> <code>Wind down, bed by {s.bed_target}</code>.</li>
            <li>Optional: also <strong>Run Shortcut</strong> <code>Planner Tap</code> with input <code>winddown</code> to get the streak in a second notification.</li>
            <li>Edit this automation by hand whenever the bed target changes; Settings reminds you.</li>
          </ol>
        </section>

        <section class="card">
          <div class="card-head"><span class="card-title">Good to know</span></div>
          <ul class="steps" style={{ listStyle: 'disc' }}>
            <li>Automations do not sync through iCloud; set them up on the phone that carries the stickers.</li>
            <li>iOS updates have flipped automations back to "Ask before running". Re-check <strong>Run Immediately</strong> after each update.</li>
            <li>Every tap, including duplicates and rejects, is listed in the NFC tap log.</li>
          </ul>
        </section>
      </main>
    </>
  )
}
