// Throttles sign-in and sign-up, with the Workers rate limiters bound in wrangler.jsonc.
// Limits are soft: going over answers 429 for the rest of the minute, and nobody is locked out for longer.
// Each check returns the message to refuse with, or null to go ahead; auth/service.ts turns it into a 429.

export type ThrottleEnv = Pick<Env, 'LOGIN_IP_RATE' | 'LOGIN_EMAIL_RATE' | 'REGISTER_IP_RATE'>

/**
 * Before the password is checked: 10 attempts a minute per IP (password spraying) and 5 per email address (one
 * account guessed from many IPs). Every attempt counts, right or wrong, so the answer doesn't hint at the password.
 * Without an IP (a call that didn't come over HTTP) only the email limit applies.
 */
export async function loginThrottled(env: ThrottleEnv, email: string, ip: string | undefined): Promise<string | null> {
  const [byIp, byEmail] = await Promise.all([
    ip ? env.LOGIN_IP_RATE.limit({ key: ip }) : { success: true },
    env.LOGIN_EMAIL_RATE.limit({ key: email }),
  ])
  return byIp.success && byEmail.success ? null : 'Too many sign-in attempts. Wait a minute and try again.'
}

/** 5 sign-ups a minute per IP. */
export async function registerThrottled(env: ThrottleEnv, ip: string | undefined): Promise<string | null> {
  if (!ip) return null
  const { success } = await env.REGISTER_IP_RATE.limit({ key: ip })
  return success ? null : 'Too many sign-ups from this network. Wait a minute and try again.'
}
