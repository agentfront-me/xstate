// Log in, for people who already have an account: email, then password. There is no sign-up here; new people
// join from an invite email.

import { Redirect } from 'expo-router'
import { ChevronLeft, Eye, EyeOff } from 'lucide-react-native'
import { useState } from 'react'
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { queryClient } from '@/lib/account'
import { api, ApiError, errorMessage } from '@/lib/api'
import { isEmail } from '@/lib/format'
import { saveSession, type Session, useSession } from '@/lib/session'
import { Button, IconButton, Screen } from '@/ui/kit'
import { c } from '@/ui/theme'

export default function Login() {
  const { session } = useSession()
  const [step, setStep] = useState<'email' | 'password' | 'new'>('email')
  // After signing in with a temporary password an admin set: a short token that only lets them choose their own.
  const [changeToken, setChangeToken] = useState('')
  const [repeat, setRepeat] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [show, setShow] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  if (session) return <Redirect href="/" />

  function next() {
    const value = email.trim().toLowerCase()
    if (!isEmail(value)) return setError('Enter a valid email address.')
    setEmail(value)
    setError('')
    setStep('password')
  }

  async function logIn() {
    if (!password) return setError('Enter your password.')
    setBusy(true)
    setError('')
    try {
      const result = await api<Session>('POST', '/auth/login', { email, password }, { anonymous: true })
      queryClient.clear()
      await saveSession(result)
    } catch (err) {
      if (err instanceof ApiError && err.code === 'password_change_required' && typeof err.details?.changeToken === 'string') {
        setChangeToken(err.details.changeToken)
        setPassword('')
        setRepeat('')
        setShow(false)
        setStep('new')
      } else {
        setError(errorMessage(err))
      }
    } finally {
      setBusy(false)
    }
  }

  async function choose() {
    if (password.length < 8) return setError('Use at least 8 characters.')
    if (password !== repeat) return setError("The two passwords don't match.")
    setBusy(true)
    setError('')
    try {
      const result = await api<Session>('POST', '/auth/password/change', { changeToken, password }, { anonymous: true })
      queryClient.clear()
      await saveSession(result)
    } catch (err) {
      // The 15-minute token ran out: start again from the temporary password.
      if (err instanceof ApiError && err.code === 'invalid_token') {
        setStep('password')
        setPassword('')
      }
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Screen>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <View style={s.top}>
          {step !== 'email' ? (
            <IconButton
              icon={ChevronLeft}
              label="Back"
              size={26}
              onPress={() => {
                setStep('email')
                setPassword('')
                setError('')
              }}
            />
          ) : null}
        </View>

        <View style={s.body}>
          {step === 'email' ? (
            <>
              <Text style={s.title}>Log in to xstate</Text>
              <Text style={s.sub}>Use the email you signed up with.</Text>
              <TextInput
                value={email}
                onChangeText={setEmail}
                placeholder="you@company.com"
                placeholderTextColor={c.dim}
                style={s.input}
                autoFocus
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="email-address"
                textContentType="username"
                autoComplete="email"
                returnKeyType="next"
                onSubmitEditing={next}
              />
              {error ? <Text style={s.error}>{error}</Text> : null}
              <Button title="Continue" onPress={next} style={{ marginTop: 18 }} />
            </>
          ) : step === 'new' ? (
            <>
              <Text style={s.title}>Choose your password</Text>
              <Text style={s.sub}>You signed in to {email} with a temporary password. Choose your own to continue.</Text>
              <TextInput
                autoFocus
                value={password}
                onChangeText={setPassword}
                placeholder="New password (at least 8 characters)"
                placeholderTextColor={c.dim}
                style={s.input}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                textContentType="newPassword"
                autoComplete="new-password"
                returnKeyType="next"
              />
              <TextInput
                value={repeat}
                onChangeText={setRepeat}
                placeholder="Repeat it"
                placeholderTextColor={c.dim}
                style={[s.input, { marginTop: 12 }]}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                textContentType="newPassword"
                autoComplete="new-password"
                returnKeyType="go"
                onSubmitEditing={choose}
              />
              {error ? <Text style={s.error}>{error}</Text> : null}
              <Button title="Continue" onPress={choose} busy={busy} style={{ marginTop: 18 }} />
            </>
          ) : (
            <>
              <Text style={s.title}>Enter your password</Text>
              <Text style={s.sub}>{email}</Text>
              <View>
                <TextInput
                  autoFocus
                  value={password}
                  onChangeText={setPassword}
                  placeholder="Password"
                  placeholderTextColor={c.dim}
                  style={[s.input, { paddingRight: 52 }]}
                  secureTextEntry={!show}
                  autoCapitalize="none"
                  autoCorrect={false}
                  textContentType="password"
                  autoComplete="current-password"
                  returnKeyType="go"
                  onSubmitEditing={logIn}
                />
                <Pressable onPress={() => setShow((v) => !v)} hitSlop={8} accessibilityLabel={show ? 'Hide password' : 'Show password'} style={s.eye}>
                  {show ? <EyeOff color={c.muted} size={20} strokeWidth={1.75} /> : <Eye color={c.muted} size={20} strokeWidth={1.75} />}
                </Pressable>
              </View>
              {error ? <Text style={s.error}>{error}</Text> : null}
              <Button title="Log in" onPress={logIn} busy={busy} style={{ marginTop: 18 }} />
            </>
          )}
        </View>

        <Text style={s.footer}>No account? Ask your workspace admin for an invite.</Text>
      </KeyboardAvoidingView>
    </Screen>
  )
}

const s = StyleSheet.create({
  top: { height: 56, paddingHorizontal: 8, justifyContent: 'center' },
  body: { flex: 1, paddingHorizontal: 24, paddingTop: 64 },
  title: { color: c.text, fontSize: 26, fontWeight: '500' },
  sub: { color: c.muted, fontSize: 16, marginTop: 8, marginBottom: 24 },
  input: { height: 52, borderRadius: 12, backgroundColor: c.card, borderWidth: 1, borderColor: c.border, color: c.text, fontSize: 17, paddingHorizontal: 16 },
  eye: { position: 'absolute', right: 0, top: 0, width: 52, height: 52, alignItems: 'center', justifyContent: 'center' },
  error: { color: c.danger, fontSize: 14, marginTop: 10 },
  footer: { color: c.dim, fontSize: 14, textAlign: 'center', paddingHorizontal: 24, paddingBottom: 16 },
})
