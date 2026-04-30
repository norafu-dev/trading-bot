import type { KolConfig } from '../../kol/types.js'
import type { IRegexConfigRegistry, RegexConfig } from './types.js'

export class RegexConfigMissingError extends Error {
  constructor(
    message: string,
    public readonly kolId: string,
    public readonly regexConfigName: string,
  ) {
    super(message)
    this.name = 'RegexConfigMissingError'
  }
}

export class RegexConfigRegistry implements IRegexConfigRegistry {
  private readonly configs = new Map<string, RegexConfig>()

  register(config: RegexConfig): void {
    if (this.configs.has(config.name)) {
      throw new Error(`RegexConfig '${config.name}' is already registered`)
    }
    this.configs.set(config.name, config)
  }

  get(name: string): RegexConfig | null {
    return this.configs.get(name) ?? null
  }

  list(): RegexConfig[] {
    return Array.from(this.configs.values())
  }

  healthCheck(kols: ReadonlyArray<KolConfig>): void {
    for (const kol of kols) {
      if (!kol.enabled) continue
      if (kol.parsingStrategy !== 'regex_structured' && kol.parsingStrategy !== 'hybrid') continue

      if (!this.configs.has(kol.regexConfigName)) {
        throw new RegexConfigMissingError(
          `KOL '${kol.id}' requires RegexConfig '${kol.regexConfigName}' but none is registered under that name`,
          kol.id,
          kol.regexConfigName,
        )
      }
    }
  }
}
