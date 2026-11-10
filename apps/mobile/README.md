# xstate mobile

The xstate app for iOS and Android, built with Expo (SDK 58) and Expo Router. It talks to the same API as the web
app (`apps/api`, served at `api.xstate.com`).

## Run it

```bash
pnpm install                      # from the repo root
cd apps/mobile
pnpm ios                          # builds the dev client and opens it in the iOS simulator
pnpm android                      # the same for an Android emulator
pnpm start                        # just the bundler, once a dev client is installed
```

The app uses native modules (secure storage), so it needs its own dev client and doesn't run in Expo Go.

It points at `https://api.xstate.com/v1` by default. To use another API (a local `wrangler dev`, say), copy
`.env.example` to `.env.local` and change `EXPO_PUBLIC_API_URL`.

## Builds: development, preview, production

`eas.json` has one profile for each. `APP_VARIANT` picks the name and bundle id (`app.config.ts`), so all three
can sit on one phone.

| Profile       | Name             | Bundle id                | For                                  |
| ------------- | ---------------- | ------------------------ | ------------------------------------ |
| `development` | xstate (Dev)     | `com.xstate.app.dev`     | A dev client on your phone           |
| `preview`     | xstate (Preview) | `com.xstate.app.preview` | Testers (ad hoc on iOS, APK on Android) |
| `production`  | xstate           | `com.xstate.app`         | App Store and Play Store             |

First time, signed in to Expo (`eas login`):

```bash
eas init                # links the app to your Expo account, writes the project id to app.json
eas update:configure    # turns on over-the-air updates (writes updates.url to app.json)
```

Then:

```bash
pnpm build:preview              # eas build --profile preview (asks which platform)
pnpm build:production
eas submit --profile production # sends the production build to the stores
pnpm update:preview             # a JS-only fix to preview builds, no new build needed
pnpm update:production
```

Every profile uses the production API for now, because it is the only one. When there is a staging API, change
`EXPO_PUBLIC_API_URL` under `preview` in `eas.json`.

## Layout

- `src/app` — screens (Expo Router). `login.tsx` is public; everything in `(app)` needs a session.
- `src/sections` — the four sections of the home screen (Email, Users, Storage, Agents) and the drawer.
- `src/lib` — the API client, the session (kept in the keychain), types and formatting.
- `src/ui` — colours and the shared pieces (header, card, row, button, toast).
