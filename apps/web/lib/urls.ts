// Where the product lives. The dashboard, sign-up, sign-in and public file links are apps/app on go.xstate.com;
// in development that app runs on http://localhost:8787 (`pnpm --filter @xstate/app dev`).
export const APP_URL = process.env.NODE_ENV === 'development' ? 'http://localhost:8787' : 'https://go.xstate.com'

/** Always the live sign-up page, in development too, so "Start free" works without the local app running. */
export const SIGNUP_URL = 'https://go.xstate.com/signup'
export const LOGIN_URL = `${APP_URL}/login`
/** The signed-in dashboard. */
export const APP_HOME_URL = `${APP_URL}/app/`
