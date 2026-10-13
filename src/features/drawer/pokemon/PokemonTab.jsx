// @ts-check
import * as React from 'react'
import Divider from '@mui/material/Divider'
import List from '@mui/material/List'
import ListSubheader from '@mui/material/ListSubheader'
import { useTranslation } from 'react-i18next'

import { XXS_XXL, NUNDO_HUNDO } from '@assets/constants'
import { TabPanel } from '@components/TabPanel'
import { GenderListItem } from '@components/filters/Gender'
import { BoolToggle, DualBoolToggle } from '@components/inputs/BoolToggle'
import { useMemory } from '@store/useMemory'
import { PokemonSlider } from './PokemonSlider'

/**
 *
 * @param {{
 *  openTab: number,
 *  index: number,
 *  sliders: import('@rm/types').RMSlider[],
 * }} param0
 * @returns
 */
export function PokemonTabPanel({ openTab, index, sliders }) {
  const { t } = useTranslation()
  // Two gates, because neither alone is enough. `ui.pokemon.predictedShiny` is
  // the server's BLOCKED convention and covers the permission plus a scanner
  // source that reports the eligibility columns; `supportsShinyPrediction`
  // additionally covers "has a linked game account", which the drawer cannot
  // check because it is built synchronously.
  const showPredictedShiny = useMemory(
    (s) =>
      !!s.ui.pokemon?.predictedShiny &&
      !!s.featureFlags.supportsShinyPrediction,
  )
  return (
    <TabPanel value={openTab} index={index}>
      <List>
        {sliders.map((slider) => (
          <PokemonSlider key={slider.name} slider={slider} />
        ))}
        {index ? (
          <DualBoolToggle
            items={XXS_XXL}
            field="filters.pokemon.ivOr"
            label="size_1-size_5"
          />
        ) : (
          <>
            <GenderListItem
              disablePadding
              field="filters.pokemon.ivOr"
              sx={{ pt: 1 }}
            />
            <Divider sx={{ mt: 2, mb: 1 }} />
            <ListSubheader disableGutters>{t('quick_select')}</ListSubheader>
            <DualBoolToggle field="filters.pokemon" items={NUNDO_HUNDO} />
            {showPredictedShiny && (
              <BoolToggle
                field="filters.pokemon.predictedShiny"
                label="my_shinies"
              />
            )}
          </>
        )}
      </List>
    </TabPanel>
  )
}
