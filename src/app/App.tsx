import { route } from './router'
import { TabBar } from './components/TabBar'
import { Toasts } from './components/Toast'
import { Today } from './screens/Today'
import { Settings } from './screens/Settings'
import { ShortcutSetup } from './screens/ShortcutSetup'
import { TapLog } from './screens/TapLog'
import { RoutineEditor } from './screens/RoutineEditor'
import { ComingSoon } from './screens/ComingSoon'

const TAB_ROUTES = new Set(['today', 'food', 'lift', 'work', 'day'])

function Screen() {
  switch (route.value.name) {
    case 'today': return <Today />
    case 'food': return <ComingSoon title="Food" icon="food" milestone="Milestone 3" blurb="Calories and macros vs targets, one-tap meals, label and barcode entry." />
    case 'lift': return <ComingSoon title="Lift" icon="lift" milestone="Milestone 4" blurb="Push / Pull / Legs templates, one-tap set logging, PRs and progress charts." />
    case 'work': return <ComingSoon title="Work" icon="work" milestone="Milestone 5" blurb="Study and project sessions with what got done, per-project changelog." />
    case 'day': return <ComingSoon title="Day" icon="day" milestone="Milestone 2" blurb="The 24-hour ribbon: sleep, routine, workouts, Mac screen time and the gaps you can fill." />
    case 'settings': return <Settings />
    case 'shortcut': return <ShortcutSetup />
    case 'taps': return <TapLog />
    case 'routine': return <RoutineEditor />
  }
}

export function App() {
  const showTabs = TAB_ROUTES.has(route.value.name)
  return (
    <div class={showTabs ? 'app' : 'app no-tabs'}>
      <Screen />
      {showTabs && <TabBar />}
      <Toasts />
    </div>
  )
}
