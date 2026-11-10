// The small set of pieces every screen is built from.

import { ChevronLeft, type LucideIcon } from 'lucide-react-native'
import { Children, createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Animated,
  Pressable,
  type StyleProp,
  StyleSheet,
  Text,
  type TextStyle,
  View,
  type ViewStyle,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { router } from 'expo-router'
import { c, pad } from './theme'

/** A full screen on the app background, padded for the status bar. */
export function Screen({ children, bottom = true }: { children: ReactNode; bottom?: boolean }) {
  const insets = useSafeAreaInsets()
  return <View style={{ flex: 1, backgroundColor: c.bg, paddingTop: insets.top, paddingBottom: bottom ? insets.bottom : 0 }}>{children}</View>
}

export function IconButton({ icon: Icon, onPress, label, color = c.text, size = 22 }: { icon: LucideIcon; onPress?: () => void; label: string; color?: string; size?: number }) {
  return (
    <Pressable onPress={onPress} hitSlop={10} accessibilityRole="button" accessibilityLabel={label} style={({ pressed }) => [s.iconButton, pressed && { opacity: 0.5 }]}>
      <Icon color={color} size={size} strokeWidth={1.75} />
    </Pressable>
  )
}

/** The bar at the top of a screen: a left control, a title, and controls on the right. */
export function Header({ title, left, right, large = true }: { title?: string; left?: ReactNode; right?: ReactNode; large?: boolean }) {
  return (
    <View style={s.header}>
      {left}
      <Text numberOfLines={1} style={[large ? s.headerTitle : s.headerTitleSmall, { flex: 1 }]}>
        {title ?? ''}
      </Text>
      {right ? <View style={s.headerRight}>{right}</View> : null}
    </View>
  )
}

export const BackButton = () => <IconButton icon={ChevronLeft} label="Back" size={26} onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))} />

export const SectionLabel = ({ children, right }: { children: ReactNode; right?: ReactNode }) => (
  <View style={s.sectionLabel}>
    <Text style={s.sectionLabelText}>{children}</Text>
    {right}
  </View>
)

/** A rounded group of rows, with hairlines between them. */
export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const rows = Children.toArray(children)
  return (
    <View style={[s.card, style]}>
      {rows.map((row, i) => (
        <View key={i} style={i > 0 && s.cardDivider}>
          {row}
        </View>
      ))}
    </View>
  )
}

export function Row({ onPress, children, style }: { onPress?: () => void; children: ReactNode; style?: StyleProp<ViewStyle> }) {
  if (!onPress) return <View style={[s.row, style]}>{children}</View>
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [s.row, style, pressed && { backgroundColor: c.raised }]}>
      {children}
    </Pressable>
  )
}

/** An on/off switch drawn to the design (white track, dark knob), the same on iOS and Android. */
export function Toggle({ value, onChange, label }: { value: boolean; onChange: (on: boolean) => void; label: string }) {
  return (
    <Pressable onPress={() => onChange(!value)} hitSlop={8} accessibilityRole="switch" accessibilityState={{ checked: value }} accessibilityLabel={label} style={[s.toggle, value && { backgroundColor: c.white }]}>
      <View style={[s.knob, value ? { alignSelf: 'flex-end', backgroundColor: c.card } : { backgroundColor: c.muted }]} />
    </Pressable>
  )
}

export function Avatar({ text, size = 32 }: { text: string; size?: number }) {
  return (
    <View style={[s.avatar, { width: size, height: size, borderRadius: size / 2 }]}>
      <Text style={{ color: c.soft, fontSize: size * 0.4, fontWeight: '500' }}>{text}</Text>
    </View>
  )
}

type ButtonProps = { title: string; onPress?: () => void; busy?: boolean; disabled?: boolean; variant?: 'primary' | 'secondary' | 'danger'; small?: boolean; style?: StyleProp<ViewStyle> }

