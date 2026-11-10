// Write a message: a reply (opened from a conversation) or a new one.

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { router, useLocalSearchParams } from 'expo-router'
import { ArrowUp } from 'lucide-react-native'
import { useState } from 'react'
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { useAccount } from '@/lib/account'
import { api, errorMessage } from '@/lib/api'
import { isEmail } from '@/lib/format'
import { Screen, useToast } from '@/ui/kit'
import { c, pad } from '@/ui/theme'

export default function Compose() {
  const params = useLocalSearchParams<{ mailboxId?: string; inReplyTo?: string; to?: string; toName?: string; subject?: string }>()
  const { mailboxes } = useAccount()
  const client = useQueryClient()
  const toast = useToast()
  const isReply = !!params.inReplyTo

  // Agents send their own mail; people write from personal and shared mailboxes.
  const senders = mailboxes.filter((m) => m.kind !== 'agent' || m.id === params.mailboxId)
  const [mailboxId, setMailboxId] = useState(params.mailboxId ?? senders[0]?.id ?? '')
  const from = senders.find((m) => m.id === mailboxId)
  const [to, setTo] = useState(params.to ?? '')
  const [subject, setSubject] = useState(params.subject ?? '')
  const [text, setText] = useState('')
  const [error, setError] = useState('')

  const recipients = to.split(/[\s,;]+/).map((v) => v.trim()).filter(Boolean)
  const canSend = !!from && recipients.length > 0 && text.trim().length > 0

  const send = useMutation({
    mutationFn: () =>
      api('POST', `/email/mailboxes/${mailboxId}/send`, {
        to: recipients.map((email) => ({ email })),
        subject: subject.trim(),
        text,
        ...(params.inReplyTo && { inReplyTo: params.inReplyTo }),
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['mail'] })
      toast('Sent')
      router.back()
    },
    onError: (err) => setError(errorMessage(err)),
  })

  function submit() {
    const invalid = recipients.filter((r) => !isEmail(r))
    if (invalid.length) return setError(`${invalid[0]} isn't a valid email address.`)
    setError('')
    send.mutate()
  }

  /** With several mailboxes, tapping From moves to the next one. */
  function nextSender() {
    if (isReply || senders.length < 2) return
    const i = senders.findIndex((m) => m.id === mailboxId)
    setMailboxId(senders[(i + 1) % senders.length]!.id)
  }

  return (
    <Screen>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <View style={s.bar}>
          <Pressable onPress={() => router.back()} hitSlop={10}>
            <Text style={{ color: c.text, fontSize: 17 }}>Cancel</Text>
          </Pressable>
          <Text style={s.title}>{isReply ? 'Reply' : 'New message'}</Text>
          <Pressable onPress={submit} disabled={!canSend || send.isPending} style={[s.send, (!canSend || send.isPending) && { opacity: 0.4 }]}>
            {send.isPending ? (
              <ActivityIndicator color={c.card} />
            ) : (
              <>
                <Text style={{ color: c.card, fontSize: 16, fontWeight: '500' }}>Send</Text>
                <ArrowUp color={c.card} size={16} strokeWidth={2} />
              </>
            )}
          </Pressable>
        </View>

        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ flexGrow: 1 }}>
          <View style={s.field}>
            <Text style={s.label}>To</Text>
            <TextInput
              value={to}
              onChangeText={setTo}
              placeholder="Name or email"
              placeholderTextColor={c.dim}
              style={s.input}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              autoFocus={!isReply}
            />
          </View>
          <Pressable style={s.field} onPress={nextSender}>
            <Text style={s.label}>From</Text>
            <Text numberOfLines={1} style={[s.input, { paddingVertical: 14 }]}>
              {from?.address ?? 'No mailbox'}
            </Text>
            {!isReply && senders.length > 1 ? <Text style={{ color: c.dim, fontSize: 13 }}>Change</Text> : null}
          </Pressable>
          {isReply ? null : (
            <View style={s.field}>
              <Text style={s.label}>Subject</Text>
              <TextInput value={subject} onChangeText={setSubject} style={s.input} placeholderTextColor={c.dim} />
            </View>
          )}
          {error ? <Text style={s.error}>{error}</Text> : null}
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder={isReply ? 'Write a reply…' : 'Write a message…'}
            placeholderTextColor={c.dim}
            style={s.body}
            multiline
            textAlignVertical="top"
            autoFocus={isReply}
          />
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  )
}

const s = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', height: 60, paddingHorizontal: pad },
  title: { color: c.text, fontSize: 17, fontWeight: '500' },
  send: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 40, minWidth: 84, justifyContent: 'center', paddingHorizontal: 16, borderRadius: 20, backgroundColor: c.white },
  field: { flexDirection: 'row', alignItems: 'center', marginHorizontal: pad, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border, minHeight: 48 },
  label: { color: c.dim, fontSize: 14, width: 60 },
  input: { flex: 1, color: c.text, fontSize: 17, paddingVertical: 12 },
  error: { color: c.danger, fontSize: 14, marginHorizontal: pad, marginTop: 12 },
  body: { flex: 1, minHeight: 200, color: c.text, fontSize: 17, lineHeight: 25, paddingHorizontal: pad, paddingTop: 16 },
})
