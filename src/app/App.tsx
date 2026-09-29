import { route } from './router'
import { TabBar } from './components/TabBar'
import { Toasts } from './components/Toast'
import { Today } from './screens/Today'
import { Settings } from './screens/Settings'
import { ShortcutSetup } from './screens/ShortcutSetup'
import { TapLog } from './screens/TapLog'
import { RoutineEditor } from './screens/RoutineEditor'
import { Day } from './screens/Day'
import { Food } from './screens/Food'
import { Lift } from './screens/Lift'
import { Work } from './screens/Work'

const TAB_ROUTES = new Set(['today', 'food', 'lift', 'work', 'day'])

function Screen() {
  switch (route.value.name) {
    case 'today': return <Today />
    case 'food': return <Food />
    case 'lift': return <Lift />
    case 'work': return <Work />
    case 'day': return <Day />
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
