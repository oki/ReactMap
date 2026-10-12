// @ts-check
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { ApolloError, useMutation, useQuery } from '@apollo/client'
import List from '@mui/material/List'
import ListSubheader from '@mui/material/ListSubheader'
import ListItem from '@mui/material/ListItem'
import ListItemButton from '@mui/material/ListItemButton'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import Box from '@mui/material/Box'

import { useMemory } from '@store/useMemory'
import { useFormatStore } from '@store/useFormatStore'
import { Query } from '@services/queries'

/** Codes the server reports that have a message of their own */
const ERROR_KEYS = new Set([
  'invalid_friend_code',
  'game_account_limit_reached',
])

/**
 * Write only - the friend code is sent to the server and never read back, so
 * the input is always empty and the status line only ever shows the last 4
 * digits of what is stored.
 */
export function UserGameAccount() {
  const { t } = useTranslation()
  const hasPerm = useMemory((s) => s.auth.perms.shinyPrediction)
  const dateFormat = useFormatStore((s) => s.dateFormat)

  const [friendCode, setFriendCode] = React.useState('')
  const [errorKey, setErrorKey] = React.useState('')

  /**
   * @type {import('@apollo/client').QueryResult<{
   *   gameAccountStatus: {
   *     linked: boolean
   *     friendCodeLast4: string | null
   *     updatedAt: number | null
   *   } | null
   * }>}
   */
  const { data } = useQuery(Query.user('GAME_ACCOUNT_STATUS'), {
    fetchPolicy: 'no-cache',
    skip: !hasPerm,
  })

  const [link, { loading }] = useMutation(Query.user('LINK_GAME_ACCOUNT'), {
    refetchQueries: ['GameAccountStatus'],
  })

  const handleSave = React.useCallback(async () => {
    if (!friendCode || loading) return
    setErrorKey('')
    try {
      await link({ variables: { friendCode } })
      setFriendCode('')
    } catch (err) {
      const code = err instanceof ApolloError ? err.message : ''
      setErrorKey(ERROR_KEYS.has(code) ? code : 'game_account_error_generic')
    }
  }, [friendCode, link, loading])

  const handleChange = React.useCallback((event) => {
    setErrorKey('')
    setFriendCode(event.target.value)
  }, [])

  if (!hasPerm) return null

  const status = data?.gameAccountStatus

  return (
    <Box className="flex-center">
      <List>
        <ListSubheader>
          <Typography variant="h6" align="center">
            {t('game_account')}
          </Typography>
        </ListSubheader>
        <ListItem sx={{ flexDirection: 'column', alignItems: 'stretch' }}>
          <Typography variant="body2">
            {status?.linked
              ? t('game_account_linked', { last4: status.friendCodeLast4 })
              : t('game_account_not_linked')}
          </Typography>
          {status?.linked && status.updatedAt ? (
            <Typography variant="caption">
              {t('last_updated')}: {dateFormat.format(status.updatedAt * 1000)}
            </Typography>
          ) : null}
        </ListItem>
        <ListItem sx={{ flexDirection: 'column', alignItems: 'stretch' }}>
          <TextField
            label={t('friend_code')}
            fullWidth
            size="small"
            variant="outlined"
            value={friendCode}
            onChange={handleChange}
            inputProps={{ inputMode: 'numeric', autoComplete: 'off' }}
          />
          <ListItemButton
            disabled={!friendCode || loading}
            onClick={handleSave}
          >
            {t('save')}
          </ListItemButton>
          <Typography variant="caption">
            {t('game_account_write_only')}
          </Typography>
          {errorKey ? (
            <Typography variant="caption" color="error">
              {t(errorKey)}
            </Typography>
          ) : null}
        </ListItem>
      </List>
    </Box>
  )
}
