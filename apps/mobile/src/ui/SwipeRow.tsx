// A list row that can be swiped away, as in the inbox: it follows the finger; let go past halfway (or flick) and it
// slides off the screen and the list closes up, otherwise it springs back. Each direction uncovers its own coloured
// side with an icon and a word. The caller makes the change once the row is gone, and gives the row a new key when
// the item comes back changed, which is what shows it again.

import type { LucideIcon } from 'lucide-react-native'
import type { ReactNode } from 'react'
import { StyleSheet, Text, useWindowDimensions, View } from 'react-native'
import { GestureDetector, usePanGesture } from 'react-native-gesture-handler'
import Animated, { useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated'
import { scheduleOnRN } from 'react-native-worklets'
import { c } from './theme'

/** `ink`: the icon and label colour on `color` (dark on a light colour). */
export type SwipeSide = { icon: LucideIcon; label: string; color: string; ink?: string; onDone: () => void }

/** `right`: what swiping right does (its side shows on the left). `left`: what swiping left does. */
export function SwipeRow({ children, right, left }: { children: ReactNode; right: SwipeSide; left: SwipeSide }) {
  const { width } = useWindowDimensions()
  const x = useSharedValue(0)
  // -1 until measured; then the row's height, which runs down to 0 once it has slid away.
  const height = useSharedValue(-1)
  const leaving = useSharedValue(false)

  const done = (direction: number) => (direction > 0 ? right : left).onDone()

  const pan = usePanGesture({
    // Only a sideways drag starts it, so scrolling the list never swipes a row by mistake.
    activeOffsetX: [-14, 14],
    failOffsetY: [-12, 12],
    onUpdate: (e) => {
      'worklet'
      if (!leaving.get()) x.set(e.translationX)
    },
    onDeactivate: (e) => {
      'worklet'
      if (leaving.get()) return
      const moved = e.translationX
      const past = Math.abs(moved) > width / 2 || (Math.abs(e.velocityX) > 900 && Math.abs(moved) > 60 && moved * e.velocityX > 0)
      if (!past) {
        x.set(withSpring(0, { damping: 24, stiffness: 260 }))
        return
      }
      const direction = moved > 0 ? 1 : -1
      leaving.set(true)
      x.set(
        withTiming(direction * width, { duration: 170 }, () => {
          height.set(
            withTiming(0, { duration: 180 }, () => {
              scheduleOnRN(done, direction)
            }),
          )
        }),
      )
    },
    onFinalize: () => {
      'worklet'
      // Interrupted (a call, the list scrolling): put it back.
      if (!leaving.get() && x.get() !== 0) x.set(withSpring(0, { damping: 24, stiffness: 260 }))
    },
  })

  const collapse = useAnimatedStyle(() => (height.get() < 0 ? {} : { height: height.get(), overflow: 'hidden' }))
  const slide = useAnimatedStyle(() => ({ transform: [{ translateX: x.get() }] }))
  const showRight = useAnimatedStyle(() => ({ opacity: x.get() > 0 ? 1 : 0 }))
  const showLeft = useAnimatedStyle(() => ({ opacity: x.get() < 0 ? 1 : 0 }))

  return (
    <Animated.View
      style={collapse}
      onLayout={(e) => {
        if (height.get() < 0) height.set(e.nativeEvent.layout.height)
      }}
    >
      <Animated.View style={[s.side, { backgroundColor: right.color }, showRight]}>
        <right.icon color={right.ink ?? c.white} size={20} strokeWidth={2} />
        <Text style={[s.label, { color: right.ink ?? c.white }]}>{right.label}</Text>
      </Animated.View>
      <Animated.View style={[s.side, { backgroundColor: left.color, flexDirection: 'row-reverse' }, showLeft]}>
        <left.icon color={left.ink ?? c.white} size={20} strokeWidth={2} />
        <Text style={[s.label, { color: left.ink ?? c.white }]}>{left.label}</Text>
      </Animated.View>
      <GestureDetector gesture={pan}>
        <Animated.View style={slide}>
          <View>{children}</View>
        </Animated.View>
      </GestureDetector>
    </Animated.View>
  )
}

const s = StyleSheet.create({
  side: { ...StyleSheet.absoluteFill, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 22 },
  label: { fontSize: 16, fontWeight: '500' },
})
