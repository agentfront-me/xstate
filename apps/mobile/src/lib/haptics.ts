// A short vibration for the actions that change something: a firm tap the moment a swipe commits (pin, archive),
// and Apple's success, warning or error pattern when the server answers (sent, approved, rejected, failed).
// Fire and forget: a phone without haptics (or with them turned off) just does nothing, and so does a build made
// before expo-haptics was added (its native module is missing there, and importing it would throw).

type HapticsModule = typeof import('expo-haptics')

let Haptics: HapticsModule | null = null
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  Haptics = require('expo-haptics') as HapticsModule
} catch {
  Haptics = null
}

const run = (fn: (h: HapticsModule) => Promise<void>) => {
  if (Haptics) void fn(Haptics).catch(() => {})
}

export const haptic = {
  /** A swipe let go past halfway. */
  tap: () => run((h) => h.impactAsync(h.ImpactFeedbackStyle.Medium)),
  /** Sent, approved. */
  success: () => run((h) => h.notificationAsync(h.NotificationFeedbackType.Success)),
  /** Rejected. */
  warning: () => run((h) => h.notificationAsync(h.NotificationFeedbackType.Warning)),
  /** The server said no. */
  error: () => run((h) => h.notificationAsync(h.NotificationFeedbackType.Error)),
}
