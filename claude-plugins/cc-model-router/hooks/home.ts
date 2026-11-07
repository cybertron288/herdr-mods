import type { EngineInterface } from 'claude-code'

// The user's home: HOME, else USERPROFILE (Windows sets no HOME), read without a shell.
export async function userHome($: EngineInterface): Promise<string | undefined> {
  return (await $.env.get('HOME')) || (await $.env.get('USERPROFILE')) || undefined
}
