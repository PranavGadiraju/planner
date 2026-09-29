// The Work tab's "Suggested" section: today's and yesterday's Mac-derived session suggestions with the same
// controls as Today's card plus Edit times before logging. Hidden when neither day has anything to suggest.
import { useEffect } from 'preact/hooks'
import { addDays } from '@shared/tz'
import { SuggestionItem } from '../../components/SuggestionCard'
import { localToday } from '../../data/store'
import { suggestState, suggestionKey, visibleSuggestions, watchSuggestions, type Suggestion, type SuggestionsPayload } from '../../data/suggest'

interface Group { day: string; label: string; data: SuggestionsPayload; list: Suggestion[] }

export function SuggestedCard() {
  const day = localToday.value
  const yesterday = addDays(day, -1)
  useEffect(() => watchSuggestions([day, yesterday]), [day, yesterday])
  const groups: Group[] = []
  for (const [d, label] of [[day, 'Today'], [yesterday, 'Yesterday']] as const) {
    const data = suggestState(d).value.data
    const list = visibleSuggestions(d)
    if (data && list.length) groups.push({ day: d, label, data, list })
  }
  if (groups.length === 0) return null
  return (
    <section class="card sg-card" aria-label="Suggested sessions">
      <div class="card-head">
        <span class="card-title">Suggested</span>
        <span class="small faint">Mac dev time outside any session</span>
      </div>
      <div class="stack-sm">
        {groups.map((g) => (
          <div key={g.day}>
            <div class="sg-day">{g.label}</div>
            <div class="sg-list">
              {g.list.map((s) => <SuggestionItem key={suggestionKey(s)} s={s} day={g.day} payload={g.data} editable />)}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
