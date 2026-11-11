// The design's loader: a 22px ring, grey with a blue top arc, turning once every 0.8s. And pull to refresh built on
// it, as in the prototype's inbox: pulling the list down fades the ring in and turns it with the finger (fully shown
// at 60px); let go past that and the list keeps a 56px gap at the top with the ring spinning until the refresh is
// done. iPhone lists stretch past the top, which is what this follows; Android lists don't, so there the caller keeps
// the system RefreshControl (in the same colours, see `ringColors`).

import { useEffect, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import Animated, {
  cancelAnimation,
  Easing,
  type SharedValue,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated'
import { scheduleOnRN } from 'react-native-worklets'
import { c } from './theme'

const SIZE = 22
/** How far to pull before letting go refreshes, and the gap kept open while it does. */
const TRIGGER = 60
const GAP = 56

export const ringColors = { track: c.ringTrack, head: c.ringHead }

const ring = {
  width: SIZE,
  height: SIZE,
  borderRadius: SIZE / 2,
  borderWidth: 2.5,
  borderColor: c.ringTrack,
  borderTopColor: c.ringHead,
}

/** The ring, spinning. */
export function Spinner() {
  const turn = useSharedValue(0)
  useEffect(() => {
    turn.set(withRepeat(withTiming(360, { duration: 800, easing: Easing.linear }), -1, false))
    return () => cancelAnimation(turn)
  }, [turn])
  const style = useAnimatedStyle(() => ({ transform: [{ rotate: `${turn.get()}deg` }] }))
  return <Animated.View accessibilityRole="progressbar" accessibilityLabel="Loading" style={[ring, style]} />
}

/** State and pieces for a list's pull to refresh. `refresh` also suits a Retry button or Android's RefreshControl. */
export function usePullToRefresh(onRefresh: () => Promise<unknown>) {
  const pull = useSharedValue(0)
  const busy = useSharedValue(false)
  const [refreshing, setRefreshing] = useState(false)

  async function refresh() {
    busy.set(true)
    setRefreshing(true)
    try {
      await onRefresh()
    } catch {
      // The list shows its own error.
    } finally {
      setRefreshing(false)
      busy.set(false)
    }
  }

  const onScroll = useAnimatedScrollHandler({
    onScroll: (e) => {
      pull.set(Math.max(0, -e.contentOffset.y))
    },
    onEndDrag: (e) => {
      if (-e.contentOffset.y >= TRIGGER && !busy.get()) {
        busy.set(true)
        scheduleOnRN(refresh)
      }
    },
  })

  return { pull, refreshing, refresh, onScroll }
}

/** Goes over the top of the list: the ring that follows the pull, centred in the space the pull opens. */
export function PullIndicator({ pull, refreshing }: { pull: SharedValue<number>; refreshing: boolean }) {
  const style = useAnimatedStyle(() => {
    const p = pull.get()
    return {
      opacity: refreshing ? 0 : Math.min(1, p / TRIGGER),
      transform: [{ translateY: p / 2 - SIZE / 2 }, { rotate: `${p * 4}deg` }],
    }
  })
  return (
    <View pointerEvents="none" style={s.indicator}>
      <Animated.View style={[ring, style]} />
    </View>
  )
}

/** The list's header: the gap with the spinning ring while it refreshes, closing when done. */
export function PullHeader({ refreshing }: { refreshing: boolean }) {
  const height = useSharedValue(0)
  useEffect(() => {
    height.set(withTiming(refreshing ? GAP : 0, { duration: 200, easing: Easing.out(Easing.quad) }))
  }, [refreshing, height])
  const style = useAnimatedStyle(() => ({ height: height.get() }))
  return <Animated.View style={[s.header, style]}>{refreshing ? <Spinner /> : null}</Animated.View>
}

const s = StyleSheet.create({
  indicator: { position: 'absolute', top: 0, left: 0, right: 0, alignItems: 'center', zIndex: 1 },
  header: { alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
})
