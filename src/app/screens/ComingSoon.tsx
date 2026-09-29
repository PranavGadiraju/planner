// Placeholder for tabs that later milestones fill in (Food, Lift, Work, Day).
import { TopBar } from '../components/TopBar'
import { Icon, type IconName } from '../components/Icon'

export function ComingSoon({ title, icon, milestone, blurb }: { title: string; icon: IconName; milestone: string; blurb: string }) {
  return (
    <>
      <TopBar title={title} />
      <main class="content fade">
        <div class="placeholder">
          <div class="glyph"><Icon name={icon} size={30} /></div>
          <h2>{title} is coming</h2>
          <p class="small">{blurb}</p>
          <span class="badge">{milestone}</span>
        </div>
      </main>
    </>
  )
}
