// Food tab (route '#/food[/...]'; sub-segments are in route.value.rest):
//   '#/food' | '#/food/log'                 the home screen (log = Today's quick action, search input focused)
//   '#/food/scan' | '/search' | '/label'    add a food (one screen, segmented)
//   '#/food/meal' | '#/food/meal/<id>'      the meal builder
import '../styles/food.css'
import { route } from '../router'
import { FoodHome } from './food/FoodHome'
import { AddFood } from './food/AddFood'
import { MealBuilder } from './food/MealBuilder'

export function Food() {
  const r = route.value
  const rest = r.name === 'food' ? r.rest : []
  const head = rest[0]
  if (head === 'scan' || head === 'search' || head === 'label') return <AddFood mode={head} />
  if (head === 'meal') return <MealBuilder key={rest[1] ?? 'new'} id={rest[1] ?? null} />
  return <FoodHome focusSearch={head === 'log'} />
}