export function Button({ title, onPress, busy, disabled, variant = 'primary', small, style }: ButtonProps) {
  const primary = variant === 'primary'
  const color = primary ? c.card : variant === 'danger' ? c.danger : c.text
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      accessibilityRole="button"
      style={({ pressed }) => [
        s.button,
        small && s.buttonSmall,
        primary ? { backgroundColor: c.white } : { backgroundColor: c.card, borderWidth: 1, borderColor: c.border },
        (disabled || busy) && { opacity: 0.5 },
        pressed && { opacity: 0.8 },
        style,
      ]}
    >
      {busy ? <ActivityIndicator color={color} /> : <Text style={{ color, fontSize: small ? 15 : 17, fontWeight: '500' }}>{title}</Text>}
    </Pressable>
  )
}

export const Empty = ({ children }: { children: ReactNode }) => <Text style={s.empty}>{children}</Text>

export const Loading = () => (
  <View style={{ paddingVertical: 48, alignItems: 'center' }}>
    <ActivityIndicator color={c.dim} />
  </View>
)

/** What a list shows when its request failed. */
export function Failed({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <View style={{ padding: 32, alignItems: 'center', gap: 16 }}>
      <Text style={{ color: c.muted, fontSize: 15, textAlign: 'center' }}>{message}</Text>
      <Button title="Try again" variant="secondary" small onPress={onRetry} />
    </View>
  )
}

export const T = {
  title: { color: c.text, fontSize: 17 } satisfies TextStyle,
  body: { color: c.soft, fontSize: 16, lineHeight: 24 } satisfies TextStyle,
  sub: { color: c.dim, fontSize: 13 } satisfies TextStyle,
  muted: { color: c.muted, fontSize: 15 } satisfies TextStyle,
}

// ---------------------------------------------------------------------------------------------------------------
// Toast: one short line at the bottom, gone after a moment.

const ToastContext = createContext<(message: string) => void>(() => undefined)
export const useToast = () => useContext(ToastContext)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState<string | null>(null)
  const opacity = useState(() => new Animated.Value(0))[0]
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const insets = useSafeAreaInsets()

  const show = useCallback(
    (text: string) => {
      if (timer.current) clearTimeout(timer.current)
      setMessage(text)
      Animated.timing(opacity, { toValue: 1, duration: 150, useNativeDriver: true }).start()
      timer.current = setTimeout(() => {
        Animated.timing(opacity, { toValue: 0, duration: 200, useNativeDriver: true }).start(() => setMessage(null))
      }, 2200)
    },
    [opacity],
  )

  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), [])

  return (
    <ToastContext.Provider value={show}>
      {children}
      {message ? (
        <Animated.View pointerEvents="none" style={[s.toast, { bottom: insets.bottom + 84, opacity }]}>
          <Text style={{ color: c.card, fontSize: 15, fontWeight: '500' }}>{message}</Text>
        </Animated.View>
      ) : null}
    </ToastContext.Provider>
  )
}

const s = StyleSheet.create({
  iconButton: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', height: 56, paddingHorizontal: 8, gap: 4 },
  headerTitle: { color: c.text, fontSize: 22, fontWeight: '500', paddingLeft: 4 },
  headerTitleSmall: { color: c.text, fontSize: 17, fontWeight: '500', paddingLeft: 4 },
  headerRight: { flexDirection: 'row', alignItems: 'center' },
  sectionLabel: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: pad, paddingTop: 24, paddingBottom: 8 },
  sectionLabelText: { color: c.dim, fontSize: 12, letterSpacing: 0.8, textTransform: 'uppercase' },
  card: { backgroundColor: c.card, borderRadius: 14, marginHorizontal: pad, overflow: 'hidden' },
  cardDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 14, minHeight: 52 },
  toggle: { width: 50, height: 30, borderRadius: 15, padding: 3, backgroundColor: c.borderStrong, justifyContent: 'center' },
  knob: { width: 24, height: 24, borderRadius: 12 },
  avatar: { backgroundColor: c.border, alignItems: 'center', justifyContent: 'center' },
  button: { height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 20 },
  buttonSmall: { height: 40, borderRadius: 20, paddingHorizontal: 16 },
  empty: { color: c.dim, fontSize: 15, textAlign: 'center', paddingVertical: 40, paddingHorizontal: 32 },
  toast: { position: 'absolute', alignSelf: 'center', backgroundColor: c.white, paddingHorizontal: 16, paddingVertical: 10, borderRadius: 20 },
})
