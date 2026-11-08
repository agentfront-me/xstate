// Where the product lives. The dashboard, sign-up, sign-in and public file links are apps/app on go.xstate.com;
// in development that app runs on http://localhost:8787 (`pnpm --filter @xstate/app dev`).
export const APP_URL = process.env.NODE_ENV === 'development' ? 'http://localhost:8787' : 'https://go.xstate.com'

export const SIGNUP_URL = `${APP_URL}/signup`
export const LOGIN_URL = `${APP_URL}/login`
