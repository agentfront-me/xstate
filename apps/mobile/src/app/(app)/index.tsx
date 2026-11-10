// Home: one of four sections (Email, Users, Storage, Agents), switched from the drawer.

import { useState } from 'react'
import { Drawer, type Section } from '@/sections/Drawer'
import { Agents } from '@/sections/Agents'
import { Email } from '@/sections/Email'
import { Storage } from '@/sections/Storage'
import { Users } from '@/sections/Users'
import { Screen } from '@/ui/kit'

export default function Home() {
  const [section, setSection] = useState<Section>('email')
  const [open, setOpen] = useState(false)
  const menu = () => setOpen(true)

  return (
    <Screen bottom={false}>
      {section === 'email' ? <Email onMenu={menu} /> : null}
      {section === 'users' ? <Users onMenu={menu} /> : null}
      {section === 'storage' ? <Storage onMenu={menu} /> : null}
      {section === 'agents' ? <Agents onMenu={menu} /> : null}
      <Drawer open={open} section={section} onClose={() => setOpen(false)} onPick={setSection} />
    </Screen>
  )
}
