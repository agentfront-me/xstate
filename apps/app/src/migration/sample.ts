// A made-up Google Workspace (Acme Co) for the simulated migration API (./api.ts). Names and numbers follow the
// design; the domain is swapped for the organization's own when it has one.

import type { Discovery, GoogleUser } from './types'

const GB = 1024 ** 3
const TB = 1024 ** 4

type Seed = [name: string, local: string, mailGb: number, driveGb: number, messages: number, contacts: number, files: number]

const PEOPLE: Seed[] = [
  ['Dana Whitfield', 'dana', 38.4, 212, 31_002, 1_204, 5_000],
  ['Priya Raman', 'priya', 21.0, 88, 31_002, 1_204, 5_000],
  ['Marcus Oyelaran', 'marcus', 14.2, 2_048, 500_000, 2_118, 61_220],
  ['Jordan Lee', 'jordan', 9.7, 18, 18_884, 412, 2_230],
  ['Sofia Keller', 'sofia', 14.0, 12, 14_010, 640, 1_100],
  ['Amara Bello', 'amara', 12.6, 40, 26_310, 520, 3_904],
  ['Luca Ferraro', 'luca', 11.9, 33, 24_480, 488, 3_120],
  ['Hannah Cho', 'hannah', 10.4, 29, 22_015, 410, 2_870],
  ['Omar Haddad', 'omar', 9.8, 26, 20_772, 395, 2_640],
  ['Grace Mensah', 'grace', 9.1, 24, 19_340, 377, 2_410],
  ['Mateo Rossi', 'mateo', 8.7, 22, 18_520, 362, 2_288],
  ['Ingrid Dahl', 'ingrid', 8.2, 20, 17_604, 340, 2_102],
  ['Kenji Watanabe', 'kenji', 7.9, 19, 16_930, 331, 1_990],
  ['Leila Farahani', 'leila', 7.4, 18, 15_812, 318, 1_874],
  ['Tomás Silva', 'tomas', 6.9, 16, 14_706, 296, 1_720],
  ['Nadia Petrova', 'nadia', 6.5, 15, 13_998, 284, 1_633],
  ['Ethan Brooks', 'ethan', 6.0, 14, 12_870, 270, 1_512],
  ['Zara Ahmed', 'zara', 5.6, 12, 12_004, 255, 1_402],
  ['Felix Wagner', 'felix', 5.1, 11, 10_980, 240, 1_288],
  ['Maya Goldberg', 'maya', 4.7, 10, 10_120, 226, 1_190],
  ['Samuel Osei', 'samuel', 4.2, 9, 9_042, 210, 1_070],
  ['Theo Brandt', 'theo', 11.3, 2, 22_410, 0, 980],
  ['Rhea Nair', 'rhea', 0.4, 0, 820, 0, 0],
]

const SUSPENDED = new Set(['theo', 'rhea'])

export function sampleDiscovery(domain: string): Discovery {
  const base = domain.split('.')[0] ?? 'acme'
  const alt = `${base}.io`
  const users: GoogleUser[] = PEOPLE.map(([name, local, mailGb, driveGb, messages, contacts, files]) => ({
    id: `g-${local}`,
    name,
    email: `${local}@${local === 'jordan' ? alt : domain}`,
    suspended: SUSPENDED.has(local),
    mailBytes: Math.round(mailGb * GB),
    driveBytes: Math.round(driveGb * GB),
    messages,
    contacts,
    files,
    ...(local === 'jordan' && { existingMailbox: `jordan@${domain}` }),
  }))
  return {
    domain,
    users,
    groups: [
      { id: 'grp-sales', email: `sales@${domain}`, members: 6 },
      { id: 'grp-support', email: `support@${domain}`, members: 9 },
      { id: 'grp-billing', email: `billing@${domain}`, members: 3 },
      { id: 'grp-everyone', email: `everyone@${domain}`, members: users.length, note: `All ${users.length} users · announcement list` },
    ],
    drives: [
      { id: 'drv-marketing', name: 'Marketing assets', bytes: Math.round(840 * GB), members: 16, files: 41_220 },
      { id: 'drv-finance', name: 'Finance', bytes: Math.round(120 * GB), members: 4, files: 6_310 },
    ],
    domains: [
      { name: domain, kind: 'primary', inXstate: true },
      { name: alt, kind: 'secondary', inXstate: false },
      { name: `${base}-mail.com`, kind: 'alias', inXstate: true },
    ],
    aliases: 4,
  }
}

export const sizes = { GB, TB }
