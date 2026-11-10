// Logging out: stop notifications to this phone, forget the session, drop everything cached.

import { queryClient } from './account'
import { removeDevice } from './push'
import { clearSession } from './session'

export async function signOut(): Promise<void> {
  await removeDevice()
  await clearSession()
  queryClient.clear()
}
