// Log in, for people who already have an account: email, then password. There is no sign-up here; new people
// join from an invite email.

import { Redirect } from 'expo-router'
import { ChevronLeft, Eye, EyeOff } from 'lucide-react-native'
import { useState } from 'react'
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { queryClient } from '@/lib/account'
import { api, errorMessage } from '@/lib/api'
import { isEmail } from '@/lib/format'
import { saveSession, type Session, useSession } from '@/lib/session'
import { Button, IconButton, Screen } from '@/ui/kit'
import { c } from '@/ui/theme'

export default function Login() {
  const { session } = useSession()
  const [step, setStep] = useState<'email' | 'password'>('email')
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
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Screen>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <View style={s.top}>
          {step === 'password' ? (
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
